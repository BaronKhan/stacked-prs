import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as azure from "./ado.mjs";
import { defaultRemote, gitOut } from "./git.mjs";

export function repositoryFromRemote(remote, override) {
  const scp = remote.match(/^git@([^:]+):(.+)$/);
  const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : remote);
  if (!["https:", "ssh:"].includes(url.protocol)) throw new Error("Use an HTTPS or SSH hosting remote.");
  const host = url.hostname.toLowerCase();
  const azureHost = host === "dev.azure.com" || host === "ssh.dev.azure.com" || /^[a-z0-9][a-z0-9-]*\.visualstudio\.com$/.test(host);
  if (azureHost) {
    if (override && override !== "azure-devops") throw new Error("The provider override conflicts with the Azure remote.");
    const config = azure.configFromRemote(remote);
    return { provider: "azure-devops", identity: `${config.orgUrl}/${config.project}/${config.repository}`, azure: config };
  }
  const detected = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : null;
  if (detected && override && detected !== override) throw new Error("The provider override conflicts with the remote host.");
  const provider = detected ?? override;
  if (!["github", "gitlab"].includes(provider)) {
    throw new Error("For a configured self-hosted GitHub or GitLab service, set STACKED_PRS_PROVIDER explicitly.");
  }
  const repository = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, "").split("/").map(decodeURIComponent).join("/");
  const parts = repository.split("/");
  if (parts.length < 2 || parts.some(part => !part || part === "." || part === "..") || (provider === "github" && parts.length !== 2)) {
    throw new Error("Cannot determine the repository namespace from the remote.");
  }
  const apiHost = url.protocol === "https:" ? url.host : host;
  return { provider, host: apiHost, repository, identity: `${provider}:${apiHost}/${repository}` };
}

function currentRepository() {
  const remote = defaultRemote();
  return { ...repositoryFromRemote(gitOut(["remote", "get-url", "--push", remote]), process.env.STACKED_PRS_PROVIDER), remote };
}

function execute(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
}

function gitlabTitle(title, draft) {
  const plain = title.replace(/^(?:(?:Draft|WIP):\s*|\[(?:Draft|WIP)\]\s*|\((?:Draft|WIP)\)\s*)+/i, "");
  return draft ? `Draft: ${plain}` : plain;
}

export function normalizePullRequest(provider, item) {
  if (provider === "azure-devops") return item;
  const github = provider === "github";
  const merged = github ? Boolean(item.merged_at) : item.state === "merged";
  return {
    pullRequestId: github ? item.number : item.iid,
    title: item.title,
    description: github ? item.body ?? "" : item.description ?? "",
    sourceRefName: `refs/heads/${github ? item.head.ref : item.source_branch}`,
    targetRefName: `refs/heads/${github ? item.base.ref : item.target_branch}`,
    status: merged ? "completed" : item.state === "closed" ? "abandoned" : "active",
    isDraft: Boolean(item.draft ?? item.work_in_progress),
    url: github ? item.html_url : item.web_url,
  };
}

export function createHosting(resolve = currentRepository, run = execute) {
  let cached;
  const repo = () => cached ??= resolve();
  const fail = message => { throw Object.assign(new Error(message), { exitCode: 4 }); };
  const endpoint = () => repo().provider === "github"
    ? `repos/${repo().repository.split("/").map(encodeURIComponent).join("/")}`
    : `projects/${encodeURIComponent(repo().repository)}`;
  const raw = (resource, method = "GET", body) => run(
    repo().provider === "github" ? "gh" : "glab",
    ["api", "--hostname", repo().host, "--method", method, resource, ...(body === undefined ? [] : ["--input", "-"])],
    body === undefined ? undefined : JSON.stringify(body)
  );
  const decode = result => {
    if (result.status !== 0) fail(`Hosting request failed: ${result.stderr}`);
    try {
      const data = JSON.parse(result.stdout);
      if (data?.errors?.length) fail(`Hosting API errors: ${JSON.stringify(data.errors)}`);
      return data;
    } catch (error) {
      if (error.exitCode) throw error;
      fail("Hosting CLI returned invalid JSON.");
    }
  };
  const request = (resource, method, body) => decode(raw(resource, method, body));
  const collection = () => `${endpoint()}/${repo().provider === "github" ? "pulls" : "merge_requests"}`;
  const numericId = id => {
    if (!/^[1-9]\d*$/.test(String(id))) throw new Error("A positive PR or merge request number is required.");
    return String(id);
  };
  const sameRepository = value => repo().provider === "github"
    ? value.head?.repo?.full_name?.toLowerCase() === repo().repository.toLowerCase()
    : Number.isInteger(value.source_project_id) && value.source_project_id === value.target_project_id;
  const normalized = value => {
    if (!sameRepository(value)) fail("Fork-based stacks are not supported. Use branches in the selected hosting repository.");
    return normalizePullRequest(repo().provider, value);
  };

  const api = {
    identity: () => repo(),
    assertRepository(stack) {
      const current = repo();
      if (stack.remote && current.remote && stack.remote !== current.remote) fail("The selected push remote differs from the stack's recorded remote. Reconcile the remote before continuing.");
      if (stack.repository && stack.repository !== current.identity) fail("This stack belongs to a different hosting repository. Reconcile the remote before continuing.");
      stack.repository = current.identity;
      stack.provider = current.provider;
    },
    assertBranchEngine(stack) {
      api.assertRepository(stack);
      if (repo().provider === "github" && api.hasNativeState()) fail("Native gh stack state exists in this checkout. Use gh stack, or explicitly reconcile the two engines before changing this branch chain.");
    },
    isAuthenticated() {
      if (repo().provider === "azure-devops") return azure.isAuthenticated(repo().azure);
      request(endpoint());
      return true;
    },
    backendInfo() {
      const current = repo();
      if (current.provider !== "github") return { ...current, engine: "branch-chain", experimentalAlternative: current.provider === "gitlab" ? "glab stack" : undefined };
      request(endpoint());
      const extension = run("gh", ["stack", "--help"]);
      if (extension.status !== 0 && !/unknown command|not found|ENOENT|not installed/i.test(extension.stderr + extension.stdout)) {
        fail(`Cannot inspect gh stack: ${extension.stderr}`);
      }
      const support = raw(`${endpoint()}/stacks?per_page=1`);
      let supported = false;
      if (support.status === 0) {
        if (!Array.isArray(decode(support))) fail("GitHub returned an unexpected stacks response.");
        supported = true;
      } else if (!/HTTP 404/.test(support.stderr)) {
        fail(`Cannot determine native stack support: ${support.stderr}`);
      }
      return { ...current, engine: supported && extension.status === 0 ? "gh-stack" : "branch-chain", nativeRepositorySupport: supported, nativeCliAvailable: extension.status === 0, nativeStatePresent: api.hasNativeState() };
    },
    getPr(id) {
      if (repo().provider === "azure-devops") return azure.getPr(id, repo().azure);
      return normalized(request(`${collection()}/${numericId(id)}`));
    },
    findPrForBranch(branch) {
      if (repo().provider === "azure-devops") return azure.findPrForBranch(branch, repo().azure);
      const github = repo().provider === "github";
      const query = new URLSearchParams(github
        ? { state: "all", head: `${repo().repository.split("/")[0]}:${branch}`, sort: "updated", direction: "desc", per_page: "100" }
        : { scope: "all", state: "all", source_branch: branch, order_by: "updated_at", sort: "desc", per_page: "100" });
      let latest = null;
      for (let page = 1; ; page++) {
        query.set("page", String(page));
        const data = request(`${collection()}?${query}`);
        if (!Array.isArray(data)) fail("Hosting API did not return a PR list.");
        const candidates = data.filter(sameRepository).map(normalized);
        const active = candidates.find(item => item.status === "active");
        if (active) return active;
        latest ??= candidates[0] ?? null;
        if (data.length < 100) return latest;
      }
    },
    createPr(options) {
      if (repo().provider === "azure-devops") return azure.createPr(options, repo().azure);
      const github = repo().provider === "github";
      const body = github
        ? { head: options.sourceBranch, base: options.targetBranch, title: options.title, body: options.description ?? "", draft: options.draft !== false }
        : { source_branch: options.sourceBranch, target_branch: options.targetBranch, title: gitlabTitle(options.title, options.draft !== false), description: options.description ?? "" };
      const created = normalized(request(collection(), "POST", body));
      if (created.isDraft !== (options.draft !== false)) fail("The server did not confirm the requested draft state.");
      return created;
    },
    updatePr(id, fields) {
      if (repo().provider === "azure-devops") return azure.updatePr(id, fields, repo().azure);
      const github = repo().provider === "github";
      const body = {};
      if (fields.title !== undefined) body.title = fields.title;
      if (fields.description !== undefined) body[github ? "body" : "description"] = fields.description;
      if (fields.targetBranch !== undefined) body[github ? "base" : "target_branch"] = fields.targetBranch.replace(/^refs\/heads\//, "");
      if (!github && fields.isDraft !== undefined) {
        const title = fields.title ?? api.getPr(id).title;
        body.title = gitlabTitle(title, fields.isDraft);
      }
      const resource = `${collection()}/${numericId(id)}`;
      let result = Object.keys(body).length ? request(resource, github ? "PATCH" : "PUT", body) : request(resource);
      if (github && fields.isDraft !== undefined && result.draft !== fields.isDraft) {
        const mutation = fields.isDraft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
        request("graphql", "POST", {
          query: `mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){pullRequest{id isDraft}}}`,
          variables: { id: result.node_id },
        });
        result = request(resource);
      }
      const updated = normalized(result);
      if (fields.isDraft !== undefined && updated.isDraft !== fields.isDraft) fail("The server did not confirm the requested draft state.");
      if (fields.targetBranch !== undefined && updated.targetRefName !== `refs/heads/${fields.targetBranch.replace(/^refs\/heads\//, "")}`) fail("The server did not confirm the requested target branch.");
      return updated;
    },
    prWebUrl(id) {
      if (repo().provider === "azure-devops") return azure.prWebUrl(id, repo().azure);
      const route = repo().provider === "github" ? "pull" : "-/merge_requests";
      return `https://${repo().host}/${repo().repository.split("/").map(encodeURIComponent).join("/")}/${route}/${numericId(id)}`;
    },
    reconstructStack(id, trunk) {
      const chain = [];
      const seen = new Set();
      let current = api.getPr(id);
      while (current && !seen.has(current.pullRequestId)) {
        seen.add(current.pullRequestId);
        const branch = current.sourceRefName.replace(/^refs\/heads\//, "");
        const target = current.targetRefName.replace(/^refs\/heads\//, "");
        chain.unshift({ prId: current.pullRequestId, branch, target, title: current.title, status: current.status, isDraft: current.isDraft });
        if (target === trunk) break;
        current = api.findPrForBranch(target);
      }
      return chain;
    },
    hasNativeState() {
      const common = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      return fs.existsSync(path.join(common, "gh-stack"));
    },
  };
  return api;
}
