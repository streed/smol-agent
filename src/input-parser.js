/**
 * Input parser for @file mentions and image attachments.
 *
 * Parses user input for @path/to/file syntax and loads:
 *   - Text files: Inject content into context
 *   - Images: Base64-encode for vision models
 *
 * Security: All paths must resolve within the jail directory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

// Image extensions that vision models can process
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Match @file or @path/to/file.ext (extension optional)
// The @ must be followed by a path (alphanumeric, dots, dashes, underscores, slashes)
// Must end at whitespace or end of string to avoid matching email addresses
const AT_MENTION_RE = /@([a-zA-Z0-9._\-/]+)(?=[\s]|$)/g;

// MIME types for images
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Parse user input for @file mentions and load attachments.
 *
 * @param {string} userMessage - The raw user input
 * @param {string} cwd - The jail directory for path resolution
 * @param {object} [options]
 * @param {number} [options.maxFileSize=32768] - Max bytes for text files
 * @param {number} [options.maxImageSize=10485760] - Max bytes for images (10MB)
 * @returns {Promise<{
 *   text: string,
 *   files: Array<{ path: string, content: string }>,
 *   images: Array<{ path: string, base64: string, mimeType: string }>,
 *   errors: Array<{ path: string, error: string }>
 * }>}
 */
export async function parseInput(userMessage, cwd, options = {}) {
  const { maxFileSize = 32768, maxImageSize = 10485760 } = options;

  // Extract all @mentions
  const mentions = [...userMessage.matchAll(AT_MENTION_RE)].map(m => m[1]);

  if (mentions.length === 0) {
    return { text: userMessage, files: [], images: [], errors: [] };
  }

  logger.info(`Input parser: found ${mentions.length} @mention(s)`);

  const files = [];
  const images = [];
  const errors = [];
  const resolvedCwd = path.resolve(cwd);
  let cleanText = userMessage;

  for (const ref of mentions) {
    const resolved = path.resolve(cwd, ref);
    const ext = path.extname(ref).toLowerCase();

    // Security: must be within jail directory
    if (!resolved.startsWith(resolvedCwd + path.sep) && resolved !== resolvedCwd) {
      errors.push({ path: ref, error: 'Path outside jail directory' });
      logger.warn(`Rejected @${ref}: outside jail directory`);
      continue;
    }

    try {
      const stat = await fs.stat(resolved);

      if (!stat.isFile()) {
        errors.push({ path: ref, error: 'Not a file' });
        continue;
      }

      // Handle images
      if (IMAGE_EXTENSIONS.has(ext)) {
        if (stat.size > maxImageSize) {
          errors.push({ path: ref, error: `Image too large (${Math.round(stat.size / 1024)}KB > ${Math.round(maxImageSize / 1024)}KB)` });
          continue;
        }

        const buffer = await fs.readFile(resolved);
        const base64 = buffer.toString('base64');
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

        images.push({ path: ref, base64, mimeType });
        cleanText = cleanText.replace(`@${ref}`, `[image: ${ref}]`);
        logger.info(`Loaded image: ${ref} (${Math.round(stat.size / 1024)}KB)`);
      } else {
        // Handle text files
        if (stat.size > maxFileSize) {
          errors.push({ path: ref, error: `File too large (${Math.round(stat.size / 1024)}KB > ${Math.round(maxFileSize / 1024)}KB)` });
          continue;
        }

        // Quick binary check
        const probe = Buffer.alloc(Math.min(512, stat.size));
        const fd = await fs.open(resolved, 'r');
        try {
          await fd.read(probe, 0, probe.length, 0);
        } finally {
          await fd.close();
        }

        if (probe.includes(0)) {
          errors.push({ path: ref, error: 'Binary file' });
          continue;
        }

        const content = await fs.readFile(resolved, 'utf-8');
        const lines = content.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n');

        files.push({ path: ref, content: lines });
        cleanText = cleanText.replace(`@${ref}`, '');
        logger.info(`Loaded file: ${ref} (${content.split('\n').length} lines)`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        errors.push({ path: ref, error: 'File not found' });
      } else {
        errors.push({ path: ref, error: err.message });
      }
      logger.debug(`Failed to load @${ref}: ${err.message}`);
    }
  }

  return {
    text: cleanText.replace(/\s+/g, ' ').trim(),
    files,
    images,
    errors,
  };
}

/**
 * Build a user message content array with files and images.
 * Used by providers that support multi-part content.
 *
 * @param {string} text - The cleaned user text
 * @param {Array} files - Loaded files from parseInput
 * @param {Array} images - Loaded images from parseInput
 * @returns {object} - Either a string or multi-part content array
 */
export function buildUserContent(text, files, images) {
  let fullText = text;

  // Append file contents
  if (files.length > 0) {
    const fileBlocks = files.map(f =>
      `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
    );
    fullText += `\n\n[Attached files]\n${fileBlocks.join('\n\n')}`;
  }

  // If no images, return simple string content
  if (images.length === 0) {
    return fullText;
  }

  // Build multi-part content with images
  const content = [{ type: 'text', text: fullText }];

  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        base64: img.base64,
        mimeType: img.mimeType,
      },
    });
  }

  return content;
}