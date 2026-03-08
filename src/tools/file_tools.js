import fs from "node:fs";
import path from "node:path";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";

const BINARY_PROBE_SIZE = 8192;

// ── Whitespace-normalized matching helper ────────────────────────────

function normalizeWS(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
}

// ── read_file ───────────────────────────────────────────────────────

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
  async execute({ filePath, startLine, endLine }, { cwd = process.cwd() } = {}) {
    const resolved = resolveJailedPath(cwd, filePath);

    if (!fs.existsSync(resolved)) {
      return { error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { error: `Path is a directory, not a file: ${filePath}` };
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
      return { error: `File appears to be binary: ${filePath}` };
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

    return {
      filePath,
      totalLines,
      startLine: start,
      endLine: end,
      content: numbered,
    };
  },
});

// ── write_file ──────────────────────────────────────────────────────

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
  async execute({ filePath, content }, { cwd = process.cwd() } = {}) {
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
        return { error: `Blocked: writing to '${filePath}' is not allowed for security reasons` };
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

    const lines = content.split("\n").length;
    return {
      filePath,
      action: existed ? "overwritten" : "created",
      lines,
      bytes: Buffer.byteLength(content, "utf-8"),
      _display: {
        type: existed ? "overwrite" : "new",
        filePath,
        oldContent,
        newContent: content,
      },
    };
  },
});

// ── replace_in_file ─────────────────────────────────────────────────

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
  async execute({ filePath, oldText, newText, replaceAll }, { cwd = process.cwd() } = {}) {
    if (!oldText) {
      return { error: "oldText must be non-empty" };
    }

    const resolved = resolveJailedPath(cwd, filePath);

    if (!fs.existsSync(resolved)) {
      return { error: `File not found: ${filePath}` };
    }

    const original = fs.readFileSync(resolved, "utf-8");
    let matchType = 'exact';
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
          matchType = 'whitespace-normalized';
        } else {
          return {
            error: "oldText not found in file. Make sure it matches exactly, including whitespace and indentation.",
          };
        }
      } else {
        // 3. No match — find closest hint using first line
        const firstLine = oldText.split('\n')[0].trim();
        if (firstLine.length > 10) {
          const origLines = original.split('\n');
          const hintLine = origLines.find(l => l.trim().includes(firstLine));
          if (hintLine) {
            return {
              error: `oldText not found in file. Closest match found near: "${hintLine.trim().slice(0, 120)}"`,
            };
          }
        }
        return {
          error: "oldText not found in file. Make sure it matches exactly, including whitespace and indentation.",
        };
      }
    }

    let updated;
    let count;
    if (replaceAll) {
      count = original.split(matchedOldText).length - 1;
      updated = original.split(matchedOldText).join(newText);
    } else {
      count = 1;
      const idx = original.indexOf(matchedOldText);
      updated = original.slice(0, idx) + newText + original.slice(idx + matchedOldText.length);
    }

    fs.writeFileSync(resolved, updated, "utf-8");

    return {
      filePath,
      replacements: count,
      matchType,
      oldLines: oldText.split("\n").length,
      newLines: newText.split("\n").length,
      _display: {
        type: "replace",
        filePath,
        fileContent: original,
        oldText: matchedOldText,
        newText,
      },
    };
  },
});
