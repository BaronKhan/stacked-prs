# Azure DevOps mapping

This helper uses ordinary Git branches and Azure DevOps pull requests.
It does not require or create a native server-side stack object.

The Azure organization/collection, project and repository are derived from
the selected Git remote's push URL. Supported forms include Azure HTTPS,
legacy visualstudio.com HTTPS, and Azure ssh.dev.azure.com SSH. Existing
CLI authentication and repository permissions are still required.
Custom Azure DevOps Server hosts require a separately reviewed authentication
adapter; the helper will not send an Azure bearer token to an arbitrary host.

The bottom PR targets trunk. Each later PR targets the branch below it.
PR descriptions have a compact footer after a divider, with bottom-up links,
a current-PR marker, and strikethrough for merged predecessors.
The `stacked-prs:begin` and `stacked-prs:end` HTML comments delimit the block.
The author's main description and checklist remain separate.

Retargeting uses the REST API because the CLI update command cannot represent
every field. Authentication uses Azure CLI. The bearer header is sent to
curl through standard input, not a command argument or header file. The
request body uses a private temporary directory and is removed afterward.
Azure CLI retains its own authentication cache; do not export or publish it.

Push attempts atomic multi-ref updates and falls back when the server reports
that atomic push is unsupported. Force-with-lease remains enabled. A fallback
push can partially succeed, so reconcile the remote state before retrying.

Branch policies can depend on the PR's direct target. Do not assume a
mid-stack PR has trunk's required checks or reviewers. Land bottom-up only
after each PR targets trunk and satisfies its actual policies.

The helper's display is not a policy checker. It does not automatically
merge PRs, certify builds, or subscribe to server-side merge events.
