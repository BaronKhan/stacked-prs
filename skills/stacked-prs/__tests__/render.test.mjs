// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyFooter,
  MARK_BEGIN,
  MARK_END,
  renderFooter,
  renderStack,
} from "../scripts/lib/render.mjs";

const stack = {
  id: "1",
  title: "Remove obsolete-packages",
  topic: "rm-obsolete-packages",
  trunk: "main",
  remote: "origin",
  createdAt: "x",
  updatedAt: "x",
  branches: [
    { name: "users/me/rm.01-a", parent: "main", prId: 101, state: "merged", isDraft: false },
    { name: "users/me/rm.02-b", parent: "users/me/rm.01-a", prId: 102, state: "open", isDraft: true },
    { name: "users/me/rm.03-c", parent: "users/me/rm.02-b", prId: 103, state: "open", isDraft: true },
  ],
};

const url = (id) => `https://example/pr/${id}`;

describe("stack map", () => {
  it("draws trunk at the bottom and the top layer at the top", () => {
    const out = renderStack(stack, { current: "users/me/rm.02-b" });
    const lines = out.split("\n").filter(Boolean);
    assert.ok(lines[0].includes("rm.03-c"), "top layer should be first");
    assert.equal(lines[lines.length - 1], "main (trunk)");
  });

  it("marks top, bottom and the current branch", () => {
    const out = renderStack(stack, { current: "users/me/rm.02-b" });
    assert.match(out, /rm\.03-c.*← top/);
    assert.match(out, /rm\.01-a.*← bottom/);
    assert.match(out, /rm\.02-b.*● you are here/);
  });

  it("shows merged state distinctly", () => {
    const out = renderStack(stack);
    assert.match(out, /✔ users\/me\/rm\.01-a/);
    assert.match(out, /○ users\/me\/rm\.02-b/);
  });

  it("is deterministic", () => {
    assert.equal(renderStack(stack), renderStack(stack));
  });

  it("--short lists branches top-first and nothing else", () => {
    const out = renderStack(stack, { short: true });
    assert.deepEqual(out.split("\n"), [
      "users/me/rm.03-c",
      "users/me/rm.02-b",
      "users/me/rm.01-a",
    ]);
  });
});

describe("PR footer", () => {
  it("uses the hosting provider's PR and MR notation", () => {
    assert.match(renderFooter({ ...stack, provider: "github" }, stack.branches[1].name, url), /#102<\/a> ← this PR/);
    assert.match(renderFooter({ ...stack, provider: "gitlab" }, stack.branches[1].name, url), /!102<\/a> ← this MR/);
    assert.match(renderStack({ ...stack, provider: "gitlab" }), /MR !102/);
  });
  it("is omitted when there is only one PR - one PR is not a stack", () => {
    const single = { ...stack, branches: [stack.branches[0]] };
    assert.equal(renderFooter(single, "users/me/rm.01-a", url), null);
  });

  it("marks the current PR and strikes through merged ones", () => {
    const f = renderFooter(stack, "users/me/rm.02-b", url);
    assert.match(f, /!102<\/a> ← this PR/);
    assert.match(f, /<s><a href="https:\/\/example\/pr\/101">!101<\/a><\/s>/);
  });

  it("carries no [n/m] position marker", () => {
    const f = renderFooter(stack, "users/me/rm.02-b", url);
    assert.doesNotMatch(f, /\[\d+\/\d+\]/);
  });
});

describe("footer insertion", () => {
  const body = "## Summary\n\nDoes a thing.\n";

  it("appends after a --- divider and leaves prose untouched", () => {
    const f = renderFooter(stack, "users/me/rm.02-b", url);
    const out = applyFooter(body, f);
    assert.ok(out.startsWith("## Summary\n\nDoes a thing."));
    assert.match(out, /\n---\n/);
    assert.ok(out.includes(MARK_BEGIN) && out.includes(MARK_END));
  });

  it("is idempotent - re-applying does not duplicate the block", () => {
    const f = renderFooter(stack, "users/me/rm.02-b", url);
    const once = applyFooter(body, f);
    const twice = applyFooter(once, f);
    assert.equal(once, twice);
    assert.equal(twice.match(/stacked-prs:begin/g).length, 1);
  });

  it("replaces a stale footer rather than stacking a second one", () => {
    const oldF = renderFooter(stack, "users/me/rm.01-a", url);
    const newF = renderFooter(stack, "users/me/rm.03-c", url);
    const out = applyFooter(applyFooter(body, oldF), newF);
    assert.equal(out.match(/stacked-prs:begin/g).length, 1);
    assert.match(out, /!103<\/a> ← this PR/);
  });

  it("removes the footer and its divider cleanly on unstack", () => {
    const f = renderFooter(stack, "users/me/rm.02-b", url);
    const withFooter = applyFooter(body, f);
    const stripped = applyFooter(withFooter, null);
    assert.equal(stripped, "## Summary\n\nDoes a thing.");
    assert.ok(!stripped.includes("stacked-prs"));
    assert.ok(!stripped.trimEnd().endsWith("---"));
  });

  it("handles an empty description", () => {
    const f = renderFooter(stack, "users/me/rm.02-b", url);
    const out = applyFooter("", f);
    assert.ok(out.startsWith("\n\n---") || out.startsWith("---"));
    assert.ok(out.includes(MARK_BEGIN));
  });
});
