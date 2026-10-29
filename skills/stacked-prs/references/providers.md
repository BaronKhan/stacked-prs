# Providers and engine ownership

`node HELPER backend` reads the selected push remote and reports the provider.
It does not publish or modify a stack.

| Provider | Required authentication | Default implementation |
| --- | --- | --- |
| GitHub | `gh auth login` for the target host | Native `gh stack` when installed and enabled for the repository; otherwise chained PRs |
| Azure DevOps Services | Azure CLI and its `azure-devops` extension | Chained PRs, with REST updates for retargeting |
| GitLab | `glab auth login` for the target host | Chained merge requests |

For an already configured self-hosted GitHub or GitLab host, explicitly set
`STACKED_PRS_PROVIDER=github` or `STACKED_PRS_PROVIDER=gitlab`. The helper does
not guess a service from an unknown hostname. Use HTTPS or SSH remotes.
Custom Azure DevOps Server authentication is not implemented.

All branches in a helper-managed chain must live in the selected hosting
repository. Fork PRs and MRs are not adopted. Stored repository identity is
checked before remote stack changes.

## Native GitHub support

Detection first verifies repository access. It then checks `gh stack --help`
and the repository's stacks API. An empty successful stack list means the
feature is enabled. A stacks-endpoint 404 means it is unavailable only after
the repository itself was successfully read. Authentication, server and
network failures stop the operation.

If only the extension is missing, explain the optional installation command,
`gh extension install github/gh-stack`, and obtain approval before installing.
Do not claim that installing the extension enables the server feature.

The skill's handover uses the helper only to construct and validate an
approved path split. Native `gh stack` then adopts those branches. Verify
native adoption before removing the helper's local record.

GitHub's common-directory `gh-stack` file is distinct from this helper's
`stacked-prs` directory. Do not run branch-chain mutations in a checkout with
native state until the two engines have been explicitly reconciled. Do not
silently migrate published helper stacks just because native support appears.

## Ordinary branch chains

The bottom PR or MR targets trunk. Every later one targets its predecessor.
Titles and main descriptions remain standalone; the helper maintains a
delimited navigation footer. GitHub uses PR numbers; GitLab uses project-relative
MR IIDs, not global database IDs.

PRs and MRs start as drafts. GitHub readiness uses its GraphQL mutation.
GitLab drafts use supported title prefixes, removed only with readiness
approval. The helper verifies the returned draft state and retargeted branch.

GitLab's `glab stack` is experimental and can use a different commit-oriented
workflow. Treat it as an explicit opt-in alternative rather than enabling it
automatically. Never hand a helper-owned stack to it without a reviewed
migration plan.

These are ordinary review chains, not automatic approvals, merge queues or
enforced dependencies. Verify each layer's actual target-branch requirements
and merge bottom-up through the provider's normal process.
