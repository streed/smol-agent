/**
 * Diff visualization for file changes.
 *
 * Generates git-style unified diffs with chalk coloring for terminal display.
 * Shows additions (green), deletions (red), and context lines (dim).
 *
 * Key exports:
 *   - formatDiff(oldText, newText, filePath, opts): Generate unified diff
 *   - formatReplaceDiff(filePath, oldText, newText, replacement): Diff for replace_in_file
 *   - formatNewFileDiff(filePath, content): Diff for new file creation
 *   - computeEditScript(oldLines, newLines): Myers diff algorithm
 *   - buildHunks(ops, contextLines): Group changes into hunks
 *
 * The diff is limited to prevent flooding the TUI (default 40 lines max).
 * For very large files, returns a summary instead of computing full diff.
 *
 * Dependencies: chalk
 * Depended on by: src/agent.js, src/context.js, src/providers/anthropic.js,
 *                 src/providers/base.js, src/providers/errors.js, src/tool-call-parser.js,
 *                 src/tools/cross_agent.js, src/tools/file_tools.js, src/tools/git.js, src/ui/App.js,
 *                 test/e2e/scenarios/55-git-safety.test.js, test/unit/agent-registry.test.js,
 *                 test/unit/cross-agent.test.js, test/unit/repo-map.test.js
 */

import chalk from "chalk";

interface DiffOptions {
  contextLines?: number;
  maxLines?: number;
  plain?: boolean;
}

interface EditOp {
  type: "keep" | "del" | "add";
  line: string;
  oldIdx?: number;
  newIdx?: number;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  ops: EditOp[];
}

interface Styles {
  dim: (s: string) => string;
  bold: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  cyan: (s: string) => string;
}

/** Build a style helper — chalk for TUI, identity for plain text. */
function _styles(plain: boolean): Styles {
  if (!plain) return { dim: chalk.dim, bold: chalk.bold, red: chalk.red, green: chalk.green, cyan: chalk.cyan };
  const id = (s: string) => s;
  return { dim: id, bold: id, red: id, green: id, cyan: id };
}

/** Build the gutter prefix — decorated for TUI, empty for plain. */
function _prefix(plain: boolean, s: string): string {
  return plain ? "" : s;
}

export function formatDiff(oldText: string, newText: string, filePath: string, opts: DiffOptions = {}): string[] {
  const { contextLines = 3, maxLines = 40, plain = false } = opts;
  const s = _styles(plain);
  const pfx = (str: string) => _prefix(plain, str);

  if (oldText === newText) return [];

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // For very large files, bail out with a summary instead of computing a full diff
  if (oldLines.length * newLines.length > 2_000_000) {
    return [
      s.dim(`${pfx("    ⎿  ")}diff too large (${oldLines.length} → ${newLines.length} lines)`),
    ];
  }

  const ops = computeEditScript(oldLines, newLines);
  if (!ops) {
    return [
      s.dim(`${pfx("    ⎿  ")}diff too large to compute`),
    ];
  }

  const hunks = buildHunks(ops, contextLines);
  if (hunks.length === 0) return [];

  // Format output
  const lines: string[] = [];
  lines.push(s.dim(pfx("    ⎿  ")) + s.bold(`diff ${filePath}`));
  lines.push(s.dim(pfx("    ⎿  ")) + s.red(`--- a/${filePath}`));
  lines.push(s.dim(pfx("    ⎿  ")) + s.green(`+++ b/${filePath}`));

  let outputCount = 3;
  let truncated = false;

  for (const hunk of hunks) {
    if (outputCount >= maxLines - 1) {
      truncated = true;
      break;
    }

    // Hunk header
    const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    lines.push(s.dim(pfx("    ⎿  ")) + s.cyan(header));
    outputCount++;

    for (const op of hunk.ops) {
      if (outputCount >= maxLines - 1) {
        truncated = true;
        break;
      }

      if (op.type === "keep") {
        lines.push(s.dim(pfx("    ⎿  ")) + s.dim(` ${op.line}`));
      } else if (op.type === "del") {
        lines.push(s.dim(pfx("    ⎿  ")) + s.red(`-${op.line}`));
      } else if (op.type === "add") {
        lines.push(s.dim(pfx("    ⎿  ")) + s.green(`+${op.line}`));
      }
      outputCount++;
    }
  }

  if (truncated) {
    lines.push(s.dim(pfx("    ⎿  ")) + s.dim(`... (diff truncated)`));
  }

  return lines;
}

/**
 * Generate a diff specifically for a replace operation where we know
 * the exact old and new text. This is more efficient than a full file diff
 * since we can show just the replacement with surrounding context.
 */
export function formatReplaceDiff(fileContent: string, oldText: string, newText: string, filePath: string, opts: DiffOptions = {}): string[] {
  const { contextLines = 3, maxLines = 40, plain = false } = opts;
  const s = _styles(plain);
  const pfx = (str: string) => _prefix(plain, str);

  // Find the location of oldText in fileContent
  const idx = fileContent.indexOf(oldText);
  if (idx === -1) {
    return [s.dim(`${pfx("    ⎿  ")}oldText not found in file`)];
  }

  // Get line numbers
  const beforeLines = fileContent.slice(0, idx).split("\n");
  const startLine = beforeLines.length;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Build context
  const fileLines = fileContent.split("\n");
  const contextStart = Math.max(0, startLine - 1 - contextLines);
  const contextEnd = Math.min(fileLines.length, startLine - 1 + oldLines.length + contextLines);

  const lines: string[] = [];
  lines.push(s.dim(pfx("    ⎿  ")) + s.bold(`diff ${filePath}`));
  lines.push(s.dim(pfx("    ⎿  ")) + s.red(`--- a/${filePath}`));
  lines.push(s.dim(pfx("    ⎿  ")) + s.green(`+++ b/${filePath}`));

  // Hunk header
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const header = `@@ -${startLine},${oldCount} +${startLine},${newCount} @@`;
  lines.push(s.dim(pfx("    ⎿  ")) + s.cyan(header));

  // Context before
  for (let i = contextStart; i < startLine - 1; i++) {
    lines.push(s.dim(pfx("    ⎿  ")) + s.dim(` ${fileLines[i]}`));
  }

  // Deleted lines
  for (const line of oldLines) {
    lines.push(s.dim(pfx("    ⎿  ")) + s.red(`-${line}`));
  }

  // Added lines
  for (const line of newLines) {
    lines.push(s.dim(pfx("    ⎿  ")) + s.green(`+${line}`));
  }

  // Context after
  const afterStart = startLine - 1 + oldLines.length;
  for (let i = afterStart; i < contextEnd; i++) {
    lines.push(s.dim(pfx("    ⎿  ")) + s.dim(` ${fileLines[i]}`));
  }

  // Truncate if needed
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines - 1).concat([s.dim(pfx("    ⎿  ")) + s.dim("... (diff truncated)")]);
  }

  return lines;
}

/**
 * Generate a diff for a new file creation.
 */
export function formatNewFileDiff(filePath: string, content: string, opts: DiffOptions = {}): string[] {
  const { maxLines = 40, plain = false } = opts;
  const s = _styles(plain);
  const pfx = (str: string) => _prefix(plain, str);

  const lines: string[] = [];
  lines.push(s.dim(pfx("    ⎿  ")) + s.bold(`new file: ${filePath}`));
  lines.push(s.dim(pfx("    ⎿  ")) + s.green(`+++ b/${filePath}`));

  const contentLines = content.split("\n");
  const truncated = contentLines.length > maxLines - 2;

  for (let i = 0; i < Math.min(contentLines.length, maxLines - 2); i++) {
    lines.push(s.dim(pfx("    ⎿  ")) + s.green(`+${contentLines[i]}`));
  }

  if (truncated) {
    lines.push(s.dim(pfx("    ⎿  ")) + s.dim(`... (${contentLines.length - maxLines + 2} more lines)`));
  }

  return lines;
}

/**
 * Compute an edit script using the Myers diff algorithm.
 * Returns null if the diff is too large to compute efficiently.
 */
export function computeEditScript(oldLines: string[], newLines: string[]): EditOp[] | null {
  const MAX_EDITS = 10_000;
  const MAX_DIAGONAL = 5_000;

  const n = oldLines.length;
  const m = newLines.length;

  // Myers diff algorithm
  // We use the O(ND) algorithm where D is the edit distance
  const maxD = Math.min(n + m, MAX_EDITS);
  const v: Record<number, number> = { 1: 0 };

  const trace: Array<Record<number, number>> = [];

  for (let d = 0; d <= maxD; d++) {
    trace.push({ ...v });
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[k - 1] ?? 0) < (v[k + 1] ?? 0))) {
        x = v[k + 1] ?? 0;
      } else {
        x = (v[k - 1] ?? 0) + 1;
      }
      let y = x - k;

      // Follow diagonal
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      v[k] = x;

      if (x >= n && y >= m) {
        // Found path — backtrack to find edit script
        return backtrack(oldLines, newLines, trace, d);
      }
    }
  }

  // Too many edits
  return null;
}

function backtrack(oldLines: string[], newLines: string[], trace: Array<Record<number, number>>, d: number): EditOp[] {
  const ops: EditOp[] = [];
  let x = oldLines.length;
  let y = newLines.length;

  for (let i = d; i >= 0; i--) {
    const v = trace[i];
    const k = x - y;

    let prevK: number;
    if (k === -i || (k !== i && (v[k - 1] ?? 0) < (v[k + 1] ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = v[prevK] ?? 0;
    const prevY = prevX - prevK;

    // Add diagonal moves (keeps)
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.unshift({ type: "keep", line: oldLines[x], oldIdx: x, newIdx: y });
    }

    if (i > 0) {
      if (x === prevX) {
        // Insertion
        y--;
        ops.unshift({ type: "add", line: newLines[y], newIdx: y });
      } else {
        // Deletion
        x--;
        ops.unshift({ type: "del", line: oldLines[x], oldIdx: x });
      }
    }
  }

  return ops;
}

/**
 * Group edit operations into hunks with context.
 */
export function buildHunks(ops: EditOp[], contextLines: number): Hunk[] {
  if (ops.length === 0) return [];

  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  let oldLine = 1;
  let newLine = 1;

  for (const op of ops) {
    const isChange = op.type !== "keep";
    const shouldStartHunk = isChange && !currentHunk;
    const shouldExtendHunk = isChange && currentHunk;

    if (shouldStartHunk) {
      // Start a new hunk with context
      const startOld = Math.max(1, oldLine - contextLines);
      const startNew = Math.max(1, newLine - contextLines);

      currentHunk = {
        oldStart: startOld,
        oldCount: 0,
        newStart: startNew,
        newCount: 0,
        ops: [],
      };

      // Add context lines before the change
      for (let i = Math.max(0, oldLine - contextLines - 1); i < oldLine - 1; i++) {
        if (ops.find(o => o.type === "keep" && o.oldIdx === i)) {
          currentHunk.ops.push({ type: "keep", line: ops.find(o => o.oldIdx === i && o.type === "keep")!.line });
        }
      }

      hunks.push(currentHunk);
    }

    if (op.type === "keep") {
      if (currentHunk) {
        currentHunk.ops.push(op);
      }
      oldLine++;
      newLine++;
    } else if (op.type === "del") {
      if (currentHunk) {
        currentHunk.ops.push(op);
        currentHunk.oldCount++;
      }
      oldLine++;
    } else if (op.type === "add") {
      if (currentHunk) {
        currentHunk.ops.push(op);
        currentHunk.newCount++;
      }
      newLine++;
    }
  }

  // Add context lines after the last change in each hunk
  for (const hunk of hunks) {
    // Count context after
    let lastChangeIdx = -1;
    for (let i = hunk.ops.length - 1; i >= 0; i--) {
      if (hunk.ops[i].type !== "keep") {
        lastChangeIdx = i;
        break;
      }
    }
    
    if (lastChangeIdx >= 0) {
      // Add context lines after the last change
      const lastChangeOldIdx = hunk.ops[lastChangeIdx]?.oldIdx ?? 0;
      const keepOpsAfter = ops.filter(op =>
        op.type === "keep" &&
        op.oldIdx !== undefined &&
        op.oldIdx > lastChangeOldIdx
      ).slice(0, contextLines);

      for (const op of keepOpsAfter) {
        hunk.ops.push(op);
      }
    }
  }

  // Calculate counts for each hunk
  for (const hunk of hunks) {
    hunk.oldCount = hunk.ops.filter(op => op.type === "del" || op.type === "keep").length;
    hunk.newCount = hunk.ops.filter(op => op.type === "add" || op.type === "keep").length;
  }

  return hunks;
}