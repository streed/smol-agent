import { register } from "./registry.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveJailedPath } from "../path-utils.js";

const DOCS_DIR = ".smol-agent/docs";

/**
 * Sanitize a path for use as a filename.
 * Trims slashes, replaces `/` with `-`, strips leading dots.
 */
function sanitizePath(p: string): string {
  return p
    .replace(/^[./\\]+|\/+$/g, "")
    .replace(/\//g, "-");
}

/**
 * Load available context doc names from .smol-agent/docs/.
 * Returns array of base filenames (without .md) or [] if dir missing.
 */
export async function loadContextDocs(cwd: string): Promise<string[]> {
  try {
    const docsPath = resolveJailedPath(cwd, DOCS_DIR);
    const entries = await fs.readdir(docsPath);
    return entries
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

interface SaveContextArgs {
  path: string;
  summary: string;
}

interface SaveContextResult {
  success?: boolean;
  message?: string;
  error?: string;
}

register("save_context", {
  description:
    "Save a short, dense summary about a directory or code area for future sessions. Keep it compact: list key files, exports, and patterns — no prose. This lets you skip re-exploring known areas.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Relative directory or file path being documented (e.g. 'src/tools', 'src/agent.js')",
      },
      summary: {
        type: "string",
        description:
          "Short, dense markdown: purpose (1 line), key files/exports (bulleted), important patterns or gotchas. No filler prose.",
      },
    },
    required: ["path", "summary"],
  },
  async execute({ path: docPath, summary }: SaveContextArgs, { cwd = process.cwd() } = {}): Promise<SaveContextResult> {
    const sanitized = sanitizePath(docPath);
    if (!sanitized) {
      return { error: "Invalid path" };
    }

    const docsDir = resolveJailedPath(cwd, DOCS_DIR);
    await fs.mkdir(docsDir, { recursive: true });

    const metadata = `<!-- path: ${docPath} | updated: ${new Date().toISOString()} -->`;
    const content = `${metadata}\n\n${summary}\n`;

    const filepath = path.join(docsDir, `${sanitized}.md`);
    await fs.writeFile(filepath, content, "utf-8");

    return { success: true, message: `Saved context doc for "${docPath}" → .smol-agent/docs/${sanitized}.md` };
  },
});