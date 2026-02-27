import fs from "node:fs";
import path from "node:path";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";

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
  async execute({ filePath, startLine, endLine }) {
    const resolved = resolveJailedPath(process.cwd(), filePath);

    if (!fs.existsSync(resolved)) {
      return { error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { error: `Path is a directory, not a file: ${filePath}` };
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
  async execute({ filePath, content }) {
    const resolved = resolveJailedPath(process.cwd(), filePath);

    // Ensure parent directories exist
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const existed = fs.existsSync(resolved);
    fs.writeFileSync(resolved, content, "utf-8");

    const lines = content.split("\n").length;
    return {
      filePath,
      action: existed ? "overwritten" : "created",
      lines,
      bytes: Buffer.byteLength(content, "utf-8"),
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
  async execute({ filePath, oldText, newText, replaceAll }) {
    const resolved = resolveJailedPath(process.cwd(), filePath);

    if (!fs.existsSync(resolved)) {
      return { error: `File not found: ${filePath}` };
    }

    const original = fs.readFileSync(resolved, "utf-8");

    if (!original.includes(oldText)) {
      return {
        error: "oldText not found in file. Make sure it matches exactly, including whitespace and indentation.",
      };
    }

    let updated;
    let count;
    if (replaceAll) {
      // Count occurrences then replace all
      count = original.split(oldText).length - 1;
      updated = original.split(oldText).join(newText);
    } else {
      // Replace first occurrence only
      count = 1;
      const idx = original.indexOf(oldText);
      updated = original.slice(0, idx) + newText + original.slice(idx + oldText.length);
    }

    fs.writeFileSync(resolved, updated, "utf-8");

    return {
      filePath,
      replacements: count,
      oldLines: oldText.split("\n").length,
      newLines: newText.split("\n").length,
    };
  },
});
