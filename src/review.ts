/**
 * Review Mode — analyzes recent changes and provides actionable feedback.
 *
 * Uses a read-only agent pass to examine git diffs and recent commits,
 * then produces a structured code review with actionable suggestions.
 *
 * Similar to architect mode but focused on reviewing existing changes
 * rather than planning new ones.
 *
 * Key exports:
 *   - reviewPass(client, model, options): Main entry point
 *   - REVIEW_SYSTEM_PROMPT: System prompt for review mode
 *
 * Dependencies: ./tools/registry.js, ./tool-call-parser.js,
 *               ./logger.js, ./constants.js, ./providers/ollama.js
 * Depended on by: src/agent.js, src/ui/App.js
 */

import * as registry from "./tools/registry.js";
import { parseToolCallsFromContent } from "./tool-call-parser.js";
import { logger } from "./logger.js";
import { DEFAULT_MAX_TOKENS } from "./constants.js";
import { execFileSync } from "node:child_process";
import { OllamaProvider } from "./providers/ollama.js";

const REVIEW_TOOLS = new Set(["read_file", "list_files", "grep", "code_execution"]);

export const REVIEW_SYSTEM_PROMPT = `You are a code reviewer that analyzes recent changes and provides actionable feedback.

## Your role
- Examine the git diff and recent commits provided below
- Use tools (read_file, list_files, grep, code_execution) to understand surrounding context
- Use code_execution to batch multiple reads/searches in a single turn for efficiency
- Produce a clear, actionable code review

## What to look for
- **Correctness**: Bugs, logic errors, off-by-one mistakes, unhandled edge cases, race conditions
- **Security**: Injection vulnerabilities, unsafe input handling, leaked secrets, OWASP top 10
- **Complexity**: Overly nested logic, functions doing too much, unclear control flow, code that should be simplified or extracted
- **Test quality**: Bad or vague test names (e.g. "test1", "it works"), missing assertions, tests that don't actually test the behavior they claim to, missing edge case coverage
- **Naming & grammar**: Typos in variable/function names, misleading names, grammatical errors in comments/strings/docs
- **Error handling**: Swallowed errors, missing error paths, unhelpful error messages
- **Performance**: Unnecessary allocations, O(n²) where O(n) is possible, repeated work that could be cached

## Rules
- Use tools immediately — do NOT narrate "I will read..."
- Read relevant files to understand the context around changes
- Focus on substantive issues, not style nitpicks
- Your final output must be a structured review with:
  1. **Summary**: Brief overview of what changed
  2. **Issues**: Bugs, logic errors, security concerns, complexity problems, or correctness issues
  3. **Test feedback**: Problems with test names, missing coverage, or weak assertions
  4. **Improvements**: Suggestions for better approaches, performance, or readability
  5. **Naming & grammar**: Typos, misleading names, grammatical errors in comments/strings
  6. **Good patterns**: Things done well that should be continued
  7. **Action items**: A prioritized checklist of concrete fixes (most important first)
- Each issue or improvement must reference the specific file and code involved
- Be constructive — explain *why* something is a problem and *how* to fix it
- If a section has no findings, omit it rather than saying "none found"
- Use <thinking>...</thinking> for internal reasoning`;

// No hard iteration cap — the review runs until the model stops making tool calls.
// Safety valve to prevent infinite loops (e.g. model stuck in a tool-call cycle).
const MAX_REVIEW_ITERATIONS = 200;

interface GitChanges {
  diff: string;
  log: string;
  uncommitted: string;
  branch: string;
}

interface ReviewOptions {
  cwd?: string;
  maxTokens?: number;
  projectContext?: string;
  signal?: AbortSignal | null;
  onProgress?: ((event: ReviewProgressEvent) => void) | null;
  scope?: string;
  branch?: string;
}

interface ReviewProgressEvent {
  type: string;
  current?: number;
  max?: number;
  name?: string;
  args?: Record<string, unknown>;
  iterations?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface BaseLLMProvider {
  formatTools(tools: unknown[]): unknown;
  chatWithRetry(
    messages: ChatMessage[],
    tools: unknown,
    signal: AbortSignal | null,
    maxTokens: number
  ): Promise<{ message: ChatMessage }>;
  client?: unknown;
}

/**
 * Detect the base branch that a branch diverged from.
 * Tries main, then master, then falls back to HEAD~1.
 */
function detectBaseBranch(cwd: string, branch?: string): string {
  const opts = { cwd, maxBuffer: 10 * 1024, timeout: 10_000 };
  const tip = branch || "HEAD";

  // Get the branch name we're reviewing
  let branchName = branch || "";
  if (!branchName) {
    try {
      branchName = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts).toString().trim();
    } catch { /* empty */ }
  }

  // If reviewing main/master itself, fall back to HEAD~1
  if (branchName === "main" || branchName === "master") {
    return `${tip}~1`;
  }

  // Try to find the merge-base with common default branches
  for (const base of ["main", "master"]) {
    try {
      const mergeBase = execFileSync(
        "git", ["merge-base", base, tip],
        opts,
      ).toString().trim();
      if (mergeBase) return mergeBase;
    } catch { /* branch doesn't exist, try next */ }
  }

  // Fallback: diff against tip~1
  return `${tip}~1`;
}

/**
 * Gather changes for review.
 * When a branch is specified, compares that branch against its base.
 * Otherwise compares the current branch against its base (main/master),
 * including uncommitted work.
 */
function gatherGitChanges(cwd: string, branch?: string): GitChanges {
  const opts = { cwd, maxBuffer: 200 * 1024, timeout: 15_000 };
  const tip = branch || "HEAD";

  const base = detectBaseBranch(cwd, branch);
  let diff = "";
  let log = "";
  let uncommitted = "";

  // All committed changes since diverging from base
  try {
    diff = execFileSync("git", ["diff", base, tip], opts).toString();
  } catch {
    // Fallback for fresh repos or missing base
    try {
      diff = execFileSync("git", ["diff", `${tip}~1`, tip], opts).toString();
    } catch { /* empty */ }
  }

  // Uncommitted changes only make sense for the current branch
  if (!branch) {
    try {
      const uncommittedDiff = execFileSync("git", ["diff", "HEAD"], opts).toString();
      if (uncommittedDiff.trim()) {
        uncommitted = uncommittedDiff;
      }
    } catch { /* empty */ }
  }

  // Commit log since base
  try {
    log = execFileSync(
      "git", ["log", "--oneline", "--no-decorate", `${base}..${tip}`],
      opts,
    ).toString();
  } catch {
    // Fallback
    try {
      log = execFileSync(
        "git", ["log", "--oneline", "-10", "--no-decorate", tip],
        opts,
      ).toString();
    } catch { /* empty */ }
  }

  // Resolve the branch name for display
  let branchName = branch || "";
  if (!branchName) {
    try {
      branchName = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts).toString().trim();
    } catch { /* empty */ }
  }

  return { diff, log, uncommitted, branch: branchName };
}

/**
 * Run the review pass: analyze recent changes and produce a code review.
 *
 * Accepts either:
 *   reviewPass(provider, options) — provider is a BaseLLMProvider instance
 *   reviewPass(client, model, options) — legacy Ollama client + model string
 */
export async function reviewPass(
  clientOrProvider: unknown,
  modelOrOptions?: string | ReviewOptions,
  options: ReviewOptions = {}
): Promise<string> {
  // Support both calling conventions:
  //   reviewPass(provider, options) — new style
  //   reviewPass(client, model, options) — legacy style
  let provider: BaseLLMProvider;
  let opts: ReviewOptions;

  if (typeof modelOrOptions === "string") {
    // Legacy: reviewPass(client, model, options)
    provider = new OllamaProvider({ model: modelOrOptions }) as unknown as BaseLLMProvider;
    provider.client = clientOrProvider;
    opts = options;
  } else {
    // New: reviewPass(provider, options)
    provider = clientOrProvider as BaseLLMProvider;
    opts = modelOrOptions || {};
  }

  const {
    cwd = process.cwd(),
    maxTokens = DEFAULT_MAX_TOKENS,
    projectContext = "",
    signal = null,
    onProgress = null,
    scope = "",
    branch = "",
  } = opts;

  const { diff, log, uncommitted, branch: branchName } = gatherGitChanges(cwd, branch || undefined);

  if (!diff && !uncommitted) {
    return "(No changes found to review. Make some changes or commits first.)";
  }

  // Build the user prompt with the git context
  const branchLabel = branchName ? ` on branch \`${branchName}\`` : "";
  let changesSection = "";
  if (log) {
    changesSection += `## Branch commits${branchLabel}\n\`\`\`\n${log}\n\`\`\`\n\n`;
  }
  if (diff) {
    changesSection += `## Branch changes (committed)\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
  }
  if (uncommitted) {
    changesSection += `## Uncommitted changes\n\`\`\`diff\n${uncommitted}\n\`\`\`\n\n`;
  }

  const scopeHint = scope ? `\nFocus your review on: ${scope}\n` : "";

  const userPrompt = `Review the following changes${branchLabel} and provide actionable feedback.${scopeHint}

${changesSection}
Read the relevant source files for additional context, then produce your review.`;

  const systemContent = projectContext
    ? `${REVIEW_SYSTEM_PROMPT}\n\n# Project context\n\n${projectContext}`
    : REVIEW_SYSTEM_PROMPT;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userPrompt },
  ];

  // Only expose read-only tools
  const readOnlyTools = registry
    .ollamaTools(true)
    .filter((t) => REVIEW_TOOLS.has(t.function.name));

  onProgress?.({ type: "review_start" });

  for (let i = 0; i < MAX_REVIEW_ITERATIONS; i++) {
    if (signal?.aborted) {
      return "(Review cancelled)";
    }

    onProgress?.({ type: "review_iteration", current: i + 1, max: MAX_REVIEW_ITERATIONS });

    let response;
    try {
      const formattedTools = provider.formatTools(readOnlyTools);
      response = await provider.chatWithRetry(
        messages, formattedTools, signal, maxTokens,
      );
    } catch (err: unknown) {
      const error = err as Error;
      logger.error(`Review pass failed: ${error.message}`);
      return `(Review failed: ${error.message})`;
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
        .filter(tc => REVIEW_TOOLS.has(tc.function.name)) as ToolCall[];
    }

    // No tool calls → this is the final review
    if (toolCalls.length === 0) {
      onProgress?.({ type: "review_done", iterations: i + 1 });
      return content || "(No review produced)";
    }

    // Execute review-safe tool calls
    // code_execution sandbox is restricted to read-only tools via allowedTools
    const readOnlySet = new Set(["read_file", "list_files", "grep"]);
    for (const tc of toolCalls) {
      const name = tc.function.name;
      const args = tc.function.arguments;

      if (!REVIEW_TOOLS.has(name)) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Tool "${name}" not available in review mode` }),
        });
        continue;
      }

      onProgress?.({ type: "review_tool", name, args });

      const result = await registry.execute(name, args, { cwd, allowedTools: readOnlySet });
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
  return lastAssistant?.content || "(Review reached iteration limit)";
}