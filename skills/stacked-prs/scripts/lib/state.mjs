// @ts-check
/**
 * state.mjs - machine-local stack state store.
 *
 * Everything lives under `.git/stacked-prs/`. `.git/` is the repository's private
 * control directory and is NOT part of the working tree, so it is structurally
 * impossible for git to track, stage, commit or push anything written here.
 * State is therefore per-clone, never synced, and lost when you move machines -
 * exactly the lifetime of a Copilot CLI session.
 *
 * Zero judgement. Pure storage, locking and journalling.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_VERSION = 1;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
const BACKUP_REF_PREFIX = "refs/stacked-prs-backup";

/**
 * @typedef {"open"|"merged"|"abandoned"|"unsubmitted"} BranchState
 *
 * @typedef {object} StackBranch
 * @property {string} name
 * @property {string} parent
 * @property {number|null} [prId]
 * @property {string|null} [prStatus]
 * @property {boolean} [isDraft]
 * @property {string|null} [targetRefName]
 * @property {string|null} [lastSubmittedSha]
 * @property {BranchState} state
 *
 * @typedef {object} Stack
 * @property {string} id
 * @property {string} title
 * @property {string} topic
 * @property {string} trunk
 * @property {string} remote
 * @property {"github"|"gitlab"|"azure-devops"} [provider]
 * @property {string} [repository]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string|null} [sourceBranch]
 * @property {StackBranch[]} branches
 *
 * @typedef {object} StateFile
 * @property {number} version
 * @property {string|null} activeStackId
 * @property {Record<string, Stack>} stacks
 */

/** Resolve `.git` for this working tree (handles worktrees, where it is a file). */
export function resolveGitDir(cwd = process.cwd()) {
  const out = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd,
    encoding: "utf8",
  });
  return out.trim();
}

export function stateDir(cwd = process.cwd()) {
  return path.join(resolveGitDir(cwd), "stacked-prs");
}

export function statePaths(cwd = process.cwd()) {
  const dir = stateDir(cwd);
  return {
    dir,
    file: path.join(dir, "stacks.json"),
    backup: path.join(dir, "stacks.json.bak"),
    lock: path.join(dir, "stack.lock"),
    journalDir: path.join(dir, "journal"),
  };
}

/** @returns {StateFile} */
export function emptyState() {
  return { version: STATE_VERSION, activeStackId: null, stacks: {} };
}

/**
 * Load state. Falls back to `.bak` if the primary file is corrupt, and to an
 * empty state if neither is usable - losing this state is always recoverable
 * via `checkout <pr-id>`, so we never hard-fail a read.
 * @returns {StateFile}
 */
export function loadState(cwd = process.cwd()) {
  const p = statePaths(cwd);
  for (const candidate of [p.file, p.backup]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.stacks) {
        if (parsed.version !== STATE_VERSION) {
          parsed.version = STATE_VERSION;
        }
        return /** @type {StateFile} */ (parsed);
      }
    } catch {
      // fall through to the next candidate
    }
  }
  return emptyState();
}

/**
 * Atomically persist state: write a temp file in the same directory, fsync it,
 * rotate the previous good copy to `.bak`, then rename into place. A crash can
 * therefore never leave a partially-written `stacks.json`.
 * @param {StateFile} state
 */
export function saveState(state, cwd = process.cwd()) {
  const p = statePaths(cwd);
  fs.mkdirSync(p.dir, { recursive: true });
  state.version = STATE_VERSION;
  const tmp = path.join(p.dir, `.stacks.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(p.file)) {
    try {
      fs.copyFileSync(p.file, p.backup);
    } catch {
      // a missing backup is not fatal
    }
  }
  fs.renameSync(tmp, p.file);
  return p.file;
}

/* ------------------------------------------------------------------ locking */

class LockedError extends Error {
  constructor(/** @type {any} */ holder) {
    super(
      `Stack is locked by pid ${holder?.pid ?? "?"} running "${
        holder?.command ?? "?"
      }" since ${holder?.startedAt ?? "?"}`
    );
    this.name = "LockedError";
    this.exitCode = 8;
    this.holder = holder;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === "EPERM";
  }
}

/**
 * Acquire the advisory lock. Exclusive create (`wx`) makes this race-free.
 * A lock whose owner is dead, or that is older than 2h, is broken automatically.
 * @param {string} command
 * @returns {() => void} release
 */
export function acquireLock(command, cwd = process.cwd()) {
  const p = statePaths(cwd);
  fs.mkdirSync(p.dir, { recursive: true });
  const payload = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    command,
  };

  const tryWrite = () => {
    const fd = fs.openSync(p.lock, "wx");
    fs.writeSync(fd, JSON.stringify(payload, null, 2));
    fs.closeSync(fd);
  };

  try {
    tryWrite();
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== "EEXIST") throw err;
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(p.lock, "utf8"));
    } catch {
      holder = null;
    }
    const age = holder?.startedAt
      ? Date.now() - Date.parse(holder.startedAt)
      : Number.POSITIVE_INFINITY;
    const sameHost = holder?.host === os.hostname();
    const stale =
      !holder ||
      Number.isNaN(age) ||
      age > LOCK_STALE_MS ||
      (sameHost && !pidAlive(holder.pid));
    if (!stale) throw new LockedError(holder);
    fs.rmSync(p.lock, { force: true });
    tryWrite();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(fs.readFileSync(p.lock, "utf8"));
      if (current.pid !== process.pid) return; // someone broke our stale lock
    } catch {
      return;
    }
    fs.rmSync(p.lock, { force: true });
  };
}

/** Run `fn` while holding the lock. */
export function withLock(command, fn, cwd = process.cwd()) {
  const release = acquireLock(command, cwd);
  try {
    return fn();
  } finally {
    release();
  }
}

/* ---------------------------------------------------------------- journal */

/**
 * @typedef {object} Journal
 * @property {string} op
 * @property {string} stackId
 * @property {string} startedAt
 * @property {Record<string,string>} backupRefs
 * @property {{branch:string,status:"pending"|"done"|"conflict"}[]} steps
 * @property {Record<string, unknown>} [meta]
 */

function journalPath(stackId, cwd = process.cwd()) {
  return path.join(statePaths(cwd).journalDir, `${stackId}.json`);
}

/**
 * @param {string} op
 * @param {string} stackId
 * @param {Record<string,string>} backupRefs branch -> sha before the operation
 * @param {string[]} branches
 * @returns {Journal}
 */
export function beginJournal(
  op,
  stackId,
  backupRefs,
  branches,
  cwd = process.cwd()
) {
  const dir = statePaths(cwd).journalDir;
  fs.mkdirSync(dir, { recursive: true });
  /** @type {Journal} */
  const journal = {
    op,
    stackId,
    startedAt: new Date().toISOString(),
    backupRefs,
    steps: branches.map((branch) => ({ branch, status: "pending" })),
  };
  writeJournal(journal, cwd);
  return journal;
}

/** @param {Journal} journal */
export function writeJournal(journal, cwd = process.cwd()) {
  const file = journalPath(journal.stackId, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** @returns {Journal|null} */
export function readJournal(stackId, cwd = process.cwd()) {
  const file = journalPath(stackId, cwd);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function clearJournal(stackId, cwd = process.cwd()) {
  fs.rmSync(journalPath(stackId, cwd), { force: true });
}

/** Every unfinished operation across all stacks. @returns {Journal[]} */
export function pendingJournals(cwd = process.cwd()) {
  const dir = statePaths(cwd).journalDir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* -------------------------------------------------------------- accessors */

/** @param {StateFile} state @returns {Stack|null} */
export function activeStack(state) {
  if (!state.activeStackId) return null;
  return state.stacks[state.activeStackId] ?? null;
}

/**
 * Find the stack containing `branch`.
 * @param {StateFile} state
 * @param {string} branch
 * @returns {Stack[]} every stack that contains it (>1 means disambiguation, exit 6)
 */
export function stacksContaining(state, branch) {
  return Object.values(state.stacks).filter((s) =>
    s.branches.some((b) => b.name === branch)
  );
}

/** @param {StateFile} state */
export function nextStackId(state) {
  const ids = Object.keys(state.stacks)
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  return String((ids.length ? Math.max(...ids) : 0) + 1);
}

/**
 * @param {StateFile} state
 * @param {Stack} stack
 */
export function upsertStack(state, stack) {
  stack.updatedAt = new Date().toISOString();
  state.stacks[stack.id] = stack;
  return state;
}

export function backupRefName(stackId, branch) {
  return `${BACKUP_REF_PREFIX}/${stackId}/${branch}`;
}

export { BACKUP_REF_PREFIX, LockedError };
