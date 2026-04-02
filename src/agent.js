/**
 * Core agent loop for smol-agent.
 *
 * This module implements the main Agent class that drives the conversation
 * with the LLM provider. It handles:
 * - Tool call execution and result feeding
 * - Context management and summarization
 * - Error handling and retries
 * - Session persistence
 * - Cross-agent communication
 * - Shift-left lint feedback
 * - Checkpoint creation and rollback
 *
 * The agent runs in a loop: send messages → receive response → execute tools → repeat
 * until the model produces a text response (no tool calls).
 *
 * Key components:
 * - Agent class (extends EventEmitter): Main agent with run(), cancel(), reset() methods
 * - parseThinkingContent(): Extracts <thinking> blocks from model output
 * - analyzeToolResults(): Generates self-correction suggestions from failures
 * - System prompt construction with context injection
 *
 * Dependencies: node:events, ./providers/index.js, ./tools/registry.js, ./context.js,
 *               ./logger.js, ./context-manager.js, ./tools/save_plan.js, ./tool-call-parser.js,
 *               ./errors.js, ./prehydrate.js, ./token-estimator.js, ./shift-left.js,
 *               ./architect.js, ./checkpoint.js, ./agent-registry.js, ./cross-agent.js,
 *               ./tools/*.js (all tools imported for self-registration), ./lru-tool-cache.js,
 *               ./constants.js, ollama (optional, for web search/fetch clients)
 * Depended on by: src/acp-server.js, src/index.js, src/ui/App.js, test/e2e/harness.js,
 *                 test/unit/*.test.js, test/e2e/scenarios/*.test.js (extensive)
 *
 * @module agent
 */
import { EventEmitter } from "node:events";
import { createProvider } from "./providers/index.js";
import * as registry from "./tools/registry.js";
import { gatherContext, loadScopedRules } from "./context.js";
import { logger, setLogBaseDir } from "./logger.js";
import { ContextManager } from "./context-manager.js";
import { getCurrentPlan } from "./tools/save_plan.js";
import { parseToolCallsFromContent } from "./tool-call-parser.js";
import { classifyError, formatUserError } from "./errors.js";
import { prehydrate, extractFileRefs } from "./prehydrate.js";
import { ensureInitialized as ensureTiktoken } from "./token-estimator.js";
import { ShiftLeftFeedback } from "./shift-left.js";
import {
  createSession,
  saveSession as persistSession,
  loadSession as fetchSession,
} from "./sessions.js";
import { architectPass, formatPlanForEditor } from "./architect.js";
import { createCheckpoint, rollbackToCheckpoint, listCheckpoints, cleanupCheckpoints } from "./checkpoint.js";
import { detectRepoMetadata, detectSnippet, registerAgent } from "./agent-registry.js";
import { watchForResponses, clearStaleInbox } from "./cross-agent.js";
import {
  MAX_ITERATIONS,
  DEFAULT_MAX_TOKENS,
  MAX_TOOL_FAILURES,
  MAX_STREAM_RETRIES,
  STREAM_RETRY_DELAY_MS,
  TOOL_HISTORY_SIZE
} from "./constants.js";

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
import { getEditedFiles } from "./tools/file_documentation.js";
import "./tools/memory.js";
import { setSubAgentConfig } from "./tools/sub_agent.js";
import { setCrossAgentConfig } from "./tools/cross_agent.js";
import "./tools/context_docs.js";
import "./tools/git.js";
import "./tools/session_tools.js";
import "./tools/code_execution.js";
import { setActivateGroupCallback } from "./tools/discover_tools.js";
import { LRUToolCache } from "./lru-tool-cache.js";
import { buildCavemanPrompt, buildCavemanCommitRules, buildCavemanReviewRules, CAVEMAN_LEVELS, DEFAULT_LEVEL } from "./caveman.js";
import { setCompressProvider } from "./tools/caveman_compress.js";

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
Explore → Edit → Verify → Report. Use replace_in_file for edits, read_file for reads. Prefer file tools over shell.
Keep responses concise. Ask only when genuinely ambiguous.

## Rules
- Use relative paths. Think internally with <thinking> tags, then act — never narrate.
- After edits, re-read files to verify. If a tool fails, try alternative approaches.
- Use remember tool for project facts. Use delegate for large research tasks.
- For 3+ tool calls or loops, use code_execution to batch calls in one turn.
- Use save_context after exploring directories. Check .smol-agent/docs/ and skills before tasks.
- Fix lint errors immediately (2 fix rounds max). Follow .cursorrules/CLAUDE.md coding rules.
- Test servers in background: \`node server.js & sleep 1 && curl localhost:PORT\`.

## Example
User: "Add hello() to utils.js" → tool call: replace_in_file(filePath, oldText, newText)`;

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
   * @param {string[]} [options.approvedCategories] - Pre-approved tool categories from settings
   */
  constructor({ host, model, provider, apiKey, llmProvider, contextSize, maxTokens, jailDirectory, coreToolsOnly, programmaticToolCalling, approvedCategories } = {}) {
    super();

    // Create or use the provided LLM provider
    this.llmProvider = llmProvider || createProvider({ provider, model, host, apiKey, cwd: jailDirectory || process.cwd(), programmaticToolCalling });
    this.model = this.llmProvider.model;
    this.contextSize = contextSize; // AGENT.md line limit only
    this.maxTokens = maxTokens || DEFAULT_MAX_TOKENS;
    this.jailDirectory = jailDirectory || process.cwd();
    setLogBaseDir(this.jailDirectory);
    this.messages = [];
    this.running = false;
    this._initialized = false;
    this.abortController = null;
    // When false, all tools are exposed with progressive discovery.
    // The --all-tools flag is no longer needed as all models get the same tools.
    this.coreToolsOnly = coreToolsOnly ?? false;

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
    // Load persisted approved categories from settings
    if (approvedCategories && Array.isArray(approvedCategories)) {
      for (const cat of approvedCategories) {
        this._approvedCategories.add(cat);
      }
      logger.info(`Loaded approved categories from settings: ${approvedCategories.join(", ")}`);
    }

    // Shift-left feedback — auto-lint after file modifications (Stripe Minions pattern)
    this._shiftLeft = new ShiftLeftFeedback(this.jailDirectory);

    // Session tracking — persists conversation across CLI invocations
    this._session = null;
    this._autoSaveSession = true;

    // Architect mode — two-pass planning/execution (Aider/Kilocode pattern)
    this._architectMode = false;

    // Caveman mode — ultra-compressed communication (JuliusBrussee/caveman)
    // When active, injects terse communication rules into the system prompt
    // to cut output tokens ~75% while preserving technical accuracy.
    // Values: null (off), "lite", "full", "ultra"
    this._cavemanMode = null;

    // Progressive tool discovery — start with starter groups, unlock more on demand.
    // All models now use progressive discovery with the same tool set.
    // The agent starts with starter groups + discover_tools meta-tool,
    // and can unlock additional groups as needed.
    this._progressiveDiscovery = true;
    this._activeToolGroups = new Set(registry.getStarterGroups());

    // Wire up the discover_tools callback so it can mutate our active groups
    setActivateGroupCallback((groups) => this._activateToolGroups(groups));

    // LRU tool cache — evicts tools that haven't been used recently to free
    // context space. Only active when progressive discovery is enabled (large models).
    // Core/starter tools are pinned and never evicted.
    this._lruCache = new LRUToolCache({
      maxTools: 25, // max non-pinned tools before eviction kicks in
      ttl: 0,       // no time-based eviction by default
    });
    if (this._progressiveDiscovery) {
      // Pin all starter-group tools so they're never evicted
      const starterGroups = registry.getToolGroups();
      for (const groupName of registry.getStarterGroups()) {
        const group = starterGroups[groupName];
        if (group) this._lruCache.pinAll(group.tools);
      }
      // Warm starter tools into the cache
      for (const groupName of this._activeToolGroups) {
        const group = starterGroups[groupName];
        if (group) {
          for (const t of group.tools) this._lruCache.warm(t);
        }
      }
    }

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

    // Configure caveman compress tool with the LLM provider
    setCompressProvider(this.llmProvider);
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
   * Set approved categories from loaded settings.
   * Merges with existing approved categories.
   * @param {string[]} categories - Categories to approve
   */
  setApprovedCategories(categories) {
    for (const cat of categories) {
      this._approvedCategories.add(cat);
    }
    logger.info(`Loaded approved categories from settings: ${categories.join(", ")}`);
  }

  // ── Progressive Tool Discovery ────────────────────────────────────

  /**
   * Activate tool groups (called by discover_tools meta-tool).
   * @param {string[]} groups - Group names to activate
   * @returns {{ activated: string[], alreadyActive: string[], unknown: string[] }}
   */
  _activateToolGroups(groups) {
    const allGroups = registry.getToolGroups();
    const activated = [];
    const alreadyActive = [];
    const unknown = [];

    for (const g of groups) {
      if (!allGroups[g]) {
        unknown.push(g);
      } else if (this._activeToolGroups.has(g)) {
        alreadyActive.push(g);
      } else {
        this._activeToolGroups.add(g);
        activated.push(g);
        logger.info(`Progressive discovery: activated tool group "${g}"`);
        // Warm newly activated tools into the LRU cache so they aren't
        // immediately eligible for eviction
        for (const t of allGroups[g].tools) {
          this._lruCache.warm(t);
        }
      }
    }

    return { activated, alreadyActive, unknown };
  }

  /**
   * Auto-discover tool groups based on context signals in the user message
   * or tool usage patterns. This avoids requiring the model to explicitly
   * call discover_tools for obvious cases.
   * @param {string} text - User message or current context
   */
  _autoDiscoverFromContext(text) {
    if (!this._progressiveDiscovery) return;
    if (!text) return;

    const lower = text.toLowerCase();

    // Plan group — complex tasks, multi-step work
    if (!this._activeToolGroups.has("plan")) {
      const planSignals = [
        "plan", "step by step", "multi-step", "break down",
        "implement", "build", "refactor", "migrate",
        "architecture", "design",
      ];
      if (planSignals.some(s => lower.includes(s))) {
        this._activateToolGroups(["plan"]);
        logger.info("Auto-discovered plan group from context");
      }
    }

    // Memory group — references to persistence, previous sessions
    if (!this._activeToolGroups.has("memory")) {
      const memorySignals = [
        "remember", "recall", "previous session", "last time",
        "memory", "save context", "knowledge base",
      ];
      if (memorySignals.some(s => lower.includes(s))) {
        this._activateToolGroups(["memory"]);
        logger.info("Auto-discovered memory group from context");
      }
    }

    // Web group — search/fetch needs
    if (!this._activeToolGroups.has("web")) {
      const webSignals = [
        "search", "look up", "find online", "documentation",
        "web", "url", "http", "api docs", "latest version",
        "fetch", "download",
      ];
      if (webSignals.some(s => lower.includes(s))) {
        this._activateToolGroups(["web"]);
        logger.info("Auto-discovered web group from context");
      }
    }

    // Multi-agent group — delegation and cross-agent communication
    if (!this._activeToolGroups.has("multi_agent")) {
      const agentSignals = [
        "delegate", "sub-agent", "other agent", "agent",
        "letter", "inbox", "send to", "coordinate",
      ];
      if (agentSignals.some(s => lower.includes(s))) {
        this._activateToolGroups(["multi_agent"]);
        logger.info("Auto-discovered multi_agent group from context");
      }
    }

    // Caveman mode — auto-activate from natural language triggers
    if (!this._cavemanMode) {
      const cavemanSignals = [
        "caveman mode", "talk like caveman", "use caveman",
        "less tokens", "be brief", "fewer tokens",
      ];
      if (cavemanSignals.some(s => lower.includes(s))) {
        this.setCavemanMode(DEFAULT_LEVEL);
        logger.info("Auto-discovered caveman mode from context");
      }
    }

    // Caveman off — detect "stop caveman" or "normal mode" to disable
    if (this._cavemanMode) {
      const offSignals = ["stop caveman", "normal mode", "disable caveman", "caveman off"];
      if (offSignals.some(s => lower.includes(s))) {
        this.setCavemanMode(null);
        logger.info("Caveman mode disabled from context");
      }
    }
  }

  /**
   * Get the current tools array based on progressive discovery state.
   * When progressive discovery is active, returns tools from active groups
   * plus the discover_tools meta-tool. Otherwise falls back to the
   * coreToolsOnly/all-tools behavior.
   */
  _getCurrentTools() {
    if (!this._progressiveDiscovery) {
      return registry.getTools(this.coreToolsOnly);
    }
    // Get tools for active groups, plus any ungrouped tools (e.g. session tools)
    const tools = registry.getToolsForGroups(this._activeToolGroups, /* includeUngrouped */ true);
    // Filter out LRU-evicted tools to save context space
    return this._lruCache.filterTools(tools);
  }

  /**
   * Inject a user message into the running conversation.
   * The message will be picked up at the next injection flush point:
   *   - Before tool execution (skips all pending tool calls)
   *   - Between sequential tool calls (skips remaining tool calls)
   *   - After tool execution completes
   *   - At the top of the next loop iteration (safety net)
   */
  inject(message) {
    if (this.running) {
      this._pendingInjections.push(message);
    }
  }

  /**
   * Flush all pending injections into the message history.
   * Called at multiple points during the tool loop to give the user
   * faster steering control over the agent.
   * @returns {number} Number of messages flushed.
   */
  _flushPendingInjections() {
    let count = 0;
    while (this._pendingInjections.length > 0) {
      const injected = this._pendingInjections.shift();
      this.messages.push({ role: "user", content: injected });
      this.emit("injection", { content: injected });
      logger.info(`Injected user message: ${injected.slice(0, 80)}`);
      count++;
    }
    return count;
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

  // ── Caveman Mode ─────────────────────────────────────────────────

  /**
   * Enable, change, or disable caveman mode.
   * When enabled, the agent communicates in ultra-compressed style to
   * reduce output tokens ~75% while preserving technical accuracy.
   *
   * @param {string|null} level - "lite", "full", "ultra", or null to disable
   */
  setCavemanMode(level) {
    if (level && !CAVEMAN_LEVELS.has(level)) {
      level = DEFAULT_LEVEL;
    }
    this._cavemanMode = level || null;
    logger.info(`Caveman mode ${level ? `enabled (${level})` : "disabled"}`);

    // Auto-activate the caveman tool group when caveman mode is enabled
    if (level && this._progressiveDiscovery && !this._activeToolGroups.has("caveman")) {
      this._activateToolGroups(["caveman"]);
    }

    // Rebuild system message to inject/remove caveman rules
    if (this._initialized && this.messages.length > 0) {
      this._rebuildSystemMessage();
    }
  }

  /** Get current caveman mode level (null if disabled). */
  get cavemanMode() {
    return this._cavemanMode;
  }

  /**
   * Rebuild the system message to reflect current caveman mode state.
   * This patches the existing system message instead of re-gathering
   * all context, keeping the operation cheap.
   */
  _rebuildSystemMessage() {
    if (!this.messages[0] || this.messages[0].role !== "system") return;

    let content = this.messages[0].content;

    // Remove any existing caveman block
    content = content.replace(/\n\n## Caveman Mode[\s\S]*?(?=\n\n## |\n\n# |$)/, "");

    // Inject caveman block if active
    if (this._cavemanMode) {
      const cavemanBlock = `\n\n## Caveman Mode\n${buildCavemanPrompt(this._cavemanMode)}\n\n${buildCavemanCommitRules()}\n\n${buildCavemanReviewRules()}`;
      // Insert before "# Project context" if present, otherwise append
      const contextIdx = content.indexOf("\n\n# Project context");
      if (contextIdx !== -1) {
        content = content.slice(0, contextIdx) + cavemanBlock + content.slice(contextIdx);
      } else {
        content += cavemanBlock;
      }
    }

    this.messages[0].content = content;
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
    const currentTools = this._getCurrentTools();
    // Compact tool schema: short param list, first sentence only
    const toolLines = currentTools.map(t => {
      const fn = t.function;
      const params = fn.parameters?.properties || {};
      const required = fn.parameters?.required || [];
      const paramList = Object.keys(params)
        .map(k => k + (required.includes(k) ? '' : '?'))
        .join(', ');
      const desc = (fn.description || '').split('.')[0];
      return `- **${fn.name}**(${paramList}): ${desc}`;
    });
    const toolSchemaBlock = `\n\n## Tools\n${toolLines.join('\n')}`;

    // Progressive discovery: describe inactive groups so the model knows
    // it can unlock more tools. Falls back to the old "extended tools" note.
    let extendedNote = "";
    if (this._progressiveDiscovery) {
      const inactive = registry.describeInactiveGroups(this._activeToolGroups);
      const evictedDesc = this._lruCache.describeEvicted(registry.getToolMap());
      const parts = [];
      if (inactive) {
        parts.push(`Inactive groups: ${inactive.split('\n').map(l => l.split(':')[0].trim()).join(', ')}. Call discover_tools.`);
      }
      if (evictedDesc) {
        parts.push(`Evicted: ${evictedDesc.split('\n').map(l => l.split('(')[0].trim()).join(', ')}`);
      }
      if (parts.length > 0) {
        extendedNote = `\n\n## More tools\n${parts.join('\n')}`;
      }
    } else {
      const extended = registry.extendedToolNames();
      if (extended.length > 0) {
        extendedNote = `\n\nAdditional tools available if needed: ${extended.join(", ")}`;
      }
    }

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

    // Caveman mode — inject terse communication rules when active
    let cavemanBlock = "";
    if (this._cavemanMode) {
      cavemanBlock = `\n\n## Caveman Mode\n${buildCavemanPrompt(this._cavemanMode)}\n\n${buildCavemanCommitRules()}\n\n${buildCavemanReviewRules()}`;
    }

    const systemContent = contextBlock
      ? `${SYSTEM_PROMPT}${toolSchemaBlock}${extendedNote}${planBlock}${cavemanBlock}\n\n# Project context\n\n${contextBlock}`
      : `${SYSTEM_PROMPT}${toolSchemaBlock}${extendedNote}${planBlock}${cavemanBlock}`;

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
      // Include dirs from both loaded files AND all file refs in the message
      // (so rules are loaded even when the target file doesn't exist yet).
      const loadedDirs = hydration.files
        .filter(f => f.path.includes("/"))
        .map(f => f.path.substring(0, f.path.lastIndexOf("/")));
      const refDirs = extractFileRefs(userMessage)
        .filter(ref => ref.includes("/"))
        .map(ref => ref.substring(0, ref.lastIndexOf("/")));
      const dirs = [...loadedDirs, ...refDirs];
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

    // Progressive discovery: auto-detect tool groups from the user message
    this._autoDiscoverFromContext(userMessage);

    // Fetch tools dynamically — re-evaluated each iteration when progressive
    // discovery is active (groups may be activated mid-run via discover_tools).
    let tools = this._getCurrentTools();
    let iterations = 0;
    let consecutiveAgentRetries = 0;
    let overflowRetries = 0;
    const MAX_AGENT_RETRIES = 2;
    const MAX_OVERFLOW_RETRIES = 1;

    // Retry callback — emits events for UI feedback
    const onRetry = ({ attempt, maxRetries, error, delayMs }) => {
      const msg = formatUserError(error, this.model, this.llmProvider?.name);
      logger.warn(`Retry ${attempt}/${maxRetries}: ${msg} (waiting ${Math.round(delayMs)}ms)`);
      this.emit("retry", { attempt, maxRetries, message: msg, delayMs });
    };

    while (iterations++ < MAX_ITERATIONS) {
      try {
        // ── Refresh tools if groups changed (progressive discovery) ──
        if (this._progressiveDiscovery) {
          tools = this._getCurrentTools();
        }

        // ── Flush any injected user messages ──
        this._flushPendingInjections();

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
          // LRU eviction — remove unused tools to save context space
          if (this._progressiveDiscovery) {
            const evicted = this._lruCache.evict();
            if (evicted.length > 0) {
              logger.info(`LRU evicted ${evicted.length} tool(s): ${evicted.join(', ')}`);
              this.emit("lru_eviction", { evicted, stats: this._lruCache.getStats() });
            }
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
              await new Promise(r => setTimeout(r, STREAM_RETRY_DELAY_MS));
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

          // ── Automatic reflection (5% chance per run) ──
          // Probabilistically trigger reflection to keep file documentation
          // up-to-date and build codebase understanding over time.
          const editedFiles = getEditedFiles();
          if (editedFiles.length > 0 && Math.random() < 0.05) {
            logger.info("Auto-reflection triggered (5% chance, files were edited)");
            this.emit("auto_reflect", { reason: "probabilistic" });
            this._triggerAutoReflection().catch(err => {
              logger.warn(`Auto-reflection failed: ${err.message}`);
            });
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
          this._recentToolCalls = this._recentToolCalls.slice(-TOOL_HISTORY_SIZE);
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
        // Defer loop warning until after tool results to avoid breaking
        // message ordering (tool results must follow the assistant message
        // that contained tool_calls — injecting a user message in between
        // creates an invalid [user] → [tool] sequence).
        let deferredLoopWarning = null;
        if (loopSeverity === 1) {
          this._loopNudges++;
          logger.info(`Loop detected (severity 1, nudge ${this._loopNudges}) — injecting warning after tool results`);
          deferredLoopWarning = "[Auto-hint] You are repeating the same tool calls without making progress. STOP and try a completely different approach. If you cannot accomplish the task, explain what's blocking you instead of retrying the same actions.";
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
          if (failures >= MAX_TOOL_FAILURES) {
            const msg = `Tool "${name}" has failed ${failures} times consecutively. Try a different approach.`;
            this.emit("tool_result", { name, result: { error: msg } });
            return { error: msg };
          }

          // Touch the LRU cache so this tool stays active
          this._lruCache.touch(name);

          let result = await registry.execute(name, args, { cwd: this.jailDirectory, eventEmitter: this });

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

        // ── Pre-execution injection check ──
        // If the user sent a message while the LLM was streaming, skip
        // all tool execution so the model can respond to the redirect.
        if (this._pendingInjections.length > 0) {
          logger.info(`Pending user message(s) — skipping ${uniqueToolCalls.length} tool call(s)`);
          for (const tc of uniqueToolCalls) {
            const skipResult = { skipped: true, reason: "User sent a new message" };
            this.emit("tool_call", { name: tc.function.name, args: tc.function.arguments });
            this.emit("tool_result", { name: tc.function.name, result: skipResult });
            this.messages.push({ role: "tool", content: JSON.stringify(skipResult) });
          }
          this._flushPendingInjections();
          continue;
        }

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

            // Check for pending user messages between sequential tool calls.
            // If the user sent a steering message, skip remaining tools so
            // the LLM can respond to the new direction sooner.
            if (this._pendingInjections.length > 0 && results.length < uniqueToolCalls.length) {
              const remaining = uniqueToolCalls.length - results.length;
              logger.info(`Pending user message — skipping remaining ${remaining} tool call(s)`);
              for (let i = results.length; i < uniqueToolCalls.length; i++) {
                const skipResult = { skipped: true, reason: "User sent a new message" };
                this.emit("tool_call", { name: uniqueToolCalls[i].function.name, args: uniqueToolCalls[i].function.arguments });
                this.emit("tool_result", { name: uniqueToolCalls[i].function.name, result: skipResult });
                results.push(skipResult);
              }
              break;
            }
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

        // ── Flush pending user messages after tool results ──
        // Messages that arrived during tool execution are injected here
        // so the LLM sees them immediately on the next call, rather than
        // waiting for the top-of-loop flush on the next iteration.
        this._flushPendingInjections();

        // Inject deferred loop warning (must come after tool results to
        // maintain valid message ordering for providers like Ollama)
        if (deferredLoopWarning) {
          this.messages.push({
            role: "user",
            content: deferredLoopWarning,
          });
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

    // Iteration limit reached — provide helpful guidance
    this.running = false;
    this.abortController = null;
    const iterationMsg = iterations - 1; // iterations was pre-incremented
    const msg = `Reached the tool round limit (${iterationMsg} tool calls). The task may be too complex to complete in one session.

Options to continue:
1. Say "continue" — I'll pick up where we left off
2. Describe what you want to focus on next — I'll prioritize the remaining work
3. Rethink the approach — There may be a simpler way to accomplish your goal

What would you like to do?`;
    this.emit("response", { content: msg });
    return msg;
  }

  // ── Automatic reflection ────────────────────────────────────────────

  /**
   * Trigger an automatic reflection pass. Calls the reflect tool internally
   * to analyze edited files and update documentation headers.
   * This runs as a fire-and-forget operation after a successful run.
   */
  async _triggerAutoReflection() {
    const reflectPrompt = `You just completed a task. Use the reflect tool to summarize what you did, then review and update documentation headers for any code files >100 lines that were modified. Include a codebaseInsights field with your observations about how the code you touched fits into the broader architecture.`;

    try {
      await this.run(reflectPrompt);
    } catch (err) {
      logger.warn(`Auto-reflection run failed: ${err.message}`);
    }
  }

  /**
   * Run a full end-of-session reflection. Should be called when the user
   * exits or ends a session. Reflects on all work done during the session
   * and ensures file documentation is up-to-date.
   */
  async reflectOnSession() {
    const editedFiles = getEditedFiles();
    if (editedFiles.length === 0) {
      logger.info("End-of-session reflection skipped — no files were edited");
      return;
    }

    logger.info(`End-of-session reflection — ${editedFiles.length} file(s) edited`);
    this.emit("auto_reflect", { reason: "end_of_session" });

    const reflectPrompt = `This session is ending. Use the reflect tool to provide a comprehensive summary of all work done this session. Make sure to include codebaseInsights about patterns and architecture you discovered. The reflect tool will automatically analyze edited files for documentation needs — act on its recommendations by reading each file and adding/updating documentation headers.`;

    try {
      await this.run(reflectPrompt);
    } catch (err) {
      logger.warn(`End-of-session reflection failed: ${err.message}`);
    }
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
    this._lruCache.reset();
    // Re-warm starter tools after reset
    if (this._progressiveDiscovery) {
      const allGroups = registry.getToolGroups();
      for (const groupName of this._activeToolGroups) {
        const group = allGroups[groupName];
        if (group) {
          for (const t of group.tools) this._lruCache.warm(t);
        }
      }
    }
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
    return gatherContext(this.jailDirectory, this.contextSize);
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
    // Compact tool schema: short param list, first sentence only
    const toolLines = allTools.map(t => {
      const fn = t.function;
      const params = fn.parameters?.properties || {};
      const required = fn.parameters?.required || [];
      const paramList = Object.keys(params)
        .map(k => k + (required.includes(k) ? '' : '?'))
        .join(', ');
      const desc = (fn.description || '').split('.')[0];
      return `- **${fn.name}**(${paramList}): ${desc}`;
    });
    const toolSchemaBlock = `\n\n## Tools\n${toolLines.join('\n')}`;

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
