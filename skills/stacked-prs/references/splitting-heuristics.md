# Choosing reviewable layers

Use review boundaries, not a fixed file quota. A small coherent change should
usually stay one PR. About 10 review units and 250 changed lines per layer
is a starting point; avoid exceeding 10 layers without discussing scope.

Whole recognized package additions and deletions count as one review unit.
Other source layouts still work as ordinary changed paths. The helper's
package.json dependency graph is a hint, not a complete dependency proof.
Inspect language-specific imports, project references, manifests, tests, and
configuration yourself.

| Change | Preferred order |
| --- | --- |
| Add a feature | Shared types and configuration, producers, consumers, integration |
| Remove a feature | Consumers first, dependencies later, final configuration cleanup |
| Rename a package | Rename and affected consumers in the same layer |
| Move functionality gradually | Add the new location, migrate consumers, remove the old location |

Every intermediate layer must pass its own appropriate checks. The top
layer matching the source only proves completeness, not intermediate validity.

Keep a package's source and manifest coherent. Include the exact changed
lockfiles and generated artifacts in the plan. If the file-level partition
cannot produce valid intermediate states, say so and propose a smaller stack
or explicit preparatory edits. Do not silently invent generated contents.

Each file belongs to exactly one layer, so different edits to a single file
cannot be distributed among layers by this helper.

Name PRs for their individual change. Never add mandatory stack-position
prefixes. Layer branch numbers are stable creation order, not a count of
remaining unmerged PRs.
