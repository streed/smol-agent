/**
 * Caveman mode — ultra-compressed communication that cuts token usage ~75%
 * while keeping full technical accuracy.
 *
 * Ported from https://github.com/JuliusBrussee/caveman
 *
 * Supports intensity levels:
 *   - lite:  No filler/hedging, keep articles + full sentences
 *   - full:  Drop articles, fragments OK, short synonyms (default)
 *   - ultra: Abbreviate (DB/auth/config/req/res/fn/impl), arrows for causality
 *
 * Key exports:
 *   - CAVEMAN_LEVELS: Set of valid intensity levels
 *   - buildCavemanPrompt(level): Build the system prompt injection for a given level
 *   - buildCavemanCommitRules(): Rules for terse commit messages
 *   - buildCavemanReviewRules(): Rules for terse code review comments
 *   - CAVEMAN_COMPRESS_PROMPT: Prompt template for compressing markdown files
 *   - buildCompressPrompt(text): Build compression prompt for a given text
 *   - buildFixPrompt(original, compressed, errors): Build fix prompt for validation errors
 *
 * Dependencies: None (pure functions/constants)
 * Depended on by: src/agent.js, src/ui/App.js, src/tools/caveman_compress.js
 *
 * @module caveman
 */

// ── Valid intensity levels ──────────────────────────────────────────

export const CAVEMAN_LEVELS = new Set(["lite", "full", "ultra"]);

export const DEFAULT_LEVEL = "full";

// ── Core caveman rules (injected into system prompt) ────────────────

const RULES_COMMON = `Respond terse like smart caveman. All technical substance stay. Only fluff die.

## Caveman Rules

Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.

Pattern: \`[thing] [action] [reason]. [next step].\`

Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"`;

const RULES_BY_LEVEL = {
  lite: `${RULES_COMMON}

## Intensity: Lite
No filler/hedging. Keep articles + full sentences. Professional but tight.

Example — "Why React component re-render?"
"Your component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."`,

  full: `${RULES_COMMON}

## Intensity: Full (Default)
Drop articles, fragments OK, short synonyms. Classic caveman.

Example — "Why React component re-render?"
"New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."`,

  ultra: `${RULES_COMMON}

## Intensity: Ultra
Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y), one word when one word enough.

Example — "Why React component re-render?"
"Inline obj prop → new ref → re-render. \`useMemo\`."`,
};

const AUTO_CLARITY = `
## Auto-Clarity Exceptions
Drop caveman for: security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread, user confused. Resume caveman after clear part done.`;

const BOUNDARIES = `
## Boundaries
Code blocks: write normal. "stop caveman" or "normal mode": revert to standard.`;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build the caveman system prompt injection for a given intensity level.
 * @param {string} level - One of "lite", "full", "ultra"
 * @returns {string} System prompt block to inject
 */
export function buildCavemanPrompt(level = DEFAULT_LEVEL) {
  if (!CAVEMAN_LEVELS.has(level)) {
    level = DEFAULT_LEVEL;
  }
  return `${RULES_BY_LEVEL[level]}${AUTO_CLARITY}${BOUNDARIES}`;
}

// ── Caveman commit rules ────────────────────────────────────────────

/**
 * Build rules for ultra-compressed commit messages.
 * Follows Conventional Commits format with strict brevity.
 */
export function buildCavemanCommitRules() {
  return `## Caveman Commit Rules
Subject: \`<type>(<scope>): <imperative summary>\` — max 50 chars (hard limit 72).
Types: feat/fix/refactor/perf/docs/test/chore/build/ci/style/revert.
Imperative mood (add/fix/remove), never past tense. The diff says what — commit says why.
Body only when reasoning non-obvious, breaking changes, or migration notes. Wrap 72 chars.
No "This commit does", no first-person, no AI attribution, no redundant file paths when scope clarifies.`;
}

// ── Caveman review rules ────────────────────────────────────────────

/**
 * Build rules for ultra-compressed code review comments.
 * Format: L<line>: <severity>: <problem>. <fix>.
 */
export function buildCavemanReviewRules() {
  return `## Caveman Review Rules
Format: \`L<line>: <problem>. <fix>.\` (single file) or \`<file>:L<line>:\` (multi-file).
Severity: 🔴 bug | 🟡 risk | 🔵 nit | ❓ q
Drop: hedging (perhaps/maybe), padding (I noticed that...), praise, restating visible diff, vague "refactor this".
Keep: exact line numbers, symbol names in backticks, concrete fixes with rationale when non-obvious.
Full explanation only for: CVE-level security issues, architectural disagreements, onboarding scenarios.`;
}

// ── Compression prompts (for caveman_compress tool) ─────────────────

/**
 * Build the compression prompt for a given markdown text.
 * @param {string} text - Original markdown content
 * @returns {string} Prompt for LLM compression
 */
export function buildCompressPrompt(text) {
  return `Compress this markdown into caveman format.

STRICT RULES:
- Do NOT modify anything inside \`\`\` code blocks
- Do NOT modify anything inside inline backticks
- Preserve ALL URLs exactly
- Preserve ALL headings exactly
- Preserve file paths and commands

Only compress natural language.

TEXT:
${text}`;
}

/**
 * Build a targeted fix prompt for validation errors in compressed output.
 * @param {string} original - Original text
 * @param {string} compressed - Compressed text with errors
 * @param {string[]} errors - List of validation error descriptions
 * @returns {string} Prompt for LLM fix pass
 */
export function buildFixPrompt(original, compressed, errors) {
  const errorsStr = errors.map(e => `- ${e}`).join("\n");
  return `You are fixing a caveman-compressed markdown file. Specific validation errors were found.

CRITICAL RULES:
- DO NOT recompress or rephrase the file
- ONLY fix the listed errors — leave everything else exactly as-is
- The ORIGINAL is provided as reference only (to restore missing content)
- Preserve caveman style in all untouched sections

ERRORS TO FIX:
${errorsStr}

HOW TO FIX:
- Missing URL: find it in ORIGINAL, restore it exactly where it belongs in COMPRESSED
- Code block mismatch: find the exact code block in ORIGINAL, restore it in COMPRESSED
- Heading mismatch: restore the exact heading text from ORIGINAL into COMPRESSED
- Do not touch any section not mentioned in the errors

ORIGINAL (reference only):
${original}

COMPRESSED (fix this):
${compressed}

Return ONLY the fixed compressed file. No explanation.`;
}

// ── Compression validation ──────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s)]+/g;
const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const HEADING_REGEX = /^(#{1,6})\s+(.*)/gm;
const BULLET_REGEX = /^\s*[-*+]\s+/gm;

/**
 * Validate compressed output against the original.
 * @param {string} original - Original text
 * @param {string} compressed - Compressed text
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateCompression(original, compressed) {
  const errors = [];
  const warnings = [];

  // Headings
  const origHeadings = [...original.matchAll(HEADING_REGEX)].map(m => m[2].trim());
  const compHeadings = [...compressed.matchAll(HEADING_REGEX)].map(m => m[2].trim());
  if (origHeadings.length !== compHeadings.length) {
    errors.push(`Heading count mismatch: ${origHeadings.length} vs ${compHeadings.length}`);
  }

  // Code blocks
  const origBlocks = original.match(CODE_BLOCK_REGEX) || [];
  const compBlocks = compressed.match(CODE_BLOCK_REGEX) || [];
  if (JSON.stringify(origBlocks) !== JSON.stringify(compBlocks)) {
    errors.push("Code blocks not preserved exactly");
  }

  // URLs
  const origUrls = new Set(original.match(URL_REGEX) || []);
  const compUrls = new Set(compressed.match(URL_REGEX) || []);
  const lostUrls = [...origUrls].filter(u => !compUrls.has(u));
  const addedUrls = [...compUrls].filter(u => !origUrls.has(u));
  if (lostUrls.length > 0 || addedUrls.length > 0) {
    errors.push(`URL mismatch: lost=${lostUrls.join(", ")}, added=${addedUrls.join(", ")}`);
  }

  // Bullets (warning only — 15% threshold)
  const origBullets = (original.match(BULLET_REGEX) || []).length;
  const compBullets = (compressed.match(BULLET_REGEX) || []).length;
  if (origBullets > 0 && Math.abs(origBullets - compBullets) / origBullets > 0.15) {
    warnings.push(`Bullet count changed: ${origBullets} -> ${compBullets}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── File type detection (for compress tool) ─────────────────────────

const COMPRESSIBLE_EXTENSIONS = new Set([".md", ".txt", ".markdown", ".rst"]);

const SKIP_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".env", ".lock", ".css", ".scss", ".html", ".xml",
  ".sql", ".sh", ".bash", ".zsh", ".go", ".rs", ".java", ".c",
  ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt", ".lua",
]);

/**
 * Check if a file path is compressible (natural language, not code/config).
 * @param {string} filePath - Path to check
 * @returns {boolean}
 */
export function isCompressible(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (filePath.endsWith(".original.md")) return false;
  if (COMPRESSIBLE_EXTENSIONS.has(ext)) return true;
  if (SKIP_EXTENSIONS.has(ext)) return false;
  // Unknown extension — not compressible by default
  return false;
}
