import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

/**
 * Pre-hydration — inspired by Stripe's Minions.
 *
 * Before the agent loop starts, deterministically scan the user message for
 * file paths, URLs, and other references.  Pre-load any that exist so the
 * model has immediate context without burning a tool-call round-trip.
 *
 * Returns an array of { type, ref, content } objects that the agent can
 * inject as an extra system/user message.
 */

// Match things that look like file paths (with extensions or trailing /)
const FILE_PATH_RE = /(?:^|\s|["'`(])([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,10})(?=[\s"'`),;:]|$)/g;
const DIR_PATH_RE = /(?:^|\s|["'`(])([a-zA-Z0-9_./-]+\/)(?=[\s"'`),;:]|$)/g;

// Common non-file extensions to skip
const SKIP_EXTENSIONS = new Set([
  ".com", ".org", ".net", ".io", ".dev", ".ai", ".app",
  ".0", ".1", ".2", ".3", ".4", ".5", ".6", ".7", ".8", ".9",
]);

/**
 * Extract file-like references from the user message.
 */
function extractFileRefs(message) {
  const refs = new Set();

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
 * @param {string} userMessage - The user's prompt
 * @param {string} cwd - Project root directory
 * @param {object} [options]
 * @param {number} [options.maxFiles=5] - Max files to pre-load
 * @param {number} [options.maxBytesPerFile=8192] - Max bytes per file
 * @returns {Promise<{ files: Array<{ path: string, content: string }>, summary: string | null }>}
 */
export async function prehydrate(userMessage, cwd, options = {}) {
  const { maxFiles = 5, maxBytesPerFile = 8192 } = options;
  const refs = extractFileRefs(userMessage);

  if (refs.length === 0) {
    return { files: [], summary: null };
  }

  logger.info(`Pre-hydration: found ${refs.length} file reference(s): ${refs.join(", ")}`);

  const loaded = [];

  for (const ref of refs.slice(0, maxFiles + 3)) {
    if (loaded.length >= maxFiles) break;

    const resolved = path.resolve(cwd, ref);

    // Security: must be within cwd
    if (!resolved.startsWith(path.resolve(cwd) + path.sep) && resolved !== path.resolve(cwd)) {
      continue;
    }

    try {
      const stat = fs.statSync(resolved);

      if (stat.isFile() && stat.size <= maxBytesPerFile) {
        // Quick binary check
        const probe = Buffer.alloc(Math.min(512, stat.size));
        const fd = fs.openSync(resolved, "r");
        try {
          fs.readSync(fd, probe, 0, probe.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (probe.includes(0)) continue; // skip binary

        const content = fs.readFileSync(resolved, "utf-8");
        const lines = content.split("\n");
        const numbered = lines
          .map((line, i) => `${i + 1}\t${line}`)
          .join("\n");

        loaded.push({ path: ref, content: numbered });
        logger.debug(`Pre-hydrated: ${ref} (${lines.length} lines)`);
      } else if (stat.isDirectory()) {
        // List directory contents (shallow)
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
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

export { extractFileRefs };
