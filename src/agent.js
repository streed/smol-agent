import { EventEmitter } from "node:events";
import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { gatherContext } from "./context.js";
import { logger } from "./logger.js";
import { ContextManager } from "./context-manager.js";
import { getCurrentPlan } from "./tools/save_plan.js";
import { parseToolCallsFromContent } from "./tool-call-parser.js";
import { classifyError, formatUserError } from "./errors.js";

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
import "./tools/context_docs.js";

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
- After exploring a directory, use save_context to record what you found (keep it short and dense — key files, exports, patterns, no prose).
- Before exploring, check if .smol-agent/docs/ has context for that area (listed in project context).
- Check available skills (listed in project context) and read relevant ones before starting a task.

## Error recovery
- If replace_in_file fails, read the file to see its actual content, then retry.
- If a command fails, analyze the error output before retrying blindly.
- If you're stuck after 2 failed attempts, step back and try a different approach.
- To test HTTP servers, start the server in the background and use curl to hit endpoints (e.g. \`node server.js & sleep 1 && curl http://localhost:PORT/endpoint\`).

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

// ── Loop detection ───────────────────────────────────────────────────

/**
 * Detect if the agent is stuck in a repetitive tool-call loop.
 * Examines a sliding window of recent tool call signatures and returns
 * a severity level:
 *   0 = no loop detected
 *   1 = likely loop (nudge the model)
 *   2 = definite loop (force stop)
 */
export function detectToolLoop(recentSignatures, loopNudges) {
  if (recentSignatures.length < 6) return 0;

  // Count frequency of each signature in the window
  const freq = new Map();
  for (const sig of recentSignatures) {
    freq.set(sig, (freq.get(sig) || 0) + 1);
  }

  const maxFreq = Math.max(...freq.values());
  const uniqueRatio = freq.size / recentSignatures.length;

  // Definite loop: same call >6 times, or very low diversity after a nudge
  if (maxFreq > 6 || (uniqueRatio < 0.2 && loopNudges >= 1)) {
    return 2;
  }

  // Likely loop: same call 4+ times, or very low diversity
  if (maxFreq >= 4 || (uniqueRatio < 0.3 && recentSignatures.length >= 8)) {
    return 1;
  }

  return 0;
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

    // Loop detection — sliding window of recent tool call signatures
    this._recentToolCalls = [];
    this._loopNudges = 0;

    // User nudge injection — messages queued while the agent is running
    this._pendingInjections = [];

    // Approval system — handler set by UI, _approveAll toggled by user pressing "a"
    this._approvalHandler = null;
    this._approveAll = false;

    // Set the global jail directory for all tools
    registry.setJailDirectory(this.jailDirectory);

    setSearchClient(this.client);
    setFetchClient(this.client);

    // Set up LLM-based summarization if model is large enough (has all tools)
    if (!coreToolsOnly) {
      this.contextManager.setLLMClient(host, this.model);
    }

    // Always configure sub-agent for delegation (share parent's client)
    setSubAgentConfig({
      client: this.client,
      host,
      model: this.model,
      maxTokens: this.maxTokens,
      cwd: this.jailDirectory,
    });
  }

  /**
   * Set the approval handler for dangerous tool calls.
   * handler: (name: string, args: object) => Promise<{ approved: boolean, approveAll?: boolean }>
   */
  setApprovalHandler(handler) {
    this._approvalHandler = handler;
  }

  /**
   * Inject a user message into the running conversation.
   * The message will be picked up on the next loop iteration.
   */
  inject(message) {
    if (this.running) {
      this._pendingInjections.push(message);
    }
  }

  /** Get current token usage info. */
  getTokenInfo() {
    return this.contextManager.getUsage(this.messages);
  }

  /** Change the model on the fly. */
  setModel(newModel) {
    this.model = newModel;
    // Update context manager's LLM client for summarization
    this.contextManager.setLLMClient(this.client.host, this.model);
    // Update sub-agent config
    setSubAgentConfig({
      client: this.client,
      host: this.client.host,
      model: this.model,
      maxTokens: this.maxTokens,
      cwd: this.jailDirectory,
    });
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
    const allTools = registry.ollamaTools(this.coreToolsOnly);
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
    this._toolFailures = new Map();
    this._modifiedFiles = new Set();
    this._verifiedFiles = new Set();
    this._recentToolCalls = [];
    this._loopNudges = 0;
    this.messages.push({ role: "user", content: userMessage });

    // Progressive compression of old messages (cheap, always runs)
    this.contextManager.compressOldMessages(this.messages);

    // Update sub-agent with current run's signal and progress callback
    setSubAgentConfig({
      signal: this.abortController.signal,
      onProgress: (event) => this.emit("sub_agent_progress", event),
    });

    const tools = registry.ollamaTools(this.coreToolsOnly);
    let iterations = 0;
    let consecutiveAgentRetries = 0;
    let overflowRetries = 0;
    const MAX_AGENT_RETRIES = 2;
    const MAX_STREAM_RETRIES = 2;
    const MAX_OVERFLOW_RETRIES = 1;

    // Retry callback — emits events for UI feedback
    const onRetry = ({ attempt, maxRetries, error, delayMs }) => {
      const msg = formatUserError(error, this.model);
      logger.warn(`Retry ${attempt}/${maxRetries}: ${msg} (waiting ${Math.round(delayMs)}ms)`);
      this.emit("retry", { attempt, maxRetries, message: msg, delayMs });
    };

    while (iterations++ < 200) {
      try {
        // ── Flush any injected user messages ──
        while (this._pendingInjections.length > 0) {
          const injected = this._pendingInjections.shift();
          this.messages.push({ role: "user", content: injected });
          this.emit("injection", { content: injected });
          logger.info(`Injected user nudge: ${injected.slice(0, 80)}`);
        }

        // Emit current usage for UI
        this.emit("token_usage", this.getTokenInfo());

        // ── Mid-loop context management (every 5 iterations, skip first) ──
        if (iterations > 1 && iterations % 5 === 0) {
          this.contextManager.compressOldMessages(this.messages);
          const midStatus = this.contextManager.getStatus(this.messages);
          if (midStatus.shouldPrune) {
            logger.info(`Mid-loop prune at iteration ${iterations} (${midStatus.usage.percentage}%)`);
            const pruneResult = this.contextManager.pruneMessages(this.messages);
            this.messages = pruneResult.messages;
            this.emit("token_usage", this.getTokenInfo());
          }
        }

        // ── Stream the response (with mid-stream retry) ──
        let fullContent = "";
        let toolCalls = [];
        let streamSuccess = false;

        for (let streamAttempt = 0; streamAttempt <= MAX_STREAM_RETRIES; streamAttempt++) {
          fullContent = "";
          toolCalls = [];
          let streamTimedOut = false;

          this.emit("stream_start");

          // Stream timeout — abort if no token arrives within 60 seconds
          let streamTimer = setTimeout(() => {
            streamTimedOut = true;
            if (this.abortController) {
              this.abortController.abort();
            }
          }, 60_000);
          const resetStreamTimer = () => {
            clearTimeout(streamTimer);
            if (!streamTimedOut) {
              streamTimer = setTimeout(() => {
                streamTimedOut = true;
                if (this.abortController) {
                  this.abortController.abort();
                }
              }, 60_000);
            }
          };

          try {
            for await (const event of ollama.chatStream(
              this.client, this.model, this.messages, tools,
              this.abortController.signal, this.maxTokens, onRetry,
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
                    event.tokenUsage.completionTokens,
                    this.messages.length,
                  );
                }
              }
            }

            clearTimeout(streamTimer);
            this.emit("stream_end");
            streamSuccess = true;
            break; // stream completed successfully
          } catch (streamErr) {
            clearTimeout(streamTimer);
            this.emit("stream_end");

            // User cancellation propagates immediately
            if (streamErr.name === "AbortError" || streamErr.message === "Operation cancelled") {
              if (streamTimedOut && streamAttempt < MAX_STREAM_RETRIES) {
                // Stream timeout — retry with fresh AbortController
                logger.warn(`Stream timed out, retrying (attempt ${streamAttempt + 1}/${MAX_STREAM_RETRIES})`);
                this.abortController = new AbortController();
                this.emit("retry", { attempt: streamAttempt + 1, maxRetries: MAX_STREAM_RETRIES, message: "Stream timed out, retrying...", delayMs: 0 });
                continue;
              }
              throw streamErr; // real cancellation
            }

            // Only retry transient errors
            if (streamAttempt < MAX_STREAM_RETRIES && classifyError(streamErr) === 'transient') {
              const msg = formatUserError(streamErr, this.model);
              logger.warn(`Mid-stream error, retrying (attempt ${streamAttempt + 1}/${MAX_STREAM_RETRIES}): ${msg}`);
              this.abortController = new AbortController();
              this.emit("retry", { attempt: streamAttempt + 1, maxRetries: MAX_STREAM_RETRIES, message: msg, delayMs: 1000 });
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }

            throw streamErr; // non-retryable or exhausted retries
          }
        }

        if (!streamSuccess) {
          // Should not reach here, but safety net
          throw new Error("Stream failed after all retry attempts");
        }

        // Reset consecutive agent retries on successful stream
        consecutiveAgentRetries = 0;

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

        // ── Loop detection ──
        // Track recent tool call signatures (sliding window of last 12)
        for (const tc of uniqueToolCalls) {
          const sig = JSON.stringify({ n: tc.function.name, a: tc.function.arguments });
          this._recentToolCalls.push(sig);
        }
        if (this._recentToolCalls.length > 12) {
          this._recentToolCalls = this._recentToolCalls.slice(-12);
        }

        const loopSeverity = detectToolLoop(this._recentToolCalls, this._loopNudges);
        if (loopSeverity === 2) {
          // Definite loop — force stop
          logger.warn(`Loop detected (severity 2) after ${iterations} iterations — aborting`);
          this.running = false;
          this.abortController = null;
          this._loopNudges = 0; // Reset for next run
          const msg = "I appear to be stuck in a loop repeating the same actions. Let me stop here — could you rephrase your request or provide more details?";
          this.messages.push({ role: "assistant", content: msg });
          this.emit("response", { content: msg });
          this.emit("token_usage", this.getTokenInfo());
          return msg;
        }
        if (loopSeverity === 1) {
          this._loopNudges++;
          logger.info(`Loop detected (severity 1, nudge ${this._loopNudges}) — injecting warning`);
          this.messages.push({
            role: "user",
            content: "[Auto-hint] You are repeating the same tool calls without making progress. STOP and try a completely different approach. If you cannot accomplish the task, explain what's blocking you instead of retrying the same actions.",
          });
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

          let result = await registry.execute(name, args, { cwd: this.jailDirectory });

          // Track consecutive failures
          if (result?.error) {
            this._toolFailures.set(name, failures + 1);
          } else {
            this._toolFailures.set(name, 0);
          }

          // Truncate large tool results to prevent context bloat (adaptive ceiling)
          const usageRatio = this.contextManager.getUsage(this.messages).percentage / 100;
          result = this.contextManager.truncateToolResult(result, usageRatio);

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
      } catch (err) {
        // ── Agent-level retry for transient errors ──
        if (classifyError(err) === 'transient' && consecutiveAgentRetries < MAX_AGENT_RETRIES) {
          consecutiveAgentRetries++;
          const msg = formatUserError(err, this.model);
          logger.warn(`Agent-level retry ${consecutiveAgentRetries}/${MAX_AGENT_RETRIES}: ${msg}`);
          this.abortController = new AbortController();
          this.emit("retry", { attempt: consecutiveAgentRetries, maxRetries: MAX_AGENT_RETRIES, message: msg, delayMs: 2000 });
          await new Promise(r => setTimeout(r, 2000));
          continue; // retry the while loop iteration
        }

        if (err.name === "AbortError" || err.message === "Operation cancelled") {
          this.running = false;
          this.abortController = null;
          this.emit("response", { content: "(Operation cancelled)" });
          return "(Operation cancelled)";
        }

        // Handle context overflow errors — compress + prune, then retry once
        if (ContextManager.isContextOverflowError(err)) {
          const beforeUsage = this.contextManager.getUsage(this.messages);
          logger.error(`Context overflow: ${beforeUsage.used}/${beforeUsage.max} tokens (${beforeUsage.percentage}%)`);

          // Compress old messages first, then aggressively prune
          this.contextManager.compressOldMessages(this.messages);
          const result = this.contextManager.pruneMessages(this.messages, { aggressive: true });
          this.messages = result.messages;

          const afterUsage = this.contextManager.getUsage(this.messages);
          logger.info(`After overflow pruning: ${afterUsage.used}/${afterUsage.max} tokens (${afterUsage.percentage}%)`);
          this.emit("token_usage", afterUsage);

          if (overflowRetries < MAX_OVERFLOW_RETRIES) {
            overflowRetries++;
            logger.info(`Overflow retry ${overflowRetries}/${MAX_OVERFLOW_RETRIES} — continuing`);
            continue; // retry the while loop after pruning
          }

          // Exhausted overflow retries — give up
          this.running = false;
          this.abortController = null;
          const msg = `(Context limit exceeded at ${beforeUsage.percentage}% — pruned ${result.pruned} messages, now at ${afterUsage.percentage}%. Please retry.)`;
          this.emit("error", new Error(msg));
          return msg;
        }

        // Non-recoverable error
        this.running = false;
        this.abortController = null;
        const userMsg = formatUserError(err, this.model);
        this.emit("error", new Error(userMsg));
        throw err;
      }
    }

    // Iteration limit
    this.running = false;
    this.abortController = null;
    const msg = "(Agent reached maximum iteration limit)";
    this.emit("response", { content: msg });
    return msg;
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
    this._recentToolCalls = [];
    this._loopNudges = 0;
    this._pendingInjections = [];
    this._approveAll = false;
  }

  /** Get the current project context as a string. */
  async getContext() {
    return await gatherContext(this.jailDirectory, this.contextSize);
  }

  /**
   * Refresh the system context (skills, plans, etc.) without resetting conversation.
   * Updates the system message with fresh context while preserving message history.
   */
  async refreshContext() {
    // Find and update the system message in place
    const systemIndex = this.messages.findIndex(m => m.role === "system");
    if (systemIndex === -1) return;

    // Re-gather context
    let contextBlock = "";
    try {
      contextBlock = await gatherContext(this.jailDirectory, this.contextSize);
    } catch { /* proceed without context */ }

    // Rebuild tool schema block
    const allTools = registry.ollamaTools(this.coreToolsOnly);
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

    // List extended tools
    const extended = registry.extendedToolNames();
    const extendedNote = extended.length > 0
      ? `\n\nAdditional tools available if needed: ${extended.join(", ")}`
      : "";

    // Load active plan
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
      + toolSchemaBlock
      + extendedNote
      + planBlock
      + SYSTEM_PROMPT;

    this.messages[systemIndex].content = systemContent;
    logger.info("Context refreshed (skills, plans, tools updated)");
  }

  /** Get conversation messages. */
  getMessages() {
    return this.messages;
  }
}
