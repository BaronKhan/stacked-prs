// @ts-check
/**
 * render.mjs - all human-facing output.
 *
 * Deterministic: the same state always produces the same picture. That property
 * is what makes the golden tests meaningful and what lets the model quote the
 * map back to the user without re-deriving anything.
 */

const MARK_BEGIN = "<!-- stacked-prs:begin -->";
const MARK_END = "<!-- stacked-prs:end -->";

const STATUS_GLYPH = {
  merged: "✔",
  open: "○",
  abandoned: "✖",
  unsubmitted: "·",
};

/**
 * The stack map, drawn bottom-up like the GitHub docs: trunk at the bottom,
 * top of the stack at the top.
 *
 * @param {import("./state.mjs").Stack} stack
 * @param {{current?:string|null, prUrl?:(id:number)=>string, short?:boolean}} [opts]
 */
export function renderStack(stack, opts = {}) {
  const { current = null, short = false } = opts;
  const lines = [];
  const branches = stack.branches;

  if (short) {
    for (let i = branches.length - 1; i >= 0; i--) {
      lines.push(branches[i].name);
    }
    return lines.join("\n");
  }

  const label = (b) => {
    const parts = [];
    const kind = stack.provider === "gitlab" ? "MR" : "PR";
    const marker = stack.provider === "github" ? "#" : "!";
    parts.push(b.prId ? `${kind} ${marker}${b.prId}` : `no ${kind} yet`);
    if (b.isDraft && b.prId) parts.push("draft");
    if (b.state === "merged") parts.push("merged");
    if (b.state === "abandoned") parts.push("abandoned");
    return parts.join(", ");
  };

  const width = Math.max(...branches.map((b) => b.name.length), 10);

  lines.push("");
  for (let i = branches.length - 1; i >= 0; i--) {
    const b = branches[i];
    const indent = " ".repeat(i + 1);
    const glyph = STATUS_GLYPH[b.state] ?? "○";
    const here = current && b.name === current ? "  ● you are here" : "";
    const pos =
      i === branches.length - 1 && branches.length > 1
        ? "  ← top"
        : i === 0 && branches.length > 1
          ? "  ← bottom"
          : "";
    lines.push(
      `${indent}┌── ${glyph} ${b.name.padEnd(width)}  → ${label(b)}  (base: ${
        b.parent
      })${pos}${here}`
    );
  }
  lines.push(`${stack.trunk} (trunk)`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Preview of a proposed split, before anything is written.
 * @param {import("./plan.mjs").Plan} plan
 * @param {any[]} stats from validatePlan
 */
export function renderPlan(plan, stats) {
  const lines = [];
  const totalUnits = stats.reduce((n, s) => n + s.reviewUnits, 0);
  const totalLines = stats.reduce((n, s) => n + s.lines, 0);
  lines.push("");
  lines.push(
    `  Proposed stack - ${plan.layers.length} layers, ${totalUnits} review units, ~${totalLines} lines`
  );
  lines.push(`  ${"─".repeat(72)}`);
  for (let i = plan.layers.length - 1; i >= 0; i--) {
    const s = stats[i];
    const arrow =
      i === plan.layers.length - 1 ? "▲" : i === 0 ? "▼" : " ";
    lines.push(
      `   ${arrow} ${String(i + 1).padStart(2, "0")}  ${s.title.slice(0, 44).padEnd(44)} ${String(
        s.reviewUnits
      ).padStart(3)} units ${String(s.lines).padStart(6)} lines`
    );
  }
  lines.push(`  ${"─".repeat(72)}`);
  lines.push(`  ${plan.trunk} (trunk)`);
  lines.push("");
  return lines.join("\n");
}

/**
 * The PR description footer.
 *
 * Deliberately small and placed after a `---` divider: each PR must read as a
 * normal standalone PR. No "[2/5]" in the title or body - only this footer
 * links the stack together.
 *
 * @param {import("./state.mjs").Stack} stack
 * @param {string} branchName the branch this PR belongs to
 * @param {(id:number)=>string} prUrl
 */
export function renderFooter(stack, branchName, prUrl) {
  const submitted = stack.branches.filter((b) => b.prId);
  if (submitted.length < 2) return null; // one PR is not a stack

  const parts = submitted.map((b) => {
    const link = `<a href="${prUrl(b.prId)}">${stack.provider === "github" ? "#" : "!"}${b.prId}</a>`;
    if (b.name === branchName) return `${link} ← this ${stack.provider === "gitlab" ? "MR" : "PR"}`;
    if (b.state === "merged") return `<s>${link}</s>`;
    return link;
  });

  return [
    MARK_BEGIN,
    "<sub>📚 Part of a stack created with the `stacked-prs` skill.",
    `Merge bottom-up: ${parts.join(" · ")}</sub>`,
    MARK_END,
  ].join("\n");
}

/**
 * Insert or replace the footer in a PR description without touching the
 * author's prose. Idempotent: running it twice yields the same string.
 * @param {string} description
 * @param {string|null} footer
 */
export function applyFooter(description, footer) {
  const body = description ?? "";
  const begin = body.indexOf(MARK_BEGIN);
  const end = body.indexOf(MARK_END);

  let prose = body;
  if (begin !== -1 && end !== -1 && end > begin) {
    prose = body.slice(0, begin) + body.slice(end + MARK_END.length);
    // also drop the divider we previously added
    prose = prose.replace(/\n*---\s*$/, "");
  }
  prose = prose.replace(/\s+$/, "");

  if (!footer) return prose;
  return `${prose}\n\n---\n\n${footer}\n`;
}

/** Human-readable summary of an interrupted operation. */
export function renderJournalWarning(journal) {
  const done = journal.steps.filter((s) => s.status === "done").length;
  const conflicted = journal.steps.find((s) => s.status === "conflict");
  const lines = [
    "",
    `  ⚠️  An interrupted \`${journal.op}\` was found on stack ${journal.stackId}.`,
    `      Started ${journal.startedAt}; ${done}/${journal.steps.length} branches completed.`,
  ];
  if (conflicted) {
    lines.push(`      Stopped on: ${conflicted.branch} (conflict)`);
  }
  lines.push(
    "      Resolve and run `--continue`, or run `--abort` to restore every branch to:"
  );
  for (const [branch, sha] of Object.entries(journal.backupRefs)) {
    lines.push(`        ${branch} → ${String(sha).slice(0, 8)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export { MARK_BEGIN, MARK_END };
