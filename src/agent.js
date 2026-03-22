import { EventEmitter } from "node:events";
import { createProvider } from "./providers/index.js";
import * as registry from "./tools/registry.js";
import { gatherContext, loadScopedRules } from "./context.js";
import { logger, setLogBaseDir } from "./logger.js";
import { ContextManager } from "./context-manager.js";
import { getCurrentPlan } from "./tools/save_plan.js";
import { parseToolCallsFromContent } from "./tool-call-parser.js";
import { classifyError, formatUserError } from "./errors.js";
import { prehydrate } from "./prehydrate.js";
import { ensureInitialized as ensureTiktoken } from "./token-estimator.js";
import { ShiftLeftFeedback } from "./shift-left.js";
import {
  createSession,
  saveSession as persistSession,
  loadSession as fetchSession,
} from "./sessions.js";
import { architectPass, formatPlanForEditor } from "./architect.js";
import { createCheckpoint, rollbackToCheckpoint, listCheckpoints, cleanupCheckpoints } from "./checkpoint.js";
import { touchAgent, detectRepoMetadata, detectSnippet, registerAgent } from "./agent-registry.js";
import { watchForResponses, clearStaleInbox } from "./cross-agent.js";

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
import { setCrossAgentConfig } from "./tools/cross_agent.js";
import "./tools/context_docs.js";
import "./tools/git.js";
import "./tools/session_tools.js";
import "./tools/cross_agent.js";
import "./tools/code_execution.js";

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
    cleaned: thinkingBlocks.length > 0 ? cleaned : content,
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
1. **Explore** — list_files, grep, read_file to understand the codebase. (Referenced files may be pre-loaded for you.)
2. **Edit** — replace_in_file for surgical changes; write_file for new files.
3. **Verify** — re-read modified files to confirm changes. Lint runs automatically after edits — fix any reported errors.
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
- For multi-tool workflows (3+ tool calls, loops, or data aggregation), use code_execution to batch tool calls in a single turn. Write JS code that calls tools as async functions (e.g. \`await read_file({ filePath: "..." })\`). Use console.log() for output.
- After exploring a directory, use save_context to record what you found (keep it short and dense — key files, exports, patterns, no prose).
- Before exploring, check if .smol-agent/docs/ has context for that area (listed in project context).
- Check available skills (listed in project context) and read relevant ones before starting a task.

## Error recovery
- If replace_in_file fails, read the file to see its actual content, then retry.
- If a command fails, analyze the error output before retrying blindly.
- If you're stuck after 2 failed attempts, step back and try a different approach.
- To test HTTP servers, start the server in the background and use curl to hit endpoints (e.g. \`node server.js & sleep 1 && curl http://localhost:PORT/endpoint\`).
- When lint errors appear in [Shift-left] messages, fix them immediately — you have at most 2 fix rounds before the lint budget is exhausted.
- Follow any coding rules from shared rule files (.cursorrules, CLAUDE.md, etc.) shown in project context.

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

  // Exclusion phrases — model is reporting results, not narrating intent
  const exclusionPhrases = [
    "couldn't", "didn't", "not found", "no matching",
    "unable to", "failed to", "already ", "no results",
  ];

  const hasIntent = intentPhrases.some((p) => lower.includes(p));
  const mentionsTool = toolMentions.some((t) => lower.includes(t));
  const hasExclusion = exclusionPhrases.some((p) => lower.includes(p));

  if (hasExclusion) return false;

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
  /**
   * @param {object} options
   * @param {string}  [options.host]          - Ollama host or API base URL
   * @param {string}  [options.model]         - Model name
   * @param {string}  [options.provider]      - Provider name ("ollama", "openai", "anthropic", "grok")
   * @param {string}  [options.apiKey]        - API key for cloud providers
   * @param {import('./providers/base.js').BaseLLMProvider} [options.llmProvider] - Pre-built provider instance
   * @param {number}  [options.contextSize]   - AGENT.md line limit
   * @param {number}  [options.maxTokens]     - Max context window
   * @param {string}  [options.jailDirectory] - Working directory jail
   * @param {boolean} [options.coreToolsOnly] - Restrict to core tools
   * @param {boolean} [options.programmaticToolCalling] - Enable programmatic tool calling
   */
  constructor({ host, model, provider, apiKey, llmProvider, contextSize, maxTokens, jailDirectory, coreToolsOnly, programmaticToolCalling } = {}) {
    super();

    // Create or use the provided LLM provider
    this.llmProvider = llmProvider || createProvider({ provider, model, host, apiKey, programmaticToolCalling });
    this.model = this.llmProvider.model;
    this.contextSize = contextSize; // AGENT.md line limit only
    this.maxTokens = maxTokens || 128000;
    this.jailDirectory = jailDirectory || process.cwd();
    setLogBaseDir(this.jailDirectory);
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
    // Granular auto-approve: per-category approval (Aider/Kilocode pattern)
    // Categories: "read", "write", "execute", "network", "safe", "other"
    this._approvalHandler = null;
    this._approveAll = false;
    this._approvedCategories = new Set(["safe", "read"]); // reads are always auto-approved

    // Shift-left feedback — auto-lint after file modifications (Stripe Minions pattern)
    this._shiftLeft = new ShiftLeftFeedback(this.jailDirectory);

    // Session tracking — persists conversation across CLI invocations
    this._session = null;
    this._autoSaveSession = true;

    // Architect mode — two-pass planning/execution (Aider/Kilocode pattern)
    this._architectMode = false;

    // Cross-agent response watcher — notifies this agent when replies arrive
    this._responseWatcher = null;

    // Set the global jail directory for all tools
    registry.setJailDirectory(this.jailDirectory);
    // Expose client for backward-compatibility (e.g. TUI calls listModels(agent.client))
    this.client = this.llmProvider.client || null;

    // Set up Ollama client for web search/fetch
    // Always try to initialize, even when using other providers (OpenAI, Anthropic, etc.)
    // This allows web search/fetch to work with any provider if Ollama is running locally
    const ollamaClient = this.llmProvider.client || this._createOllamaClient();
    if (ollamaClient) {
      setSearchClient(ollamaClient);
      setFetchClient(ollamaClient);
    }

    // Set up LLM-based summarization if model is large enough (has all tools)
    if (!this.coreToolsOnly) {
      this.contextManager.setLLMProvider(this.llmProvider);
    }

    // Always configure sub-agent for delegation (share parent's provider)
    setSubAgentConfig({
      llmProvider: this.llmProvider,
      maxTokens: this.maxTokens,
      cwd: this.jailDirectory,
    });

    // Configure cross-agent progress reporting
    setCrossAgentConfig({
      onProgress: (e) => this.emit("cross_agent_progress", e),
    });
  }

  /**
   * Create an Ollama client for web search/fetch.
   * Returns null if Ollama is not available.
   */
  _createOllamaClient() {
    try {
      const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
      // Use the Ollama class from the ollama package
      const { Ollama } = require("ollama");
      return new Ollama({ host });
    } catch {
      // Ollama package not available or import failed
      return null;
    }
  }

  /**
   * Set the approval handler for dangerous tool calls.
   * handler: (name: string, args: object) => Promise<{ approved: boolean, approveAll?: boolean }>
   */
  setApprovalHandler(handler) {
    this._approvalHandler = handler;
  }

  /**
   * Auto-approve a tool category (e.g., "write", "execute", "network").
   * Tools in approved categories skip the approval prompt.
   */
  approveCategory(category) {
    this._approvedCategories.add(category);
    logger.info(`Auto-approve enabled for category: ${category}`);
  }

  /**
   * Revoke auto-approval for a tool category.
   */
  revokeCategory(category) {
    if (category === "safe" || category === "read") return; // always approved
    this._approvedCategories.delete(category);
    logger.info(`Auto-approve revoked for category: ${category}`);
  }

  /**
   * Get the set of currently auto-approved categories.
   */
  getApprovedCategories() {
    return new Set(this._approvedCategories);
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

  /**
   * Enable or disable architect mode.
   * When enabled, the next run() will use a two-pass approach:
   *   1. Architect pass: read-only analysis → produces a plan
   *   2. Editor pass: executes the plan with full tools
   */
  setArchitectMode(enabled) {
    this._architectMode = enabled;
    logger.info(`Architect mode ${enabled ? "enabled" : "disabled"}`);
  }

  /** Check if architect mode is enabled. */
  get architectMode() {
    return this._architectMode;
  }

  /** Get current token usage info. */
  getTokenInfo() {
    return this.contextManager.getUsage(this.messages);
  }

  /** Change the model on the fly. */
  setModel(newModel) {
    this.model = newModel;
    this.llmProvider.model = newModel;
    // Update context manager's LLM provider for summarization
    this.contextManager.setLLMProvider(this.llmProvider);
    // Update sub-agent config
    setSubAgentConfig({
      llmProvider: this.llmProvider,
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

    // Ensure tiktoken is ready for accurate token counting
    await ensureTiktoken();

    // Self-register in the global agent registry so other agents can discover us
    try {
      const meta = detectRepoMetadata(this.jailDirectory);
      const snippet = detectSnippet(this.jailDirectory);
      registerAgent({
        repoPath: this.jailDirectory,
        name: meta.name,
        description: meta.description,
        snippet: snippet || undefined,
      });
    } catch (err) {
      logger.debug(`Agent registry: ${err.message}`);
    }

    // Clear stale inbox letters on startup — agents only process new work
    try {
      clearStaleInbox(this.jailDirectory);
    } catch (err) {
      logger.debug(`Inbox cleanup: ${err.message}`);
    }

    // Start watching for cross-agent response letters arriving in our inbox.
    // When a reply arrives, inject it into the conversation so the agent
    // doesn't have to poll with check_reply.
    if (!this._responseWatcher) {
      try {
        this._responseWatcher = watchForResponses({
          repoPath: this.jailDirectory,
          onResponse: (response) => {
            const summary = [
              `[Cross-agent reply received]`,
              `Letter: "${response.title}"`,
              `From: ${response.from}`,
              `Status: ${response.status || "completed"}`,
              response.changesMade ? `Changes: ${response.changesMade}` : "",
              response.verificationResults ? `Verification: ${response.verificationResults}` : "",
              response.apiContract ? `API: ${response.apiContract}` : "",
              response.notes ? `Notes: ${response.notes}` : "",
            ].filter(Boolean).join("\n");

            this._pendingInjections.push(summary);
            this.emit("cross_agent_reply", response);
            logger.info(`Cross-agent reply received for "${response.title}" from ${response.from}`);
          },
        });
      } catch (err) {
        logger.debug(`Response watcher: ${err.message}`);
      }
    }

    let contextBlock = "";
    try {
      contextBlock = await gatherContext(this.jailDirectory, this.contextSize);
    } catch { /* proceed without context */ }

    // Build compact tool schema block so the model knows the available API
    const allTools = registry.getTools(this.coreToolsOnly);
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
    this._lastServerToolUses = null;
    this._lastCodeExecutionResults = null;
    this._shiftLeft.reset();
    // Drain (not clear) pending injections to avoid losing messages queued during async init
    const earlyInjections = this._pendingInjections.splice(0);
    this.messages.push({ role: "user", content: userMessage });
    for (const injected of earlyInjections) {
      this.messages.push({ role: "user", content: injected });
    }

    // ── Git checkpoint (Kilocode/OpenCode pattern) ──
    // Create a checkpoint before making changes so the user can /undo
    try {
      const checkpoint = createCheckpoint(this.jailDirectory, userMessage.slice(0, 60));
      if (checkpoint.created) {
        this.emit("checkpoint", { message: checkpoint.message });
        logger.info(`Checkpoint created: ${checkpoint.message}`);
      }
      // Clean up old checkpoints (keep last 5)
      cleanupCheckpoints(this.jailDirectory, 5);
    } catch (err) {
      logger.debug(`Checkpoint skipped: ${err.message}`);
    }

    // ── Pre-hydration (Stripe Minions pattern) ──
    // Deterministically pre-load files referenced in the user message so
    // the model has immediate context without burning tool-call round-trips.
    try {
      const hydration = await prehydrate(userMessage, this.jailDirectory);
      if (hydration.summary) {
        this.messages.push({ role: "user", content: hydration.summary });
        this.emit("prehydrate", { files: hydration.files.map(f => f.path) });
      }

      // ── Subdirectory-scoped rules (Stripe Minions pattern) ──
      // Load AGENT.md rules for subdirectories referenced in the message.
      const dirs = hydration.files
        .filter(f => f.path.includes("/"))
        .map(f => f.path.substring(0, f.path.lastIndexOf("/")));
      const seenDirs = new Set();
      for (const dir of dirs) {
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        const scopedRules = await loadScopedRules(this.jailDirectory, dir);
        if (scopedRules) {
          this.messages.push({ role: "user", content: scopedRules });
          logger.info(`Loaded scoped rules for ${dir}/`);
        }
      }
    } catch (err) {
      logger.debug(`Pre-hydration skipped: ${err.message}`);
    }

    // ── Architect mode (Aider/Kilocode pattern) ──
    // When enabled, run a read-only analysis pass first to produce a plan,
    // then inject the plan into the conversation for the editor pass.
    if (this._architectMode) {
      this.emit("status", { phase: "architect", message: "Analyzing codebase..." });
      try {
        const projectContext = this.messages[0]?.content?.split("# Project context\n\n")[1] || "";
        const plan = await architectPass(this.client, this.model, userMessage, {
          cwd: this.jailDirectory,
          maxTokens: this.maxTokens,
          projectContext,
          signal: this.abortController.signal,
          onProgress: (event) => this.emit("architect_progress", event),
        });

        if (plan && !plan.startsWith("(")) {
          // Inject the plan as context for the editor pass
          const planMessage = formatPlanForEditor(plan, userMessage);
          this.messages.push({ role: "user", content: planMessage });
          this.emit("architect_plan", { plan });
          logger.info(`Architect plan produced (${plan.length} chars)`);
        }
      } catch (err) {
        logger.warn(`Architect pass failed, continuing with direct execution: ${err.message}`);
      }
      // Auto-disable after use (one-shot)
      this._architectMode = false;
      this.emit("status", { phase: "editor", message: "Executing plan..." });
    }

    // Progressive compression of old messages (cheap, always runs)
    this.contextManager.compressOldMessages(this.messages);

    // Update sub-agent with current run's signal and progress callback
    setSubAgentConfig({
      signal: this.abortController.signal,
      onProgress: (event) => this.emit("sub_agent_progress", event),
    });

    // Update cross-agent progress callback
    setCrossAgentConfig({
      onProgress: (e) => this.emit("cross_agent_progress", e),
    });

    const tools = registry.getTools(this.coreToolsOnly);
    let iterations = 0;
    let consecutiveAgentRetries = 0;
    let overflowRetries = 0;
    const MAX_AGENT_RETRIES = 2;
    const MAX_STREAM_RETRIES = 2;
    const MAX_OVERFLOW_RETRIES = 1;

    // Retry callback — emits events for UI feedback
    const onRetry = ({ attempt, maxRetries, error, delayMs }) => {
      const msg = formatUserError(error, this.model, this.llmProvider?.name);
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

          // Stream timeout — longer initial wait (first token can be slow on large contexts),
          // shorter timeout between subsequent tokens
          const INITIAL_TIMEOUT = 180_000; // 3 min for first token
          const TOKEN_TIMEOUT = 60_000;    // 60s between tokens
          let streamTimer = setTimeout(() => {
            streamTimedOut = true;
            if (this.abortController) {
              this.abortController.abort();
            }
          }, INITIAL_TIMEOUT);
          const resetStreamTimer = () => {
            clearTimeout(streamTimer);
            if (!streamTimedOut) {
              streamTimer = setTimeout(() => {
                streamTimedOut = true;
                if (this.abortController) {
                  this.abortController.abort();
                }
              }, TOKEN_TIMEOUT);
            }
          };

          try {
            for await (const event of this.llmProvider.chatStream(
              this.messages, tools,
              this.abortController.signal, this.maxTokens, onRetry,
            )) {
              resetStreamTimer();
              if (event.type === "token") {
                fullContent += event.content;
                this.emit("token", { content: event.content });
              } else if (event.type === "done") {
                toolCalls = event.toolCalls || [];
                // Capture server-side programmatic tool calling metadata
                if (event.serverToolUses?.length) {
                  this._lastServerToolUses = event.serverToolUses;
                }
                if (event.codeExecutionResults?.length) {
                  this._lastCodeExecutionResults = event.codeExecutionResults;
                }
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
              const msg = formatUserError(streamErr, this.model, this.llmProvider?.name);
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

        // Reset consecutive retries on successful stream
        consecutiveAgentRetries = 0;
        overflowRetries = 0;

        // Guard: if the stream timeout fired but the stream completed anyway
        // (race condition), reset the abort controller so tool execution isn't blocked.
        // This is safe because user-initiated cancel() would have caused the stream
        // to throw, not complete normally.
        if (this.abortController.signal.aborted) {
          logger.info("Resetting stale abort controller (stream timeout race)");
          this.abortController = new AbortController();
          setSubAgentConfig({ signal: this.abortController.signal });
        }

        // ── Parse thinking tags ──
        const { thinking, cleaned: cleanedContent } = parseThinkingContent(fullContent);
        if (thinking) {
          this.emit("thinking", { content: thinking });
        }

        // Fallback: parse tool calls from content text
        if (toolCalls.length === 0) {
          toolCalls = parseToolCallsFromContent(fullContent);
          // Filter out tool calls not in the allowed tool set
          if (toolCalls.length > 0) {
            const allowedNames = new Set(tools.map(t => t.function.name));
            toolCalls = toolCalls.filter(tc => allowedNames.has(tc.function.name));
            // Block dangerous tools invoked via text-parsed calls (higher injection risk)
            const DANGEROUS_TOOLS = new Set(["run_command", "write_file"]);
            const hadDangerous = toolCalls.some(tc => DANGEROUS_TOOLS.has(tc.function.name) && tc._textParsed);
            if (hadDangerous) {
              logger.warn("Blocked dangerous tool call from text-parsed content (potential prompt injection)");
              toolCalls = toolCalls.filter(tc => !(DANGEROUS_TOOLS.has(tc.function.name) && tc._textParsed));
            }
          }
        }

        // Build assistant message — use cleaned content (thinking stripped) to save context
        const assistantMsg = { role: "assistant", content: cleanedContent };
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        // Preserve server-side programmatic tool calling metadata for Anthropic
        if (this._lastServerToolUses?.length) {
          assistantMsg._serverToolUses = this._lastServerToolUses;
          this._lastServerToolUses = null;
        }
        if (this._lastCodeExecutionResults?.length) {
          assistantMsg._codeExecutionResults = this._lastCodeExecutionResults;
          this._lastCodeExecutionResults = null;
        }
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

          // Auto-save session after each completed run
          if (this._session && this._autoSaveSession) {
            this.saveSession().catch(() => {});
          }

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

          if (this.abortController?.signal?.aborted) {
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

          // Extract _display (UI-only data) before truncation so it doesn't
          // inflate the size estimate and so we can pass it to the UI untouched.
          let display = null;
          if (result && result._display) {
            display = result._display;
            const { _display, ...rest } = result;
            result = rest;
          }

          // Truncate large tool results to prevent context bloat (adaptive ceiling)
          const usageRatio = this.contextManager.getUsage(this.messages).percentage / 100;
          result = this.contextManager.truncateToolResult(result, usageRatio);

          // Emit with _display attached so the UI can render a diff
          this.emit("tool_result", { name, result: display ? { ...result, _display: display } : result });

          return result;
        };

        // Decide whether any call needs approval
        // Granular: check both the global _approveAll flag and per-category approvals
        const needsApproval = this._approvalHandler && !this._approveAll;
        const anyDangerous = needsApproval &&
          uniqueToolCalls.some(tc => {
            if (!registry.requiresApproval(tc.function.name)) return false;
            // Check if the tool's category is auto-approved
            const category = registry.getToolCategory(tc.function.name);
            return !this._approvedCategories.has(category);
          });

        let results;
        if (anyDangerous) {
          // Sequential — approval prompts must be shown one at a time
          results = [];
          for (const tc of uniqueToolCalls) {
            const name = tc.function.name;
            const args = tc.function.arguments;
            this.emit("tool_call", { name, args });

            // Request approval for dangerous tools (respects per-category approvals)
            const toolCategory = registry.getToolCategory(name);
            if (registry.requiresApproval(name) && !this._approveAll && !this._approvedCategories.has(toolCategory) && this._approvalHandler) {
              let decision;
              try {
                decision = await this._approvalHandler(name, args);
              } catch (approvalErr) {
                logger.warn(`Approval handler threw: ${approvalErr.message}`);
                decision = { approved: false };
              }
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

        // Track file modifications for shift-left feedback
        for (let i = 0; i < uniqueToolCalls.length; i++) {
          const tc = uniqueToolCalls[i];
          const result = results[i];
          const name = tc.function.name;
          if ((name === "write_file" || name === "replace_in_file") && !result?.error) {
            this._shiftLeft.trackModification(tc.function.arguments?.filePath);
          }
        }

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

        // ── Shift-left feedback (Stripe Minions pattern) ──
        // Auto-run lint after file modifications to catch errors early.
        // Capped at 2 rounds to avoid infinite fix loops.
        if (this._shiftLeft.shouldLint()) {
          try {
            const lintResult = await this._shiftLeft.runLint();
            if (lintResult) {
              this.emit("shift_left", lintResult);
              if (!lintResult.passed) {
                this.messages.push({
                  role: "user",
                  content: `${lintResult.message}\n\nFix the lint errors above before continuing.`,
                });
              } else {
                logger.info(lintResult.message);
              }
            }
          } catch (err) {
            logger.debug(`Shift-left lint skipped: ${err.message}`);
          }
        }
      } catch (err) {
        // ── Agent-level retry for transient errors ──
        if (classifyError(err) === 'transient' && consecutiveAgentRetries < MAX_AGENT_RETRIES) {
          consecutiveAgentRetries++;
          const msg = formatUserError(err, this.model, this.llmProvider?.name);
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
        const userMsg = formatUserError(err, this.model, this.llmProvider?.name);
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

  // ── Session management ──────────────────────────────────────────────

  /** Get the current session, or null if none. */
  getSession() {
    return this._session;
  }

  /**
   * Start a new session.
   * @param {string} [name] - Optional human-friendly name
   */
  startSession(name) {
    this._session = createSession(name);
    logger.info(`Session started: ${this._session.id}${name ? ` (${name})` : ""}`);
    return this._session;
  }

  /**
   * Resume a previously saved session.
   * Restores conversation messages and reinitializes context.
   * @param {string} sessionId - Session ID to resume
   * @returns {boolean} True if session was loaded, false if not found
   */
  async resumeSession(sessionId) {
    const data = await fetchSession(this.jailDirectory, sessionId);
    if (!data) return false;

    // Initialize system context first
    await this._init();

    // Restore conversation messages after system message
    const restoredMessages = data.messages || [];
    this.messages.push(...restoredMessages);

    // Restore session metadata (without messages)
    this._session = {
      id: data.id,
      name: data.name,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: data.messageCount,
      summary: data.summary,
    };

    logger.info(`Session resumed: ${data.id} (${restoredMessages.length} messages)`);
    this.emit("session_resumed", { session: this._session, messageCount: restoredMessages.length });
    return true;
  }

  /**
   * Save the current session to disk.
   * Called automatically after each agent run if a session is active.
   */
  async saveSession() {
    if (!this._session) return null;
    try {
      const saved = await persistSession(this.jailDirectory, this._session, this.messages);
      // Update local session metadata
      this._session.updatedAt = saved.updatedAt;
      this._session.messageCount = saved.messageCount;
      this._session.summary = saved.summary;
      logger.info(`Session saved: ${this._session.id} (${saved.messageCount} messages)`);
      return saved;
    } catch (err) {
      logger.warn(`Failed to save session: ${err.message}`);
      return null;
    }
  }

  /** Cancel the current operation. */
  cancel() {
    if (this.running && this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Clean up resources (file watchers, etc.). Call when the agent is being
   * disposed of (e.g., on process exit).
   */
  destroy() {
    this.cancel();
    if (this._responseWatcher) {
      this._responseWatcher.stop();
      this._responseWatcher = null;
    }
  }

  /**
   * Undo the last run's changes by rolling back to the most recent checkpoint.
   * @returns {{ restored: boolean, message?: string, error?: string }}
   */
  undo() {
    return rollbackToCheckpoint(this.jailDirectory);
  }

  /**
   * List available checkpoints for rollback.
   * @returns {Array<{ index: number, message: string }>}
   */
  getCheckpoints() {
    return listCheckpoints(this.jailDirectory);
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
    this._shiftLeft.reset();
    // Stop the cross-agent response watcher so it doesn't inject stale replies
    // into a fresh conversation. A new watcher will be created on next _init().
    if (this._responseWatcher) {
      this._responseWatcher.stop();
      this._responseWatcher = null;
    }
    // Clear session so next run starts fresh (unless a new session is started)
    this._session = null;
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
    const allTools = registry.getTools(this.coreToolsOnly);
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
      ? `${SYSTEM_PROMPT}${toolSchemaBlock}${extendedNote}${planBlock}\n\n# Project context\n\n${contextBlock}`
      : `${SYSTEM_PROMPT}${toolSchemaBlock}${extendedNote}${planBlock}`;

    this.messages[systemIndex].content = systemContent;
    logger.info("Context refreshed (skills, plans, tools updated)");
  }

  /** Get conversation messages. */
  getMessages() {
    return this.messages;
  }
}
