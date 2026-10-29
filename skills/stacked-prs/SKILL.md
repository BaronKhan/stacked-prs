---
name: stacked-prs
description: Split an existing large branch into reviewable dependent PRs on GitHub, Azure DevOps or GitLab. Propose coherent layers, verify lossless path partitioning, prefer native gh stack when available, otherwise create chained draft PRs or merge requests. Use for "stacked PRs", "split my branch", "this PR is too big", "show my stack", "sync my stack", or landing a large change incrementally.
license: MIT
metadata:
  author: Baron Khan
  version: 1.0.0
---

# Stacked PRs

Split an existing large branch into smaller PRs that target each other.
Propose the split around the dependencies and confirm the plan with the user.
The helper creates the branches and checks that the top layer matches the
original source. Use native GitHub stacks or the provider adapters to create
the PRs and manage the stack.

## Resolve the helper

Use `scripts/stack.mjs` relative to this loaded skill's base directory. Resolve
its absolute path and invoke it with Node from the target repository, not from
the skill directory. Below, `HELPER` means that absolute path.

Run `node HELPER help` to see implemented commands. Outside a Git repository,
explain that repository operations require a checkout. Do not initialize one
or choose a repository without the user's direction.

Node 22+ and Git are prerequisites. Remote operations use the existing login
for `gh`, `glab`, or Azure CLI with its `azure-devops` extension and curl.
Local state reads do not require hosting authentication.
Do not print tokens, export credentials, or change accounts
without asking. If authentication fails, explain the error and use the
organization's normal sign-in flow.

## Non-negotiable workflow

1. Show `status` or `view` before changes. Read the repository's instructions.
2. Propose the actual plan, then obtain explicit confirmation before splitting,
   pushing, retargeting, publishing, pruning, or removing tracking. Pass `--yes`
   only after approval of that operation.
3. Use the selected engine for stack mutations. Do not replace it with ad hoc
   branch rewrites. Never bypass commit hooks or use an unconditional force push.
4. Each layer must be independently valid. Run the repository's appropriate
   build, tests, and checks for every layer before calling it ready.
5. Merge bottom-up through normal repository approval and CI requirements.
   Do not complete an upper PR while a lower dependency is unmerged.
6. Keep PR titles and main descriptions standalone. The footer carries the
   stack links, not a `[2/5]` title prefix.
7. Preserve branch names as layers land. Their numbers record creation order.

## Choose the engine first

Run `node HELPER backend` and read [provider routing](references/providers.md).
Authentication or network errors are errors, not permission to fall back.

If native local state exists, use `gh stack` and reconcile any helper tracking
before mutations. If the result is `gh-stack`, use the native handover below
for a new stack. Otherwise use this helper's branch-chain commands. Do not
silently migrate already published helper stacks when native support appears.

GitLab defaults to ordinary MR chains. Its experimental `glab stack` requires
an explicit user choice and a separate lifecycle; never mix the engines.

## Split an existing branch

Run `node HELPER status`, then `node HELPER analyze --json`.
Trunk is derived from the remote HEAD, or an unambiguous local main/master.
Pass `--trunk BRANCH` or `--base REF` when the repository requires it.

Read the full diff and `analysis.changes`, not just totals. Do not split an
already coherent small change. About 10 review units and 250 lines is a
starting heuristic, not a universal rule.

Read [splitting heuristics](references/splitting-heuristics.md). Propose a
bottom-up order: foundational changes before consumers; consumers before
dependencies when removing code. Keep renames and consumer updates together.

Write a JSON plan outside the working tree. It contains `sourceBranch`,
`trunk`, `topic`, optional `title`, and `layers`. Each layer has a kebab-case
`slug`, a standalone `title`, optional `description`, and explicit
repository-relative `paths`.

Assign **every changed path exactly once**, including lockfiles, generated
files, binary files, and deletions. A single file cannot belong to two layers.
Do not omit files merely because they do not count toward the review budget.

Run `node HELPER split --plan PLAN --dry-run`. Fix all reported errors and
discuss warnings. Show the layer order, paths, sizes, titles, and intended
validation. Ask the user to confirm or revise the plan.

After confirmation, run `node HELPER split --plan PLAN --yes`.
The helper preserves source contents; it does not assume a package manager,
regenerate lockfiles, generate release notes, or run a repository formatter.
If generated files cannot be partitioned into independently valid layers,
revise the plan or discuss preparatory source changes. Do not claim buildability
from tree equality alone.

The top layer must match the entire source tree, with **no generated-file
exemptions**. On failure, inspect the reported state before retrying. Keep
the original source branch until the stack is safely landed.

### Native GitHub handover

For a new stack with native support, adopt the approved generated branches
in bottom-up order using `gh stack init --base TRUNK BRANCH1 BRANCH2 ...`.
This also enables Git's rerere conflict-resolution cache.
Verify branch names, order and trunk using `gh stack view --json`.
Only after verification, remove the helper's tracking with
`node HELPER unstack --local --yes`. Do not delete branches or native state.

With publication approval, run `gh stack submit --auto --remote REMOTE` for
drafts, using the remote reported by `backend`. Add
`--open` only with explicit readiness approval. Apply the approved standalone
titles and descriptions with `gh api` without removing native stack metadata.
Use `gh stack` for subsequent view, navigation, rebase and sync operations.
Read the installed command's help before unfamiliar options.

## Submit and land

Fill in each PR's description using the target repository's own template.
Preserve its checklist. Show the target branches and draft/readiness intent
before requesting approval.

In branch-chain mode, run `node HELPER submit --yes` for draft PRs, or add `--open` only when the
user approved marking them ready. The helper pushes with force-with-lease,
creates or retargets PRs, and updates compact bottom-up link footers.
Servers may not support atomic push, so inspect partial failures.

After a lower PR merges, run `node HELPER sync` only with approval for its
fetch, retarget, rebase, and push effects. This is an explicit command, not a
background watcher. `rebase` also delegates to sync and can push.

The current helper has legacy recovery and remote-lifecycle limitations.
Read [state and recovery](references/state-and-recovery.md) before sync or
rebase, especially after a squash merge. Stop if the recorded old base is
unclear. Do not replay already merged changes or improvise a reset.

## Other tasks

| Intent | Command |
| --- | --- |
| Show the stack | `node HELPER view` |
| Inspect cached state | `node HELPER status` |
| Inspect hosting and native support | `node HELPER backend` |
| Refresh hosting state | `node HELPER view --refresh` |
| Navigate | `node HELPER up`, `down`, `top`, `bottom`, or `trunk` |
| Recover a current ancestor chain | `node HELPER checkout TOP_PR_ID` |
| Inspect inconsistencies | `node HELPER doctor` |
| Remove tracking | `node HELPER unstack --local --yes` |

The table applies to branch-chain mode. Only use commands documented by the
selected engine. The helper does not implement a
full-screen editor, native stack objects, a merge command, or automatic
CI execution.

See [commands](references/commands.md), [providers](references/providers.md),
and [ADO mapping](references/ado-mapping.md),
and [state and recovery](references/state-and-recovery.md).
