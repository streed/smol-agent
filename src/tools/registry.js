import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Tool registry — registers tools and provides them in standard tool-call format.
 */

const tools = new Map();

// Global jail directory - set by Agent, cannot be overridden by tool callers
let _jailDirectory = null;

/**
 * Set the global jail directory. Called once by Agent during initialization.
 * @param {string} dir - Absolute path to the jail directory
 */
export function setJailDirectory(dir) {
  _jailDirectory = path.resolve(dir);
  logger.debug(`Jail directory set to: ${_jailDirectory}`);
}

/**
 * Get the current jail directory
 */
export function getJailDirectory() {
  return _jailDirectory || process.cwd();
}

// Core tools — always shown to the model. Keeping this small improves
// tool-selection accuracy on smaller models (7B–14B).
const CORE_TOOLS = new Set([
  "read_file", "write_file", "replace_in_file",
  "list_files", "grep", "run_command", "ask_user",
]);

// Tools that can modify the filesystem or execute arbitrary code.
// These require user approval before execution (unless auto-approve is on).
const DANGEROUS_TOOLS = new Set([
  "write_file", "replace_in_file", "run_command",
]);

// Approval categories for granular auto-approve (Aider/Kilocode pattern)
// Maps tool names to categories. Users can auto-approve per category.
const TOOL_CATEGORIES = {
  read_file: "read",
  list_files: "read",
  grep: "read",
  write_file: "write",
  replace_in_file: "write",
  run_command: "execute",
  git: "execute",
  web_search: "network",
  web_fetch: "network",
  ask_user: "safe",
  delegate: "safe",
  remember: "safe",
  recall: "safe",
  save_context: "safe",
  reflect: "safe",
  save_plan: "safe",
  load_plan_progress: "safe",
  complete_plan_step: "safe",
  update_plan_status: "safe",
  get_current_plan: "safe",
  memory_bank_read: "safe",
  memory_bank_write: "safe",
  memory_bank_init: "safe",
  send_letter: "network",
  check_reply: "safe",
  read_inbox: "safe",
  read_outbox: "safe",
  reply_to_letter: "write",
  list_agents: "safe",
  link_repos: "safe",
};

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
 * Return the tools array in the standard format (OpenAI/Ollama-compatible).
 * @param {boolean} coreOnly - If true, only include core tools (default true)
 */
export function getTools(coreOnly = true) {
  const out = [];
  for (const [name, tool] of tools) {
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

/** @deprecated Use getTools() instead. Kept for backward compatibility. */
export const ollamaTools = getTools;

/** Return names of all extended (non-core) tools currently registered. */
export function extendedToolNames() {
  return [...tools.entries()]
    .filter(([, t]) => !t.core)
    .map(([name]) => name);
}

/**
 * Execute a tool call by name with the given arguments.
 * Uses the global jail directory for security - the cwd parameter from callers
 * is ignored to prevent jail escape attempts.
 */
export async function execute(name, args, _options = {}) {
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

  // Always use global jail directory, ignore options.cwd for security
  const cwd = _jailDirectory || process.cwd();
  logger.debug(`Executing tool: ${name}`, { args: Object.keys(args || {}), cwd });

  try {
    const result = await tool.execute(args, { cwd });
    logger.info(`Tool ${name} completed successfully`);
    return result;
  } catch (err) {
    logger.error(`Tool ${name} failed`, { error: err.message, stack: err.stack });
    return { error: err.message };
  }
}

/** Check whether a tool requires user approval before execution. */
export function requiresApproval(name) {
  return DANGEROUS_TOOLS.has(name);
}

/** Get the approval category for a tool. */
export function getToolCategory(name) {
  return TOOL_CATEGORIES[name] || "other";
}

/** Get all defined approval categories. */
export function getApprovalCategories() {
  return ["read", "write", "execute", "network", "safe", "other"];
}

export function list() {
  return [...tools.keys()];
}

export default {
  register,
  getTools,
  ollamaTools,
  execute,
  list,
  validateToolArgs,
  validateFilePath,
  requiresApproval,
  getToolCategory,
  getApprovalCategories,
  setJailDirectory,
  getJailDirectory,
};
