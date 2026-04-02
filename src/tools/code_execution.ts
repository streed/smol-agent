/**
 * Code Execution Tool — Programmatic Tool Calling.
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
 *
 * Key exports:
 *   - register: Tool registration (re-exported from registry)
 *   - buildSandbox(tools, options): Create sandboxed context with tool functions
 *   - execute: Main tool execution entry point
 *
 * Dependencies: node:vm, ./registry.js, ../logger.js
 * Depended on by: src/agent.js, src/index.js, src/providers/anthropic.js,
 *                  src/tools/registry.js, test/unit/code-execution.test.js
 */

import vm from "node:vm";
import { register, getTools, execute as executeRegisteredTool } from "./registry.js";
import { logger } from "../logger.js";

/** Maximum execution time for code (ms) */
const CODE_TIMEOUT = 120_000; // 2 minutes

/** Maximum captured stdout size (chars) */
const MAX_STDOUT = 50_000;

interface ToolDefinition {
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface SandboxOptions {
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, args: Record<string, unknown>, result: unknown) => void;
}

interface SandboxResult {
  context: vm.Context;
  getOutput: () => { stdout: string; stderr: string };
}

interface CodeExecutionArgs {
  code: string;
}

interface CodeExecutionContext {
  cwd?: string;
  eventEmitter?: NodeJS.EventEmitter | null;
  allowedTools?: Set<string>;
}

interface CodeExecutionResult {
  stdout?: string;
  stderr?: string;
  error?: string;
}

type ToolFunction = (args?: Record<string, unknown>) => Promise<unknown>;

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
 */
function buildSandbox(tools: ToolDefinition[], options: SandboxOptions = {}): SandboxResult {
  const { onToolCall, onToolResult } = options;
  let stdout = "";
  let stderr = "";

  const appendStdout = (...args: unknown[]): void => {
    const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    if (stdout.length < MAX_STDOUT) {
      stdout += line + "\n";
    }
  };

  const appendStderr = (...args: unknown[]): void => {
    const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    if (stderr.length < MAX_STDOUT) {
      stderr += line + "\n";
    }
  };

  const sandbox: Record<string, unknown> = {
    console: {
      log: appendStdout,
      info: appendStdout,
      warn: appendStderr,
      error: appendStderr,
      debug: () => { /* suppress debug output */ },
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
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 30_000)),
    clearTimeout,
  };

  // Make each registered tool available as an async function
  for (const tool of tools) {
    const toolName = tool.function.name;
    // Skip self to prevent infinite recursion
    if (toolName === "code_execution") continue;

    sandbox[toolName] = async (args: Record<string, unknown> = {}): Promise<unknown> => {
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
    "Execute JavaScript code that can call any registered tool as an async function. " +
    "Use this to batch multiple tool calls, filter/aggregate results, or run loops — " +
    "all in a single turn without extra round-trips. " +
    "Tools are available as async functions: e.g. `await read_file({ filePath: 'src/index.js' })`, " +
    "`await grep({ pattern: 'TODO', path: 'src/' })`, " +
    "`await run_command({ command: 'npm test' })`. " +
    "Use console.log() to produce output — only the final stdout is returned. " +
    "The code runs in a sandboxed environment with a 2-minute timeout.",
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
  async execute({ code }: CodeExecutionArgs, { cwd: _cwd, eventEmitter, allowedTools }: CodeExecutionContext = {}): Promise<CodeExecutionResult> {
    if (!code || typeof code !== "string") {
      return { error: "code must be a non-empty string" };
    }

    if (code.length > 50_000) {
      return { error: "Code too long (max 50,000 characters)" };
    }

    // Get tools to expose in the sandbox — optionally restricted
    let allTools = getTools(false);
    if (allowedTools) {
      allTools = allTools.filter(t => allowedTools.has(t.function.name));
    }

    const toolCallLog: Array<{ name: string; args: Record<string, unknown>; timestamp: number }> = [];
    const { context, getOutput } = buildSandbox(allTools as ToolDefinition[], {
      onToolCall: (name, args) => {
        toolCallLog.push({ name, args, timestamp: Date.now() });
        // Emit event for UI visibility
        if (eventEmitter) {
          eventEmitter.emit("code_exec_tool_call", { name, args });
        }
      },
      onToolResult: (name, args, result) => {
        if (eventEmitter) {
          eventEmitter.emit("code_exec_tool_result", { name, args, result });
        }
      },
    });

    // Emit event for UI visibility when code execution starts
    if (eventEmitter) {
      eventEmitter.emit("code_exec_start", { code });
    }

    try {
      // Wrap in an async IIFE so top-level await works
      const wrappedCode = `(async () => {\n${code}\n})()`;

      const script = new vm.Script(wrappedCode, {
        filename: "code_execution",
      });

      // Run with timeout
      const result = await script.runInContext(context, {
        timeout: CODE_TIMEOUT,
        displayErrors: true,
      });

      const { stdout, stderr } = getOutput();

      // Log tool calls for debugging
      if (toolCallLog.length > 0) {
        logger.debug(`[code_execution] ${toolCallLog.length} tool calls made`);
      }

      // Extract unique tool names
      const toolsCalled = [...new Set(toolCallLog.map(call => call.name))];

      // Return captured output (default to "(no output)" for tests)
      return {
        stdout: stdout || "(no output)",
        stderr: stderr || undefined,
        return_code: 0,
        tool_calls_made: toolCallLog.length,
        tools_called: toolsCalled.length > 0 ? toolsCalled : undefined,
      };
    } catch (err: unknown) {
      const error = err as Error;
      const { stdout, stderr } = getOutput();

      // Provide helpful error messages
      let errorMsg = error.message;

      if (error.message.includes("Script execution timed out")) {
        errorMsg = `Code execution timed out after ${CODE_TIMEOUT / 1000}s`;
      } else if (error.message.includes("is not defined")) {
        // Extract the undefined identifier
        const match = error.message.match(/(\w+) is not defined/);
        if (match && match[1]) {
          errorMsg = `${match[1]} is not defined. Only registered tools and standard library globals are available.`;
        }
      }

      logger.error(`[code_execution] error: ${errorMsg}`);

      return {
        stdout: stdout || "(no output)",
        stderr: stderr ? `${stderr}\n${errorMsg}` : errorMsg,
        error: errorMsg,
        return_code: 1,
        tool_calls_made: toolCallLog.length,
        tools_called: toolCallLog.length > 0 ? [...new Set(toolCallLog.map(call => call.name))] : undefined,
      };
    }
  },
});

// Re-export buildSandbox for testing
export { buildSandbox };