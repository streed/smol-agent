/**
 * Pre-hydration — inspired by Stripe's Minions.
 *
 * Before the agent loop starts, deterministically scan the user message for
 * file paths, URLs, and other references. Pre-load any that exist so the
 * model has immediate context without burning a tool-call round-trip.
 *
 * Returns an array of { type, ref, content } objects that the agent can
 * inject as an extra system/user message.
 *
 * Key exports:
 *   - prehydrateRefs(message, cwd): Extract and load referenced files/URLs
 *   - extractFileRefs(message): Extract file path references from text
 *
 * Dependencies: node:fs/promises, node:fs, node:path, ./logger.js
 * Depended on by: src/agent.js (only consumer)
 */

import fs from "node:fs/promises";
import { openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

// Match things that look like file paths (with extensions or trailing /)
const FILE_PATH_RE = /(?:^|\s|["'`(\[])([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,10})(?=[\s"`'),;:]|$)/g;
// Match directory paths (trailing /)
const DIR_PATH_RE = /(?:^|\s|["'`(\[])([a-zA-Z0-9_./-]+\/)(?=[\s"`'),;:]|$)/g;

// Common non-file extensions to skip
const SKIP_EXTENSIONS = new Set([
  ".com", ".org", ".net", ".io", ".dev", ".ai", ".app",
  ".0", ".1", ".2", ".3", ".4", ".5", ".6", ".7", ".8", ".9",
]);

export interface PrehydrateFile {
  path: string;
  content: string;
}

export interface PrehydrateOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
}

export interface PrehydrateResult {
  files: PrehydrateFile[];
  summary: string | null;
}

/**
 * Extract file-like references from the user message.
 */
export function extractFileRefs(message: string): string[] {
  const refs = new Set<string>();

  for (const match of message.matchAll(FILE_PATH_RE)) {
    const ref = match[1];
    const ext = path.extname(ref).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;
    if (ref.startsWith("http") || ref.startsWith("//")) continue;
    refs.add(ref);
  }

  for (const match of message.matchAll(DIR_PATH_RE)) {
    const ref = match[1];
    if (ref.startsWith("http") || ref.startsWith("//")) continue;
    refs.add(ref);
  }

  return [...refs];
}

/**
 * Pre-hydrate context from a user message.
 *
 * @param userMessage - The user's prompt
 * @param cwd - Project root directory
 * @param options - Optional configuration
 * @returns Loaded files and summary
 */
export async function prehydrate(
  userMessage: string,
  cwd: string,
  options: PrehydrateOptions = {}
): Promise<PrehydrateResult> {
  const { maxFiles = 5, maxBytesPerFile = 8192 } = options;
  const refs = extractFileRefs(userMessage);

  if (refs.length === 0) {
    return { files: [], summary: null };
  }

  logger.info(`Pre-hydration: found ${refs.length} file reference(s): ${refs.join(", ")}`);

  const loaded: PrehydrateFile[] = [];

  for (const ref of refs.slice(0, maxFiles + 3)) {
    if (loaded.length >= maxFiles) break;

    const resolved = path.resolve(cwd, ref);

    // Security: must be within cwd
    if (!resolved.startsWith(path.resolve(cwd) + path.sep) && resolved !== path.resolve(cwd)) {
      continue;
    }

    try {
      const stat = await fs.stat(resolved);

      if (stat.isFile() && stat.size <= maxBytesPerFile) {
        // Quick binary check (sync — small read, not worth async overhead)
        const probe = Buffer.alloc(Math.min(512, stat.size));
        const fd = openSync(resolved, "r");
        try {
          readSync(fd, probe, 0, probe.length, 0);
        } finally {
          closeSync(fd);
        }
        if (probe.includes(0)) continue; // skip binary

        const content = await fs.readFile(resolved, "utf-8");
        const lines = content.split("\n");
        const numbered = lines
          .map((line, i) => `${i + 1}\t${line}`)
          .join("\n");

        loaded.push({ path: ref, content: numbered });
        logger.debug(`Pre-hydrated: ${ref} (${lines.length} lines)`);
      } else if (stat.isDirectory()) {
        // List directory contents (shallow)
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const listing = entries
          .slice(0, 30)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n");

        loaded.push({ path: ref, content: listing });
        logger.debug(`Pre-hydrated dir: ${ref} (${entries.length} entries)`);
      }
    } catch {
      // File doesn't exist or isn't readable — skip silently
    }
  }

  if (loaded.length === 0) {
    return { files: [], summary: null };
  }

  // Build a compact context block
  const blocks = loaded.map(
    (f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
  );
  const summary = `[Pre-loaded ${loaded.length} referenced file(s) for immediate context]\n\n${blocks.join("\n\n")}`;

  logger.info(`Pre-hydration complete: ${loaded.length} file(s) loaded`);

  return { files: loaded, summary };
}