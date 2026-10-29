import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { configFromRemote, prWebUrl, updatePr } from "../scripts/lib/ado.mjs";
import { capturePushLeases, defaultTrunk, pushBranches } from "../scripts/lib/git.mjs";

const helper = fileURLToPath(new URL("../scripts/stack.mjs", import.meta.url));

it("runs the entrypoint from a path containing spaces and URL characters", t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "Skill directory #1");
  fs.cpSync(path.dirname(helper), directory, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(directory, "stack.mjs"), "help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Stacked PRs/);
});

it("derives Azure HTTPS coordinates and encodes display links", () => {
  const cfg = configFromRemote("https://dev.azure.com/example/My%20Project/_git/My%20Repo");
  assert.equal(cfg.orgUrl, "https://dev.azure.com/example");
  assert.equal(cfg.project, "My Project");
  assert.equal(cfg.repository, "My Repo");
  assert.equal(prWebUrl(42, cfg), "https://dev.azure.com/example/My%20Project/_git/My%20Repo/pullrequest/42");
});

it("preserves collection paths for legacy Azure HTTPS remotes", () => {
  const cfg = configFromRemote("https://example.visualstudio.com/DefaultCollection/Project/_git/Repository");
  assert.equal(cfg.orgUrl, "https://example.visualstudio.com/DefaultCollection");
  assert.equal(cfg.project, "Project");
  assert.equal(cfg.repository, "Repository");
});

it("maps Azure SSH remotes without treating them as HTTPS paths", () => {
  for (const remote of [
    "git@ssh.dev.azure.com:v3/example/Project/Repository",
    "ssh://git@ssh.dev.azure.com/v3/example/Project/Repository",
  ]) {
    const cfg = configFromRemote(remote);
    assert.equal(cfg.orgUrl, "https://dev.azure.com/example");
    assert.equal(cfg.project, "Project");
    assert.equal(cfg.repository, "Repository");
  }
});

it("rejects non-Azure shapes rather than selecting a fixed repository", () => {
  assert.throws(() => configFromRemote("https://github.com/example/repository.git"), /limited to Azure/);
  assert.throws(() => configFromRemote("http://ado.example.com/P/_git/R"), /HTTPS/);
  assert.throws(() => configFromRemote("https://ado.example.com/P/_git/R"), /limited to Azure/);
  assert.throws(() => configFromRemote("https://example.visualstudio.com.attacker.example/P/_git/R"), /limited to Azure/);
  assert.throws(() => configFromRemote("https://dev.azure.com:8443/example/P/_git/R"), /limited to Azure/);
});

function azureFixtures(t, failPatch = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azure-fixture-"));
  const originalPath = process.env.PATH;
  const log = path.join(dir, "request.json");
  fs.writeFileSync(path.join(dir, "az"), [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'account') process.stdout.write('fake-token');",
    "else if (args[0] === 'repos' && args[1] === 'show') process.stdout.write('repository-id');",
    "else process.exit(1);",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "curl"), [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const body = args[args.indexOf('--data-binary') + 1].slice(1);",
    `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: fs.readFileSync(0, 'utf8'), body, files: fs.readdirSync(path.dirname(body)) }));`,
    failPatch ? "process.exit(22);" : "process.stdout.write(JSON.stringify({ pullRequestId: 42, targetRefName: 'refs/heads/main' }));",
  ].join("\n"), { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return log;
}

it("passes authorization on stdin and cleans up the private request body", { skip: process.platform === "win32" }, t => {
  const log = azureFixtures(t);
  const cfg = configFromRemote("https://dev.azure.com/example/Project/_git/Repository");
  assert.equal(updatePr(42, { targetBranch: "main" }, cfg).pullRequestId, 42);
  const request = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.ok(request.input.includes("fake-token"));
  assert.ok(!request.args.some(arg => arg.includes("fake-token")));
  assert.deepEqual(request.files, ["body.json"]);
  assert.equal(fs.existsSync(path.dirname(request.body)), false);
});

it("fails an unsuccessful retarget instead of reporting a title-only fallback as success", { skip: process.platform === "win32" }, t => {
  azureFixtures(t, true);
  const cfg = configFromRemote("https://dev.azure.com/example/Project/_git/Repository");
  assert.throws(() => updatePr(42, { targetBranch: "main" }, cfg), /Failed to retarget/);
});

it("splits a non-JavaScript master-based repository without losing generated or binary paths", t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "portable-stack-"));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const run = args => spawnSync(process.execPath, [helper, ...args], { cwd: repo, encoding: "utf8" });
  git(["init", "-q", "-b", "master"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "service.cs"), "class Service {}\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# Service\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "Initial service"]);
  git(["checkout", "-qb", "feature/large-change"]);
  fs.writeFileSync(path.join(repo, "service.cs"), "class Service { public int Value = 1; }\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# Updated service\n");
  fs.mkdirSync(path.join(repo, "__generated__"));
  fs.writeFileSync(path.join(repo, "__generated__/client.cs"), "class Client {}\n");
  fs.writeFileSync(path.join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(repo, "binary.dat"), Buffer.from([0, 1, 255, 0]));
  git(["add", "-A"]);
  git(["commit", "-qm", "Add service functionality"]);
  assert.equal(defaultTrunk(repo), "master");
  const analyzed = run(["analyze"]);
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const analysis = JSON.parse(analyzed.stdout);
  assert.ok(analysis.changes.some(c => c.path === "package-lock.json"));
  assert.ok(analysis.changes.some(c => c.path === "__generated__/client.cs"));
  const plan = path.join(parent, "plan.json");
  fs.writeFileSync(plan, JSON.stringify({
    sourceBranch: "feature/large-change", trunk: "master", topic: "service",
    layers: [
      { slug: "implementation", title: "Add the service implementation", paths: ["service.cs", "__generated__/client.cs", "package-lock.json"] },
      { slug: "assets", title: "Document the service and add its asset", paths: ["README.md", "binary.dat"] },
    ],
  }));
  const split = run(["split", "--plan", plan, "--yes"]);
  assert.equal(split.status, 0, `${split.stdout}\n${split.stderr}`);
  assert.equal(git(["diff", "--name-only", "HEAD", "feature/large-change"]), "");
  assert.equal(git(["branch", "--show-current"]), "stacks/service.02-assets");
  assert.equal(git(["status", "--porcelain"]), "");
  assert.ok(fs.existsSync(path.join(repo, ".git/stacked-prs/stacks.json")));
  const invalid = JSON.parse(fs.readFileSync(plan, "utf8"));
  invalid.layers[0].paths.pop();
  fs.writeFileSync(plan, JSON.stringify(invalid));
  const checked = run(["split", "--plan", plan, "--dry-run"]);
  assert.equal(checked.status, 5);
  assert.equal(JSON.parse(checked.stdout).validation.ok, false);
});

function remoteFixtures(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stack-leases-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote");
  const local = path.join(root, "local");
  const collaborator = path.join(root, "collaborator");
  const git = (cwd, args) => execFileSync("git", cwd === remote ? ["--git-dir", remote, ...args] : args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  fs.mkdirSync(local);
  git(root, ["init", "--bare", "-q", "-b", "main", remote]);
  git(local, ["init", "-q", "-b", "main"]);
  const identity = cwd => {
    git(cwd, ["config", "user.name", "Test"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "commit.gpgsign", "false"]);
  };
  identity(local);
  fs.writeFileSync(path.join(local, "base.txt"), "base\n");
  git(local, ["add", "-A"]);
  git(local, ["commit", "-qm", "Base"]);
  git(local, ["remote", "add", "origin", remote]);
  git(local, ["push", "-q", "-u", "origin", "main"]);
  git(root, ["clone", "-q", remote, collaborator]);
  identity(collaborator);
  fs.writeFileSync(path.join(local, "ours.txt"), "ours\n");
  git(local, ["add", "-A"]);
  git(local, ["commit", "-qm", "Local change"]);
  const advance = () => {
    fs.writeFileSync(path.join(collaborator, "theirs.txt"), "theirs\n");
    git(collaborator, ["add", "-A"]);
    git(collaborator, ["commit", "-qm", "Collaborator change"]);
    git(collaborator, ["push", "-q", "origin", "main"]);
    return git(collaborator, ["rev-parse", "HEAD"]);
  };
  return { remote, local, git, advance };
}

it("rejects unincorporated collaborator commits even after fetch advances tracking refs", t => {
  const { remote, local, git, advance } = remoteFixtures(t);
  const theirs = advance();
  git(local, ["fetch", "-q", "origin"]);
  assert.throws(() => capturePushLeases("origin", ["main"], local), /not incorporated locally/);
  assert.throws(() => pushBranches("origin", ["main"], local), /not incorporated locally/);
  assert.equal(git(remote, ["rev-parse", "refs/heads/main"]), theirs);
});

it("keeps explicit leases when atomic push is unsupported and tracking refs move", t => {
  const { remote, local, git, advance } = remoteFixtures(t);
  const expected = capturePushLeases("origin", ["main"], local);
  const theirs = advance();
  git(local, ["fetch", "-q", "origin"]);
  git(remote, ["config", "receive.advertiseAtomic", "false"]);
  const result = pushBranches("origin", ["main"], local, expected);
  assert.notEqual(result.status, 0);
  assert.equal(git(remote, ["rev-parse", "refs/heads/main"]), theirs);
});
