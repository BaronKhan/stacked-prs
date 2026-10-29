// @ts-check
/**
 * git.mjs - thin, deterministic git plumbing.
 *
 * No judgement, no state, no network policy. Every function is a direct
 * translation of one git operation so the caller (and the model reading the
 * output) can always see exactly what ran.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * @param {string[]} args
 * @param {{cwd?: string, allowFail?: boolean, input?: string}} [opts]
 */
export function git(args, opts = {}) {
  const res = spawnSync("git", args, {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0 && !opts.allowFail) {
    const err = new Error(
      `git ${args.join(" ")} failed (${res.status}):\n${res.stderr ?? ""}`
    );
    /** @type {any} */ (err).stdout = res.stdout;
    /** @type {any} */ (err).stderr = res.stderr;
    /** @type {any} */ (err).status = res.status;
    throw err;
  }
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

export function gitOut(args, opts = {}) {
  return git(args, opts).stdout;
}

/** Lines of stdout, empty lines dropped. */
export function gitLines(args, opts = {}) {
  const out = gitOut(args, opts);
  return out ? out.split("\n").filter(Boolean) : [];
}

export function repoRoot(cwd = process.cwd()) {
  return gitOut(["rev-parse", "--show-toplevel"], { cwd });
}

export function currentBranch(cwd = process.cwd()) {
  const b = gitOut(["branch", "--show-current"], { cwd });
  return b || null; // empty when detached
}

export function revParse(ref, cwd = process.cwd()) {
  const r = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
    allowFail: true,
  });
  return r.status === 0 ? r.stdout : null;
}

export function branchExists(name, cwd = process.cwd()) {
  return (
    git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
      cwd,
      allowFail: true,
    }).status === 0
  );
}

export function remoteBranchExists(remote, name, cwd = process.cwd()) {
  return (
    gitOut(["ls-remote", "--heads", remote, name], { cwd }).length > 0
  );
}

export function isClean(cwd = process.cwd()) {
  return gitOut(["status", "--porcelain"], { cwd }).length === 0;
}

export function isRebaseInProgress(cwd = process.cwd()) {
  const gitDir = gitOut(["rev-parse", "--absolute-git-dir"], { cwd });
  return (
    existsSync(`${gitDir}/rebase-merge`) || existsSync(`${gitDir}/rebase-apply`)
  );
}

export function defaultRemote(cwd = process.cwd()) {
  const remotes = gitLines(["remote"], { cwd });
  if (remotes.includes("origin")) return "origin";
  return remotes[0] ?? "origin";
}

export function defaultTrunk(cwd = process.cwd()) {
  const remote = defaultRemote(cwd);
  const head = git(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], { cwd, allowFail: true });
  if (head.status === 0) return head.stdout.slice(remote.length + 1);
  const candidates = ["main", "master"].filter((name) => revParse(name, cwd));
  if (candidates.length === 1) return candidates[0];
  throw new Error("Cannot determine trunk. Set the plan's trunk or pass --trunk explicitly.");
}

/** Enable rerere so conflict resolutions survive repeated cascading rebases. */
export function enableRerere(cwd = process.cwd()) {
  git(["config", "rerere.enabled", "true"], { cwd });
  git(["config", "rerere.autoupdate", "true"], { cwd });
}

export function checkout(ref, cwd = process.cwd()) {
  git(["checkout", ref], { cwd });
}

export function createBranch(name, startPoint, cwd = process.cwd()) {
  git(["checkout", "-b", name, startPoint], { cwd });
}

export function deleteBranch(name, { force = false } = {}, cwd = process.cwd()) {
  git(["branch", force ? "-D" : "-d", name], { cwd, allowFail: true });
}

export function mergeBase(a, b, cwd = process.cwd()) {
  const r = git(["merge-base", a, b], { cwd, allowFail: true });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Changed paths between two refs, with status letters.
 *
 * Rename detection is OFF by default and that is deliberate. `git diff -M`
 * reports a move as a single `R` record naming only the DESTINATION path, so a
 * partition built from it would never assign the source path to any layer -
 * the old file would survive into the top layer and the split would not be
 * lossless. With `--no-renames` every move is a plain delete plus a plain add,
 * which is exactly the vocabulary a path partition needs.
 *
 * @returns {{status:string, path:string, oldPath?:string}[]}
 */
export function diffNameStatus(base, head, cwd = process.cwd(), { detectRenames = false } = {}) {
  const raw = gitOut(
    [
      "diff",
      "--name-status",
      detectRenames ? "--find-renames" : "--no-renames",
      "-z",
      `${base}...${head}`,
    ],
    { cwd }
  );
  if (!raw) return [];
  const parts = raw.split("\0").filter((s) => s.length > 0);
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      out.push({ status: status[0], path: newPath, oldPath });
    } else {
      out.push({ status: status[0], path: parts[i++] });
    }
  }
  return out;
}

/** Per-path insertions/deletions between two refs. @returns {Map<string,{ins:number,del:number}>} */
export function diffNumstat(base, head, cwd = process.cwd()) {
  const lines = gitLines(["diff", "--numstat", `${base}...${head}`], { cwd });
  const map = new Map();
  for (const line of lines) {
    const [ins, del, ...rest] = line.split("\t");
    const p = rest.join("\t");
    map.set(p, {
      ins: ins === "-" ? 0 : Number.parseInt(ins, 10) || 0,
      del: del === "-" ? 0 : Number.parseInt(del, 10) || 0,
    });
  }
  return map;
}

/**
 * Every path tracked at `ref` under one or more prefixes.
 * Accepts an array so a whole set of packages costs one git call, not N.
 */
export function lsTree(ref, prefix, cwd = process.cwd()) {
  const prefixes = Array.isArray(prefix) ? prefix : [prefix];
  if (prefixes.length === 0) return [];
  const out = [];
  for (const chunk of chunked(prefixes, 500)) {
    out.push(...gitLines(["ls-tree", "-r", "--name-only", ref, "--", ...chunk], { cwd }));
  }
  return out;
}

/**
 * Materialise `paths` exactly as they are at `sourceRef` into the working tree
 * and index. Paths absent at `sourceRef` are removed. This is the primitive the
 * whole `split` flow is built on.
 * @param {string} sourceRef
 * @param {string[]} paths
 */
export function materialisePaths(sourceRef, paths, cwd = process.cwd()) {
  if (paths.length === 0) return { restored: 0, removed: 0 };
  // Which of these paths exist at the source ref?
  const existing = new Set(
    gitLines(["ls-tree", "-r", "--name-only", sourceRef, "--", ...paths], {
      cwd,
    })
  );
  const toRestore = paths.filter((p) => existing.has(p));
  const toRemove = paths.filter((p) => !existing.has(p));

  for (const chunk of chunked(toRestore, 500)) {
    git(["checkout", sourceRef, "--", ...chunk], { cwd });
  }
  for (const chunk of chunked(toRemove, 500)) {
    // -r for directories, --ignore-unmatch because a path may already be gone
    git(["rm", "-r", "-q", "--ignore-unmatch", "--", ...chunk], {
      cwd,
      allowFail: true,
    });
  }
  return { restored: toRestore.length, removed: toRemove.length };
}

export function stageAll(cwd = process.cwd()) {
  git(["add", "-A"], { cwd });
}

export function hasStagedChanges(cwd = process.cwd()) {
  return git(["diff", "--cached", "--quiet"], { cwd, allowFail: true }).status !== 0;
}

/**
 * Commit. Hooks are always run - never `--no-verify`.
 * @param {string} message
 */
export function commit(message, cwd = process.cwd()) {
  git(["commit", "-q", "-F", "-"], { cwd, input: message });
  return revParse("HEAD", cwd);
}

/** True when `base` is fully contained in `head`. */
export function isAncestor(base, head, cwd = process.cwd()) {
  return (
    git(["merge-base", "--is-ancestor", base, head], {
      cwd,
      allowFail: true,
    }).status === 0
  );
}

/** True when the two trees are identical. The `split` completeness gate. */
export function treesIdentical(a, b, cwd = process.cwd()) {
  return (
    git(["diff", "--quiet", `${a}`, `${b}`], { cwd, allowFail: true })
      .status === 0
  );
}

/** Paths that differ between two refs - used to explain a failed gate. */
export function treeDelta(a, b, cwd = process.cwd()) {
  return gitLines(["diff", "--name-only", a, b], { cwd });
}

export function fetch(remote, cwd = process.cwd()) {
  git(["fetch", "--prune", remote], { cwd });
}

/**
 * Rebase `branch` onto `newBase`. When `oldBase` is supplied uses `--onto`,
 * which is what makes replay correct after the layer below was squash-merged.
 * @returns {{ok:true}|{ok:false, conflicts:string[]}}
 */
export function rebaseOnto(branch, newBase, oldBase, cwd = process.cwd()) {
  checkout(branch, cwd);
  const args = oldBase
    ? ["rebase", "--onto", newBase, oldBase, branch]
    : ["rebase", newBase, branch];
  const res = git(args, { cwd, allowFail: true });
  if (res.status === 0) return { ok: true };
  const conflicts = gitLines(["diff", "--name-only", "--diff-filter=U"], {
    cwd,
    allowFail: true,
  });
  return { ok: false, conflicts };
}

export function rebaseContinue(cwd = process.cwd()) {
  const res = git(["rebase", "--continue"], {
    cwd,
    allowFail: true,
    input: "",
  });
  return res.status === 0;
}

export function rebaseAbort(cwd = process.cwd()) {
  git(["rebase", "--abort"], { cwd, allowFail: true });
}

/** Pin a sha so `--abort` survives `git gc`. Local-only ref, never pushed. */
export function writeRef(ref, sha, cwd = process.cwd()) {
  git(["update-ref", ref, sha], { cwd });
}

export function deleteRef(ref, cwd = process.cwd()) {
  git(["update-ref", "-d", ref], { cwd, allowFail: true });
}

export function resetHard(ref, cwd = process.cwd()) {
  git(["reset", "--hard", ref], { cwd });
}

/**
 * Push branches.
 *
 * Always `--force-with-lease`, never `--force`.
 *
 * `--atomic` is preferred so a stack is never left half-pushed, but Azure
 * DevOps does not implement the atomic push capability and hangs up with
 * "the receiving end does not support --atomic push". We therefore try atomic
 * first and fall back to an ordinary multi-ref push, which git still sends as
 * a single request - it just will not roll the whole thing back if one ref is
 * rejected.
 *
 * @param {string[]} branches
 */
export function capturePushLeases(remote, branches, cwd = process.cwd(), knownTips = {}) {
  const expected = Object.fromEntries(branches.map((branch) => [branch, null]));
  if (branches.length === 0) return expected;
  const refs = branches.map((branch) => `refs/heads/${branch}`);
  const lines = gitLines(["ls-remote", "--heads", "--", remote, ...refs], { cwd });
  for (const line of lines) {
    const [sha, ref] = line.split("\t");
    const branch = ref?.replace(/^refs\/heads\//, "");
    if (!Object.hasOwn(expected, branch)) continue;
    if (!isAncestor(sha, branch, cwd) && !(knownTips[branch] && isAncestor(sha, knownTips[branch], cwd))) {
      throw new Error(`Remote branch ${branch} has changes not incorporated locally. Reconcile them before rewriting or pushing the stack.`);
    }
    expected[branch] = sha;
  }
  return expected;
}

export function pushBranches(remote, branches, cwd = process.cwd(), expectedTips) {
  if (branches.length === 0) return { status: 0, stdout: "", stderr: "" };
  const expected = expectedTips ?? capturePushLeases(remote, branches, cwd);
  const leases = branches.map((branch) => {
    if (!Object.hasOwn(expected, branch)) throw new Error(`Missing push lease for ${branch}.`);
    return `--force-with-lease=refs/heads/${branch}:${expected[branch] ?? ""}`;
  });
  const refspecs = branches.map((b) => `${b}:${b}`);
  const base = ["push", ...leases, "--set-upstream", remote];

  const atomic = git(["push", ...leases, "--atomic", "--set-upstream", remote, ...refspecs], {
    cwd,
    allowFail: true,
  });
  if (atomic.status === 0) return atomic;
  if (!/does not support --atomic/i.test(atomic.stderr)) return atomic;

  return git([...base, ...refspecs], { cwd, allowFail: true });
}

function* chunked(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

export { chunked, execFileSync };
