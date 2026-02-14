import { EventEmitter } from "node:events";
import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { gatherContext } from "./context.js";
import { getCurrentPlan, getPlanSummary, hasActivePlan } from "./plan-tracker.js";
import ContextTracker from "./context-tracker.js";
import { estimateTokenCount, shouldSummarize, createSummarizedMessages, simpleSummarize } from "./conversation-summarizer.js";

// Detect if we're a child agent (for multi-agent coordination)
const IS_CHILD_AGENT = process.env.SMOL_AGENT_PARENT_ID !== undefined;

// Import all tools so they self-register
import "./tools/read_file.js";
import "./tools/write_file.js";
import "./tools/edit_file.js";
import "./tools/list_files.js";
import "./tools/shell.js";
import "./tools/grep.js";
import "./tools/find_in_file.js";
import { setOllamaClient as setSearchClient } from "./tools/web_search.js";
import { setOllamaClient as setFetchClient } from "./tools/web_fetch.js";
import "./tools/ask_user.js";
import "./tools/spawn_agent.js";
import "./tools/agent_coordinator.js";
import "./tools/agent_monitor.js";
import "./tools/agent_status.js";
import "./tools/plan_tools.js";
import "./tools/requirements_tools.js";
import "./tools/file_touched.js";

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
3. Use \`read_file\`, \`list_files\`, \`grep\`, and \`find_in_file\` to understand the codebase
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

- You cannot use \`write_file\`, \`edit_file\`, or \`shell\` in preplan mode
- Always ask questions if you're unsure about requirements
- Break complex tasks into smaller, actionable steps
- The plan should be detailed enough that it can be followed step-by-step
- Plans are saved to files (PLAN-*.md) for tracking and reference

After the plan is saved, the user can review it. When they're ready to implement, they'll switch to coding mode with the \`/code\` command.`;

const SYSTEM_PROMPT = `You are smol-agent, a coding assistant that runs in the user's terminal. You have direct access to the user's project through tools. Your job is to **do the work**, not describe it.

## Mode: CODING

You are in CODING mode. You can read, write, edit files and run shell commands.

## Golden rule

**Act, don't explain.** When the user asks you to do something, use your tools to do it. Do not describe what you would do, narrate what you're seeing, or explain the codebase back to the user. They already know their code — they want you to change it.

Bad: "I can see that your project uses React. The App component is in src/App.js. I would suggest adding..."
Good: [read the file, then immediately edit it]

## How to work

1. Read the files you need to change (use \`read_file\` — you need the exact text for edits).
2. Make the changes (use \`edit_file\` or \`write_file\`).
3. Verify if possible (run tests/builds with \`shell\`).
4. Briefly say what you changed and why.

That's it. Do not over-research. Do not narrate. Jump to action quickly.

- Use \`list_files\` or \`grep\` only when you genuinely don't know where to look. If the user tells you which file to change, go straight to it.
- Use \`ask_user\` only when the request is truly ambiguous or the action is destructive. Do not ask for permission to do routine work.

## Editing files

- **Prefer \`edit_file\` over \`write_file\`** for existing files. edit_file does targeted find-and-replace.
- The \`old_string\` must match file contents **exactly** — indentation, whitespace, everything. Copy it from the read_file output (without line numbers).
- Use \`write_file\` only for new files or full rewrites.
- Match the existing code style (indentation, quotes, commas, etc.).

## Shell commands

- Use \`shell\` for builds, tests, linters, git, package installs, etc.
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

1. Use \`read_file\`, \`list_files\`, \`grep\`, and \`find_in_file\` to understand the codebase.
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

- You cannot use \`write_file\`, \`edit_file\`, or \`shell\` in planning mode.
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
   * Summarize conversation if needed
   */
  async summarizeIfNeeded() {
    if (!this.shouldSummarizeContext()) {
      return;
    }

    // Simple summarization: keep system prompt and recent messages
    // In production, this would call an LLM for better summaries
    const summary = simpleSummarize(this.messages, 5);
    
    if (summary.length !== this.messages.length) {
      this.messages = summary;
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
    await this._init();
    
    // Check if we need to summarize before adding new message
    await this.summarizeIfNeeded();

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

    const planningMode = this.mode === "planning";
    const preplanMode = this.mode === "preplan";
    const tools = registry.ollamaTools(planningMode, preplanMode, IS_CHILD_AGENT);
    let iterations = 0;
    const MAX_ITERATIONS = 999;

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        // Check if we need to summarize before each API call
        await this.summarizeIfNeeded();

        const response = await ollama.chat(
          this.client,
          this.model,
          this.messages,
          tools,
          this.abortController.signal
        );

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
      if (err.name === "AbortError" || err.message === "Operation cancelled") {
        this.emit("response", { content: "(Operation cancelled)" });
        return "(Operation cancelled)";
      }
      this.emit("error", err);
      throw err;
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
}
