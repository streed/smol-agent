import chalk from "chalk";

/**
 * Generate a git-style unified diff between two texts.
 * Returns an array of chalk-colored strings ready for TUI display.
 *
 * @param {string} oldText  - Original file content (empty string for new files)
 * @param {string} newText  - New file content
 * @param {string} filePath - File path for the diff header
 * @param {object} opts
 * @param {number} opts.contextLines - Number of context lines around changes (default 3)
 * @param {number} opts.maxLines     - Max output lines to prevent flooding the TUI (default 40)
 * @returns {string[]} Array of chalk-styled strings
 */
export function formatDiff(oldText, newText, filePath, opts = {}) {
  const { contextLines = 3, maxLines = 40 } = opts;

  if (oldText === newText) return [];

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // For very large files, bail out with a summary instead of computing a full diff
  if (oldLines.length * newLines.length > 2_000_000) {
    return [
      chalk.dim(`    ⎿  diff too large (${oldLines.length} → ${newLines.length} lines)`),
    ];
  }

  const ops = computeEditScript(oldLines, newLines);
  if (!ops) {
    return [
      chalk.dim(`    ⎿  diff too large to compute`),
    ];
  }

  const hunks = buildHunks(ops, contextLines);
  if (hunks.length === 0) return [];

  // Format output
  const lines = [];
  lines.push(chalk.dim(`    ⎿  `) + chalk.bold(`diff ${filePath}`));
  lines.push(chalk.dim(`    ⎿  `) + chalk.red(`--- a/${filePath}`));
  lines.push(chalk.dim(`    ⎿  `) + chalk.green(`+++ b/${filePath}`));

  let outputCount = 3;
  let truncated = false;

  for (const hunk of hunks) {
    if (outputCount >= maxLines - 1) {
      truncated = true;
      break;
    }

    // Hunk header
    const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    lines.push(chalk.dim(`    ⎿  `) + chalk.cyan(header));
    outputCount++;

    for (const op of hunk.ops) {
      if (outputCount >= maxLines - 1) {
        truncated = true;
        break;
      }

      if (op.type === "keep") {
        lines.push(chalk.dim(`    ⎿  `) + chalk.dim(` ${op.line}`));
      } else if (op.type === "del") {
        lines.push(chalk.dim(`    ⎿  `) + chalk.red(`-${op.line}`));
      } else if (op.type === "add") {
        lines.push(chalk.dim(`    ⎿  `) + chalk.green(`+${op.line}`));
      }
      outputCount++;
    }
  }

  if (truncated) {
    lines.push(chalk.dim(`    ⎿  `) + chalk.dim(`... (diff truncated)`));
  }

  return lines;
}

/**
 * Generate a diff specifically for a replace operation where we know
 * the exact old and new text. This is more efficient than a full file diff
 * since we can show just the replacement with surrounding context.
 *
 * @param {string} fileContent  - Full original file content
 * @param {string} oldText      - The text that was replaced
 * @param {string} newText      - The replacement text
 * @param {string} filePath     - File path for the header
 * @param {object} opts
 * @param {number} opts.contextLines - Context lines around the change (default 3)
 * @param {number} opts.maxLines     - Max output lines (default 40)
 * @returns {string[]}
 */
export function formatReplaceDiff(fileContent, oldText, newText, filePath, opts = {}) {
  const { contextLines = 3, maxLines = 40 } = opts;

  const fileLines = fileContent.split("\n");
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Find where the replacement starts in the file
  const replaceIdx = fileContent.indexOf(oldText);
  if (replaceIdx === -1) return [];

  // Count the line number where the replacement starts
  const startLine = fileContent.slice(0, replaceIdx).split("\n").length - 1;

  // Gather context before
  const ctxBefore = [];
  for (let i = Math.max(0, startLine - contextLines); i < startLine; i++) {
    ctxBefore.push(fileLines[i]);
  }

  // Gather context after
  const afterLine = startLine + oldLines.length;
  const ctxAfter = [];
  for (let i = afterLine; i < Math.min(fileLines.length, afterLine + contextLines); i++) {
    ctxAfter.push(fileLines[i]);
  }

  // Build output
  const lines = [];
  lines.push(chalk.dim(`    ⎿  `) + chalk.bold(`diff ${filePath}`));
  lines.push(chalk.dim(`    ⎿  `) + chalk.red(`--- a/${filePath}`));
  lines.push(chalk.dim(`    ⎿  `) + chalk.green(`+++ b/${filePath}`));

  const oldStart = Math.max(0, startLine - contextLines) + 1; // 1-based
  const oldCount = ctxBefore.length + oldLines.length + ctxAfter.length;
  const newCount = ctxBefore.length + newLines.length + ctxAfter.length;
  const newStart = oldStart;

  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  lines.push(chalk.dim(`    ⎿  `) + chalk.cyan(header));

  let outputCount = 4;

  // Context before
  for (const line of ctxBefore) {
    if (outputCount >= maxLines - 1) break;
    lines.push(chalk.dim(`    ⎿  `) + chalk.dim(` ${line}`));
    outputCount++;
  }

  // Removed lines
  for (const line of oldLines) {
    if (outputCount >= maxLines - 1) break;
    lines.push(chalk.dim(`    ⎿  `) + chalk.red(`-${line}`));
    outputCount++;
  }

  // Added lines
  for (const line of newLines) {
    if (outputCount >= maxLines - 1) break;
    lines.push(chalk.dim(`    ⎿  `) + chalk.green(`+${line}`));
    outputCount++;
  }

  // Context after
  for (const line of ctxAfter) {
    if (outputCount >= maxLines - 1) break;
    lines.push(chalk.dim(`    ⎿  `) + chalk.dim(` ${line}`));
    outputCount++;
  }

  if (outputCount >= maxLines - 1) {
    lines.push(chalk.dim(`    ⎿  `) + chalk.dim(`... (diff truncated)`));
  }

  return lines;
}

/**
 * Format a "new file" diff — shows the first few lines as all additions.
 */
export function formatNewFileDiff(content, filePath, opts = {}) {
  const { maxLines = 20 } = opts;
  const contentLines = content.split("\n");
  const lines = [];

  lines.push(chalk.dim(`    ⎿  `) + chalk.bold(`diff ${filePath} (new file)`));
  lines.push(chalk.dim(`    ⎿  `) + chalk.green(`+++ b/${filePath}`));

  const header = `@@ -0,0 +1,${contentLines.length} @@`;
  lines.push(chalk.dim(`    ⎿  `) + chalk.cyan(header));

  let outputCount = 3;
  for (const line of contentLines) {
    if (outputCount >= maxLines - 1) {
      lines.push(chalk.dim(`    ⎿  `) + chalk.dim(`... +${contentLines.length - outputCount + 3} more lines`));
      break;
    }
    lines.push(chalk.dim(`    ⎿  `) + chalk.green(`+${line}`));
    outputCount++;
  }

  return lines;
}


// ── Internal: LCS-based edit script ─────────────────────────────────

/**
 * Compute an edit script (array of {type, line} ops) using LCS.
 * Returns null if the inputs are too large to diff efficiently.
 */
function computeEditScript(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;

  // Safety cap for very large files
  if (m + n > 4000) return null;

  // Build LCS table
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce edit operations
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: "keep", line: oldLines[i - 1], oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "add", line: newLines[j - 1], newIdx: j - 1 });
      j--;
    } else {
      ops.unshift({ type: "del", line: oldLines[i - 1], oldIdx: i - 1 });
      i--;
    }
  }

  return ops;
}

/**
 * Group edit operations into unified-diff hunks with context lines.
 */
function buildHunks(ops, contextLines) {
  // Find ranges of changes (non-keep ops)
  const changeIndices = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "keep") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Group nearby changes into hunks
  const groups = [];
  let groupStart = changeIndices[0];
  let groupEnd = changeIndices[0];

  for (let k = 1; k < changeIndices.length; k++) {
    if (changeIndices[k] - groupEnd <= contextLines * 2 + 1) {
      // Merge into current group
      groupEnd = changeIndices[k];
    } else {
      groups.push([groupStart, groupEnd]);
      groupStart = changeIndices[k];
      groupEnd = changeIndices[k];
    }
  }
  groups.push([groupStart, groupEnd]);

  // Build hunks with context
  const hunks = [];
  for (const [gStart, gEnd] of groups) {
    const hunkStart = Math.max(0, gStart - contextLines);
    const hunkEnd = Math.min(ops.length - 1, gEnd + contextLines);

    const hunkOps = ops.slice(hunkStart, hunkEnd + 1);

    // Calculate line numbers
    let oldStart = 1, newStart = 1;
    for (let i = 0; i < hunkStart; i++) {
      if (ops[i].type === "keep" || ops[i].type === "del") oldStart++;
      if (ops[i].type === "keep" || ops[i].type === "add") newStart++;
    }

    let oldCount = 0, newCount = 0;
    for (const op of hunkOps) {
      if (op.type === "keep" || op.type === "del") oldCount++;
      if (op.type === "keep" || op.type === "add") newCount++;
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, ops: hunkOps });
  }

  return hunks;
}
