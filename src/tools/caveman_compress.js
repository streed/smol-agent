/**
 * Caveman compress tool — compresses markdown/text files using the LLM
 * to reduce token usage while preserving technical content.
 *
 * Ported from https://github.com/JuliusBrussee/caveman (caveman-compress)
 *
 * Features:
 *   - Compresses natural language files (.md, .txt, .rst, .markdown)
 *   - Preserves code blocks, URLs, headings, file paths, commands
 *   - Validates output and retries with targeted fixes (up to 2 retries)
 *   - Creates .original.md backup of the uncompressed version
 *
 * Dependencies: node:fs, node:path, ./registry.js, ../caveman.js, ../path-utils.js
 * Depended on by: src/agent.js (import for self-registration)
 *
 * @module tools/caveman_compress
 */
import fs from "node:fs";
import path from "node:path";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";
import {
  isCompressible,
  buildCompressPrompt,
  buildFixPrompt,
  validateCompression,
} from "../caveman.js";

// LLM provider set by agent during initialization
let _llmProvider = null;

/**
 * Set the LLM provider for compression calls.
 * Called by the agent during initialization.
 */
export function setCompressProvider(provider) {
  _llmProvider = provider;
}

const MAX_RETRIES = 2;
const MAX_FILE_SIZE = 500_000; // 500KB

/**
 * Call the LLM with a prompt and return the text response.
 */
async function callLLM(prompt) {
  if (!_llmProvider) {
    throw new Error("LLM provider not initialized for caveman compress");
  }

  let fullContent = "";
  for await (const event of _llmProvider.chatStream(
    [{ role: "user", content: prompt }],
    [], // no tools
    null, // no abort signal
  )) {
    if (event.type === "token") {
      fullContent += event.content;
    }
  }

  return fullContent.trim();
}

register("caveman_compress", {
  description:
    "Compress a markdown/text file into caveman format to reduce token usage (~45% savings). " +
    "Preserves code blocks, URLs, headings, and file paths. Creates a .original.md backup. " +
    "Only works on natural language files (.md, .txt, .rst, .markdown).",
  parameters: {
    type: "object",
    required: ["filePath"],
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to compress (relative to working directory).",
      },
    },
  },
  async execute({ filePath }, context) {
    const cwd = context?.cwd || process.cwd();
    let absPath;
    try {
      absPath = resolveJailedPath(cwd, filePath);
    } catch (err) {
      return { error: err.message };
    }

    // Check file exists
    if (!fs.existsSync(absPath)) {
      return { error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      return { error: `Not a file: ${filePath}` };
    }

    if (stat.size > MAX_FILE_SIZE) {
      return { error: `File too large (max 500KB): ${filePath}` };
    }

    // Check if compressible
    if (!isCompressible(absPath)) {
      return { error: `Not a compressible file (must be .md, .txt, .rst, .markdown): ${filePath}` };
    }

    // Check backup doesn't already exist
    const ext = path.extname(absPath);
    const backupPath = absPath.replace(ext, `.original${ext}`);
    if (fs.existsSync(backupPath)) {
      return {
        error: `Backup already exists: ${path.relative(cwd, backupPath)}. Remove or rename it first to prevent data loss.`,
      };
    }

    const originalText = fs.readFileSync(absPath, "utf-8");

    // Step 1: Compress with LLM
    let compressed;
    try {
      compressed = await callLLM(buildCompressPrompt(originalText));
    } catch (err) {
      return { error: `Compression failed: ${err.message}` };
    }

    // Save backup, write compressed
    fs.writeFileSync(backupPath, originalText, "utf-8");
    fs.writeFileSync(absPath, compressed, "utf-8");

    // Step 2: Validate + retry
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = validateCompression(originalText, compressed);

      if (result.valid) {
        const origTokens = Math.ceil(originalText.length / 4);
        const compTokens = Math.ceil(compressed.length / 4);
        const savings = origTokens > 0 ? Math.round((1 - compTokens / origTokens) * 100) : 0;

        return {
          compressed: filePath,
          backup: path.relative(cwd, backupPath),
          estimatedTokensBefore: origTokens,
          estimatedTokensAfter: compTokens,
          savings: `${savings}%`,
          warnings: result.warnings,
        };
      }

      // Last attempt — restore original
      if (attempt === MAX_RETRIES - 1) {
        fs.writeFileSync(absPath, originalText, "utf-8");
        fs.unlinkSync(backupPath);
        return {
          error: `Validation failed after ${MAX_RETRIES} retries. Original restored.`,
          validationErrors: result.errors,
        };
      }

      // Fix with LLM
      try {
        compressed = await callLLM(buildFixPrompt(originalText, compressed, result.errors));
        fs.writeFileSync(absPath, compressed, "utf-8");
      } catch (err) {
        // Restore original on fix failure
        fs.writeFileSync(absPath, originalText, "utf-8");
        fs.unlinkSync(backupPath);
        return { error: `Fix attempt failed: ${err.message}. Original restored.` };
      }
    }
  },
});
