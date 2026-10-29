// @ts-check
/**
 * analyze.mjs - deterministic diff analysis.
 *
 * One job: describe what a branch changed, in the vocabulary the model needs to
 * decide where the seams go. Review units, package rollups, dependency edges.
 *
 * Zero judgement. It never proposes a split, never scores a layer, never guesses
 * whether something is "foundational". It supplies facts; the model decides.
 */

import fs from "node:fs";
import path from "node:path";

import { diffNameStatus, diffNumstat, lsTree, repoRoot } from "./git.mjs";

/**
 * Paths whose churn should never count toward a layer's size: they are
 * regenerated mechanically per layer, so they are noise in a review budget.
 */
const GENERATED = [
  /(^|\/)yarn\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)change\/change-[0-9a-f-]+\.json$/,
  /(^|\/)__generated__\//,
  // Build output only - anchored to a package root so a package legitimately
  // NAMED `lib` or `dist` is not mistaken for compiler output.
  /(^|\/)packages\/[^/]+\/(lib|dist)\//,
];

export function isGenerated(p) {
  return GENERATED.some((re) => re.test(p));
}

/** `workspace/packages/foo/src/x.ts` -> `workspace/packages/foo`. */
export function packageDirOf(p) {
  const m = p.match(/^((?:[^/]+\/)*packages\/[^/]+)\//);
  if (m) return m[1];
  return null;
}

/**
 * Group changed paths into "review units".
 *
 * A whole directory that is entirely added, entirely deleted, or entirely
 * renamed collapses to ONE unit - deleting a 900-file package is a single
 * review decision. Everything else is one unit per edited file.
 *
 * @param {{status:string,path:string,oldPath?:string}[]} changes
 * @param {string} base
 * @param {string} head
 */
export function computeReviewUnits(changes, base, head, cwd = process.cwd()) {
  const real = changes.filter((c) => !isGenerated(c.path));

  /** @type {Map<string, typeof real>} */
  const byPkg = new Map();
  const loose = [];
  for (const c of real) {
    const pkg = packageDirOf(c.path);
    if (!pkg) {
      loose.push(c);
      continue;
    }
    if (!byPkg.has(pkg)) byPkg.set(pkg, []);
    byPkg.get(pkg).push(c);
  }

  // Presence at base vs head is the reliable signal. An exact file-count match
  // is NOT: git pairs identical files (a shared .npmignore, an empty index.ts)
  // across package boundaries as renames, so a wholly deleted package can show
  // one fewer deletion than it has files.
  const dirs = [...byPkg.keys()];
  const prefixes = dirs.map((d) => `${d}/`);
  const atBase = countsByPrefix(base, dirs, prefixes, cwd);
  const atHead = countsByPrefix(head, dirs, prefixes, cwd);

  /** @type {{kind:string, key:string, paths:string[], units:number}[]} */
  const units = [];

  for (const [pkg, cs] of byPkg) {
    const paths = cs.map((c) => c.path);
    const before = atBase.get(pkg) ?? 0;
    const after = atHead.get(pkg) ?? 0;

    if (before > 0 && after === 0) {
      units.push({ kind: "package-deleted", key: pkg, paths, units: 1 });
      continue;
    }
    if (before === 0 && after > 0) {
      units.push({ kind: "package-added", key: pkg, paths, units: 1 });
      continue;
    }
    units.push({
      kind: "package-edited",
      key: pkg,
      paths,
      units: paths.length,
    });
  }

  for (const c of loose) {
    units.push({ kind: "file", key: c.path, paths: [c.path], units: 1 });
  }

  labelRenamePairs(units);
  return units;
}

/**
 * A package that disappears while an identical set of files appears elsewhere is
 * a rename, not an unrelated delete-and-add. Detecting it at the PACKAGE level
 * (rather than trusting git's per-file rename detection) keeps path coverage
 * exact while still giving the model the signal it needs: a rename and its
 * consumers must land in the same layer.
 *
 * The pair counts as one review decision, so the source side contributes zero.
 */
function labelRenamePairs(units) {
  const rel = (u) => {
    const base = `${u.key}/`;
    return u.paths.map((p) => p.slice(base.length)).sort().join("\n");
  };
  const deleted = units.filter((u) => u.kind === "package-deleted");
  const added = units.filter((u) => u.kind === "package-added");
  const byShape = new Map();
  for (const d of deleted) {
    const k = rel(d);
    if (!byShape.has(k)) byShape.set(k, []);
    byShape.get(k).push(d);
  }
  for (const a of added) {
    const candidates = byShape.get(rel(a));
    const d = candidates?.shift();
    if (!d) continue;
    a.kind = "package-renamed";
    a.renamedFrom = d.key;
    d.kind = "package-renamed-from";
    d.renamedTo = a.key;
    d.units = 0; // the pair is one decision, counted on the destination
  }
}

/**
 * How many non-generated files each package directory has at `ref`.
 * One git call for the whole set rather than one per package.
 * @returns {Map<string, number>}
 */
function countsByPrefix(ref, dirs, prefixes, cwd) {
  /** @type {Map<string, number>} */
  const counts = new Map(dirs.map((d) => [d, 0]));
  if (dirs.length === 0) return counts;
  const tracked = lsTree(ref, prefixes, cwd);
  for (const p of tracked) {
    if (isGenerated(p)) continue;
    const pkg = packageDirOf(p);
    if (pkg && counts.has(pkg)) counts.set(pkg, counts.get(pkg) + 1);
  }
  return counts;
}

/** Read a package.json without throwing. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Build the workspace dependency graph restricted to the packages this branch
 * touches. These edges are the hard constraint the model must respect: an edge
 * `a -> b` means b must land in the same layer as a, or a lower one.
 * @param {string[]} pkgDirs
 */
export function dependencyEdges(pkgDirs, root) {
  /** @type {Map<string,string>} name -> dir */
  const nameToDir = new Map();
  /** @type {Map<string,string[]>} */
  const deps = new Map();

  // Index every workspace package so we can resolve names, not just changed ones.
  const roots = [...new Set(pkgDirs.map((dir) => path.posix.dirname(dir)))];
  for (const r of roots) {
    const abs = path.join(root, r);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs)) {
      const pj = path.join(abs, entry, "package.json");
      if (!fs.existsSync(pj)) continue;
      const json = readJson(pj);
      if (json?.name) nameToDir.set(json.name, `${r}/${entry}`);
    }
  }

  for (const dir of pkgDirs) {
    const json = readJson(path.join(root, dir, "package.json"));
    if (!json) continue;
    const all = {
      ...(json.dependencies ?? {}),
      ...(json.devDependencies ?? {}),
      ...(json.peerDependencies ?? {}),
    };
    const edges = [];
    for (const name of Object.keys(all)) {
      const target = nameToDir.get(name);
      if (target && target !== dir) edges.push(target);
    }
    deps.set(dir, edges);
  }

  /** @type {{from:string,to:string}[]} */
  const out = [];
  const changed = new Set(pkgDirs);
  for (const [from, tos] of deps) {
    for (const to of tos) {
      if (changed.has(to)) out.push({ from, to });
    }
  }
  return { edges: out, nameToDir: Object.fromEntries(nameToDir) };
}

/**
 * Full analysis payload. This is the JSON the model reads before proposing a plan.
 * @param {{base:string, head:string, cwd?:string}} opts
 */
export function analyze({ base, head, cwd = process.cwd() }) {
  const root = repoRoot(cwd);
  const changes = diffNameStatus(base, head, cwd);
  const numstat = diffNumstat(base, head, cwd);

  const units = computeReviewUnits(changes, base, head, cwd);
  const totalUnits = units.reduce((n, u) => n + u.units, 0);

  const linesFor = (paths) =>
    paths.reduce((n, p) => {
      const s = numstat.get(p);
      return n + (s ? s.ins + s.del : 0);
    }, 0);

  const generated = changes.filter((c) => isGenerated(c.path));
  const real = changes.filter((c) => !isGenerated(c.path));

  const pkgDirs = [
    ...new Set(real.map((c) => packageDirOf(c.path)).filter(Boolean)),
  ];
  const { edges } = dependencyEdges(pkgDirs, root);

  const byStatus = {};
  for (const c of real) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

  return {
    base,
    head,
    totals: {
      filesChanged: changes.length,
      filesChangedExcludingGenerated: real.length,
      generatedFiles: generated.length,
      reviewUnits: totalUnits,
      linesChanged: linesFor(real.map((c) => c.path)),
      byStatus,
    },
    // Sizing guidance is data, not a decision - the model chooses the layers.
    sizing: {
      targetUnitsPerLayer: 10,
      targetLinesPerLayer: 250,
      warnUnitsPerLayer: 20,
      warnLinesPerLayer: 600,
      maxLayers: 10,
      suggestedLayerCountFromUnits: Math.max(
        1,
        Math.ceil(totalUnits / 10)
      ),
      note: "Starting review-size heuristics, not a build guarantee. Adapt the plan to this repository.",
    },
    reviewUnits: units
      .map((u) => ({
        ...u,
        lines: linesFor(u.paths),
        fileCount: u.paths.length,
      }))
      .sort((a, b) => b.units - a.units || b.lines - a.lines),
    packages: pkgDirs.map((dir) => {
      const paths = real.filter((c) => packageDirOf(c.path) === dir);
      return {
        dir,
        files: paths.length,
        lines: linesFor(paths.map((c) => c.path)),
      };
    }),
    dependencyEdges: edges,
    generatedPaths: generated.map((c) => c.path),
    changes,
  };
}
