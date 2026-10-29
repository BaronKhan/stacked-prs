// @ts-check
/**
 * plan.mjs - plan validation and the completeness invariant.
 *
 * This is the safety gate for `split`. The model proposes layers; this module
 * decides whether the proposal is *sound* before a single branch is created.
 *
 * Zero judgement about whether a split is a GOOD idea - only whether it is a
 * VALID one.
 */

import { packageDirOf } from "./analyze.mjs";

/**
 * @typedef {object} Layer
 * @property {string} slug        short kebab-case name, used in the branch
 * @property {string} title       PR title (must read standalone - no "[2/5]")
 * @property {string} [description]
 * @property {string} [changeType] patch | minor | major | none
 * @property {string[]} paths     repo-relative paths owned by this layer
 *
 * @typedef {object} Plan
 * @property {string} sourceBranch
 * @property {string} trunk
 * @property {string} topic       groups the stack in branch names
 * @property {string} [title]
 * @property {Layer[]} layers
 */

const STACK_MARKER = /\[\d+\s*\/\s*\d+\]|\(\d+\s*of\s*\d+\)|part \d+ of \d+/i;

/**
 * Validate a plan against the analysis. Returns every problem found, so the
 * model can fix them all in one pass instead of trial-and-error.
 *
 * @param {Plan} plan
 * @param {ReturnType<import("./analyze.mjs").analyze>} analysis
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:any}}
 */
export function validatePlan(plan, analysis) {
  const errors = [];
  const warnings = [];

  if (!plan || !Array.isArray(plan.layers) || plan.layers.length === 0) {
    return {
      ok: false,
      errors: ["Plan has no layers."],
      warnings,
      stats: null,
    };
  }
  if (plan.layers.length === 1) {
    warnings.push(
      "Plan has a single layer - that is not a stack. Consider leaving the branch as one PR."
    );
  }
  if (plan.layers.length > analysis.sizing.maxLayers) {
    errors.push(
      `Plan has ${plan.layers.length} layers, above the maximum of ${analysis.sizing.maxLayers}. Ask the user before going deeper.`
    );
  }

  /* ---- 1. every changed path assigned exactly once ---------------------- */

  const expected = new Set(analysis.changes.map((c) => c.path));
  /** @type {Map<string, number[]>} path -> layer indexes */
  const seen = new Map();

  plan.layers.forEach((layer, i) => {
    if (!layer.slug || !/^[a-z0-9][a-z0-9-]*$/.test(layer.slug)) {
      errors.push(
        `Layer ${i + 1} has an invalid slug "${layer.slug}" (expected kebab-case).`
      );
    }
    if (!layer.title || layer.title.trim().length < 8) {
      errors.push(`Layer ${i + 1} needs a descriptive title.`);
    }
    if (layer.title && STACK_MARKER.test(layer.title)) {
      errors.push(
        `Layer ${i + 1} title "${layer.title}" contains stack position markers. Each PR title must read standalone; the stack link belongs in the footer only.`
      );
    }
    if (!Array.isArray(layer.paths) || layer.paths.length === 0) {
      errors.push(`Layer ${i + 1} ("${layer.slug}") owns no paths.`);
      return;
    }
    for (const p of layer.paths) {
      if (!seen.has(p)) seen.set(p, []);
      seen.get(p).push(i + 1);
    }
  });

  const duplicated = [...seen.entries()].filter(([, ls]) => ls.length > 1);
  for (const [p, ls] of duplicated.slice(0, 20)) {
    errors.push(`Path assigned to multiple layers (${ls.join(", ")}): ${p}`);
  }
  if (duplicated.length > 20) {
    errors.push(`…and ${duplicated.length - 20} more duplicated paths.`);
  }

  const missing = [...expected].filter((p) => !seen.has(p));
  for (const p of missing.slice(0, 20)) {
    errors.push(`Changed path not assigned to any layer: ${p}`);
  }
  if (missing.length > 20) {
    errors.push(`…and ${missing.length - 20} more unassigned paths.`);
  }

  const extra = [...seen.keys()].filter((p) => !expected.has(p));
  for (const p of extra.slice(0, 20)) {
    errors.push(`Layer references a path the branch never changed: ${p}`);
  }

  /* ---- 2. dependency ordering ------------------------------------------ */

  /** @type {Map<string, number>} package dir -> lowest layer that touches it */
  const pkgLayer = new Map();
  plan.layers.forEach((layer, i) => {
    for (const p of layer.paths) {
      const pkg = packageDirOf(p);
      if (pkg && (!pkgLayer.has(pkg) || pkgLayer.get(pkg) > i)) {
        pkgLayer.set(pkg, i);
      }
    }
  });

  /** What is happening to each package on this branch? */
  const kindOf = new Map(
    analysis.reviewUnits
      .filter((u) => u.kind.startsWith("package-"))
      .map((u) => [u.key, u.kind])
  );

  // The ordering constraint flips depending on the direction of the change:
  //
  //   ADDING b, and a depends on b   → b must land at or below a.
  //                                    Otherwise a references something that
  //                                    does not exist yet.
  //
  //   DELETING b, and a depends on b → b must be removed at or ABOVE a.
  //                                    Otherwise a is left pointing at a
  //                                    package that has already gone.
  //
  //   EDITING b                      → no ordering constraint; b exists either
  //                                    way.
  //
  // Getting this backwards is the single easiest way to produce a stack whose
  // middle layers are red, so it is checked explicitly rather than assumed.
  for (const edge of analysis.dependencyEdges) {
    const from = pkgLayer.get(edge.from);
    const to = pkgLayer.get(edge.to);
    if (from === undefined || to === undefined) continue;

    const kind = kindOf.get(edge.to);

    if (kind === "package-deleted" || kind === "package-renamed-from") {
      if (to < from) {
        errors.push(
          `Dependency removed too early: ${edge.to} is deleted in layer ${
            to + 1
          } but ${edge.from} still depends on it until layer ${
            from + 1
          }. Delete the dependent first - move ${edge.to} up, or ${
            edge.from
          } down.`
        );
      }
    } else if (kind === "package-added" || kind === "package-renamed") {
      if (to > from) {
        errors.push(
          `Dependency inverted: ${edge.from} (layer ${
            from + 1
          }) depends on ${edge.to}, which only appears in layer ${
            to + 1
          }. A layer may only depend on layers below it - move ${
            edge.to
          } down, or ${edge.from} up.`
        );
      }
    }
  }

  /* ---- 3. sizing --------------------------------------------------------- */

  const numstat = new Map(
    analysis.reviewUnits.flatMap((u) =>
      u.paths.map((p) => [p, u.lines / Math.max(1, u.paths.length)])
    )
  );
  const unitOf = new Map();
  for (const u of analysis.reviewUnits) {
    for (const p of u.paths) unitOf.set(p, u);
  }

  const byKey = new Map(analysis.reviewUnits.map((u) => [u.key, u]));

  const stats = plan.layers.map((layer, i) => {
    const units = new Set();
    let lines = 0;
    let reviewLines = 0;
    let files = 0;
    for (const p of layer.paths) {
      const u = unitOf.get(p);
      if (u) units.add(u.key);
      const l = numstat.get(p) ?? 0;
      lines += l;
      // A wholly added, deleted or renamed directory is one decision, not a
      // line-by-line read, so its churn does not count against the budget.
      if (!u || u.kind === "package-edited" || u.kind === "file") reviewLines += l;
      files += 1;
    }
    let unitCount = 0;
    for (const key of units) {
      const u = byKey.get(key);
      unitCount += u ? u.units : 1;
    }
    const s = {
      layer: i + 1,
      slug: layer.slug,
      title: layer.title,
      files,
      reviewUnits: unitCount,
      lines: Math.round(lines),
      reviewLines: Math.round(reviewLines),
    };
    if (unitCount > analysis.sizing.warnUnitsPerLayer) {
      warnings.push(
        `Layer ${i + 1} ("${layer.slug}") has ${unitCount} review units, above the ${analysis.sizing.warnUnitsPerLayer} warning threshold - consider splitting it.`
      );
    }
    if (s.reviewLines > analysis.sizing.warnLinesPerLayer) {
      warnings.push(
        `Layer ${i + 1} ("${layer.slug}") changes ~${s.reviewLines} lines that must be read line by line, above the ${analysis.sizing.warnLinesPerLayer} warning threshold.`
      );
    }
    if (unitCount < 2 && plan.layers.length > 1) {
      warnings.push(
        `Layer ${i + 1} ("${layer.slug}") is tiny (${unitCount} review unit) - consider folding it into a neighbour.`
      );
    }
    return s;
  });

  /* ---- 4. branch naming -------------------------------------------------- */

  if (plan.topic && !/^[a-z0-9][a-z0-9-]*$/.test(plan.topic)) {
    errors.push(`Topic "${plan.topic}" must be kebab-case.`);
  }
  const slugs = plan.layers.map((l) => l.slug);
  const dupSlug = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (dupSlug.length) {
    errors.push(`Duplicate layer slugs: ${[...new Set(dupSlug)].join(", ")}`);
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}

/**
 * Branch name for a layer. Stack membership lives in the branch name and is
 * never rewritten as layers merge - the number records creation order.
 * @param {string} userPrefix e.g. "users/developer"
 */
export function branchNameFor(userPrefix, topic, index, slug) {
  const nn = String(index + 1).padStart(2, "0");
  return `${userPrefix}/${topic}.${nn}-${slug}`;
}

/** Split a `users/<alias>/<rest>` branch into its prefix. */
export function userPrefixFrom(branch, fallbackAlias = null) {
  const m = branch.match(/^((?:users|user)\/[^/]+)\//);
  return m ? m[1] : fallbackAlias ? `users/${fallbackAlias}` : "stacks";
}
