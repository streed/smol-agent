/**
 * Simplify Mode — analyzes current changes and simplifies them.
 *
 * Uses an agent pass to examine git diffs and apply simplifications
 * such as: removing redundant code, consolidating functions, improving
 * variable names, extracting common patterns, reducing complexity.
 *
 * Key exports:
 *   - simplifyPass(client, model, options): Main entry point
 *
 * Dependencies: ./ollama.js, ./tools/registry.js, ./tool-call-parser.js,
 *               ./logger.js, ./constants.js
 */

import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { parseToolCallsFromContent } from "./tool-call-parser.js";
import { logger } from "./logger.js";
import { DEFAULT_MAX_TOKENS } from "./constants.js";
import { execFileSync } from "node:child_process";

// Tools allowed for simplification: read + write operations
const SIMPLIFY_TOOLS = new Set([
  "read_file", "list_files", "grep", "replace_in_file", "write_file",
]);

const SIMPLIFY_SYSTEM_PROMPT = `You are a code simplification agent that improves current changes.

## Your role
- Examine the git diff showing current uncommitted changes
- Simplify the changes by removing redundancy, improving clarity, reducing complexity
- Apply the simplifications directly using file tools

## Simplification guidelines
- Remove duplicate code — if the same logic exists elsewhere, consolidate it
- Simplify complex conditionals — use early returns, extract methods, use guard clauses
- Improve naming — rename cryptic variables/functions to be self-documenting
- Reduce nesting — flatten deeply nested conditionals
- Remove dead code — delete unused variables, imports, functions
- Extract common patterns — if similar code appears multiple times, create a helper
- Apply idiomatic patterns — use language-native idioms instead of manual implementations

## Rules
- Use tools immediately — do NOT narrate "I will read..." or "I will simplify..."
- Read relevant files to understand context before modifying
- Use replace_in_file for targeted edits, write_file only for new files
- After applying all simplifications, output a summary of what was changed
- If changes are already simple, output "(No simplifications needed)"
- Keep the core functionality intact — simplify, don't rewrite from scratch
- Use <thinking>...</thinking> for internal reasoning
- Your final output must be a markdown summary of changes made`;

const MAX_SIMPLIFY_ITERATIONS = 25;

/**
 * Gather uncommitted changes for simplification.
 *
 * @param {string} cwd - Working directory (must be inside a git repo)
 * @returns {{ diff: string, files: string[] }} The git context
 */
function gatherUncommittedChanges(cwd) {
  const opts = { cwd, maxBuffer: 200 * 1024, timeout: 15_000 };

  let diff = "";
  const files = [];

  // Get uncommitted changes (staged + unstaged)
  try {
    diff = execFileSync("git", ["diff", "HEAD"], opts).toString();
  } catch {
    // Not a git repo or no commits
    return { diff: "", files: [] };
  }

  // Get list of changed files
  try {
    const status = execFileSync("git", ["status", "--porcelain"], opts).toString();
    const lines = status.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      // Status format: "XY filename" where XY are status codes
      const file = line.slice(3).trim();
      if (file) files.push(file);
    }
  } catch { /* empty */ }

  return { diff, files };
}

/**
 * Run the simplify pass: analyze current changes and apply simplifications.
 *
 * @param {object} client - LLM client
 * @param {string} model - Model name
 * @param {object} [options]
 * @param {string} [options.cwd] - Working directory
 * @param {number} [options.maxTokens] - Max context tokens
 * @param {string} [options.projectContext] - Pre-gathered project context
 * @param {AbortSignal} [options.signal] - Cancellation signal
 * @param {function} [options.onProgress] - Progress callback
 * @returns {Promise<string>} Summary of simplifications made
 */
export async function simplifyPass(client, model, options = {}) {
  const {
    cwd = process.cwd(),
    maxTokens = DEFAULT_MAX_TOKENS,
    projectContext = "",
    signal = null,
    onProgress = null,
  } = options;

  const { diff, files } = gatherUncommittedChanges(cwd);

  if (!diff) {
    return "(No uncommitted changes to simplify. Stage or modify some files first.)";
  }

  // Build the user prompt with the git context
  const userPrompt = `Simplify the following uncommitted changes. Read the relevant source files for context, then apply simplifications using replace_in_file.

## Changed files
${files.map(f => `- ${f}`).join("\n")}

## Current diff
\`\`\`diff
${diff}
\`\`\`

Apply simplifications now, then summarize what you changed.`;

  const systemContent = projectContext
    ? `${SIMPLIFY_SYSTEM_PROMPT}\n\n# Project context\n\n${projectContext}`
    : SIMPLIFY_SYSTEM_PROMPT;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userPrompt },
  ];

  // Expose read + write tools for simplification
  const simplifyTools = registry
    .ollamaTools(true)
    .filter((t) => SIMPLIFY_TOOLS.has(t.function.name));

  onProgress?.({ type: "simplify_start", files });

  for (let i = 0; i < MAX_SIMPLIFY_ITERATIONS; i++) {
    if (signal?.aborted) {
      return "(Simplification cancelled)";
    }

    onProgress?.({ type: "simplify_iteration", current: i + 1, max: MAX_SIMPLIFY_ITERATIONS });

    let response;
    try {
      response = await ollama.chatWithRetry(
        client, model, messages, simplifyTools, signal, maxTokens,
      );
    } catch (err) {
      logger.error(`Simplify pass failed: ${err.message}`);
      return `(Simplification failed: ${err.message})`;
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
        .filter(tc => SIMPLIFY_TOOLS.has(tc.function.name));
    }

    // No tool calls → this is the final summary
    if (toolCalls.length === 0) {
      onProgress?.({ type: "simplify_done", iterations: i + 1 });
      return content || "(No simplifications made)";
    }

    // Execute tool calls
    for (const tc of toolCalls) {
      const name = tc.function.name;
      const args = tc.function.arguments;

      if (!SIMPLIFY_TOOLS.has(name)) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Tool "${name}" not available in simplify mode` }),
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
  return lastAssistant?.content || "(Simplification reached iteration limit)";
}