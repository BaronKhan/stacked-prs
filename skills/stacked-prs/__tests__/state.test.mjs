// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  acquireLock,
  activeStack,
  backupRefName,
  beginJournal,
  clearJournal,
  emptyState,
  loadState,
  LockedError,
  nextStackId,
  pendingJournals,
  readJournal,
  resolveGitDir,
  saveState,
  stacksContaining,
  stateDir,
  statePaths,
  upsertStack,
} from "../scripts/lib/state.mjs";

let repo;

function git(args, cwd = repo) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "stack-state-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("state location", () => {
  it("lives inside .git, so git can never track it", () => {
    const dir = stateDir(repo);
    const gitDir = resolveGitDir(repo);
    assert.ok(dir.startsWith(gitDir), `${dir} should be under ${gitDir}`);
    assert.equal(path.basename(dir), "stacked-prs");
  });

  it("is invisible to `git status` even when populated", () => {
    saveState({ ...emptyState(), activeStackId: "1" }, repo);
    fs.writeFileSync(path.join(stateDir(repo), "junk.json"), "{}");
    assert.equal(git(["status", "--porcelain"]), "");
  });

  it("is not reported by ls-files", () => {
    assert.equal(git(["ls-files", "--", ".git"]), "");
  });
});

describe("atomic persistence", () => {
  it("round-trips", () => {
    const st = emptyState();
    const stack = {
      id: "1",
      title: "T",
      topic: "t",
      trunk: "main",
      remote: "origin",
      createdAt: "x",
      updatedAt: "x",
      branches: [{ name: "a", parent: "main", state: "open" }],
    };
    upsertStack(st, stack);
    st.activeStackId = "1";
    saveState(st, repo);
    const back = loadState(repo);
    assert.equal(back.activeStackId, "1");
    assert.equal(back.stacks["1"].branches[0].name, "a");
  });

  it("keeps the previous copy as .bak and never leaves a temp file", () => {
    const p = statePaths(repo);
    const st = loadState(repo);
    st.stacks["1"].title = "second";
    saveState(st, repo);
    assert.ok(fs.existsSync(p.backup));
    const leftovers = fs
      .readdirSync(p.dir)
      .filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("recovers from a corrupt primary file via the backup", () => {
    const p = statePaths(repo);
    fs.writeFileSync(p.file, "{ this is not json");
    const back = loadState(repo);
    assert.ok(back.stacks["1"], "should have fallen back to .bak");
  });

  it("never throws on a totally missing state dir", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "stack-empty-"));
    execFileSync("git", ["init", "-q"], { cwd: fresh });
    const st = loadState(fresh);
    assert.deepEqual(st.stacks, {});
    fs.rmSync(fresh, { recursive: true, force: true });
  });
});

describe("locking", () => {
  it("blocks a second holder", () => {
    const release = acquireLock("first", repo);
    assert.throws(() => acquireLock("second", repo), LockedError);
    release();
  });

  it("releases cleanly and can be re-acquired", () => {
    const release = acquireLock("a", repo);
    release();
    const again = acquireLock("b", repo);
    again();
    assert.equal(fs.existsSync(statePaths(repo).lock), false);
  });

  it("breaks a lock held by a dead pid on this host", () => {
    const p = statePaths(repo);
    fs.writeFileSync(
      p.lock,
      JSON.stringify({
        pid: 999999999,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
        command: "zombie",
      })
    );
    const release = acquireLock("recovering", repo);
    release();
  });

  it("exposes exit code 8", () => {
    const release = acquireLock("x", repo);
    try {
      acquireLock("y", repo);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.exitCode, 8);
    }
    release();
  });
});

describe("journal", () => {
  it("records, reads back and clears", () => {
    const j = beginJournal("rebase", "1", { a: "sha1" }, ["a", "b"], repo);
    assert.equal(j.steps.length, 2);
    assert.equal(readJournal("1", repo).op, "rebase");
    assert.equal(pendingJournals(repo).length, 1);
    clearJournal("1", repo);
    assert.equal(readJournal("1", repo), null);
    assert.equal(pendingJournals(repo).length, 0);
  });

  it("survives a simulated crash - the entry is on disk before any work", () => {
    beginJournal("sync", "2", { a: "sha" }, ["a"], repo);
    const recovered = pendingJournals(repo);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].stackId, "2");
    assert.equal(recovered[0].steps[0].status, "pending");
    clearJournal("2", repo);
  });
});

describe("accessors", () => {
  it("finds stacks containing a branch", () => {
    const st = loadState(repo);
    assert.equal(stacksContaining(st, "a").length, 1);
    assert.equal(stacksContaining(st, "nope").length, 0);
  });

  it("returns the active stack", () => {
    const st = loadState(repo);
    assert.equal(activeStack(st)?.id, "1");
  });

  it("allocates monotonically increasing ids", () => {
    const st = loadState(repo);
    assert.equal(nextStackId(st), "2");
  });

  it("namespaces backup refs so they are never pushed", () => {
    const ref = backupRefName("1", "users/me/x.01-a");
    assert.ok(ref.startsWith("refs/stacked-prs-backup/"));
    assert.ok(!ref.startsWith("refs/heads/"));
    assert.ok(!ref.startsWith("refs/tags/"));
  });
});
