/**
 * Simplify Mode — analyzes current changes and suggests simplifications.
 *
 * Examines git diffs and uncommitted changes to identify opportunities for
 * code simplification, then produces a structured analysis with actionable
 * suggestions.
 *
 * Key exports:
 *   - simplifyPass(client, model, options): Main entry point
 *   - SIMPLIFY_SYSTEM_PROMPT: System prompt for simplify mode
 *
 * Dependencies: ./ollama.js, ./tools/registry.js, ./tool-call-parser.js,
 *               ./logger.js, ./constants.js
 * Depended on by: src/ui/App.js
 */

import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { parseToolCallsFromContent } from "./tool-call-parser.js";
import { logger } from "./logger.js";
import { DEFAULT_MAX_TOKENS } from "./constants.js";
import { execFileSync } from "node:child_process";

const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep"]);

const SIMPLIFY_SYSTEM_PROMPT = `You are a code simplification expert that analyzes recent changes and identifies opportunities to simplify the code.

## Your role
- Examine the git diff provided below
- Use read-only tools (read_file, list_files, grep) to understand surrounding context
- Identify patterns that can be simplified, refactored, or cleaned up

## What to look for
1. **Redundant code** — Duplicated logic that could be consolidated
2. **Over-engineering** — Unnecessary abstraction layers, premature optimization
3. **Complex conditionals** — Nested if/else that could be simplified
4. **Dead code** — Unused variables, functions, or imports introduced in changes
5. **Verbose patterns** — Code that could be more concise without losing clarity
6. **Repetitive patterns** — Similar operations that could use helper functions
7. **Unnecessary complexity** — Overly nested callbacks, excessive error handling
8. **Better alternatives** — Simpler APIs, language features, or patterns

## Rules
- Use tools immediately — do NOT narrate "I will read..."
- Read relevant files to understand the context around changes
- Focus on substantive simplifications, not trivial nitpicks
- Your final output must be a structured analysis with:
  1. **Summary**: Brief overview of what changed
  2. **Simplification opportunities**: Prioritized list of specific improvements
  3. **Before/After examples**: Show concrete code changes for key items
  4. **Impact**: Estimated benefit of each simplification (maintainability, performance, readability)
- Each suggestion must reference specific file paths and line references
- Be practical — explain *why* something can be simplified and *how* to do it
- Use <thinking>...</thinking> for internal reasoning`;

const MAX_SIMPLIFY_ITERATIONS = 20;

/**
 * Detect the base branch that the current branch diverged from.
 * Tries main, then master, then falls back to HEAD~1.
 *
 * @param {string} cwd - Working directory
 * @returns {string} The merge-base ref to diff against
 */
function detectBaseBranch(cwd) {
  const opts = { cwd, maxBuffer: 10 * 1024, timeout: 10_000 };

  // Get current branch name
  let currentBranch = "";
  try {
    currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts).toString().trim();
  } catch { /* empty */ }

  // If we're on main/master itself, fall back to HEAD~1
  if (currentBranch === "main" || currentBranch === "master") {
    return "HEAD~1";
  }

  // Try to find the merge-base with common default branches
  for (const base of ["main", "master"]) {
    try {
      const mergeBase = execFileSync(
        "git", ["merge-base", base, "HEAD"],
        opts,
      ).toString().trim();
      if (mergeBase) return mergeBase;
    } catch { /* branch doesn't exist, try next */ }
  }

  // Fallback: diff against HEAD~1
  return "HEAD~1";
}

/**
 * Gather changes in the current branch for simplification analysis.
 * Compares the current branch against its base (main/master) to show
 * all changes introduced by this branch, including uncommitted work.
 *
 * @param {string} cwd - Working directory (must be inside a git repo)
 * @returns {{ diff: string, uncommitted: string }} The git context
 */
function gatherGitChanges(cwd) {
  const opts = { cwd, maxBuffer: 200 * 1024, timeout: 15_000 };

  const base = detectBaseBranch(cwd);
  let diff = "";
  let uncommitted = "";

  // All committed changes on this branch since diverging from base
  try {
    diff = execFileSync("git", ["diff", base, "HEAD"], opts).toString();
  } catch {
    // Fallback for fresh repos or missing base
    try {
      diff = execFileSync("git", ["diff", "HEAD~1", "HEAD"], opts).toString();
    } catch { /* empty */ }
  }

  // Uncommitted changes (staged + unstaged) on top of HEAD
  try {
    const uncommittedDiff = execFileSync("git", ["diff", "HEAD"], opts).toString();
    if (uncommittedDiff.trim()) {
      uncommitted = uncommittedDiff;
    }
  } catch { /* empty */ }

  return { diff, uncommitted };
}

/**
 * Run the simplify pass: analyze recent changes and suggest simplifications.
 *
 * @param {object} client - Ollama client
 * @param {string} model - Model name
 * @param {object} [options]
 * @param {string} [options.cwd] - Working directory
 * @param {number} [options.maxTokens] - Max context tokens
 * @param {string} [options.projectContext] - Pre-gathered project context
 * @param {AbortSignal} [options.signal] - Cancellation signal
 * @param {function} [options.onProgress] - Progress callback
 * @param {string} [options.scope] - Optional scope hint (e.g. file path)
 * @returns {Promise<string>} The simplification analysis
 */
export async function simplifyPass(client, model, options = {}) {
  const {
    cwd = process.cwd(),
    maxTokens = DEFAULT_MAX_TOKENS,
    projectContext = "",
    signal = null,
    onProgress = null,
    scope = "",
  } = options;

  const { diff, uncommitted } = gatherGitChanges(cwd);

  if (!diff && !uncommitted) {
    return "(No changes found to analyze. Make some changes first.)";
  }

  // Build the user prompt with the git context
  let changesSection = "";
  if (diff) {
    changesSection += `## Committed changes\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
  }
  if (uncommitted) {
    changesSection += `## Uncommitted changes\n\`\`\`diff\n${uncommitted}\n\`\`\`\n\n`;
  }

  const scopeHint = scope ? `\nFocus your analysis on: ${scope}\n` : "";

  const userPrompt = `Analyze the following recent changes and identify opportunities to simplify the code.${scopeHint}

${changesSection}
Read the relevant source files for additional context, then produce your simplification analysis.`;

  const systemContent = projectContext
    ? `${SIMPLIFY_SYSTEM_PROMPT}\n\n# Project context\n\n${projectContext}`
    : SIMPLIFY_SYSTEM_PROMPT;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userPrompt },
  ];

  // Only expose read-only tools
  const readOnlyTools = registry
    .ollamaTools(true)
    .filter((t) => READ_ONLY_TOOLS.has(t.function.name));

  onProgress?.({ type: "simplify_start" });

  for (let i = 0; i < MAX_SIMPLIFY_ITERATIONS; i++) {
    if (signal?.aborted) {
      return "(Simplify analysis cancelled)";
    }

    onProgress?.({ type: "simplify_iteration", current: i + 1, max: MAX_SIMPLIFY_ITERATIONS });

    let response;
    try {
      response = await ollama.chatWithRetry(
        client, model, messages, readOnlyTools, signal, maxTokens,
      );
    } catch (err) {
      logger.error(`Simplify pass failed: ${err.message}`);
      return `(Simplify analysis failed: ${err.message})`;
    }

    const msg = response.message;

    // Strip thinking tags
    const content = msg.content
      ? msg.content.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
      : "";

    messages.push({ role: "assistant", content, tool_calls: msg.tool_calls });

    // Check for tool calls
    let toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0 && content) {
      toolCalls = parseToolCallsFromContent(content)
        .filter(tc => READ_ONLY_TOOLS.has(tc.function.name));
    }

    // No tool calls → this is the final analysis
    if (toolCalls.length === 0) {
      onProgress?.({ type: "simplify_done", iterations: i + 1 });
      return content || "(No simplification analysis produced)";
    }

    // Execute read-only tool calls
    for (const tc of toolCalls) {
      const name = tc.function.name;
      const args = tc.function.arguments;

      if (!READ_ONLY_TOOLS.has(name)) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Tool "${name}" not available in simplify mode (read-only)` }),
        });
        continue;
      }

      onProgress?.({ type: "simplify_tool", name, args });

      const result = await registry.execute(name, args, { cwd });
      const str = JSON.stringify(result);
      // Truncate large results
      const truncated = str.length > 12000
        ? str.substring(0, 12000) + "\n[truncated]"
        : str;
      messages.push({ role: "tool", content: truncated });
    }
  }

  // Hit iteration limit — return last assistant content
  const lastAssistant = messages.filter(m => m.role === "assistant").pop();
  return lastAssistant?.content || "(Simplify analysis reached iteration limit)";
}