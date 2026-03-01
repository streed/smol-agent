import { EventEmitter } from "node:events";
import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { gatherContext } from "./context.js";
import { logger } from "./logger.js";
import { ContextManager, getContextConfig } from "./context-manager.js";
import { getCurrentPlan } from "./tools/save_plan.js";

// Import all tools so they self-register
import "./tools/run_command.js";
import "./tools/file_tools.js";
import "./tools/list_files.js";
import "./tools/grep.js";
import { setOllamaClient as setSearchClient } from "./tools/web_search.js";
import { setOllamaClient as setFetchClient } from "./tools/web_fetch.js";
import "./tools/ask_user.js";
import "./tools/plan_tools.js";
import "./tools/reflection.js";
import "./tools/memory.js";
import { setSubAgentConfig } from "./tools/sub_agent.js";

/**
 * Attempt to extract tool calls from the assistant's text content.
 * Some models output tool calls as JSON instead of using Ollama's
 * native tool_calls field.  We try multiple patterns because different
 * model families format them differently.
 */
function parseToolCallsFromContent(content) {
  if (!content) return [];

  const calls = [];
  const candidates = [];

  // 1. Fenced JSON blocks (```json ... ``` or ``` ... ```)
  const jsonBlockRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let match;
  while ((match = jsonBlockRe.exec(content)) !== null) {
    candidates.push(match[1].trim());
  }

  // 2. <tool_call> ... </tool_call> tags (used by some Qwen/Mistral models)
  const toolCallTagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((match = toolCallTagRe.exec(content)) !== null) {
    candidates.push(match[1].trim());
  }

  // 3. Bare JSON objects with "name" and "arguments" keys (nested braces handled)
  const bareJsonRe = /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;
  while ((match = bareJsonRe.exec(content)) !== null) {
    candidates.push(match[0].trim());
  }

  // 4. Function-call style:  function_name({"key": "value"})
  const funcCallRe = /([a-z_][a-z0-9_]*)\((\{[\s\S]*?\})\)/gi;
  while ((match = funcCallRe.exec(content)) !== null) {
    const name = match[1];
    const argsStr = match[2].trim();
    try {
      const args = JSON.parse(argsStr);
      if (typeof args === "object") {
        calls.push({ function: { name, arguments: args } });
      }
    } catch { /* not valid JSON args */ }
  }

  for (const candidate of candidates) {
    try {
      let parsed = JSON.parse(candidate);
      // Handle arrays of tool calls
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.name && typeof item.name === "string" && item.arguments && typeof item.arguments === "object") {
            calls.push({ function: { name: item.name, arguments: item.arguments } });
          }
        }
        continue;
      }
      if (parsed.name && typeof parsed.name === "string" &&
          parsed.arguments && typeof parsed.arguments === "object") {
        calls.push({
          function: { name: parsed.name, arguments: parsed.arguments },
        });
      }
      // Some models wrap in { "function": { "name": ..., "arguments": ... } }
      if (parsed.function?.name && parsed.function?.arguments) {
        calls.push({
          function: { name: parsed.function.name, arguments: parsed.function.arguments },
        });
      }
    } catch { /* not valid JSON */ }
  }

  return calls;
}

// ── Thinking tags parser ─────────────────────────────────────────────

/**
 * Extract <thinking>...</thinking> blocks from model output.
 * Returns the thinking content (for dim display) and the cleaned content
 * (without thinking blocks, to save context tokens).
 */
function parseThinkingContent(content) {
  if (!content) return { thinking: null, cleaned: content };

  const thinkingBlocks = [];
  const cleaned = content
    .replace(/<thinking>([\s\S]*?)<\/thinking>/g, (_, block) => {
      thinkingBlocks.push(block.trim());
      return "";
    })
    .trim();

  return {
    thinking: thinkingBlocks.length > 0 ? thinkingBlocks.join("\n") : null,
    cleaned: cleaned || content,
  };
}

// ── Tool result analysis ─────────────────────────────────────────────

/**
 * Analyze tool results for actionable failure patterns.
 * Returns suggestions the agent can act on to self-correct.
 */
function analyzeToolResults(results, toolCalls) {
  const suggestions = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const tc = toolCalls[i];
    if (!tc) continue;

    const name = tc.function.name;

    if (name === "replace_in_file" && result?.error) {
      suggestions.push(
        `replace_in_file failed: ${result.error}. Read the file first to see exact content, then retry with the correct oldText.`,
      );
    }

    if (name === "run_command" && result?.exit_code && result.exit_code !== 0) {
      suggestions.push(
        `Command exited with code ${result.exit_code}. Review the error output and fix the underlying issue before retrying.`,
      );
    }
  }

  return suggestions;
}

/**
 * Track which files were modified and which were verified (re-read).
 */
function trackFileOperations(toolCalls, results, modified, verified) {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const result = results[i];
    if (!tc) continue;

    const name = tc.function.name;
    const filePath = tc.function.arguments?.filePath;
    if (!filePath) continue;

    if (
      (name === "write_file" || name === "replace_in_file") &&
      !result?.error
    ) {
      modified.add(filePath);
    }

    if (name === "read_file" && !result?.error) {
      verified.add(filePath);
    }
  }
}

// ── System prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are smol-agent, an EXECUTOR that writes and modifies code directly via tools.
Do NOT describe what you would do — call the tool immediately.

## Workflow
1. **Explore** — list_files, grep, read_file to understand the codebase.
2. **Edit** — replace_in_file for surgical changes; write_file for new files.
3. **Verify** — re-read modified files to confirm changes. Run tests/linters if available.
4. **Report** — one short paragraph summarising what you changed and why.

## Reasoning
Use <thinking>...</thinking> tags to reason through complex decisions before acting.
This helps you plan your approach without cluttering the conversation. Example:
<thinking>The user wants to add auth middleware. I need to find where routes are defined first.</thinking>
Then immediately call a tool — do NOT narrate after thinking.

## Rules
- Think internally, then CALL the tool. Never narrate "I will…" without acting.
- Use relative paths from the project root.
- Prefer replace_in_file over write_file for existing files.
- Prefer file tools over shell commands for file operations.
- Keep responses concise — the user wants results, not essays.
- Ask the user only when the request is genuinely ambiguous.
- After modifying files, always re-read them to verify changes applied correctly.
- If a tool fails, try an alternative approach (e.g., read the file first, then retry with correct content).
- Use the remember tool to save important project facts for future sessions.
- For large research tasks, use the delegate tool to spawn a focused sub-agent.

## Error recovery
- If replace_in_file fails, read the file to see its actual content, then retry.
- If a command fails, analyze the error output before retrying blindly.
- If you're stuck after 2 failed attempts, step back and try a different approach.

## Example tool call
When the user asks "Add a hello() function to utils.js", respond with a tool call like:
<tool_call>
{"name": "replace_in_file", "arguments": {"filePath": "src/utils.js", "oldText": "module.exports = {", "newText": "function hello() {\\n  return 'Hello!';\\n}\\n\\nmodule.exports = {\\n  hello,"}}
</tool_call>`;

/**
 * Detect if the model's text response looks like it's *describing* tool
 * usage rather than actually calling tools.  Common patterns:
 *   "I'll read the file…"  /  "Let me search for…"  /  "First, I need to…"
 *   "I would use replace_in_file…"  /  "Here's what I'll do:…"
 */
function looksLikeUnexecutedIntent(text) {
  if (!text || text.length < 20) return false;
  const lower = text.toLowerCase();

  // Phrases that indicate the model is narrating instead of acting
  const intentPhrases = [
    "i'll ", "i will ", "let me ", "i need to ", "i would ",
    "first, ", "let's ", "i can ", "i should ", "i'm going to ",
    "here's what", "here is what", "the next step",
    "we need to ", "we should ", "we can ",
  ];

  // Tool names that suggest the model knows which tool to use but didn't call it
  const toolMentions = [
    "read_file", "write_file", "replace_in_file", "list_files",
    "grep", "run_command",
  ];

  const hasIntent = intentPhrases.some((p) => lower.includes(p));
  const mentionsTool = toolMentions.some((t) => lower.includes(t));

  // If the response both sounds intentional AND mentions a tool name, it's
  // almost certainly a case where the model described instead of acted.
  // Also trigger if it's a very short "I'll do X" style response.
  return (hasIntent && mentionsTool) || (hasIntent && text.length < 200);
}

// ── Agent ────────────────────────────────────────────────────────────

export class Agent extends EventEmitter {
  constructor({ host, model, contextSize, jailDirectory, coreToolsOnly } = {}) {
    super();
    this.client = ollama.createClient(host);
    this.model = model || ollama.DEFAULT_MODEL;
    this.contextSize = contextSize;
    this.maxTokens = contextSize || 128000;
    this.jailDirectory = jailDirectory || process.cwd();
    this.messages = [];
    this.running = false;
    this._initialized = false;
    this.abortController = null;
    // When true, only expose ~7 core tools to the model (better for <30B models).
    // When false, expose all tools (fine for 30B+ models).
    this.coreToolsOnly = coreToolsOnly ?? true;

    // Context management
    this.contextManager = new ContextManager(this.maxTokens);

    // Circuit breaker — track consecutive failures per tool
    this._toolFailures = new Map();

    // Verify step — track files modified and re-read during a run
    this._modifiedFiles = new Set();
    this._verifiedFiles = new Set();

    // Approval system — handler set by UI, _approveAll toggled by user pressing "a"
    this._approvalHandler = null;
    this._approveAll = false;

    setSearchClient(this.client);
    setFetchClient(this.client);

    // Set up LLM-based summarization if model is large enough (has all tools)
    if (!coreToolsOnly) {
      this.contextManager.setLLMClient(host, this.model);
      // Configure sub-agent for delegation
      setSubAgentConfig({
        host,
        model: this.model,
        maxTokens: this.maxTokens,
        cwd: this.jailDirectory,
      });
    }
  }

  /**
   * Set the approval handler for dangerous tool calls.
   * handler: (name: string, args: object) => Promise<{ approved: boolean, approveAll?: boolean }>
   */
  setApprovalHandler(handler) {
    this._approvalHandler = handler;
  }

  /** Get current token usage info. */
  getTokenInfo() {
    return this.contextManager.getUsage(this.messages);
  }

  /**
   * Build the system message with project context.
   * Called once before the first run(), or after reset().
   */
  async _init() {
    if (this._initialized) return;

    let contextBlock = "";
    try {
      contextBlock = await gatherContext(this.jailDirectory, this.contextSize);
    } catch { /* proceed without context */ }

    // Build compact tool schema block so the model knows the available API
    const allTools = registry.ollamaTools(false);
    const toolLines = allTools.map(t => {
      const fn = t.function;
      const params = fn.parameters?.properties || {};
      const paramList = Object.entries(params)
        .map(([k, v]) => `${k}: ${v.type || 'string'}`)
        .join(', ');
      const desc = (fn.description || '').split('.')[0];
      return `- **${fn.name}**(${paramList}): ${desc}.`;
    });
    const toolSchemaBlock = `\n\n## Available tools\n${toolLines.join('\n')}`;

    // List extended tools so the model knows they exist but isn't overwhelmed
    const extended = registry.extendedToolNames();
    const extendedNote = extended.length > 0
      ? `\n\nAdditional tools available if needed: ${extended.join(", ")}`
      : "";

    // Load active plan if one exists
    let planBlock = "";
    try {
      const plan = await getCurrentPlan();
      if (plan && (plan.details?.status === "in-progress" || plan.details?.status === "pending")) {
        const step = plan.details?.currentStep || 0;
        const desc = plan.details?.description || plan.filename;
        const lastStep = plan.details?.lastCompletedDescription || "none";
        planBlock = `\n\n## Active plan\n- Plan: ${desc}\n- Current step: ${step}\n- Last completed: ${lastStep}\n- Use complete_plan_step after finishing each step.`;
      }
    } catch { /* no plan */ }

    const systemContent = contextBlock
      ? `${SYSTEM_PROMPT}${toolSchemaBlock}${extendedNote}${planBlock}\n\n# Project context\n\n${contextBlock}`
      : `${SYSTEM_PROMPT}${toolSchemaBlock}${extendedNote}${planBlock}`;

    this.messages = [{ role: "system", content: systemContent }];
    this._initialized = true;

    this.emit("context_ready");
  }

  /**
   * Send a user message and run the full tool-call loop with streaming
   * until the model produces a final text response (no more tool calls).
   *
   * Emits:
   *   "context_ready"  — after project context is gathered
   *   "stream_start"   — response streaming begins
   *   "token"          — { content }  each text chunk
   *   "stream_end"     — response streaming finished
   *   "thinking"       — { content }  extracted <thinking> blocks (for dim display)
   *   "tool_call"      — { name, args }
   *   "tool_result"    — { name, result }
   *   "response"       — { content }  final assistant text
   *   "token_usage"    — { used, max, percentage }
   *   "error"          — Error
   */
  async run(userMessage) {
    await this._init();

    // Check and summarize/prune conversation if approaching limit
    const status = this.contextManager.getStatus(this.messages);
    
    // Try summarization first if at 55% capacity
    if (status.shouldSummarize && this.messages.length > 8) {
      logger.info(`Context at ${status.usage.percentage}% - summarizing old messages`);
      try {
        const result = await this.contextManager.summarizeOldMessages(this.messages);
        if (result.summarized) {
          this.messages = result.messages;
          this.emit("token_usage", this.getTokenInfo());
        }
      } catch (error) {
        logger.warn(`Summarization failed: ${error.message}`);
      }
    }
    
    // Then prune if still needed (at 70% capacity)
    const updatedStatus = this.contextManager.getStatus(this.messages);
    if (updatedStatus.shouldPrune) {
      logger.warn(`Context at ${updatedStatus.usage.percentage}% - pruning conversation`);
      const result = this.contextManager.pruneMessages(this.messages);
      this.messages = result.messages;
      this.emit("token_usage", this.getTokenInfo());
    }

    this.running = true;
    this.abortController = new AbortController();
    this._modifiedFiles = new Set();
    this._verifiedFiles = new Set();
    this.messages.push({ role: "user", content: userMessage });

    const tools = registry.ollamaTools(this.coreToolsOnly);
    let iterations = 0;
    let streamTimedOut = false;

    try {
      while (iterations++ < 200) {
        // Emit current usage for UI
        this.emit("token_usage", this.getTokenInfo());

        // ── Stream the response ──
        let fullContent = "";
        let toolCalls = [];

        this.emit("stream_start");

        // Stream timeout — abort if no token arrives within 60 seconds
        streamTimedOut = false;
        let streamTimer = setTimeout(() => {
          streamTimedOut = true;
          this.abortController.abort();
        }, 60_000);
        const resetStreamTimer = () => {
          clearTimeout(streamTimer);
          if (!streamTimedOut) {
            streamTimer = setTimeout(() => {
              streamTimedOut = true;
              this.abortController.abort();
            }, 60_000);
          }
        };

        for await (const event of ollama.chatStream(
          this.client, this.model, this.messages, tools,
          this.abortController.signal, this.maxTokens,
        )) {
          resetStreamTimer();
          if (event.type === "token") {
            fullContent += event.content;
            this.emit("token", { content: event.content });
          } else if (event.type === "done") {
            toolCalls = event.toolCalls || [];
            if (event.tokenUsage) {
              this.contextManager.updateFromAPI(
                event.tokenUsage.promptTokens,
                event.tokenUsage.completionTokens
              );
            }
          }
        }

        clearTimeout(streamTimer);
        this.emit("stream_end");

        // ── Parse thinking tags ──
        const { thinking, cleaned: cleanedContent } = parseThinkingContent(fullContent);
        if (thinking) {
          this.emit("thinking", { content: thinking });
        }

        // Fallback: parse tool calls from content text
        if (toolCalls.length === 0) {
          toolCalls = parseToolCallsFromContent(fullContent);
        }

        // Build assistant message — use cleaned content (thinking stripped) to save context
        const assistantMsg = { role: "assistant", content: cleanedContent };
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        this.messages.push(assistantMsg);

        // No tool calls → check if the model is describing work instead of doing it
        if (toolCalls.length === 0) {
          if (iterations <= 2 && looksLikeUnexecutedIntent(cleanedContent)) {
            // The model described what it would do instead of calling tools.
            // Nudge it to actually use tools.
            this.messages.push({
              role: "user",
              content: "Don't describe what you would do — use your tools to do it now. Call the appropriate tool.",
            });
            continue;
          }

          // ── Verify step: nudge if files were modified but not re-read ──
          const unverified = [...this._modifiedFiles].filter(f => !this._verifiedFiles.has(f));
          if (unverified.length > 0 && iterations <= 5) {
            logger.info(`Verify nudge: ${unverified.length} modified files not re-read`);
            this.messages.push({
              role: "user",
              content: `You modified ${unverified.join(", ")} but didn't verify the changes. Please re-read the modified file(s) to confirm the edits are correct.`,
            });
            continue;
          }

          if (!cleanedContent) {
            logger.warn("Model returned empty response (no content, no tool calls)");
          }

          this.running = false;
          this.abortController = null;
          const content = cleanedContent || "(no response)";
          this.emit("response", { content });
          this.emit("token_usage", this.getTokenInfo());
          return content;
        }

        // ── Deduplicate tool calls ──
        const seen = new Set();
        const uniqueToolCalls = [];
        for (const tc of toolCalls) {
          const key = JSON.stringify({ name: tc.function.name, args: tc.function.arguments });
          if (seen.has(key)) {
            logger.info(`Skipping duplicate tool call: ${tc.function.name}`);
            continue;
          }
          seen.add(key);
          uniqueToolCalls.push(tc);
        }

        // ── Execute tool calls ──
        // Shared execution logic for a single tool call.
        const executeSingleTool = async (tc) => {
          const name = tc.function.name;
          const args = tc.function.arguments;

          if (this.abortController.signal.aborted) {
            return { error: "Operation cancelled" };
          }

          // Circuit breaker — skip tools that failed 3+ times consecutively
          const failures = this._toolFailures.get(name) || 0;
          if (failures >= 3) {
            const msg = `Tool "${name}" has failed ${failures} times consecutively. Try a different approach.`;
            this.emit("tool_result", { name, result: { error: msg } });
            return { error: msg };
          }

          let result = await registry.execute(name, args);

          // Track consecutive failures
          if (result?.error) {
            this._toolFailures.set(name, failures + 1);
          } else {
            this._toolFailures.set(name, 0);
          }

          // Truncate large tool results to prevent context bloat
          result = this.contextManager.truncateToolResult(result);

          this.emit("tool_result", { name, result });
          return result;
        };

        // Decide whether any call needs approval
        const needsApproval = this._approvalHandler && !this._approveAll;
        const anyDangerous = needsApproval &&
          uniqueToolCalls.some(tc => registry.requiresApproval(tc.function.name));

        let results;
        if (anyDangerous) {
          // Sequential — approval prompts must be shown one at a time
          results = [];
          for (const tc of uniqueToolCalls) {
            const name = tc.function.name;
            const args = tc.function.arguments;
            this.emit("tool_call", { name, args });

            // Request approval for dangerous tools
            if (registry.requiresApproval(name) && !this._approveAll && this._approvalHandler) {
              const decision = await this._approvalHandler(name, args);
              if (decision.approveAll) {
                this._approveAll = true;
              }
              if (!decision.approved) {
                const err = { error: "User denied this action. Try a different approach or ask the user for guidance." };
                this.emit("tool_result", { name, result: err });
                results.push(err);
                continue;
              }
            }

            results.push(await executeSingleTool(tc));
          }
        } else {
          // Parallel — no approval needed (all safe, or user approved all)
          results = await Promise.all(
            uniqueToolCalls.map(async (tc) => {
              this.emit("tool_call", { name: tc.function.name, args: tc.function.arguments });
              return executeSingleTool(tc);
            }),
          );
        }

        // ── Track file operations for verify step ──
        trackFileOperations(uniqueToolCalls, results, this._modifiedFiles, this._verifiedFiles);

        // ── Analyze results for self-correction hints ──
        const suggestions = analyzeToolResults(results, uniqueToolCalls);
        if (suggestions.length > 0) {
          logger.info(`Tool result analysis: ${suggestions.length} suggestion(s)`);
        }

        // Push tool results as messages
        for (const result of results) {
          this.messages.push({ role: "tool", content: JSON.stringify(result) });
        }

        // Inject self-correction hints if tools failed
        if (suggestions.length > 0) {
          this.messages.push({
            role: "user",
            content: `[Auto-hint] ${suggestions.join(" ")}`,
          });
        }
      }

      // Iteration limit
      this.running = false;
      this.abortController = null;
      const msg = "(Agent reached maximum iteration limit)";
      this.emit("response", { content: msg });
      return msg;
    } catch (err) {
      this.running = false;
      this.abortController = null;

      if (err.name === "AbortError" || err.message === "Operation cancelled") {
        if (streamTimedOut) {
          const msg = "(Stream timed out — no response from model for 60 seconds)";
          this.emit("response", { content: msg });
          return msg;
        }
        this.emit("response", { content: "(Operation cancelled)" });
        return "(Operation cancelled)";
      }

      // Handle context overflow errors
      if (ContextManager.isContextOverflowError(err)) {
        const beforeUsage = this.contextManager.getUsage(this.messages);
        logger.error(`Context overflow: ${beforeUsage.used}/${beforeUsage.max} tokens (${beforeUsage.percentage}%)`);

        const result = this.contextManager.pruneMessages(this.messages, { aggressive: true });
        this.messages = result.messages;

        const afterUsage = this.contextManager.getUsage(this.messages);
        logger.info(`After pruning: ${afterUsage.used}/${afterUsage.max} tokens (${afterUsage.percentage}%)`);
        this.emit("token_usage", afterUsage);

        const msg = `(Context limit exceeded at ${beforeUsage.percentage}% — pruned ${result.pruned} messages, now at ${afterUsage.percentage}%. Please retry.)`;
        this.emit("error", new Error(msg));
        return msg;
      }

      this.emit("error", err);
      throw err;
    }
  }

  /** Cancel the current operation. */
  cancel() {
    if (this.running && this.abortController) {
      this.abortController.abort();
    }
  }

  /** Reset conversation history and re-gather context on next run. */
  reset() {
    this.messages = [];
    this._initialized = false;
    this.contextManager.reset();
    this._toolFailures = new Map();
    this._modifiedFiles = new Set();
    this._verifiedFiles = new Set();
    this._approveAll = false;
  }

  /** Get the current project context as a string. */
  async getContext() {
    return await gatherContext(this.jailDirectory, this.contextSize);
  }

  /** Get conversation messages. */
  getMessages() {
    return this.messages;
  }
}
