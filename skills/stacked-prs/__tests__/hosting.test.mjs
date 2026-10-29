import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHosting, normalizePullRequest, repositoryFromRemote } from "../scripts/lib/hosting.mjs";

const github = {
  number: 12, node_id: "PR_example", title: "Add API", body: "Summary\n\nChecklist",
  head: { ref: "feature/api", repo: { full_name: "owner/repo" } },
  base: { ref: "main" }, state: "open", draft: true, merged_at: null,
  html_url: "https://github.com/owner/repo/pull/12",
};
const gitlab = {
  id: 900, iid: 12, title: "Draft: Add API", description: "Summary\n\nChecklist",
  source_branch: "feature/api", target_branch: "main", state: "opened", draft: true,
  source_project_id: 7, target_project_id: 7,
  web_url: "https://gitlab.com/group/sub/repo/-/merge_requests/12",
};

function client(provider, reply) {
  const calls = [];
  const remote = provider === "github" ? "https://github.com/owner/repo.git" : "git@gitlab.com:group/sub/repo.git";
  const api = createHosting(() => ({ ...repositoryFromRemote(remote), remote: "origin" }), (command, args, input) => {
    const call = { command, args, method: args[4], resource: args[5], body: input === undefined ? undefined : JSON.parse(input) };
    calls.push(call);
    const value = reply(call, calls.length);
    return typeof value.status === "number" ? value : { status: 0, stdout: JSON.stringify(value), stderr: "" };
  });
  api.hasNativeState = () => false;
  return { api, calls };
}

describe("repository selection", () => {
  it("recognizes cloud HTTPS, SSH and nested GitLab namespaces", () => {
    assert.equal(repositoryFromRemote("git@github.com:owner/repo.git").identity, "github:github.com/owner/repo");
    assert.equal(repositoryFromRemote("ssh://git@gitlab.com/group/sub/repo.git").repository, "group/sub/repo");
    assert.equal(repositoryFromRemote("git@ssh.dev.azure.com:v3/org/project/repo").provider, "azure-devops");
    assert.equal(repositoryFromRemote("https://org.visualstudio.com/Collection/project/_git/repo").azure.project, "project");
  });

  it("requires an explicit provider for self-hosted services and rejects conflicting or insecure settings", () => {
    assert.throws(() => repositoryFromRemote("https://code.example/group/repo"), /explicitly/);
    assert.equal(repositoryFromRemote("https://code.example/group/repo", "gitlab").host, "code.example");
    assert.throws(() => repositoryFromRemote("http://gitlab.com/group/repo"), /HTTPS/);
    assert.throws(() => repositoryFromRemote("https://github.com/owner/repo", "gitlab"), /conflicts/);
    assert.throws(() => repositoryFromRemote("https://dev.azure.com/org/project/_git/repo", "github"), /conflicts/);
  });

  it("does not mistake the GitLab global id for its project-relative MR number", () => {
    assert.equal(normalizePullRequest("gitlab", gitlab).pullRequestId, 12);
    assert.equal(normalizePullRequest("github", { ...github, state: "closed", merged_at: "2026-01-01" }).status, "completed");
    assert.equal(normalizePullRequest("gitlab", { ...gitlab, state: "closed" }).status, "abandoned");
  });

  it("rejects a changed hosting repository before a write", () => {
    const { api, calls } = client("github", () => github);
    assert.throws(() => api.assertRepository({ repository: "github:github.com/other/repo" }), /different hosting repository/);
    assert.throws(() => api.assertRepository({ remote: "upstream" }), /selected push remote differs/);
    assert.equal(calls.length, 0);
    api.hasNativeState = () => true;
    assert.throws(() => api.assertBranchEngine({}), /Native gh stack state/);
  });
});

describe("hosting operations", () => {
  for (const provider of ["github", "gitlab"]) {
    it(`creates ${provider} drafts with literal multiline descriptions`, () => {
      const { api, calls } = client(provider, () => provider === "github" ? github : gitlab);
      const result = api.createPr({ sourceBranch: "feature/api", targetBranch: "main", title: "Add API", description: "Body\n\nChecklist" });
      assert.equal(result.isDraft, true);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].body[provider === "github" ? "body" : "description"], "Body\n\nChecklist");
      assert.equal(calls[0].command, provider === "github" ? "gh" : "glab");
      assert.deepEqual(calls[0].args.slice(-2), ["--input", "-"]);
      if (provider === "gitlab") assert.equal(calls[0].resource, "projects/group%2Fsub%2Frepo/merge_requests");
    });
  }

  it("uses a GitHub GraphQL readiness mutation and verifies the result", () => {
    let current = structuredClone(github);
    const { api, calls } = client("github", call => {
      if (call.resource === "graphql") {
        assert.match(call.body.query, /markPullRequestReadyForReview/);
        assert.equal(call.body.variables.id, github.node_id);
        current.draft = false;
        return { data: {} };
      }
      if (call.body?.base) current.base.ref = call.body.base;
      return current;
    });
    const result = api.updatePr(12, { targetBranch: "refs/heads/feature/base", isDraft: false });
    assert.equal(result.targetRefName, "refs/heads/feature/base");
    assert.equal(result.isDraft, false);
    assert.equal(calls[0].method, "PATCH");
    assert.equal(calls.length, 3);
  });

  it("retargets a GitLab MR and removes all supported draft title forms", () => {
    for (const prefix of ["Draft:", "[Draft]", "(Draft)", "WIP:"]) {
      const { api, calls } = client("gitlab", call => call.method === "GET"
        ? { ...gitlab, title: `${prefix} Add API` }
        : { ...gitlab, title: call.body.title, target_branch: call.body.target_branch, draft: false });
      const result = api.updatePr(12, { targetBranch: "feature/base", isDraft: false });
      assert.equal(result.title, "Add API");
      assert.equal(result.targetRefName, "refs/heads/feature/base");
      assert.equal(calls[1].method, "PUT");
    }
  });

  it("rejects unsuccessful draft or retarget updates rather than reporting success", () => {
    const { api } = client("gitlab", () => gitlab);
    assert.throws(() => api.updatePr(12, { targetBranch: "other" }), /target branch/);
    assert.throws(() => api.updatePr(12, { isDraft: false }), /draft state/);
    assert.throws(() => api.createPr({ title: "Ready", sourceBranch: "a", targetBranch: "main", draft: false }), /draft state/);
  });

  it("ignores fork MRs, prefers an active chain and encodes branch query parameters", () => {
    const { api, calls } = client("gitlab", () => [
      { ...gitlab, iid: 99, source_project_id: 8 },
      { ...gitlab, iid: 8, state: "merged" },
      gitlab,
    ]);
    assert.equal(api.findPrForBranch("feature/a#b&c").pullRequestId, 12);
    assert.match(calls[0].resource, /source_branch=feature%2Fa%23b%26c/);
  });

  it("follows pagination before deciding that a branch has no active PR", () => {
    const { api } = client("github", call => call.resource.includes("page=2")
      ? [github] : Array.from({ length: 100 }, (_, i) => ({ ...github, number: i + 20, state: "closed" })));
    assert.equal(api.findPrForBranch("feature/api").pullRequestId, 12);
  });

  it("reconstructs the current ancestor chain bottom-up and rejects fork adoption", () => {
    const lower = { ...gitlab, iid: 11, source_branch: "feature/base" };
    const { api } = client("gitlab", call => call.resource.includes("?")
      ? [lower] : { ...gitlab, target_branch: "feature/base" });
    assert.deepEqual(api.reconstructStack(12, "main").map(item => item.prId), [11, 12]);
    const fork = client("github", () => ({ ...github, head: { ...github.head, repo: { full_name: "someone/fork" } } }));
    assert.throws(() => fork.api.getPr(12), /Fork-based stacks/);
  });

  it("surfaces API errors and invalid JSON", () => {
    const failed = client("github", () => ({ status: 1, stdout: "", stderr: "HTTP 403" }));
    assert.throws(() => failed.api.getPr(12), /HTTP 403/);
    const malformed = client("gitlab", () => ({ status: 0, stdout: "<html>", stderr: "" }));
    assert.throws(() => malformed.api.getPr(12), /invalid JSON/);
  });
});

describe("native GitHub selection", () => {
  it("requires both the native CLI and repository capability", () => {
    for (const installed of [false, true]) {
      for (const supported of [false, true]) {
        const { api } = client("github", call => {
          if (call.args[0] === "stack") return installed
            ? { status: 0, stdout: "help", stderr: "" }
            : { status: 1, stdout: "", stderr: 'unknown command "stack" for "gh"' };
          if (call.resource.includes("/stacks")) return supported
            ? [] : { status: 1, stdout: "", stderr: "HTTP 404" };
          return { name: "repo" };
        });
        assert.equal(api.backendInfo().engine, installed && supported ? "gh-stack" : "branch-chain");
      }
    }
  });

  it("does not disguise an inaccessible repository or server failure as unavailable native support", () => {
    const inaccessible = client("github", () => ({ status: 1, stdout: "", stderr: "HTTP 404" }));
    assert.throws(() => inaccessible.api.backendInfo(), /Hosting request failed/);
    assert.equal(inaccessible.calls.length, 1);
    const outage = client("github", call => call.args[0] === "stack"
      ? { status: 0, stdout: "help", stderr: "" }
      : call.resource.includes("/stacks") ? { status: 1, stdout: "", stderr: "HTTP 503" } : {});
    assert.throws(() => outage.api.backendInfo(), /Cannot determine native stack support/);
  });
});
