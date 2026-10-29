#!/usr/bin/env node
// @ts-check
/**
 * stack.mjs - Stacked PRs across hosting providers.
 *
 * Mirrors the `gh stack` command surface so the muscle memory transfers, but
 * every command here is deterministic: it reads state, prints facts, and
 * mutates only what it was asked to. All judgement - whether to split, where the
 * seams go, what to call things - belongs to the model driving this script.
 *
 * Inspired by https://github.github.com/gh-stack/
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createHosting } from "./lib/hosting.mjs";
import { analyze } from "./lib/analyze.mjs";
import { applyPlan } from "./lib/apply.mjs";
import * as git from "./lib/git.mjs";
import {
  branchNameFor,
  userPrefixFrom,
  validatePlan,
} from "./lib/plan.mjs";
import {
  applyFooter,
  renderFooter,
  renderJournalWarning,
  renderPlan,
  renderStack,
} from "./lib/render.mjs";
import * as state from "./lib/state.mjs";
const hosting = createHosting();

const EXIT = {
  OK: 0,
  GENERIC: 1,
  NO_STACK: 2,
  CONFLICT: 3,
  API: 4,
  ARGS: 5,
  AMBIGUOUS: 6,
  REBASE_IN_PROGRESS: 7,
  LOCKED: 8,
  UNAVAILABLE: 9,
};

/* --------------------------------------------------------------- arg parsing */

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("-")) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      out.flags[a.slice(1)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function emit(obj, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  }
  return obj;
}

function fail(message, code = EXIT.GENERIC) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/* ------------------------------------------------------------ stack helpers */

function root() {
  return git.repoRoot();
}

/** Resolve the stack we should be operating on. */
function resolveStack(st, { required = true } = {}) {
  const branch = git.currentBranch();
  if (branch) {
    const matches = state.stacksContaining(st, branch);
    if (matches.length > 1) {
      fail(
        `Branch "${branch}" belongs to ${matches.length} stacks (${matches
          .map((s) => s.id)
          .join(", ")}). Pass --stack <id>.`,
        EXIT.AMBIGUOUS
      );
    }
    if (matches.length === 1) return matches[0];
  }
  const active = state.activeStack(st);
  if (active) return active;
  if (required) {
    fail(
      "Not in a stack. Run `split` to break a branch into one, or `checkout <pr-id>` to recover an ancestor chain from the hosting provider.",
      EXIT.NO_STACK
    );
  }
  return null;
}

function warnAboutJournals() {
  for (const j of state.pendingJournals()) {
    process.stderr.write(renderJournalWarning(j));
  }
}

/** Refresh cached PR facts from the hosting provider. */
function refreshPrState(stack) {
  hosting.assertRepository(stack);
  for (const b of stack.branches) {
    const pr = b.prId ? hosting.getPr(b.prId) : hosting.findPrForBranch(b.name);
    if (!pr) {
      b.state = b.state === "merged" ? "merged" : "unsubmitted";
      continue;
    }
    b.prId = pr.pullRequestId;
    b.prStatus = pr.status;
    b.isDraft = Boolean(pr.isDraft);
    b.targetRefName = pr.targetRefName;
    b.state =
      pr.status === "completed"
        ? "merged"
        : pr.status === "abandoned"
          ? "abandoned"
          : "open";
  }
  return stack;
}

/* ------------------------------------------------------------------ commands */

/**
 * Resolve the comparison base. Prefers the remote-tracking ref (what the PR
 * will actually be diffed against) but falls back to the local branch when
 * there is no remote - which is the case in tests and in fresh clones.
 */
function resolveBase(explicit, trunk) {
  if (explicit) return explicit;
  const remote = git.defaultRemote();
  for (const candidate of [`${remote}/${trunk}`, `refs/remotes/${remote}/${trunk}`, trunk]) {
    if (git.revParse(candidate)) return candidate;
  }
  return trunk;
}

const commands = {};
commands.backend = () => emit(hosting.backendInfo(), true);

commands.analyze = (args) => {
  const trunk = args.flags.trunk ?? git.defaultTrunk();
  const base = resolveBase(args.flags.base, trunk);
  const head = args.flags.head ?? git.currentBranch() ?? "HEAD";
  const result = analyze({ base, head });
  emit(result, true);
};

commands.status = (args) => {
  const st = state.loadState();
  const stack = resolveStack(st, { required: false });
  const branch = git.currentBranch();
  const payload = {
    branch,
    inStack: Boolean(stack),
    stack: stack ?? null,
    pendingOperations: state.pendingJournals(),
    stateDir: state.stateDir(),
    stateIsMachineLocal: true,
  };
  if (args.flags.json || true) emit(payload, true);
};

commands.view = (args) => {
  warnAboutJournals();
  const st = state.loadState();
  const stack = resolveStack(st);
  if (args.flags.refresh) {
    refreshPrState(stack);
    state.withLock("view --refresh", () => {
      const cur = state.loadState();
      state.upsertStack(cur, stack);
      state.saveState(cur);
    });
  }
  if (args.flags.json) return emit(stack, true);
  process.stdout.write(
    renderStack(stack, {
      current: git.currentBranch(),
      short: Boolean(args.flags.short || args.flags.s),
    })
  );
  return undefined;
};

commands.split = (args) => {
  const planFile = args.flags.plan;
  if (!planFile) {
    fail(
      "split requires --plan <file.json>. Run `analyze --json` first, propose layers, then pass them here.",
      EXIT.ARGS
    );
  }
  /** @type {import("./lib/plan.mjs").Plan} */
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const sourceBranch = plan.sourceBranch ?? git.currentBranch();
  const trunk = plan.trunk ?? git.defaultTrunk();
  plan.sourceBranch = sourceBranch;
  plan.trunk = trunk;

  const base = resolveBase(args.flags.base, trunk);
  const analysis = analyze({ base, head: sourceBranch });
  const validation = validatePlan(plan, analysis);

  if (args.flags["dry-run"] || args.flags.check) {
    emit({ plan, validation, analysis: analysis.totals }, true);
    if (!validation.ok) process.exitCode = EXIT.ARGS;
    return;
  }
  if (!validation.ok) {
    process.stderr.write(
      `Plan is invalid:\n${validation.errors.map((e) => `  • ${e}`).join("\n")}\n`
    );
    process.exit(EXIT.ARGS);
  }

  process.stdout.write(renderPlan(plan, validation.stats));
  for (const w of validation.warnings) process.stderr.write(`  ⚠️  ${w}\n`);

  if (!args.flags.yes) {
    fail(
      "Refusing to create branches without confirmation. Re-run with --yes once the user has approved the plan above.",
      EXIT.ARGS
    );
  }

  const userPrefix = userPrefixFrom(sourceBranch);
  const release = state.acquireLock("split");
  try {
    const { created } = applyPlan(plan, {
      root: root(),
      userPrefix,
      onProgress: (m) => process.stderr.write(`  ${m}\n`),
    });

    const st = state.loadState();
    const id = state.nextStackId(st);
    /** @type {import("./lib/state.mjs").Stack} */
    const stack = {
      id,
      title: plan.title ?? plan.topic,
      topic: plan.topic,
      trunk,
      remote: git.defaultRemote(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceBranch,
      branches: created.map((c, i) => ({
        name: c.branch,
        parent: c.parent,
        prId: null,
        state: "unsubmitted",
        // Carried so `submit` opens each PR with the title and body the user
        // approved, instead of inventing one from the branch name.
        title: plan.layers[i].title,
        description: plan.layers[i].description ?? "",
      })),
    };
    // A previous run of `split` that was rolled back, or replaced, can leave a
    // stack tracking these same branch names. Two stacks naming one branch
    // makes every later command ambiguous (exit 6), so the superseded one is
    // dropped here rather than left for the user to discover.
    const newNames = new Set(stack.branches.map((b) => b.name));
    for (const [otherId, other] of Object.entries(st.stacks)) {
      if (otherId === id) continue;
      if (other.branches.every((b) => newNames.has(b.name))) {
        for (const b of other.branches) {
          git.deleteRef(state.backupRefName(otherId, b.name));
        }
        state.clearJournal(otherId);
        delete st.stacks[otherId];
        process.stderr.write(
          `  Replaced superseded stack ${otherId}, which tracked the same branches.\n`
        );
      }
    }

    state.upsertStack(st, stack);
    st.activeStackId = id;
    state.saveState(st);

    process.stdout.write(
      `\n✅ Created ${created.length} branches. Verified lossless against ${sourceBranch}.\n`
    );
    process.stdout.write(renderStack(stack, { current: git.currentBranch() }));
    process.stdout.write(`Next: \`stack.mjs submit\` to push and open the PRs.\n`);
  } finally {
    release();
  }
  return undefined;
};

commands.submit = (args) => {
  const st = state.loadState();
  const stack = resolveStack(st);
  hosting.assertBranchEngine(stack);
  const backend = hosting.backendInfo();
  if (backend.engine === "gh-stack" && !stack.branches.some(branch => branch.prId)) {
    fail("Use the native gh stack workflow for this repository. Adopt the approved branches with gh stack init, verify them, remove only this helper's local tracking, and submit with gh stack submit --auto.", EXIT.UNAVAILABLE);
  }
  if (!hosting.isAuthenticated()) {
    fail("Not authenticated to the hosting provider. Check the provider CLI login.", EXIT.API);
  }

  const asDraft = !args.flags.open;
  const branches = stack.branches.filter((b) => b.state !== "merged");

  process.stdout.write(renderStack(stack, { current: git.currentBranch() }));
  if (!args.flags.yes) {
    fail(
      `Refusing to push ${branches.length} branches and open PRs without confirmation. Re-run with --yes.`,
      EXIT.ARGS
    );
  }

  const push = git.pushBranches(stack.remote, branches.map((b) => b.name));
  if (push.status !== 0) {
    fail(`Push failed:\n${push.stderr}`, EXIT.GENERIC);
  }

  for (const b of branches) {
    const existing = b.prId ? hosting.getPr(b.prId) : hosting.findPrForBranch(b.name);
    if (existing) {
      b.prId = existing.pullRequestId;
      hosting.updatePr(b.prId, { targetBranch: b.parent, ...(args.flags.open ? { isDraft: false } : {}) });
    } else {
      const pr = hosting.createPr({
        sourceBranch: b.name,
        targetBranch: b.parent,
        title: b.title ?? b.name.split("/").pop(),
        description: b.description || "Description is being populated.",
        draft: asDraft,
      });
      if (!pr) fail(`Failed to create a PR for ${b.name}.`, EXIT.API);
      b.prId = pr.pullRequestId;
    }
    b.state = "open";
    b.isDraft = args.flags.open ? false : (existing?.isDraft ?? asDraft);
  }

  // Second pass: now that every PR id is known, write the footers.
  for (const b of branches) {
    const pr = hosting.getPr(b.prId);
    const body = pr?.description?.trim() ? pr.description : (b.description ?? "");
    const footer = renderFooter(stack, b.name, (id) => hosting.prWebUrl(id));
    hosting.updatePr(b.prId, { description: applyFooter(body, footer) });
  }

  state.withLock("submit", () => {
    const cur = state.loadState();
    state.upsertStack(cur, stack);
    state.saveState(cur);
  });

  process.stdout.write(renderStack(stack, { current: git.currentBranch() }));
  for (const b of branches) {
    process.stdout.write(`  ${b.name} → ${hosting.prWebUrl(b.prId)}\n`);
  }
  return undefined;
};

commands.sync = (args) => {
  const st = state.loadState();
  const stack = resolveStack(st);
  hosting.assertBranchEngine(stack);
  const cwd = root();

  git.fetch(stack.remote, cwd);
  refreshPrState(stack);
  const live = stack.branches.filter((b) => b.state !== "merged");
  const previousJournal = state.readJournal(stack.id);
  const expectedTips = git.capturePushLeases(
    stack.remote, live.map((b) => b.name), cwd, previousJournal?.backupRefs ?? {}
  );

  // A merged layer means the ones above it should retarget past it.
  //
  // The comparison is against the SERVER's targetRefName, not our local
  // `parent`. Local state is a cache: if a previous sync updated it but the
  // remote call failed, comparing locally would conclude there is nothing to do
  // and leave the stack permanently mis-chained on the server while looking correct
  // here. The server is the source of truth for PR state.
  let newParent = stack.trunk;
  let retargeted = 0;
  for (const b of stack.branches) {
    if (b.state === "merged") continue;
    const serverTarget = (b.targetRefName ?? "").replace(/^refs\/heads\//, "");
    if (b.prId && serverTarget && serverTarget !== newParent) {
      hosting.updatePr(b.prId, { targetBranch: newParent });
      b.targetRefName = `refs/heads/${newParent}`;
      retargeted++;
    }
    b.parent = newParent;
    newParent = b.name;
  }

  const backupRefs = { ...(previousJournal?.backupRefs ?? {}) };
  for (const b of live) {
    const sha = backupRefs[b.name] ?? git.revParse(b.name, cwd);
    if (sha) {
      backupRefs[b.name] = sha;
      git.writeRef(state.backupRefName(stack.id, b.name), sha, cwd);
    }
  }

  const journal = state.beginJournal(
    "sync",
    stack.id,
    backupRefs,
    live.map((b) => b.name)
  );
  journal.meta = { expectedRemoteTips: expectedTips };
  state.writeJournal(journal);

  let conflicted = null;
  for (const b of live) {
    const res = git.rebaseOnto(b.name, b.parent, undefined, cwd);
    const step = journal.steps.find((s) => s.branch === b.name);
    if (res.ok) {
      step.status = "done";
    } else {
      step.status = "conflict";
      conflicted = { branch: b.name, files: res.conflicts };
      state.writeJournal(journal);
      break;
    }
    state.writeJournal(journal);
  }

  if (conflicted) {
    process.stderr.write(
      `\n❌ Rebase conflict on ${conflicted.branch}:\n${conflicted.files
        .map((f) => `    ${f}`)
        .join("\n")}\n\nResolve, \`git add\` them, then run \`rebase --continue\`, or \`rebase --abort\` to restore everything.\n`
    );
    process.exit(EXIT.CONFLICT);
  }

  // sync pushes without a second prompt: pushing is inherent to sync, and the
  // CLI's own tool-approval layer already gates the underlying command.
  const push = git.pushBranches(stack.remote, live.map((b) => b.name), cwd, expectedTips);
  if (push.status !== 0) {
    fail(`Push failed:\n${push.stderr}`, EXIT.GENERIC);
  }
  state.clearJournal(stack.id);
  for (const b of live) git.deleteRef(state.backupRefName(stack.id, b.name), cwd);

  for (const b of live) {
    if (!b.prId) continue;
    const pr = hosting.getPr(b.prId);
    const footer = renderFooter(stack, b.name, (id) => hosting.prWebUrl(id));
    hosting.updatePr(b.prId, {
      description: applyFooter(pr?.description ?? "", footer),
    });
  }

  if (args.flags.prune) {
    for (const b of stack.branches.filter((x) => x.state === "merged")) {
      git.deleteBranch(b.name, { force: true }, cwd);
    }
  }

  state.withLock("sync", () => {
    const cur = state.loadState();
    state.upsertStack(cur, stack);
    state.saveState(cur);
  });

  process.stdout.write(
    `\nSynced. ${retargeted} PR(s) retargeted, ${live.length} branch(es) rebased and pushed.\n`
  );
  process.stdout.write(renderStack(stack, { current: git.currentBranch() }));
  return undefined;
};

commands.rebase = (args) => {
  const st = state.loadState();
  const stack = resolveStack(st);
  const cwd = root();
  const journal = state.readJournal(stack.id);

  if (args.flags.abort) {
    git.rebaseAbort(cwd);
    if (journal) {
      for (const [branch, sha] of Object.entries(journal.backupRefs)) {
        git.checkout(branch, cwd);
        git.resetHard(sha, cwd);
        git.deleteRef(state.backupRefName(stack.id, branch), cwd);
      }
      state.clearJournal(stack.id);
    }
    process.stdout.write("Rebase aborted; every branch restored.\n");
    return undefined;
  }

  if (args.flags.continue) {
    if (!journal) fail("No interrupted rebase to continue.", EXIT.NO_STACK);
    if (!git.rebaseContinue(cwd)) {
      fail("Conflicts remain. Resolve them, `git add`, then retry.", EXIT.CONFLICT);
    }
    const step = journal.steps.find((s) => s.status === "conflict");
    if (step) step.status = "done";
    state.writeJournal(journal);
    process.stdout.write("Continuing…\n");
  }

  return commands.sync(args);
};

commands.push = () => {
  const st = state.loadState();
  const stack = resolveStack(st);
  hosting.assertBranchEngine(stack);
  const live = stack.branches.filter((b) => b.state !== "merged");
  const res = git.pushBranches(stack.remote, live.map((b) => b.name));
  if (res.status !== 0) fail(`Push failed:\n${res.stderr}`, EXIT.GENERIC);
  process.stdout.write(`Pushed ${live.length} branches.\n`);
  return undefined;
};

commands.checkout = (args) => {
  const target = args._[0];
  if (!target) fail("checkout needs a PR id or a branch name.", EXIT.ARGS);
  const trunk = args.flags.trunk ?? git.defaultTrunk();

  if (/^\d+$/.test(target)) {
    const chain = hosting.reconstructStack(Number(target), trunk);
    if (chain.length === 0) fail(`No PR chain found for !${target}.`, EXIT.API);
    const st = state.loadState();
    const id = state.nextStackId(st);
    const remote = git.defaultRemote();
    git.fetch(remote);
    for (const link of chain) {
      if (!git.branchExists(link.branch)) {
        git.git(["branch", link.branch, `${remote}/${link.branch}`], {
          allowFail: true,
        });
      }
    }
    /** @type {import("./lib/state.mjs").Stack} */
    const stack = {
      id,
      title: chain[0].title,
      topic: chain[0].branch.split("/").pop().split(".")[0],
      trunk,
      remote,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceBranch: null,
      branches: chain.map((link) => ({
        name: link.branch,
        parent: link.target,
        prId: link.prId,
        isDraft: link.isDraft,
        state: link.status === "completed" ? "merged" : "open",
      })),
    };
    hosting.assertRepository(stack);
    state.upsertStack(st, stack);
    st.activeStackId = id;
    state.saveState(st);
    git.checkout(chain[chain.length - 1].branch);
    process.stdout.write(renderStack(stack, { current: git.currentBranch() }));
    return undefined;
  }

  const st = state.loadState();
  const matches = state.stacksContaining(st, target);
  if (matches.length === 0) fail(`"${target}" is not in a tracked stack.`, EXIT.NO_STACK);
  if (matches.length > 1) fail(`"${target}" is in several stacks.`, EXIT.AMBIGUOUS);
  git.checkout(target);
  st.activeStackId = matches[0].id;
  state.saveState(st);
  process.stdout.write(renderStack(matches[0], { current: target }));
  return undefined;
};

/* ------------------------------------------------------------- navigation */

function navigate(delta, absolute) {
  const st = state.loadState();
  const stack = resolveStack(st);
  const current = git.currentBranch();
  const names = stack.branches.map((b) => b.name);
  let idx = names.indexOf(current);
  if (idx === -1) idx = absolute === "top" ? names.length - 1 : 0;

  let next;
  if (absolute === "top") next = names[names.length - 1];
  else if (absolute === "bottom") next = names[0];
  else if (absolute === "trunk") next = stack.trunk;
  else next = names[Math.min(names.length - 1, Math.max(0, idx + delta))];

  if (next === current) {
    process.stdout.write(`Already at ${current}.\n`);
    return;
  }
  git.checkout(next);
  process.stdout.write(renderStack(stack, { current: next }));
}

commands.up = (a) => navigate(Number(a._[0] ?? 1));
commands.down = (a) => navigate(-Number(a._[0] ?? 1));
commands.top = () => navigate(0, "top");
commands.bottom = () => navigate(0, "bottom");
commands.trunk = () => navigate(0, "trunk");

commands.unstack = (args) => {
  const st = state.loadState();
  const stack = resolveStack(st);
  if (!args.flags.yes) {
    process.stdout.write(renderStack(stack, { current: git.currentBranch() }));
    fail("Re-run with --yes to remove this stack from local tracking.", EXIT.ARGS);
  }
  if (!args.flags.local) {
    hosting.assertRepository(stack);
    for (const b of stack.branches.filter((x) => x.prId && x.state === "open")) {
      const pr = hosting.getPr(b.prId);
      hosting.updatePr(b.prId, {
        description: applyFooter(pr?.description ?? "", null),
      });
    }
  }
  for (const b of stack.branches) {
    git.deleteRef(state.backupRefName(stack.id, b.name));
  }
  delete st.stacks[stack.id];
  if (st.activeStackId === stack.id) st.activeStackId = null;
  state.clearJournal(stack.id);
  state.saveState(st);
  process.stdout.write(`Stack ${stack.id} removed from local tracking.\n`);
  return undefined;
};

commands.doctor = (args) => {
  const st = state.loadState();
  const problems = [];
  /** @type {string[]} */
  const dead = [];

  for (const stack of Object.values(st.stacks)) {
    const missing = stack.branches.filter((b) => !git.branchExists(b.name));
    for (const b of missing) {
      problems.push(`Stack ${stack.id}: local branch missing - ${b.name}`);
    }
    // A stack whose branches have all been deleted is a leftover: it makes
    // every later command ambiguous without doing any good.
    if (missing.length === stack.branches.length && stack.branches.length > 0) {
      dead.push(stack.id);
    }
    for (let i = 1; i < stack.branches.length; i++) {
      if (stack.branches[i].parent !== stack.branches[i - 1].name) {
        problems.push(
          `Stack ${stack.id}: layer ${i + 1} (${stack.branches[i].name}) has parent "${stack.branches[i].parent}" but the layer below is "${stack.branches[i - 1].name}". Run \`sync\`.`
        );
      }
    }
  }

  let pruned = [];
  if (args?.flags?.prune && dead.length > 0) {
    state.withLock("doctor --prune", () => {
      const cur = state.loadState();
      for (const id of dead) {
        for (const b of cur.stacks[id]?.branches ?? []) {
          git.deleteRef(state.backupRefName(id, b.name));
        }
        delete cur.stacks[id];
        state.clearJournal(id);
        if (cur.activeStackId === id) cur.activeStackId = null;
      }
      state.saveState(cur);
    });
    pruned = dead;
  }

  emit(
    {
      stateDir: state.stateDir(),
      stacks: Object.keys(state.loadState().stacks).length,
      pendingOperations: state.pendingJournals(),
      problems,
      prunable: dead,
      pruned,
      healthy: problems.length === 0,
      hint:
        dead.length > 0 && pruned.length === 0
          ? "Stacks whose branches have all been deleted make later commands ambiguous. Run `doctor --prune` to forget them."
          : undefined,
    },
    true
  );
  return undefined;
};

commands.check = commands.doctor;

commands.help = () => {
  process.stdout.write(`
stack.mjs - Stacked PRs across hosting providers

  Analysis            analyze --base <ref> [--head <ref>]
                      backend
                      status
                      check | doctor

  Split a mega-branch split --plan <file.json> [--dry-run] [--yes]

  Stack management    view [--short] [--json] [--refresh]
                      checkout <pr-id | branch>
                      unstack [--local] --yes

  Remote              submit [--open] --yes
                      sync [--prune]
                      rebase [--continue | --abort]
                      push

  Navigation          up [n] · down [n] · top · bottom · trunk

State lives in .git/stacked-prs/ - machine-local, never committed, never synced.
Inspired by GitHub Stacked PRs: https://github.github.com/gh-stack/
`);
};

/* ---------------------------------------------------------------------- main */

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._.shift() ?? "help";
  const fn = commands[cmd];
  if (!fn) {
    fail(`Unknown command "${cmd}". Run \`help\`.`, EXIT.ARGS);
  }
  try {
    fn(args);
  } catch (err) {
    const code = /** @type {any} */ (err)?.exitCode ?? EXIT.GENERIC;
    fail(/** @type {any} */ (err)?.message ?? String(err), code);
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main();
}

export { commands, parseArgs, EXIT };
