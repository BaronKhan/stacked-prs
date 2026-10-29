// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { branchNameFor, userPrefixFrom, validatePlan } from "../scripts/lib/plan.mjs";

/** Minimal analysis stub shaped like the real `analyze()` output. */
function analysisWith(paths, { edges = [], units = null } = {}) {
  return {
    changes: paths.map((p) => ({ status: "M", path: p })),
    dependencyEdges: edges,
    reviewUnits:
      units ??
      paths.map((p) => ({ kind: "file", key: p, paths: [p], units: 1, lines: 10 })),
    sizing: {
      targetUnitsPerLayer: 10,
      targetLinesPerLayer: 250,
      warnUnitsPerLayer: 20,
      warnLinesPerLayer: 600,
      maxLayers: 10,
    },
  };
}

const layer = (slug, title, paths) => ({ slug, title, paths });

describe("completeness", () => {
  it("accepts a partition that covers every changed path exactly once", () => {
    const a = analysisWith(["x/a.ts", "x/b.ts", "y/c.ts"]);
    const plan = {
      sourceBranch: "users/me/big",
      trunk: "main",
      topic: "big",
      layers: [
        layer("first", "Add the shared types", ["x/a.ts", "x/b.ts"]),
        layer("second", "Wire up the consumer", ["y/c.ts"]),
      ],
    };
    const r = validatePlan(plan, a);
    assert.equal(r.ok, true, r.errors.join("; "));
  });

  it("rejects an unassigned path", () => {
    const a = analysisWith(["x/a.ts", "x/b.ts"]);
    const plan = {
      sourceBranch: "b",
      trunk: "main",
      topic: "t",
      layers: [layer("only", "Only the first file", ["x/a.ts"])],
    };
    const r = validatePlan(plan, a);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("not assigned") && e.includes("x/b.ts")));
  });

  it("rejects a path claimed by two layers", () => {
    const a = analysisWith(["x/a.ts"]);
    const plan = {
      sourceBranch: "b",
      trunk: "main",
      topic: "t",
      layers: [
        layer("one", "First layer here", ["x/a.ts"]),
        layer("two", "Second layer here", ["x/a.ts"]),
      ],
    };
    const r = validatePlan(plan, a);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("multiple layers")));
  });

  it("rejects a path the branch never changed", () => {
    const a = analysisWith(["x/a.ts"]);
    const plan = {
      sourceBranch: "b",
      trunk: "main",
      topic: "t",
      layers: [layer("one", "Touches a ghost", ["x/a.ts", "x/ghost.ts"])],
    };
    const r = validatePlan(plan, a);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("never changed")));
  });
});

describe("dependency ordering - additive changes", () => {
  const paths = [
    "workspace/packages/lib/src/i.ts",
    "workspace/packages/app/src/i.ts",
  ];
  const edges = [{ from: "workspace/packages/app", to: "workspace/packages/lib" }];
  // `lib` is a NEW package; `app` is edited to consume it.
  const units = [
    { kind: "package-added", key: "workspace/packages/lib", paths: [paths[0]], units: 1, lines: 10 },
    { kind: "package-edited", key: "workspace/packages/app", paths: [paths[1]], units: 1, lines: 10 },
  ];
  const a = analysisWith(paths, { edges, units });

  it("accepts the new dependency below its consumer", () => {
    const r = validatePlan(
      {
        sourceBranch: "b", trunk: "main", topic: "t",
        layers: [
          layer("lib", "Add the shared library", [paths[0]]),
          layer("app", "Consume the shared library", [paths[1]]),
        ],
      },
      a
    );
    assert.equal(r.ok, true, r.errors.join("; "));
  });

  it("rejects a consumer below a package that does not exist yet", () => {
    const r = validatePlan(
      {
        sourceBranch: "b", trunk: "main", topic: "t",
        layers: [
          layer("app", "Consume the shared library", [paths[1]]),
          layer("lib", "Add the shared library", [paths[0]]),
        ],
      },
      a
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("Dependency inverted")));
  });

  it("accepts both in one layer", () => {
    const r = validatePlan(
      {
        sourceBranch: "b", trunk: "main", topic: "t",
        layers: [layer("both", "Add the library and its consumer", paths)],
      },
      a
    );
    assert.equal(r.ok, true, r.errors.join("; "));
  });
});

describe("dependency ordering - deletions invert the constraint", () => {
  // Removing a suite: `app` depends on `lib`, and BOTH are being deleted.
  // The dependent must go first, otherwise the intermediate layer leaves `app`
  // pointing at a package that has already been removed.
  const paths = [
    "workspace/packages/lib/src/i.ts",
    "workspace/packages/app/src/i.ts",
  ];
  const edges = [{ from: "workspace/packages/app", to: "workspace/packages/lib" }];
  const units = [
    { kind: "package-deleted", key: "workspace/packages/lib", paths: [paths[0]], units: 1, lines: 500 },
    { kind: "package-deleted", key: "workspace/packages/app", paths: [paths[1]], units: 1, lines: 800 },
  ];
  const a = analysisWith(paths, { edges, units });

  it("accepts deleting the dependent first, its dependency second", () => {
    const r = validatePlan(
      {
        sourceBranch: "b", trunk: "main", topic: "t",
        layers: [
          layer("drop-app", "Delete the application", [paths[1]]),
          layer("drop-lib", "Delete the library it used", [paths[0]]),
        ],
      },
      a
    );
    assert.equal(r.ok, true, r.errors.join("; "));
  });

  it("rejects deleting a dependency before its dependent", () => {
    const r = validatePlan(
      {
        sourceBranch: "b", trunk: "main", topic: "t",
        layers: [
          layer("drop-lib", "Delete the shared library", [paths[0]]),
          layer("drop-app", "Delete the application", [paths[1]]),
        ],
      },
      a
    );
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("removed too early")),
      r.errors.join("; ")
    );
  });

  it("does not count deleted packages against the line budget", () => {
    const r = validatePlan(
      {
        sourceBranch: "b", trunk: "main", topic: "t",
        layers: [
          layer("drop-app", "Delete the application", [paths[1]]),
          layer("drop-lib", "Delete the library it used", [paths[0]]),
        ],
      },
      a
    );
    assert.equal(r.stats[0].reviewLines, 0, "a whole-package deletion is not a line-by-line read");
    assert.ok(!r.warnings.some((w) => w.includes("line by line")));
  });
});

describe("dependency ordering - edited packages are unconstrained", () => {
  it("imposes no order when the dependency merely changes", () => {
    const paths = [
      "workspace/packages/lib/src/i.ts",
      "workspace/packages/app/src/i.ts",
    ];
    const a = analysisWith(paths, {
      edges: [{ from: "workspace/packages/app", to: "workspace/packages/lib" }],
      units: [
        { kind: "package-edited", key: "workspace/packages/lib", paths: [paths[0]], units: 1, lines: 5 },
        { kind: "package-edited", key: "workspace/packages/app", paths: [paths[1]], units: 1, lines: 5 },
      ],
    });
    const r = validatePlan(
      {
        sourceBranch: "b", trunk: "main", topic: "t",
        layers: [
          layer("app", "Tweak the application", [paths[1]]),
          layer("lib", "Tweak the library", [paths[0]]),
        ],
      },
      a
    );
    assert.equal(r.ok, true, r.errors.join("; "));
  });
});

describe("PR hygiene", () => {
  it("rejects stack position markers in titles", () => {
    const a = analysisWith(["x/a.ts", "x/b.ts"]);
    for (const bad of ["[1/3] Add types", "Add types (2 of 5)", "Part 3 of 4: cleanup"]) {
      const plan = {
        sourceBranch: "b",
        trunk: "main",
        topic: "t",
        layers: [
          layer("one", bad, ["x/a.ts"]),
          layer("two", "A perfectly normal title", ["x/b.ts"]),
        ],
      };
      const r = validatePlan(plan, a);
      assert.equal(r.ok, false, `should reject "${bad}"`);
      assert.ok(r.errors.some((e) => e.includes("stack position markers")));
    }
  });

  it("rejects non-kebab slugs and duplicates", () => {
    const a = analysisWith(["x/a.ts", "x/b.ts"]);
    const plan = {
      sourceBranch: "b",
      trunk: "main",
      topic: "t",
      layers: [
        layer("Not_Kebab", "A perfectly normal title", ["x/a.ts"]),
        layer("Not_Kebab", "Another normal title here", ["x/b.ts"]),
      ],
    };
    const r = validatePlan(plan, a);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("invalid slug")));
    assert.ok(r.errors.some((e) => e.includes("Duplicate layer slugs")));
  });
});

describe("sizing", () => {
  it("warns when a layer is far above the review budget", () => {
    const paths = Array.from({ length: 25 }, (_, i) => `x/f${i}.ts`);
    const plan = {
      sourceBranch: "b",
      trunk: "main",
      topic: "t",
      layers: [layer("huge", "One enormous layer", paths)],
    };
    const r = validatePlan(plan, analysisWith(paths));
    assert.ok(r.warnings.some((w) => w.includes("review units")));
  });

  it("counts a wholly deleted package as one review unit, not N files", () => {
    const paths = Array.from(
      { length: 40 },
      (_, i) => `workspace/packages/gone/src/f${i}.ts`
    );
    const units = [
      {
        kind: "package-deleted",
        key: "workspace/packages/gone",
        paths,
        units: 1,
        lines: 900,
      },
    ];
    const plan = {
      sourceBranch: "b",
      trunk: "main",
      topic: "t",
      layers: [layer("drop", "Delete the obsolete package", paths)],
    };
    const r = validatePlan(plan, analysisWith(paths, { units }));
    assert.equal(r.stats[0].reviewUnits, 1);
    assert.equal(r.stats[0].files, 40);
    assert.ok(!r.warnings.some((w) => w.includes("review units")));
  });

  it("rejects more layers than the maximum", () => {
    const paths = Array.from({ length: 11 }, (_, i) => `x/f${i}.ts`);
    const plan = {
      sourceBranch: "b",
      trunk: "main",
      topic: "t",
      layers: paths.map((p, i) => layer(`l${i}`, `Layer number ${i} here`, [p])),
    };
    const r = validatePlan(plan, analysisWith(paths));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("above the maximum")));
  });
});

describe("branch naming", () => {
  it("encodes topic and creation order, zero-padded", () => {
    assert.equal(
      branchNameFor("users/developer", "rm-obsolete-packages", 0, "delete-e2e"),
      "users/developer/rm-obsolete-packages.01-delete-e2e"
    );
    assert.equal(
      branchNameFor("users/developer", "rm-obsolete-packages", 9, "final"),
      "users/developer/rm-obsolete-packages.10-final"
    );
  });

  it("extracts the user prefix from a conventional branch", () => {
    assert.equal(
      userPrefixFrom("users/developer/remove-obsolete-packages"),
      "users/developer"
    );
    assert.equal(userPrefixFrom("weird-branch", "alias"), "users/alias");
  });
});
