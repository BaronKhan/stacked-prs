// @ts-check
/**
 * apply.mjs - turn a validated plan into real branches.
 *
 * The one interesting idea: layers are built by PATH PARTITION, not by
 * cherry-picking commits. Each layer checks out its own paths from the source
 * branch on top of the layer below. Because every changed path is assigned to
 * exactly one layer, the union of the layers is provably the source tree - and
 * we verify exactly that before letting anything be pushed.
 */

import * as git from "./git.mjs";
import { branchNameFor } from "./plan.mjs";

/**
 * Materialise every layer as a branch.
 *
 * @param {import("./plan.mjs").Plan} plan
 * @param {{
 *   root: string,
 *   userPrefix: string,
 *   onProgress?: (msg: string) => void,
 * }} opts
 */
export function applyPlan(plan, opts) {
  const {
    root,
    userPrefix,
    onProgress = () => {},
  } = opts;

  if (!git.isClean(root)) {
    const err = new Error(
      "Working tree is dirty. Commit or stash before splitting."
    );
    /** @type {any} */ (err).exitCode = 1;
    throw err;
  }

  const sourceSha = git.revParse(plan.sourceBranch, root);
  if (!sourceSha) {
    const err = new Error(`Source branch not found: ${plan.sourceBranch}`);
    /** @type {any} */ (err).exitCode = 5;
    throw err;
  }

  const created = [];
  let parent = plan.trunk;

  try {
    for (let i = 0; i < plan.layers.length; i++) {
      const layer = plan.layers[i];
      const branch = branchNameFor(userPrefix, plan.topic, i, layer.slug);
      onProgress(`Layer ${i + 1}/${plan.layers.length}: ${branch}`);

      if (git.branchExists(branch, root)) {
        const err = new Error(
          `Branch already exists: ${branch}. Delete it or pick another topic.`
        );
        /** @type {any} */ (err).exitCode = 1;
        throw err;
      }

      git.createBranch(branch, parent, root);
      git.materialisePaths(plan.sourceBranch, layer.paths, root);

      git.stageAll(root);

      if (!git.hasStagedChanges(root)) {
        const err = new Error(
          `Layer ${i + 1} ("${layer.slug}") produced no changes. The plan is inconsistent with the source branch.`
        );
        /** @type {any} */ (err).exitCode = 1;
        throw err;
      }

      const message = [
        layer.title,
        "",
        layer.description ?? "",
        "",
        "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
      ]
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");

      const sha = git.commit(message, root);
      created.push({ branch, parent, sha, layer: i + 1, slug: layer.slug });
      parent = branch;
    }

    /* ---------------- the completeness gate ---------------- */

    const top = created[created.length - 1].branch;
    const delta = git.treeDelta(top, plan.sourceBranch, root);

    if (delta.length > 0) {
      const err = new Error(
        [
          `Split is not lossless: ${delta.length} path(s) differ between the top layer (${top}) and the source branch (${plan.sourceBranch}).`,
          "Rolling back every branch created by this run.",
          ...delta.slice(0, 25).map((p) => `  ${p}`),
          delta.length > 25 ? `  …and ${delta.length - 25} more` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
      /** @type {any} */ (err).exitCode = 1;
      /** @type {any} */ (err).delta = delta;
      throw err;
    }

    return { created, verified: true };
  } catch (err) {
    // Roll back: nothing has been pushed at this point, so cleanup is total.
    onProgress("Rolling back…");
    try {
      git.checkout(plan.sourceBranch, root);
    } catch {
      /* best effort */
    }
    for (const c of created.reverse()) {
      git.deleteBranch(c.branch, { force: true }, root);
    }
    throw err;
  }
}
