# Stacked PRs

A Copilot CLI skill that splits an existing large branch into a stack of
smaller PRs on GitHub, Azure DevOps or GitLab.

## What problem does this address?

Large PRs are hard to review, and manually splitting them into stacked PRs
while managing dependencies, rebases, retargeting and merges is tedious.

For example, a feature might split into models, an API, and the frontend
that uses it:

```text
   ┌── users/me/feat.03-frontend   → PR !3 (base: feat.02-api)     ← top
  ┌── users/me/feat.02-api         → PR !2 (base: feat.01-models)
 ┌── users/me/feat.01-models       → PR !1 (base: main)            ← bottom
main (trunk)
```

Each PR targets the branch below it, so reviewers see that layer's changes
rather than the whole feature. The bottom PR targets `main`, and the stack
is merged bottom-up.

Inspired by GitHub Stacked PRs, this skill also handles the part you would
otherwise do by hand: deciding how to split code already on your branch.

## How do I use it?

Requires Node 22+, Git and GitHub Copilot CLI. Add this repository's marketplace
and install the skill:

```bash
copilot plugin marketplace add BaronKhan/stacked-prs
copilot plugin install stacked-prs@baronkhan-skills
```

Remote operations also need the relevant authenticated CLI: `gh`, `glab`, or
Azure CLI with the `azure-devops` extension and curl.

Start a Copilot session in your checkout, on the branch you want to split:

```text
/stacked-prs Split my current branch into smaller PRs and create draft PRs for each layer.
```

The skill reads the diff, proposes a split around the dependencies, and asks
you to confirm the plan before creating branches and PRs. The working tree
must be clean before splitting.

To see the stack:

```text
/stacked-prs Show my stack.
```

After merging a lower PR:

```text
/stacked-prs Sync my stack.
```

Sync rebases the remaining branches and retargets their PRs. It is an explicit
operation, not a background merge watcher.

The command is `/stacked-prs`, not `/stacked-prs:stacked-prs`.
Alternatively, copy `skills/stacked-prs` to `~/.copilot/skills/stacked-prs`.
Choose one installation method. A same-named project skill takes precedence
over personal and plugin copies; use `/skills` to check which one is loaded.

## How does it work?

**Deterministic core, LLM shell.** Copilot decides whether to split, where the
boundaries belong, and what each PR should contain. Node scripts handle the
Git operations, hosting API calls, local state and checks.

**Splitting is a path partition, not cherry-picking.** Every changed path goes
to exactly one layer. The top layer's complete tree must match the original
branch, including lockfiles, generated files, binary files and deletions.
A single file cannot be split across layers.

The agent still needs to run your repository's builds and tests on each
layer. Matching the final tree does not prove that intermediate layers build.

**Stack state is local.** The branch-chain helper stores it in
`.git/stacked-prs/`. PR titles and descriptions remain standalone, with a small
footer linking the stack. Native GitHub stacks use `gh stack`'s own state
and lifecycle instead.

## Which hosting services does it use?

| Hosting service | Implementation |
| --- | --- |
| GitHub with `gh stack` installed and enabled for the repository | Native `gh stack`, after the approved branch split |
| GitHub without both prerequisites | Chained PRs through `gh api` |
| Azure DevOps Services | Chained PRs through Azure CLI and REST |
| GitLab | Chained merge requests through `glab api` |

Existing branch-chain stacks are not automatically migrated when native
GitHub support becomes available. GitLab's native `glab stack` is experimental
and requires an explicit choice.

Self-hosted GitHub and GitLab require configured CLI authentication and an
explicit provider setting. Fork-based stacks and custom Azure DevOps Server
authentication are not implemented. See `skills/stacked-prs/references/providers.md`.

## Recovery and checks

Keep the original branch until the stack has landed. Read
`skills/stacked-prs/references/state-and-recovery.md` before syncing after a
squash merge or recovering an interrupted rebase. The helper's ancestor
recovery starts from the top PR; it does not discover the whole stack from
the bottom.

Merge through the repository's normal reviews and CI. The skill does not
merge PRs automatically or replace those checks.

## Development

No runtime npm dependencies or build step:

```bash
npm test
```

Tests use local Git repositories and mocked hosting clients. They do not
create remote PRs. MIT licensed.
