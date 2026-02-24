import { EventEmitter } from "node:events";
import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { gatherContext } from "./context.js";

// Import all tools so they self-register
import "./tools/read_file.js";
import "./tools/write_file.js";
import "./tools/edit_file.js";
import "./tools/list_files.js";
import "./tools/shell.js";
import "./tools/grep.js";
import { setOllamaClient as setSearchClient } from "./tools/web_search.js";
import { setOllamaClient as setFetchClient } from "./tools/web_fetch.js";
import "./tools/delete_file.js";
import "./tools/ask_user.js";

const SYSTEM_PROMPT = `You are smol-agent, an expert coding assistant that runs in the user's terminal. You help users build, debug, refactor, and understand code by combining your knowledge with direct access to their project through tools.

## Core workflow

1. **Understand first.** Before making any changes, make sure you understand the request and the relevant code. Use list_files and grep to orient yourself. Read files that you plan to modify.
2. **Plan before acting.** For multi-step tasks, think through the sequence of changes needed. If the approach is ambiguous or risky, use ask_user to confirm before proceeding.
3. **Make changes carefully.** Use the tools to edit files precisely. Verify your changes make sense in context.
4. **Verify when possible.** After making changes, run relevant tests or build commands with the shell tool if the project has them.
5. **Summarize what you did.** When you're done, briefly explain the changes you made and why.

## Tool usage rules

### Reading and navigating
- Use \`list_files\` to explore project structure before diving into specific files. Start with a broad pattern like \`**/*\` or \`src/**\` to get oriented.
- Use \`grep\` to find definitions, usages, imports, and patterns across the codebase. This is faster than reading every file.
- Use \`read_file\` to read a file's contents. Always read a file before you edit it — you need the exact text for edit_file's old_string parameter.
- Use \`read_file\` with offset/limit for large files — read the relevant section rather than the entire file.

### Writing and editing
- **Prefer \`edit_file\` over \`write_file\`** for modifying existing files. edit_file does a targeted find-and-replace, which is safer than overwriting the whole file.
- The \`old_string\` in edit_file must match the file contents **exactly**, including indentation and whitespace. Copy it precisely from the read_file output (without the line numbers).
- Use \`write_file\` only when creating new files or when the entire file needs to be rewritten.
- Use \`delete_file\` to remove a file. Always use \`ask_user\` to confirm before deleting unless the user has already explicitly requested the deletion.
- Preserve the existing code style — indentation (tabs vs spaces), quote style, trailing commas, etc. Match what's already there.
- Do not add unrelated changes. If you are asked to fix a bug, fix that bug — don't also refactor surrounding code or add comments.

### Shell commands
- Use \`shell\` for running builds, tests, linters, git commands, package installs, and any other CLI operations.
- Keep commands focused and non-destructive. Avoid commands that delete data or have irreversible side effects unless the user explicitly asked for that.
- If a command might be slow or dangerous, use ask_user first to confirm.

### Web search
- Use \`web_search\` to look up documentation, error messages, library APIs, or anything you don't already know. It uses Ollama's web search API and returns titles, URLs, and content snippets.
- Use \`web_fetch\` to read a specific web page — documentation, blog post, API reference, etc. It uses Ollama's web fetch API and returns the page title and content as readable text. Pass a URL from web_search results or one the user provides.
- Prefer web_search + web_fetch over guessing when you're unsure about a library's API, a language feature, or an error message you haven't seen before.

### Asking the user
- Use \`ask_user\` when the request is ambiguous and you could reasonably interpret it multiple ways.
- Use \`ask_user\` when you need to confirm a destructive or hard-to-reverse action (deleting files, overwriting data, force-pushing, etc.).
- Use \`ask_user\` when you discover something unexpected that changes the approach (e.g., the codebase uses a different framework than expected).
- Do NOT use ask_user for things you can figure out from the code — exhaust the available tools first.

## Code quality

- Write clean, idiomatic code that fits the project's existing patterns and conventions.
- Don't add unnecessary dependencies, abstractions, or over-engineering.
- Handle errors at boundaries (user input, external APIs, file I/O) but don't add defensive checks for impossible conditions.
- Be careful about security — don't introduce injection vulnerabilities, don't hardcode secrets, don't expose sensitive data.

## Important constraints

- You are running on the user's actual filesystem. Changes are real and immediate. Be careful.
- Your working directory is the project root. Use relative paths unless there's a reason for absolute paths.
- If you are unsure about something, ask rather than guess.`;

export class Agent extends EventEmitter {
  constructor({ host, model } = {}) {
    super();
    this.client = ollama.createClient(host);
    this.model = model || ollama.DEFAULT_MODEL;
    this.messages = [];
    this.running = false;
    this._initialized = false;

    // Give the web tools access to the Ollama client
    setSearchClient(this.client);
    setFetchClient(this.client);
  }

  /**
   * Build the system message with live project context.
   * Called once before the first run(), or after reset().
   */
  async _init() {
    if (this._initialized) return;

    let contextBlock = "";
    try {
      contextBlock = await gatherContext(process.cwd());
    } catch {
      // If context gathering fails, proceed without it
    }

    const systemContent = contextBlock
      ? `${SYSTEM_PROMPT}\n\n# Current project context\n\n${contextBlock}`
      : SYSTEM_PROMPT;

    this.messages = [{ role: "system", content: systemContent }];
    this._initialized = true;
    this.emit("context_ready");
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

    this.running = true;
    this.messages.push({ role: "user", content: userMessage });

    const tools = registry.ollamaTools();
    let iterations = 0;
    const MAX_ITERATIONS = 25;

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const response = await ollama.chat(
          this.client,
          this.model,
          this.messages,
          tools
        );

        const msg = response.message;
        this.messages.push(msg);

        // If no tool calls, we're done — return the text response.
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          this.running = false;
          this.emit("response", { content: msg.content });
          return msg.content;
        }

        // Process each tool call
        for (const toolCall of msg.tool_calls) {
          const name = toolCall.function.name;
          const args = toolCall.function.arguments;

          this.emit("tool_call", { name, args });

          const result = await registry.execute(name, args);

          this.emit("tool_result", { name, result });

          this.messages.push({
            role: "tool",
            content: JSON.stringify(result),
          });
        }
      }

      this.running = false;
      const limitMsg = "(Agent reached maximum iteration limit)";
      this.emit("response", { content: limitMsg });
      return limitMsg;
    } catch (err) {
      this.running = false;
      this.emit("error", err);
      throw err;
    }
  }

  /** Reset conversation history and re-gather context on next run. */
  reset() {
    this.messages = [];
    this._initialized = false;
  }
}
