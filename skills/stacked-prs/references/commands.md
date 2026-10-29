# Command reference

Run Node with the absolute path to this skill's `scripts/stack.mjs`, from the
target Git checkout. `HELPER` below denotes that path.

| Command | Behavior |
| --- | --- |
| `node HELPER backend` | Read-only hosting detection and GitHub native capability probe |
| `node HELPER analyze [--base REF] [--head REF] [--trunk BRANCH]` | Read-only diff analysis, complete changed-path list and review-size hints |
| `node HELPER status` | Current branch, tracked stack and pending operation JSON |
| `node HELPER view [--short] [--json] [--refresh]` | Stack map; refresh updates the local PR cache |
| `node HELPER split --plan PLAN --dry-run` | Validate the explicit path partition without creating branches |
| `node HELPER split --plan PLAN --yes` | Apply the approved partition and compare the complete result with the source |
| `node HELPER submit --yes [--open]` | Push branches and create or update chained PRs; drafts unless explicitly opened |
| `node HELPER sync [--prune]` | Fetch, retarget, rebase, push, update footers; pruning deletes merged local branches |
| `node HELPER rebase [--continue \| --abort]` | Recovery interface; a normal rebase or continue also invokes sync |
| `node HELPER push` | Push unmerged branches without changing PR descriptions |
| `node HELPER checkout PR_ID [--trunk BRANCH]` | Reconstruct that PR's current ancestor chain |
| `node HELPER checkout BRANCH` | Switch to a branch in a tracked stack |
| `node HELPER up [N]`, `down [N]`, `top`, `bottom`, `trunk` | Branch navigation |
| `node HELPER unstack [--local] --yes` | Remove tracking and optionally remove stack footers, not PRs |
| `node HELPER doctor [--prune]` | Inspect local inconsistencies; optionally forget stacks whose branches are gone |

The plan requires `sourceBranch`, `trunk`, `topic`, and a nonempty `layers`
array. Each layer requires `slug`, `title`, and `paths`; `description` is
optional. Every changed path belongs to exactly one layer.

The helper does not determine semantic correctness, run CI, generate package
manager files, or supply a merge command. Read the recovery limitations before
syncing a partially merged stack.

Exit codes include 0 success, 1 general failure, 2 no stack, 3 conflict,
4 hosting API failure, 5 invalid input, 6 ambiguous membership, and 8 lock contention.
Always read the error rather than blindly retrying a write.

This table describes the branch-chain engine. In native GitHub mode, use
`gh stack` after the verified adoption described in `SKILL.md`.
