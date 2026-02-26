import { EventEmitter } from "node:events";
import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { gatherContext } from "./context.js";
import { getCurrentPlan, getPlanSummary, hasActivePlan, updatePlanStatus } from "./plan-tracker.js";
import { logger } from "./logger.js";
import ContextTracker from "./context-tracker.js";
import { estimateTokenCount, shouldSummarize, createSummarizedMessages, simpleSummarize, getTokenBreakdown } from "./conversation-summarizer.js";

// Detect if we're a child agent (for multi-agent coordination)
const IS_CHILD_AGENT = process.env.SMOL_AGENT_PARENT_ID !== undefined;

// Import all tools so they self-register
import "./tools/run_command.js";
import "./tools/grep.js";
import { setOllamaClient as setSearchClient } from "./tools/web_search.js";
import { setOllamaClient as setFetchClient } from "./tools/web_fetch.js";
import "./tools/ask_user.js";
import "./tools/plan_tools.js";
import "./tools/requirements_tools.js";
import "./tools/reflection.js";
import "./tools/create_tool.js";
import { loadCustomTools } from "./tools/create_tool.js";

/**
 * Attempt to extract tool calls from the assistant's text content.
 * Some models output tool calls as JSON in their content instead of using
 * Ollama's native tool_calls field. We look for JSON objects that match
 * the pattern: {"name": "...", "arguments": {...}}
 */
function parseToolCallsFromContent(content) {
  if (!content) return [];

  const calls = [];
  // Match JSON objects that look like tool calls — may appear in ```json blocks or inline
  const jsonBlockRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  const candidates = [];

  let match;
  while ((match = jsonBlockRe.exec(content)) !== null) {
    candidates.push(match[1].trim());
  }

  // Also try to find bare JSON objects with "name" and "arguments" keys
  // (some models output them without code fences)
  const bareJsonRe = /\{[^{}]*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[^}]*\}[^}]*\}/g;
  while ((match = bareJsonRe.exec(content)) !== null) {
    candidates.push(match[0].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.name && typeof parsed.name === "string" && parsed.arguments && typeof parsed.arguments === "object") {
        calls.push({
          function: {
            name: parsed.name,
            arguments: parsed.arguments,
          },
        });
      }
    } catch {
      // Not valid JSON or wrong shape — skip
    }
  }

  return calls;
}

const PREPLAN_SYSTEM_PROMPT = `You are smol-agent, a coding assistant that runs in the user's terminal. You have direct access to the user's project through read-only tools.

## Mode: PREPLAN

You are in PREPLAN mode. This is a special planning phase designed to gather requirements and create a detailed plan BEFORE any coding begins.

Your job in this mode:
1. Understand the task thoroughly by asking clarifying questions
2. Analyze the codebase to understand current state
3. Break the task into smaller, manageable sub-tasks
4. Create a detailed, step-by-step plan
5. Identify potential risks and edge cases

## Golden rule

**Plan, don't do.** When the user asks you to do something, gather requirements and create a detailed plan. Do not make any changes or write any code.

## How to work in PREPLAN mode

1. Use \`ask_requirements\` to ask clarifying questions if the task is ambiguous
2. Use \`analyze_task\` to break complex tasks into sub-tasks
3. Use \`grep\` to understand the codebase
4. Use \`web_search\` and \`web_fetch\` if you need to research something
5. When you have enough information, use \`save_plan\` to save your plan

## Plan structure

Your plan should be saved using the \`save_plan\` tool with markdown format:

\`\`\`markdown
# Plan: [Brief Description]

## Overview
[High-level summary of what needs to be done and why]

## Files to Modify
- \`path/to/file1.js\` - [what changes]
- \`path/to/file2.js\` - [what changes]

## Implementation Steps

### Step 1: [Title]
[Description with code snippets if helpful]

### Step 2: [Title]
[Description with code snippets if helpful]

## Risks & Considerations
- [Potential issues to watch for]

## Testing
[How to verify the changes work correctly]
\`\`\`

## Special tools for preplan mode

- \`ask_requirements(questions, context)\` - Ask clarifying questions before planning
- \`analyze_task(task, constraints)\` - Break a task into smaller sub-tasks
- \`save_plan(description, planContent)\` - Save a detailed plan to a markdown file
- \`review_plan(plan, checklist)\` - Review and refine a plan before execution

## Plan lifecycle

1. User gives task → Agent enters PREPLAN mode
2. Agent asks questions, analyzes, researches as needed
3. Agent creates and saves plan with \`save_plan\`
4. User reviews plan (saved as PLAN-*.md in current directory)
5. User approves with \`/code\` command → Agent switches to CODING mode
6. Agent executes plan step-by-step, calling \`complete_plan_step\` after each step

## Important

- You cannot use \`run_command\` in preplan mode
- Always ask questions if you're unsure about requirements
- Break complex tasks into smaller, actionable steps
- The plan should be detailed enough that it can be followed step-by-step
- Plans are saved to files (PLAN-*.md) for tracking and reference

After the plan is saved, the user can review it. When they're ready to implement, they'll switch to coding mode with the \`/code\` command.`;

const SYSTEM_PROMPT = `You are smol-agent, a coding assistant that runs in the user's terminal. You have direct access to the user's project through tools. Your job is to **do the work**, not describe it.

## Mode: CODING

You are in CODING mode. You can read files and run shell commands via tools.

## Golden rule

**Act, don't explain.** When the user asks you to do something, use your tools to do it. Do not describe what you would do, narrate what you're seeing, or explain the codebase back to the user. They already know their code — they want you to change it.

Bad: "I can see that your project uses React. The App component is in src/App.js. I would suggest adding..."
Good: [read the file, then immediately edit it]

## How to work

1. Read the files you need to change using shell commands (e.g., \`cat file\`).
2. Make the changes using shell commands (like \`sed\`, \`echo\`, \`cat >\`, etc.) with the \`run_command\` tool.
3. Verify if possible (run tests/builds with \`run_command\`).
4. Briefly say what you changed and why.

That's it. Do not over-research. Do not narrate. Jump to action quickly.

- Use \`grep\` only when you genuinely don't know where to look. If the user tells you which file to change, go straight to it.
- Use \`ask_user\` only when the request is truly ambiguous or the action is destructive. Do not ask for permission to do routine work.

## Shell commands

- Use \`run_command\` for builds, tests, linters, git, package installs, file edits, etc.
- Avoid destructive commands unless the user asked for them.

## Web search

- Use \`web_search\` and \`web_fetch\` when you need to look up docs or APIs you're unsure about.

## Directory Jail

- All file operations are restricted to the current working directory (the jail directory).
- You cannot access files outside of this directory boundary.
- Use relative paths from the project root (current directory).

## Important

- Changes are real and immediate on the user's filesystem.
- Use relative paths from the project root.
- Keep your responses short. The user wants results, not essays.`;

const PLANNING_SYSTEM_PROMPT = `You are smol-agent, a coding assistant that runs in the user's terminal. You have direct access to the user's project through read-only tools.

## Mode: PLANNING

You are in PLANNING mode. You can **only read files and search the codebase** — you cannot write, edit, or run shell commands. Your job is to:

1. Explore the codebase to understand the current state
2. Ask clarifying questions if needed
3. Produce a detailed plan for the user to review

## Golden rule

**Analyze, don't modify.** When the user asks you to do something, explore the codebase and produce a clear, step-by-step plan. Do not make any changes.

## How to work

1. Use \`grep\` to understand the codebase.
2. Use \`web_search\` and \`web_fetch\` if you need to research something.
3. Ask clarifying questions with \`ask_user\` if the request is ambiguous.
4. Produce a detailed plan with:
   - Files that need to be changed
   - Specific changes to make (with code snippets where helpful)
   - Potential risks or edge cases to consider
   - Suggested order of operations

## Plan output format

Your final response will be saved to \`PLAN.md\`. Structure your response as a proper markdown document:

\`\`\`markdown
# Plan: [Brief Description]

## Overview
[High-level summary of what needs to be done and why]

## Files to Modify
- \`path/to/file1.js\` - [what changes]
- \`path/to/file2.js\` - [what changes]

## Implementation Steps

### Step 1: [Title]
[Description with code snippets if helpful]

### Step 2: [Title]
[Description with code snippets if helpful]

## Risks & Considerations
- [Potential issues to watch for]

## Testing
[How to verify the changes work correctly]
\`\`\`

Be thorough and specific. The plan should be detailed enough that it can be followed step-by-step.

## When the user approves

After the user reviews your plan, they may ask you to switch to coding mode to implement it. At that point, they will run \`/code\` and you'll have access to write tools.

## Important

- You cannot use \`run_command\` in planning mode.
- Be thorough but concise. The user wants a clear roadmap.
- Match the existing code style in your suggestions.`;

export class Agent extends EventEmitter {
  constructor({ host, model, contextSize, jailDirectory } = {}) {
    super();
    this.client = ollama.createClient(host);
    this.model = model || ollama.DEFAULT_MODEL;
    this.contextSize = contextSize;
    this.jailDirectory = jailDirectory || process.cwd();
    this.messages = [];
    this.running = false;
    this._initialized = false;
    this.abortController = null;
    this.mode = "coding"; // "coding", "planning", or "preplan"
    this.currentPlan = null; // Track current plan filename for multi-step execution
    
    // Context tracker for smart updates
    this.contextTracker = new ContextTracker(this.jailDirectory);
    
    // Token limits
    this.maxTokens = 128000; // Default for most models
    this.targetTokenThreshold = this.maxTokens * 0.95; // Summarize at 95%
    
    // Reflection settings
    this.enableReflection = true; // Enable reflection after tasks
    
    // Give the web tools access to the Ollama client
    setSearchClient(this.client);
    setFetchClient(this.client);
  }

  /**
   * Switch between planning and coding modes.
   * Returns the new mode.
   */
  setMode(newMode) {
    if (newMode !== "coding" && newMode !== "planning" && newMode !== "preplan") {
      throw new Error(`Invalid mode: ${newMode}. Use "coding", "planning", or "preplan".`);
    }
    if (this.mode === newMode) return this.mode;
    this.mode = newMode;
    // Rebuild system prompt with new mode
    this._initialized = false;
    return this.mode;
  }

  /**
   * Check if we should summarize conversation based on token count
   */
  shouldSummarizeContext() {
    const currentTokens = estimateTokenCount(this.messages);
    return shouldSummarize(this.messages, this.maxTokens, currentTokens);
  }

  /**
   * Get current token usage info
   */
  getTokenInfo() {
    const currentTokens = estimateTokenCount(this.messages);
    const breakdown = getTokenBreakdown(this.messages);
    const percentage = Math.round((currentTokens / this.maxTokens) * 100);
    
    return {
      current: currentTokens,
      max: this.maxTokens,
      percentage,
      shouldSummarize: currentTokens > this.targetTokenThreshold,
      breakdown,
    };
  }

  /**
   * Log current token usage
   */
  _logTokenUsage(label = 'Current') {
    const info = this.getTokenInfo();
    logger.info(`Token usage [${label}]: ${info.current}/${info.max} (${info.percentage}%)`);
    return info;
  }

  /**
   * Summarize conversation if needed
   */
  async summarizeIfNeeded() {
    if (!this.shouldSummarizeContext()) {
      return;
    }

    const info = this._logTokenUsage('Before summarization');
    logger.warn(`Context summarization triggered: ${info.current}/${info.max} (${info.percentage}%)`);

    // Simple summarization: keep system prompt and recent messages
    // In production, this would call an LLM for better summaries
    const summary = simpleSummarize(this.messages, 5);
    
    if (summary.length !== this.messages.length) {
      this.messages = summary;
      this._logTokenUsage('After summarization');
      logger.info(`Summarized conversation: ${summary.length} messages remaining`);
    }
  }

  /**
   * Build the system message with live project context.
   * Called once before the first run(), or after reset().
   */
  async _init() {
    if (this._initialized) return;

    let contextBlock = "";
    try {
      contextBlock = await gatherContext(this.jailDirectory, this.contextSize, this.contextTracker);
    } catch {
      // If context gathering fails, proceed without it
    }

    const basePrompt = this.mode === "preplan" ? PREPLAN_SYSTEM_PROMPT : (this.mode === "planning" ? PLANNING_SYSTEM_PROMPT : SYSTEM_PROMPT);
    
    // For coding mode with an active plan, append the plan summary
    let extraContent = "";
    if (this.mode === "coding") {
      const planSummary = await getPlanSummary();
      if (planSummary) {
        extraContent = `\n\n${planSummary}`;
      }
    }
    
    const systemContent = contextBlock
      ? `${basePrompt}\n\n# Current project context\n\n${contextBlock}${extraContent}`
      : `${basePrompt}${extraContent}`;

    this.messages = [{ role: "system", content: systemContent }];
    this._initialized = true;
    
    // Load custom tools from .smol-agent/tools/
    try {
      await loadCustomTools();
    } catch (err) {
      console.warn("Failed to load custom tools:", err.message);
    }
    
    this.emit("context_ready");
  }

  /**
   * Check if a task requires preplan mode based on its complexity
   */
  shouldPreplan(task) {
    const keywords = [
      "create", "build", "setup", "implement", "rewrite", "refactor",
      "add", "modify", "update", "fix", "bug", "feature", "architecture",
      "design", "structure", "organize", "plan", "strategize"
    ];
    
    const longTask = task.length > 50;
    const hasComplexKeyword = keywords.some(k => task.toLowerCase().includes(k));
    
    return longTask || hasComplexKeyword;
  }

  /**
   * Send a user message and run the full tool-call loop until the model
   * produces a final text response (no more tool calls).
   *
   * Emits:
   *   "context_ready" — after project context is gathered
   *   "tool_call"     — { name, args }           when the model invokes a tool
   *   "tool_result"   — { name, result }         after a tool finishes
   *   "response"      — { content }               final assistant text
   *   "error"         — Error                     on failure
   */
  async run(userMessage) {
    // Store task info for reflection
    const taskDescription = userMessage;
    const allToolCalls = [];
    
    await this._init();
    
    // Log initial token usage
    this._logTokenUsage('Start of turn');
    
    // Prune conversation if needed before adding new message
    const currentTokens = estimateTokenCount(this.messages);
    if (currentTokens > this.maxTokens * 0.85) {
      logger.warn(`Pruning conversation: ${currentTokens} tokens approaching limit`);
      // Keep system prompt and recent messages
      const recentCount = Math.max(5, Math.floor(this.messages.length * 0.3));
      this.messages = [this.messages[0], ...this.messages.slice(-(recentCount - 1))];
      this._logTokenUsage('After pruning');
    }
    
    // Check if we need to summarize before adding new message
    await this.summarizeIfNeeded();
    
    // Log after summarization
    this._logTokenUsage('After summarization check');

    // Auto-switch to preplan mode for complex tasks
    const isComplexTask = this.shouldPreplan(userMessage);
    const wasAutoSwitched = isComplexTask && this.mode === "coding";
    if (wasAutoSwitched) {
      this.mode = "preplan";
      this._initialized = false; // Rebuild system prompt with preplan mode
    }

    this.running = true;
    this.abortController = new AbortController();
    this.messages.push({ role: "user", content: userMessage });
    
    // Log with user message added
    this._logTokenUsage('After adding user message');

    const planningMode = this.mode === "planning";
    const preplanMode = this.mode === "preplan";
    const tools = registry.ollamaTools(planningMode, preplanMode, IS_CHILD_AGENT);
    let iterations = 0;
    const MAX_ITERATIONS = 999;

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        // Check if we need to summarize before each API call
        const beforeCallTokens = this._logTokenUsage(`Iteration ${iterations} - before API call`);
        
        // Emit token info for UI display
        this.emit("token_usage", { 
          current: beforeCallTokens.current, 
          max: beforeCallTokens.max, 
          percentage: beforeCallTokens.percentage 
        });

        await this.summarizeIfNeeded();

        // Use chat with retry for better error recovery
        let response;
        try {
          response = await ollama.chatWithRetry(
            this.client,
            this.model,
            this.messages,
            tools,
            this.abortController.signal,
            this.maxTokens
          );
        } catch (err) {
          logger.error("Chat API failed after all retries", { error: err.message });
          
          // If we have an active plan, mark it as failed
          const currentPlan = await getCurrentPlan();
          if (currentPlan && this.mode === "coding") {
            try {
              await updatePlanStatus(currentPlan.filename, "abandoned", {
                message: `Failed after retries: ${err.message}`,
              });
            } catch {
              // Ignore plan tracker errors
            }
          }
          
          throw err;
        }

        const msg = response.message;
        this.messages.push(msg);

        // Use native tool_calls if present, otherwise try to parse them from content
        let toolCalls = msg.tool_calls && msg.tool_calls.length > 0
          ? msg.tool_calls
          : parseToolCallsFromContent(msg.content);

        // If no tool calls, we're done — return the text response.
        if (toolCalls.length === 0) {
          this.running = false;
          this.abortController = null;
          const content = msg.content || "(no response)";
          this.emit("response", { content });
          
          // Run reflection after task completion
          if (this.mode === "coding" && this.enableReflection) {
            await this._runReflection(taskDescription, allToolCalls, content);
          }
          
          // If we auto-switched to preplan and the agent has saved a plan, return to coding mode
          if (wasAutoSwitched) {
            try {
              const current = await getCurrentPlan();
              if (current && current.details.status !== "abandoned") {
                this.mode = "coding";
                this._initialized = false; // Rebuild system prompt with coding mode
              }
            } catch {
              // Ignore errors from plan tracker
            }
          }
          
          return content;
        }

        // Process each tool call
        for (const toolCall of toolCalls) {
          const name = toolCall.function.name;
          const args = toolCall.function.arguments;

          // Track for reflection
          allToolCalls.push({ name, args });

          this.emit("tool_call", { name, args });

          // Check if we've been cancelled before executing the tool
          if (this.abortController.signal.aborted) {
            throw new Error("Operation cancelled");
          }

          const result = await registry.execute(name, args);

          this.emit("tool_result", { name, result });

          this.messages.push({
            role: "tool",
            content: JSON.stringify(result),
          });
        }
      }

      this.running = false;
      this.abortController = null;
      const limitMsg = "(Agent reached maximum iteration limit)";
      this.emit("response", { content: limitMsg });
      return limitMsg;
    } catch (err) {
      this.running = false;
      this.abortController = null;
      
      logger.error("Agent run failed", { 
        error: err.message,
        stack: err.stack,
        mode: this.mode,
        iterations: iterations,
      });
      
      if (err.name === "AbortError" || err.message === "Operation cancelled") {
        this.emit("response", { content: "(Operation cancelled)" });
        return "(Operation cancelled)";
      }
      
      this.emit("error", err);
      throw err;
    }
  }

  /**
   * Run reflection on the completed task
   */
  async _runReflection(taskDescription, toolCalls, finalResponse) {
    if (!this.enableReflection) return null;
    
    const toolSummary = toolCalls.map(tc => tc.name).join(", ") || "none";
    const reflectionPrompt = `

## Task Completion Reflection

Task: "${taskDescription}"
Tools used: ${toolSummary}

After completing this task, please reflect on what was done using the \`reflect\` tool. You can also set askUserFeedback to true to ask for feedback.`;

    this.messages.push({ role: "user", content: reflectionPrompt });
    
    const planningMode = this.mode === "planning";
    const preplanMode = this.mode === "preplan";
    const tools = registry.ollamaTools(planningMode, preplanMode, IS_CHILD_AGENT);
    
    try {
      const response = await ollama.chatWithRetry(
        this.client,
        this.model,
        this.messages,
        tools,
        this.abortController?.signal,
        this.maxTokens
      );
      
      const msg = response.message;
      this.messages.push(msg);
      
      let calledTools = msg.tool_calls && msg.tool_calls.length > 0
        ? msg.tool_calls
        : parseToolCallsFromContent(msg.content);
      
      for (const tc of calledTools) {
        const name = tc.function.name;
        const args = tc.function.arguments;
        
        this.emit("tool_call", { name, args });
        const result = await registry.execute(name, args);
        this.emit("tool_result", { name, result });
        
        this.messages.push({ role: "tool", content: JSON.stringify(result) });
        
        // If reflect tool was called, emit its result as the reflection
        if (name === "reflect" && result?.reflection) {
          this.emit("reflection", { content: result.reflection });
          msg.content = result.reflection; // Update msg.content for return value
        }
      }
      
      if (msg.content) {
        this.emit("reflection", { content: msg.content });
      }
      
      return msg.content || "";
    } catch (err) {
      console.warn("Reflection failed:", err.message);
      return null;
    }
  }

  /** Cancel the current operation if one is running */
  cancel() {
    if (this.running && this.abortController) {
      this.abortController.abort();
    }
  }

  /** Reset conversation history and re-gather context on next run. */
  reset() {
    this.messages = [];
    this._initialized = false;
    // Reset file tracking
    if (this.contextTracker) {
      this.contextTracker.resetFileTracking();
    }
  }
  
  /** Enable or disable reflection after tasks */
  setReflection(enabled) {
    this.enableReflection = enabled;
  }
}
