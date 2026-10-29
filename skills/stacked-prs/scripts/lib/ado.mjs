// @ts-check
/**
 * ado.mjs - Azure DevOps access, shelled out to `az`.
 *
 * Uses the existing Azure CLI login without exporting its credentials.
 *
 * Zero judgement - request in, JSON out.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRemote, gitOut } from "./git.mjs";

export const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

export function configFromRemote(remoteUrl) {
  const ssh = remoteUrl.match(/^(?:git@ssh\.dev\.azure\.com:|ssh:\/\/git@ssh\.dev\.azure\.com\/)v3\/([^/]+)\/([^/]+)\/(.+?)\/?$/);
  if (ssh) {
    const [, organization, project, repository] = ssh;
    return {
      orgUrl: `https://dev.azure.com/${organization}`,
      webOrgUrl: `https://dev.azure.com/${organization}`,
      project: decodeURIComponent(project),
      repository: decodeURIComponent(repository),
      apiVersion: "7.1",
    };
  }
  let url;
  try {
    url = new URL(remoteUrl);
  } catch {
    throw new Error("The selected remote is not an Azure DevOps HTTPS or SSH URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Azure DevOps remotes must use HTTPS or the supported Azure SSH format.");
  }
  if ((url.hostname !== "dev.azure.com" && !/^[a-z0-9][a-z0-9-]*\.visualstudio\.com$/i.test(url.hostname)) || url.port) {
    throw new Error("Automatic Azure authentication is limited to Azure DevOps Services hosts. Custom Server hosts require a separately reviewed authentication adapter.");
  }
  const match = url.pathname.match(/^(.*)\/([^/]+)\/_git\/([^/]+)\/?$/);
  if (!match) throw new Error("Cannot determine the Azure DevOps project and repository from the remote.");
  const [, collection, project, repository] = match;
  const orgUrl = `${url.origin}${collection}`;
  return {
    orgUrl, webOrgUrl: orgUrl, project: decodeURIComponent(project),
    repository: decodeURIComponent(repository), apiVersion: "7.1",
  };
}

export function getConfig(cwd = process.cwd()) {
  const remote = defaultRemote(cwd);
  return configFromRemote(gitOut(["remote", "get-url", "--push", remote], { cwd }));
}

/** @param {string[]} args */
function az(args, { allowFail = false } = {}) {
  const res = spawnSync("az", args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, AZURE_CORE_ONLY_SHOW_ERRORS: "true" },
  });
  if (res.status !== 0 && !allowFail) {
    const err = new Error(
      `az ${args.slice(0, 3).join(" ")} … failed (${res.status}):\n${res.stderr}`
    );
    /** @type {any} */ (err).exitCode = 4;
    throw err;
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function azJson(args, opts) {
  const { stdout, status } = az([...args, "-o", "json"], opts);
  if (status !== 0) return null;
  const t = stdout.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch (cause) {
    const error = Object.assign(new Error("Azure CLI returned invalid JSON.", { cause }), { exitCode: 4 });
    throw error;
  }
}

export function isAuthenticated(cfg = getConfig()) {
  return (
    az(["repos", "show", "--org", cfg.orgUrl, "--project", cfg.project, "--repository", cfg.repository, "-o", "none"], {
      allowFail: true,
    }).status === 0
  );
}

export function prWebUrl(prId, cfg = getConfig()) {
  return `${cfg.webOrgUrl}/${encodeURIComponent(cfg.project)}/_git/${encodeURIComponent(cfg.repository)}/pullrequest/${prId}`;
}

/**
 * PATCH a pull request.
 *
 * Three ADO access paths exist and each one is missing something:
 *
 *   az repos pr update  - authenticates reliably, but has NO --target-branch
 *                         argument at all, and caps --description at 4000 chars.
 *   az devops invoke    - authenticates reliably, but refuses PATCH on the
 *                         pullRequests resource.
 *   az rest             - supports everything, but commonly fails with
 *                         "Please run 'az login'" in Codespaces because it uses
 *                         a different credential path from the devops extension.
 *
 * What *does* work everywhere: mint a bearer token with
 * `az account get-access-token` (which succeeds even when `az account show`
 * does not) and call the REST API directly. That is the primary path here;
 * `az rest` is kept as a fallback.
 *
 * Retargeting a pull request is the whole point of `sync`, so this must not be
 * allowed to fail quietly.
 */
function bearerToken() {
  const res = az(
    ["account", "get-access-token", "--resource", ADO_RESOURCE_ID, "--query", "accessToken", "-o", "tsv"],
    { allowFail: true }
  );
  const t = res.stdout.trim();
  return res.status === 0 && t ? t : null;
}

function restPatch(uri, body, cfg = getConfig()) {
  const token = bearerToken();
  if (token) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-request-"));
    const bodyFile = path.join(dir, "body.json");
    fs.writeFileSync(bodyFile, JSON.stringify(body));
    try {
      const res = spawnSync(
        "curl",
        ["-sS", "--fail-with-body", "-X", "PATCH", uri, "--config", "-", "-H", "Content-Type: application/json", "--data-binary", `@${bodyFile}`],
        {
          encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
          input: `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\n`,
        }
      );
      if (res.status === 0 && res.stdout) {
        try {
          const parsed = JSON.parse(res.stdout);
          if (parsed && !parsed.message) return parsed;
        } catch {
          /* fall through to az rest */
        }
      }
    } finally {
      fs.rmSync(bodyFile, { force: true });
      fs.rmdirSync(dir);
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-request-"));
  const file = path.join(dir, "body.json");
  fs.writeFileSync(file, JSON.stringify(body));
  try {
    return azJson(
      ["rest", "--method", "PATCH", "--resource", ADO_RESOURCE_ID, "--uri", uri,
       "--headers", "Content-Type=application/json", "--body", `@${file}`],
      { allowFail: true }
    );
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmdirSync(dir);
  }
}

let cachedRepoId = null;
export function repositoryId(cfg = getConfig()) {
  if (cachedRepoId) return cachedRepoId;
  cachedRepoId = az([
    "repos",
    "show",
    "--org",
    cfg.orgUrl,
    "--project",
    cfg.project,
    "--repository",
    cfg.repository,
    "--query",
    "id",
    "-o",
    "tsv",
  ]).stdout.trim();
  return cachedRepoId;
}

/** Active PR for a source branch, or null. */
export function findPrForBranch(branch, cfg = getConfig()) {
  const list = azJson([
    "repos",
    "pr",
    "list",
    "--org",
    cfg.orgUrl,
    "--project",
    cfg.project,
    "--repository",
    cfg.repository,
    "--source-branch",
    branch,
    "--status",
    "all",
    "--top",
    "10",
  ]);
  if (!Array.isArray(list) || list.length === 0) return null;
  // Prefer an active PR; otherwise the most recent.
  return list.find((p) => p.status === "active") ?? list[0];
}

export function getPr(prId, cfg = getConfig()) {
  return azJson(["repos", "pr", "show", "--org", cfg.orgUrl, "--id", String(prId)]);
}

/**
 * @param {{sourceBranch:string, targetBranch:string, title:string, description?:string, draft?:boolean}} opts
 */
export function createPr(opts, cfg = getConfig()) {
  const args = [
    "repos",
    "pr",
    "create",
    "--org",
    cfg.orgUrl,
    "--project",
    cfg.project,
    "--repository",
    cfg.repository,
    "--source-branch",
    opts.sourceBranch,
    "--target-branch",
    opts.targetBranch,
    "--title",
    opts.title,
    "--description",
    opts.description ?? "Description is being populated.",
    "--draft",
    opts.draft === false ? "false" : "true",
  ];
  return azJson(args);
}

/** Update title/description/draft/target. Multiline-safe. */
export function updatePr(prId, fields, cfg = getConfig()) {
  const body = {};
  if (fields.title !== undefined) body.title = fields.title;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.isDraft !== undefined) body.isDraft = fields.isDraft;
  if (fields.targetBranch !== undefined) {
    body.targetRefName = fields.targetBranch.startsWith("refs/")
      ? fields.targetBranch
      : `refs/heads/${fields.targetBranch}`;
  }
  const uri = `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/git/repositories/${repositoryId(
    cfg
  )}/pullRequests/${prId}?api-version=${cfg.apiVersion}`;
  const res = restPatch(uri, body, cfg);
  if (res) return res;

  // Fall back to the devops extension. Note it cannot retarget - there is no
  // --target-branch argument - so a retarget that reaches here has genuinely
  // failed and must be reported, not swallowed.
  const args = ["repos", "pr", "update", "--org", cfg.orgUrl, "--id", String(prId)];
  if (fields.title !== undefined) args.push("--title", fields.title);
  if (fields.description !== undefined) args.push("--description", fields.description);
  if (fields.isDraft !== undefined) args.push("--draft", String(fields.isDraft));
  if (fields.targetBranch !== undefined) {
    const err = new Error(
      `Failed to retarget PR !${prId} to ${fields.targetBranch}. ` +
        "Azure DevOps only allows this through the REST API, and neither the " +
        "bearer-token nor the `az rest` path was available. Check `az login`."
    );
    /** @type {any} */ (err).exitCode = 4;
    throw err;
  }
  return azJson(args);
}

/** Policy evaluations (build status, required reviewers) for a PR. */
export function policyStatus(prId, cfg = getConfig()) {
  const repo = repositoryId(cfg);
  const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId(cfg)}/${prId}`;
  const uri =
    `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/policy/evaluations` +
    `?artifactId=${encodeURIComponent(artifactId)}&api-version=${cfg.apiVersion}-preview.1`;
  const res = azJson(
    ["rest", "--method", "GET", "--resource", ADO_RESOURCE_ID, "--uri", uri],
    { allowFail: true }
  );
  void repo;
  if (!res?.value) return [];
  return res.value.map((e) => ({
    status: e.status,
    type: e.configuration?.type?.displayName,
    displayName: e.configuration?.settings?.displayName ?? null,
    isBlocking: e.configuration?.isBlocking ?? false,
  }));
}

let cachedProjectId = null;
function projectId(cfg = getConfig()) {
  if (cachedProjectId) return cachedProjectId;
  cachedProjectId = az([
    "devops",
    "project",
    "show",
    "--org",
    cfg.orgUrl,
    "--project",
    cfg.project,
    "--query",
    "id",
    "-o",
    "tsv",
  ]).stdout.trim();
  return cachedProjectId;
}

/**
 * Walk a PR's base chain down to trunk, rebuilding a stack from the server.
 * This is what makes machine-local state safe to lose.
 * @returns {{prId:number, branch:string, target:string, title:string, status:string, isDraft:boolean}[]}
 *          bottom-first
 */
export function reconstructStack(prId, trunk, cfg = getConfig()) {
  const chain = [];
  const seen = new Set();
  let current = getPr(prId, cfg);
  while (current && !seen.has(current.pullRequestId)) {
    seen.add(current.pullRequestId);
    const branch = String(current.sourceRefName).replace(/^refs\/heads\//, "");
    const target = String(current.targetRefName).replace(/^refs\/heads\//, "");
    chain.unshift({
      prId: current.pullRequestId,
      branch,
      target,
      title: current.title,
      status: current.status,
      isDraft: Boolean(current.isDraft),
    });
    if (target === trunk) break;
    const parent = findPrForBranch(target, cfg);
    current = parent ? getPr(parent.pullRequestId, cfg) : null;
  }
  return chain;
}

export { az, azJson };
