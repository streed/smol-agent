/**
 * File manipulation tools for smol-agent.
 *
 * Core file operations that modify the filesystem:
 *   - read_file: Read file contents with optional line range
 *   - write_file: Create or overwrite a file
 *   - replace_in_file: Find and replace text in a file
 *   - list_files: List files matching a glob pattern
 *   - grep: Search file contents with regex
 *
 * Security: All paths must resolve within the jail directory (set via setJailDirectory).
 *
 * Fuzzy matching: replace_in_file uses Kilocode-inspired fuzzy matching to find
 * the best location when oldText doesn't match exactly, improving success rates.
 *
 * @file-doc
 * @module tools/file_tools
 * @dependencies node:fs, node:path, ./registry.js, ../path-utils.js, ../ts-lint.js,
 *               ./file_documentation.js, ./errors.js
 * @dependents dist/providers/index.js, src/agent.js, src/index.js,
 *             src/providers/index.js, src/providers/index.ts,
 *             src/tools/file_documentation.js, src/tools/git.js,
 *             src/tools/run_command.js, src/ts-lint.js, src/ui/App.js, src/ui/diff.js,
 *             test/unit/code-execution.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";
import { lintFileFormatted } from "../ts-lint.js";
import { trackEditedFile } from "./file_documentation.js";
import { ToolErrorCode } from "./errors.js";

const BINARY_PROBE_SIZE = 8192;

// ── Whitespace-normalized matching helper ────────────────────────────

function normalizeWS(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
}

// ── Fuzzy diff matching (Kilocode-inspired) ─────────────────────────

interface FuzzyMatchResult {
  match: string;
  similarity: number;
  startLine: number;
}

/**
 * Compute line-level similarity ratio between two text blocks.
 * Uses a simplified Ratcliff/Obershelp-style approach: count matching
 * lines (after trimming) divided by total lines.
 */
function lineSimilarity(a: string, b: string): number {
  const linesA = a.split('\n').map(l => l.trim());
  const linesB = b.split('\n').map(l => l.trim());
  if (linesA.length === 0 && linesB.length === 0) return 1;
  if (linesA.length === 0 || linesB.length === 0) return 0;

  // Count lines in B that appear in A
  const setA = new Set(linesA);
  let matches = 0;
  for (const line of linesB) {
    if (line.length > 0 && setA.has(line)) matches++;
  }

  // Non-empty lines only for denominator
  const nonEmptyA = linesA.filter(l => l.length > 0).length;
  const nonEmptyB = linesB.filter(l => l.length > 0).length;
  const total = Math.max(nonEmptyA, nonEmptyB);
  if (total === 0) return 1;

  return matches / total;
}

/**
 * Find the best fuzzy match for oldText in the original file content.
 * Slides a window of similar size over the original and picks the
 * highest-similarity region above the threshold.
 */
function fuzzyMatch(original: string, oldText: string, threshold = 0.8): FuzzyMatchResult | null {
  const oldLines = oldText.split('\n');
  const origLines = original.split('\n');
  const windowSize = oldLines.length;

  if (windowSize > origLines.length) return null;

  let bestMatch: string | null = null;
  let bestScore = threshold; // minimum acceptable score
  let bestStart = -1;

  // Slide a window +/- 2 lines around the expected size
  for (let delta = 0; delta <= 2; delta++) {
    for (const size of [windowSize + delta, windowSize - delta]) {
      if (size <= 0 || size > origLines.length) continue;

      for (let i = 0; i <= origLines.length - size; i++) {
        const candidate = origLines.slice(i, i + size).join('\n');
        const score = lineSimilarity(candidate, oldText);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = candidate;
          bestStart = i;
        }
      }
    }
  }

  if (bestMatch && bestStart >= 0) {
    return { match: bestMatch, similarity: bestScore, startLine: bestStart + 1 };
  }
  return null;
}

// Default fuzzy match threshold (80% similarity)
const FUZZY_THRESHOLD = 0.8;

// ── read_file ───────────────────────────────────────────────────────

interface ReadFileArgs {
  filePath: string;
  startLine?: number;
  endLine?: number;
}

interface ReadFileResult {
  content?: string;
  error?: {
    code: string;
    message: string;
    details?: { filePath: string };
  };
}

register("read_file", {
  description:
    "Read the contents of a file. Returns the file text with line numbers. Optionally read a specific line range. Use this instead of running cat/head/tail via run_command.",
  parameters: {
    type: "object",
    required: ["filePath"],
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to read (relative to project root).",
      },
      startLine: {
        type: "number",
        description: "First line to return (1-based, inclusive). Omit to start from the beginning.",
      },
      endLine: {
        type: "number",
        description: "Last line to return (1-based, inclusive). Omit to read to the end.",
      },
    },
  },
  async execute({ filePath, startLine, endLine }: ReadFileArgs, { cwd = process.cwd() } = {}): Promise<ReadFileResult> {
    const resolved = resolveJailedPath(cwd, filePath);

    if (!fs.existsSync(resolved)) {
      return { error: { code: ToolErrorCode.FILE_NOT_FOUND, message: `File not found: ${filePath}`, details: { filePath } } };
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { error: { code: ToolErrorCode.INVALID_INPUT, message: `Path is a directory, not a file: ${filePath}`, details: { filePath } } };
    }

    // Binary file detection — probe first bytes for null bytes
    const probe = Buffer.alloc(Math.min(BINARY_PROBE_SIZE, stat.size));
    const fd = fs.openSync(resolved, 'r');
    try {
      fs.readSync(fd, probe, 0, probe.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (probe.includes(0)) {
      return { error: { code: ToolErrorCode.INVALID_INPUT, message: `File appears to be binary: ${filePath}`, details: { filePath } } };
    }

    const raw = fs.readFileSync(resolved, "utf-8");
    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    // Apply line range
    const start = Math.max(1, startLine || 1);
    const end = Math.min(totalLines, endLine || totalLines);
    const selected = allLines.slice(start - 1, end);

    // Format with line numbers
    const numbered = selected
      .map((line, i) => `${start + i}\t${line}`)
      .join("\n");

    // Compact result: inline metadata as header to save tokens
    return {
      content: `${filePath}:${start}-${end}/${totalLines}\n${numbered}`,
    };
  },
});

// ── write_file ──────────────────────────────────────────────────────

interface WriteFileArgs {
  filePath: string;
  content: string;
}

interface WriteFileResult {
  result?: string;
  syntaxWarning?: string;
  error?: {
    code: string;
    message: string;
    details?: { filePath: string };
  };
  _display?: {
    type: string;
    filePath: string;
    oldContent: string;
    newContent: string;
  };
}

register("write_file", {
  description:
    "Write content to a file, creating it (and any missing parent directories) if it doesn't exist, or overwriting it if it does. Use this instead of echo/cat redirect via run_command.",
  parameters: {
    type: "object",
    required: ["filePath", "content"],
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to write (relative to project root).",
      },
      content: {
        type: "string",
        description: "The full content to write to the file.",
      },
    },
  },
  async execute({ filePath, content }: WriteFileArgs, { cwd = process.cwd() } = {}): Promise<WriteFileResult> {
    // Block writes to sensitive paths within the jail
    const PROTECTED_PATTERNS = [
      /^\.git\/hooks\//,
      /^\.git\/config$/,
      /^\.smol-agent\/settings\.json$/,
      /^\.env$/,
      /^\.env\..+/,
    ];
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    for (const pattern of PROTECTED_PATTERNS) {
      if (pattern.test(normalized)) {
        return { error: { code: ToolErrorCode.PERMISSION_DENIED, message: `Blocked: writing to '${filePath}' is not allowed for security reasons`, details: { filePath } } };
      }
    }

    const resolved = resolveJailedPath(cwd, filePath);

    // Ensure parent directories exist
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const existed = fs.existsSync(resolved);
    const oldContent = existed ? fs.readFileSync(resolved, "utf-8") : "";
    fs.writeFileSync(resolved, content, "utf-8");
    trackEditedFile(resolved);

    const lines = content.split("\n").length;
    const result: WriteFileResult = {
      result: `${existed ? "overwritten" : "created"} ${filePath}: ${lines} lines, ${(Buffer.byteLength(content, "utf-8")/1024).toFixed(1)}KB`,
      _display: {
        type: existed ? "overwrite" : "new",
        filePath,
        oldContent,
        newContent: content,
      },
    };

    // Tree-sitter syntax check after write
    const lintWarning = lintFileFormatted(resolved);
    if (lintWarning) {
      result.syntaxWarning = lintWarning;
    }

    return result;
  },
});

// ── replace_in_file ─────────────────────────────────────────────────

interface ReplaceInFileArgs {
  filePath: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

interface ReplaceInFileResult {
  result?: string;
  syntaxWarning?: string;
  error?: {
    code: string;
    message: string;
    details?: { filePath: string };
  };
  _display?: {
    type: string;
    filePath: string;
    fileContent: string;
    oldText: string;
    newText: string;
  };
}

register("replace_in_file", {
  description:
    "Find and replace text in a file. Provide the exact old text and the new text to replace it with. The old text must match exactly (including whitespace/indentation). Use this for targeted edits instead of sed via run_command.",
  parameters: {
    type: "object",
    required: ["filePath", "oldText", "newText"],
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to edit (relative to project root).",
      },
      oldText: {
        type: "string",
        description: "The exact text to find in the file. Must match exactly, including whitespace and indentation.",
      },
      newText: {
        type: "string",
        description: "The text to replace it with. Can be empty to delete the matched text.",
      },
      replaceAll: {
        type: "boolean",
        description: "If true, replace all occurrences. Default is false (replace first occurrence only).",
      },
    },
  },
  async execute({ filePath, oldText, newText, replaceAll }: ReplaceInFileArgs, { cwd = process.cwd() } = {}): Promise<ReplaceInFileResult> {
    if (!oldText) {
      return { error: { code: ToolErrorCode.INVALID_INPUT, message: "oldText must be non-empty" } };
    }

    const resolved = resolveJailedPath(cwd, filePath);

    if (!fs.existsSync(resolved)) {
      return { error: { code: ToolErrorCode.FILE_NOT_FOUND, message: `File not found: ${filePath}`, details: { filePath } } };
    }

    const original = fs.readFileSync(resolved, "utf-8");
    let matchedOldText = oldText;

    // 1. Exact match
    if (!original.includes(oldText)) {
      // 2. Whitespace-normalized match
      const normOriginal = normalizeWS(original);
      const normOldText = normalizeWS(oldText);

      if (normOriginal.includes(normOldText)) {
        // Find the actual region in the original text by matching normalized lines
        const normLines = normOldText.split('\n');
        const origLines = original.split('\n');
        let startIdx = -1;

        for (let i = 0; i <= origLines.length - normLines.length; i++) {
          let match = true;
          for (let j = 0; j < normLines.length; j++) {
            if (normalizeWS(origLines[i + j]) !== normLines[j]) {
              match = false;
              break;
            }
          }
          if (match) {
            startIdx = i;
            break;
          }
        }

        if (startIdx >= 0) {
          matchedOldText = origLines.slice(startIdx, startIdx + normLines.length).join('\n');
        } else {
          return {
            error: { code: ToolErrorCode.NOT_FOUND, message: "oldText not found in file. Make sure it matches exactly, including whitespace and indentation.", details: { filePath } },
          };
        }
      } else {
        // 3. Fuzzy match — find the best approximate match above threshold
        const fuzzyResult = fuzzyMatch(original, oldText, FUZZY_THRESHOLD);
        if (fuzzyResult) {
          matchedOldText = fuzzyResult.match;
        } else {
          // 4. No match — find closest hint using first line
          const firstLine = oldText.split('\n')[0].trim();
          if (firstLine.length > 10) {
            const origLines = original.split('\n');
            const hintLine = origLines.find(l => l.trim().includes(firstLine));
            if (hintLine) {
              return {
                error: { code: ToolErrorCode.NOT_FOUND, message: `oldText not found in file. Closest match found near: "${hintLine.trim().slice(0, 120)}"`, details: { filePath } },
              };
            }
          }
          return {
            error: { code: ToolErrorCode.NOT_FOUND, message: "oldText not found in file. Make sure it matches exactly, including whitespace and indentation.", details: { filePath } },
          };
        }
      }
    }

    let updated: string;
    let count: number;
    if (replaceAll) {
      count = original.split(matchedOldText).length - 1;
      updated = original.split(matchedOldText).join(newText);
    } else {
      count = 1;
      const idx = original.indexOf(matchedOldText);
      updated = original.slice(0, idx) + newText + original.slice(idx + matchedOldText.length);
    }

    fs.writeFileSync(resolved, updated, "utf-8");
    trackEditedFile(resolved);

    const result: ReplaceInFileResult = {
      result: `replaced ${count} ${count !== 1 ? "matches" : "match"} in ${filePath} (old:${oldText.split("\n").length} new:${newText.split("\n").length} lines)`,
      _display: {
        type: "replace",
        filePath,
        fileContent: original,
        oldText: matchedOldText,
        newText,
      },
    };

    // Tree-sitter syntax check after edit
    const lintWarning = lintFileFormatted(resolved);
    if (lintWarning) {
      result.syntaxWarning = lintWarning;
    }

    return result;
  },
});