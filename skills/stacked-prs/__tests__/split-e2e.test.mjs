// @ts-check
/**
 * End-to-end: build a real git repo, make a mega-branch, split it, and prove
 * the result is lossless. This is the test that matters - everything else is
 * detail.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STACK = path.join(HERE, "..", "scripts", "stack.mjs");

let repo;

function git(args, cwd = repo) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function stack(args, cwd = repo) {
  const res = spawnSync("node", [STACK, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function write(rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function pkg(name, deps = {}) {
  return JSON.stringify({ name: `@example/${name}`, version: "1.0.0", dependencies: deps }, null, 2);
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "stack-e2e-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  git(["config", "commit.gpgsign", "false"]);

  // Baseline: a lib, a consumer app, and an e2e package.
  write("workspace/packages/lib/package.json", pkg("lib"));
  write("workspace/packages/lib/src/index.ts", "export const v = 1;\n");
  write("workspace/packages/app/package.json", pkg("app", { "@example/lib": "*" }));
  write("workspace/packages/app/src/index.ts", "import { v } from '@example/lib';\nexport default v;\n");
  write("workspace/packages/e2e/package.json", pkg("e2e", { "@example/app": "*" }));
  write("workspace/packages/e2e/src/a.e2e.ts", "test('a', () => {});\n");
  write("workspace/packages/e2e/src/b.e2e.ts", "test('b', () => {});\n");
  write("README.md", "# repo\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);

  // The mega-branch: delete the e2e package entirely, change the lib, update
  // the app to match, and touch a root config file.
  git(["checkout", "-q", "-b", "users/tester/mega"]);
  fs.rmSync(path.join(repo, "workspace/packages/e2e"), { recursive: true });
  write("workspace/packages/newlib/package.json", pkg("newlib"));
  write("workspace/packages/newlib/src/index.ts", "export const shiny = true;\n");
  write("workspace/packages/lib/src/index.ts", "export const v = 2;\nexport const w = 3;\n");
  write("workspace/packages/lib/src/extra.ts", "export const extra = true;\n");
  write("workspace/packages/app/package.json", pkg("app", { "@example/lib": "*", "@example/newlib": "*" }));
  write("workspace/packages/app/src/index.ts", "import { v, w } from '@example/lib';\nimport { shiny } from '@example/newlib';\nexport default shiny ? v + w : 0;\n");
  write("README.md", "# repo\n\nUpdated.\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "mega change"]);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("analyze", () => {
  it("collapses a wholly deleted package into one review unit", () => {
    const r = stack(["analyze", "--base", "main", "--head", "users/tester/mega"]);
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);
    const e2e = a.reviewUnits.find((u) => u.key === "workspace/packages/e2e");
    assert.equal(e2e.kind, "package-deleted");
    assert.equal(e2e.units, 1, "a deleted package is one review decision");
    assert.equal(e2e.fileCount, 3, "…even though it removes 3 files");
  });

  it("reports the app -> newlib dependency edge", () => {
    const a = JSON.parse(
      stack(["analyze", "--base", "main", "--head", "users/tester/mega"]).stdout
    );
    assert.ok(
      a.dependencyEdges.some(
        (e) => e.from === "workspace/packages/app" && e.to === "workspace/packages/newlib"
      )
    );
  });

  it("classifies the brand-new package as an addition worth one unit", () => {
    const a = JSON.parse(
      stack(["analyze", "--base", "main", "--head", "users/tester/mega"]).stdout
    );
    const u = a.reviewUnits.find((x) => x.key === "workspace/packages/newlib");
    assert.equal(u.kind, "package-added");
    assert.equal(u.units, 1);
  });

  it("suggests a layer count from review units, not raw files", () => {
    const a = JSON.parse(
      stack(["analyze", "--base", "main", "--head", "users/tester/mega"]).stdout
    );
    assert.ok(a.totals.reviewUnits < a.totals.filesChanged);
    assert.equal(a.sizing.targetUnitsPerLayer, 10);
  });
});

describe("split", () => {
  // The plan lives OUTSIDE the repo: `split` refuses to run on a dirty tree.
  let planFile;
  const planPath = () => (planFile ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stack-plan-")), "plan.json"));
  after(() => {
    if (planFile) fs.rmSync(path.dirname(planFile), { recursive: true, force: true });
  });

  function writePlan(layers) {
    fs.writeFileSync(
      planPath(),
      JSON.stringify(
        {
          sourceBranch: "users/tester/mega",
          trunk: "main",
          topic: "mega",
          title: "Mega change",
          layers,
        },
        null,
        2
      )
    );
  }

  it("refuses to write anything without --yes", () => {
    writePlan([
      {
        slug: "lib",
        title: "Extend the shared library",
        paths: [
          "workspace/packages/lib/src/index.ts",
          "workspace/packages/lib/src/extra.ts",
          "workspace/packages/newlib/package.json",
          "workspace/packages/newlib/src/index.ts",
        ],
      },
      {
        slug: "rest",
        title: "Update the app and drop the e2e package",
        paths: [
          "workspace/packages/app/src/index.ts",
          "workspace/packages/app/package.json",
          "workspace/packages/e2e/package.json",
          "workspace/packages/e2e/src/a.e2e.ts",
          "workspace/packages/e2e/src/b.e2e.ts",
          "README.md",
        ],
      },
    ]);
    const r = stack(["split", "--plan", planPath(), "--no-lockfile", "--no-changefiles"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /without confirmation/i);
    assert.equal(git(["branch", "--list", "users/tester/mega.*"]), "");
  });

  it("rejects an inverted plan before touching git", () => {
    writePlan([
      {
        slug: "app-first",
        title: "Update the consuming app",
        paths: [
          "workspace/packages/app/src/index.ts",
          "workspace/packages/app/package.json",
        ],
      },
      {
        slug: "lib-second",
        title: "Add the new library the app imports",
        paths: [
          "workspace/packages/newlib/package.json",
          "workspace/packages/newlib/src/index.ts",
          "workspace/packages/lib/src/index.ts",
          "workspace/packages/lib/src/extra.ts",
          "workspace/packages/e2e/package.json",
          "workspace/packages/e2e/src/a.e2e.ts",
          "workspace/packages/e2e/src/b.e2e.ts",
          "README.md",
        ],
      },
    ]);
    const r = stack([
      "split", "--plan", planPath(), "--yes", "--no-lockfile", "--no-changefiles",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Dependency inverted/);
    assert.equal(git(["branch", "--list", "users/tester/mega.*"]), "");
  });

  it("rejects an incomplete plan", () => {
    writePlan([
      { slug: "partial", title: "Only part of the change", paths: ["README.md"] },
    ]);
    const r = stack([
      "split", "--plan", planPath(), "--yes", "--no-lockfile", "--no-changefiles",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not assigned to any layer/);
  });

  it("creates the stack and proves it is lossless", () => {
    writePlan([
      {
        slug: "extend-lib",
        title: "Extend the shared library and add the new one",
        paths: [
          "workspace/packages/lib/src/index.ts",
          "workspace/packages/lib/src/extra.ts",
          "workspace/packages/newlib/package.json",
          "workspace/packages/newlib/src/index.ts",
        ],
      },
      {
        slug: "update-app",
        title: "Update the app for the new library exports",
        paths: [
          "workspace/packages/app/src/index.ts",
          "workspace/packages/app/package.json",
        ],
      },
      {
        slug: "drop-e2e",
        title: "Delete the obsolete e2e package and refresh the README",
        paths: [
          "workspace/packages/e2e/package.json",
          "workspace/packages/e2e/src/a.e2e.ts",
          "workspace/packages/e2e/src/b.e2e.ts",
          "README.md",
        ],
      },
    ]);

    const r = stack([
      "split", "--plan", planPath(), "--yes", "--no-lockfile", "--no-changefiles",
    ]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /Verified lossless/);

    const branches = git(["branch", "--format=%(refname:short)"])
      .split("\n")
      .filter((b) => b.startsWith("users/tester/mega."))
      .sort();
    assert.deepEqual(branches, [
      "users/tester/mega.01-extend-lib",
      "users/tester/mega.02-update-app",
      "users/tester/mega.03-drop-e2e",
    ]);

    // THE invariant: the top layer's tree is identical to the source branch.
    const delta = git([
      "diff", "--name-only", "users/tester/mega.03-drop-e2e", "users/tester/mega",
    ]);
    assert.equal(delta, "", `top layer differs from source:\n${delta}`);
  });

  it("chains each branch onto the one below it", () => {
    assert.equal(
      execFileSync("git", ["merge-base", "--is-ancestor", "users/tester/mega.01-extend-lib", "users/tester/mega.02-update-app"], { cwd: repo, encoding: "utf8" }),
      ""
    );
    // layer 1 must NOT contain layer 2's work
    const r = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", "users/tester/mega.02-update-app", "users/tester/mega.01-extend-lib"],
      { cwd: repo }
    );
    assert.notEqual(r.status, 0, "layers must be strictly ordered");
  });

  it("each layer is a coherent tree - the bottom layer has no later work in it", () => {
    const libAtL1 = git(["show", "users/tester/mega.01-extend-lib:workspace/packages/lib/src/index.ts"]);
    assert.match(libAtL1, /w = 3/, "layer 1 contains its own change");
    const appAtL1 = git(["show", "users/tester/mega.01-extend-lib:workspace/packages/app/src/index.ts"]);
    assert.doesNotMatch(appAtL1, /newlib/, "layer 1 must not contain layer 2's change");
    // the e2e package still exists at layer 1 and 2, and is gone at layer 3
    assert.ok(git(["ls-tree", "-r", "--name-only", "users/tester/mega.02-update-app", "--", "workspace/packages/e2e"]).length > 0);
    assert.equal(git(["ls-tree", "-r", "--name-only", "users/tester/mega.03-drop-e2e", "--", "workspace/packages/e2e"]), "");
  });

  it("records machine-local state under .git and nowhere else", () => {
    assert.ok(fs.existsSync(path.join(repo, ".git", "stacked-prs", "stacks.json")));
    assert.equal(git(["status", "--porcelain"]), "", "stack state must be invisible to git");
    const st = JSON.parse(stack(["status"]).stdout);
    assert.equal(st.inStack, true);
    assert.equal(st.stack.branches.length, 3);
    assert.equal(st.stack.branches[0].parent, "main");
    assert.equal(st.stack.branches[1].parent, "users/tester/mega.01-extend-lib");
  });

  it("renders the stack map bottom-up", () => {
    const out = stack(["view"], repo).stdout;
    const lines = out.split("\n").filter(Boolean);
    assert.match(lines[0], /mega\.03-drop-e2e/);
    assert.equal(lines[lines.length - 1], "main (trunk)");
  });
});
