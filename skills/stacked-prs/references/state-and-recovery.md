# State and recovery

State lives under the current checkout's Git directory in `stacked-prs/`.
It includes `stacks.json`, a previous-copy backup, a lock, and operation
journals. Backup refs use `refs/stacked-prs-backup/`.

Normal commits and pushes do not include the state directory. State survives
Copilot sessions but does not automatically follow the user to another clone.
Do not delete it while an operation or recovery is pending.

`status` reports pending journals. `doctor` inspects tracked branches and
parent chains. Refresh cached PR state before relying on old local statuses.

The original helper journals sync/rebase, not every operation. It does not
provide a general transaction across Git, ADO, and local state.

On a conflict, inspect the named files and recorded backup tips. Resolve
semantically and stage the resolution. `rebase --continue` resumes through
sync and can push. `rebase --abort` can reset recorded branches to their saved
tips, so obtain approval and verify no unrelated work would be lost.

Before syncing after a squash merge, verify the correct old parent boundary.
The legacy sync path does not explicitly replay with a saved old-base
boundary. Stop and explain if safe replay cannot be established. Do not
silently choose a fresh rebase or reset.

The legacy sync path also uses the local trunk branch. Confirm it matches
the intended fetched trunk before syncing; otherwise stop and obtain approval
for a normal trunk update first.

Pushes record explicit remote tips before rewriting and reject remote commits
not incorporated locally. Both atomic and fallback pushes use those exact
leases. A failed push retains the recovery journal and backup refs.

`checkout TOP_PR_ID` walks that PR's current targets down to trunk. It cannot
discover children from the bottom PR, recover already retargeted historical
relationships, or fetch source branches that the server has deleted.

If a submit fails, inspect existing PRs and remote branches before retrying.
If a split fails, inspect the original branch, created branches, and working
tree before attempting cleanup. Preserve unrelated edits.
