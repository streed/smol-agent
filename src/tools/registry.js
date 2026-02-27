import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Tool registry — registers tools and provides them in Ollama's tool-call format.
 */

const tools = new Map();

// Tools that modify files or run commands (blocked in read-only mode)
const WRITE_TOOLS = new Set(["run_command", "write_file", "replace_in_file"]);

// Core tools — always shown to the model. Keeping this small improves
// tool-selection accuracy on smaller models (7B–14B).
const CORE_TOOLS = new Set([
  "read_file", "write_file", "replace_in_file",
  "list_files", "grep", "run_command", "ask_user",
]);

/**
 * Validate and sanitize a file path to prevent jail escape
 */
export function validateFilePath(filePath, cwd) {
  if (typeof filePath !== 'string') {
    return { valid: false, error: 'File path must be a string' };
  }
  if (filePath.includes('\0')) {
    return { valid: false, error: 'Invalid characters in file path' };
  }

  const resolvedPath = path.resolve(cwd, filePath);
  const normalizedCwd = path.resolve(cwd);
  if (!resolvedPath.startsWith(normalizedCwd + path.sep) && resolvedPath !== normalizedCwd) {
    return { valid: false, error: `Access denied: path escapes jail directory (${normalizedCwd})` };
  }
  if (filePath.startsWith('..') || filePath.includes('../') || filePath.includes('..\\')) {
    return { valid: false, error: 'Path traversal detected' };
  }

  return { valid: true, sanitizedPath: resolvedPath };
}

/**
 * Validate tool arguments based on expected parameters schema
 */
export function validateToolArgs(toolName, args, parameters) {
  const errors = [];

  if (!args || typeof args !== 'object') {
    errors.push('Tool arguments must be an object');
    return { valid: false, errors };
  }

  if (parameters && parameters.required) {
    for (const required of parameters.required) {
      if (args[required] === undefined) {
        errors.push(`Missing required argument: ${required}`);
      }
    }
  }

  if (toolName === 'grep' && args.pattern) {
    try { new RegExp(args.pattern); } catch (err) {
      errors.push(`Invalid regex pattern: ${err.message}`);
    }
  }

  if (toolName === 'run_command' && args.command) {
    if (typeof args.command !== 'string') errors.push('Shell command must be a string');
    else if (args.command.length > 10000) errors.push('Command too long (max 10000 characters)');
  }

  if (errors.length > 0) {
    logger.warn(`Tool validation failed for ${toolName}:`, { errors });
    return { valid: false, errors };
  }
  return { valid: true };
}

export function register(name, { description, parameters, execute, core }) {
  tools.set(name, { description, parameters, execute, core: core ?? CORE_TOOLS.has(name) });
}

/**
 * Return the tools array in the format Ollama expects.
 * @param {boolean} readOnly - If true, exclude write tools
 * @param {boolean} coreOnly - If true, only include core tools (default true)
 */
export function ollamaTools(readOnly = false, coreOnly = true) {
  const out = [];
  for (const [name, tool] of tools) {
    if (readOnly && WRITE_TOOLS.has(name)) continue;
    if (coreOnly && !tool.core) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: tool.description,
        parameters: tool.parameters,
      },
    });
  }
  return out;
}

/** Return names of all extended (non-core) tools currently registered. */
export function extendedToolNames() {
  return [...tools.entries()]
    .filter(([, t]) => !t.core)
    .map(([name]) => name);
}

/**
 * Execute a tool call by name with the given arguments.
 */
export async function execute(name, args, { cwd = process.cwd() } = {}) {
  const tool = tools.get(name);
  if (!tool) {
    logger.error(`Unknown tool: ${name}`);
    return { error: `Unknown tool: ${name}` };
  }

  if (tool.parameters) {
    const validation = validateToolArgs(name, args, tool.parameters);
    if (!validation.valid) {
      return { error: `Validation failed: ${validation.errors.join(', ')}` };
    }
  }

  logger.debug(`Executing tool: ${name}`, { args: Object.keys(args || {}) });

  try {
    const result = await tool.execute(args);
    logger.info(`Tool ${name} completed successfully`);
    return result;
  } catch (err) {
    logger.error(`Tool ${name} failed`, { error: err.message, stack: err.stack });
    return { error: err.message };
  }
}

export function list() {
  return [...tools.keys()];
}

export default { register, ollamaTools, execute, list, validateToolArgs, validateFilePath };
