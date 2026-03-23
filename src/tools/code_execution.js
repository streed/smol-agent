/**
 * Code Execution Tool — Programmatic Tool Calling
 *
 * Allows the model to write JavaScript code that calls registered tools as
 * async functions, enabling multi-tool workflows in a single turn without
 * extra model round-trips. This is the client-side equivalent of Anthropic's
 * server-side programmatic tool calling feature.
 *
 * When this tool is invoked, the code runs in a sandboxed VM context with
 * all registered tools available as `await toolName(args)` functions.
 * Only the final stdout/stderr is returned to the model — intermediate
 * tool results stay out of the context window, saving tokens.
 *
 * Compatible with all providers (Ollama, OpenAI, Anthropic, Grok, etc.).
 */

import vm from "node:vm";
import { register, getTools, execute as executeRegisteredTool } from "./registry.js";
import { logger } from "../logger.js";

/** Maximum execution time for code (ms) */
const CODE_TIMEOUT = 120_000; // 2 minutes

/** Maximum captured stdout size (chars) */
const MAX_STDOUT = 50_000;

/**
 * Build the sandbox context with tool functions and console capture.
 *
 * Each registered tool becomes an async function in the sandbox:
 *   await read_file({ filePath: "src/index.js" })
 *   await grep({ pattern: "TODO", path: "src/" })
 *
 * The sandbox also provides:
 *   - console.log / console.error → captured stdout/stderr
 *   - JSON global
 *   - setTimeout / clearTimeout (capped)
 *
 * @param {Array} tools - Tool definitions from registry.getTools()
 * @param {object} options
 * @param {Function} [options.onToolCall] - Called before each tool execution
 * @param {Function} [options.onToolResult] - Called after each tool execution
 * @returns {{ context: vm.Context, getOutput: () => { stdout: string, stderr: string } }}
 */
function buildSandbox(tools, { onToolCall, onToolResult } = {}) {
  let stdout = "";
  let stderr = "";

  const appendStdout = (...args) => {
    const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    if (stdout.length < MAX_STDOUT) {
      stdout += line + "\n";
    }
  };

  const appendStderr = (...args) => {
    const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    if (stderr.length < MAX_STDOUT) {
      stderr += line + "\n";
    }
  };

  const sandbox = {
    console: {
      log: appendStdout,
      info: appendStdout,
      warn: appendStderr,
      error: appendStderr,
      debug: () => {}, // suppress debug output
    },
    JSON,
    Math,
    Date,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    Promise,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30_000)),
    clearTimeout,
  };

  // Make each registered tool available as an async function
  for (const tool of tools) {
    const toolName = tool.function.name;
    // Skip self to prevent infinite recursion
    if (toolName === "code_execution") continue;

    sandbox[toolName] = async (args = {}) => {
      if (onToolCall) onToolCall(toolName, args);
      logger.info(`[code_execution] calling tool: ${toolName}`);
      const result = await executeRegisteredTool(toolName, args);
      if (onToolResult) onToolResult(toolName, args, result);
      return result;
    };
  }

  const context = vm.createContext(sandbox);

  return {
    context,
    getOutput: () => ({
      stdout: stdout.slice(0, MAX_STDOUT),
      stderr: stderr.slice(0, MAX_STDOUT),
    }),
  };
}

register("code_execution", {
  description:
    `Execute JavaScript code that can call any registered tool as an async function. ` +
    `Use this to batch multiple tool calls, filter/aggregate results, or run loops — ` +
    `all in a single turn without extra round-trips. ` +
    `Tools are available as async functions: e.g. \`await read_file({ filePath: "src/index.js" })\`, ` +
    `\`await grep({ pattern: "TODO", path: "src/" })\`, ` +
    `\`await run_command({ command: "npm test" })\`. ` +
    `Use console.log() to produce output — only the final stdout is returned. ` +
    `The code runs in a sandboxed environment with a 2-minute timeout.`,
  parameters: {
    type: "object",
    required: ["code"],
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript code to execute. All registered tools are available as " +
          "async functions (e.g. `await read_file({ filePath: '...' })`). " +
          "Use console.log() to produce output that will be returned.",
      },
    },
  },
  core: true,
  async execute({ code }, { cwd: _cwd } = {}) {
    if (!code || typeof code !== "string") {
      return { error: "code must be a non-empty string" };
    }

    if (code.length > 50_000) {
      return { error: "Code too long (max 50,000 characters)" };
    }

    // Get all available tools (including non-core) to expose in the sandbox
    const allTools = getTools(false);

    const toolCallLog = [];
    const { context, getOutput } = buildSandbox(allTools, {
      onToolCall: (name, args) => {
        toolCallLog.push({ name, args, timestamp: Date.now() });
      },
    });

    try {
      // Wrap in an async IIFE so top-level await works
      const wrappedCode = `(async () => {\n${code}\n})()`;

      const script = new vm.Script(wrappedCode, {
        filename: "code_execution",
        timeout: CODE_TIMEOUT,
      });

      // Run the script — this returns a Promise from the async IIFE
      const promise = script.runInContext(context, { timeout: CODE_TIMEOUT });

      // Await the async result with a timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Code execution timed out")), CODE_TIMEOUT)
      );

      await Promise.race([promise, timeoutPromise]);

      const { stdout, stderr } = getOutput();

      const result = {
        stdout: stdout || "(no output)",
        stderr: stderr || "",
        return_code: 0,
        tool_calls_made: toolCallLog.length,
      };

      if (toolCallLog.length > 0) {
        result.tools_called = [...new Set(toolCallLog.map(t => t.name))];
      }

      logger.info(`[code_execution] completed: ${toolCallLog.length} tool calls, ` +
        `${stdout.length} chars stdout, ${stderr.length} chars stderr`);

      return result;
    } catch (err) {
      const { stdout, stderr } = getOutput();

      logger.warn(`[code_execution] error: ${err.message}`);

      return {
        stdout: stdout || "",
        stderr: `${stderr}${stderr ? "\n" : ""}Error: ${err.message}`,
        return_code: 1,
        tool_calls_made: toolCallLog.length,
        error: err.message,
      };
    }
  },
});
