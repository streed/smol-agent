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
  "code_execution",
]);

// ── Progressive Tool Discovery ──────────────────────────────────────
// Tool groups for progressive discovery. The agent starts with a small
// "starter" set and unlocks groups as needed — reducing context bloat
// and improving tool-selection accuracy.

/** @type {Record<string, { tools: string[], description: string }>} */
const TOOL_GROUPS = {
  explore: {
    tools: ["read_file", "list_files", "grep", "ask_user"],
    description: "Read files, list directories, search code, ask user",
  },
  edit: {
    tools: ["write_file", "replace_in_file"],
    description: "Create and edit files",
  },
  execute: {
    tools: ["run_command", "git", "code_execution"],
    description: "Run shell commands, git operations, and execute code",
  },
  plan: {
    tools: ["save_plan", "load_plan_progress", "complete_plan_step", "update_plan_status", "get_current_plan", "reflect"],
    description: "Create plans, track progress, reflect on work",
  },
  memory: {
    tools: ["remember", "recall", "memory_bank_read", "memory_bank_write", "memory_bank_init", "save_context"],
    description: "Persist memories, context docs, and cross-session knowledge",
  },
  web: {
    tools: ["web_search", "web_fetch"],
    description: "Search the web and fetch URLs",
  },
  multi_agent: {
    tools: ["delegate", "send_letter", "check_reply", "read_inbox", "read_outbox", "reply_to_letter", "list_agents", "link_repos", "set_snippet", "find_agent_for_task"],
    description: "Delegate to sub-agents, cross-agent messaging, agent registry",
  },
};

// The starter groups always active at the beginning of a run
const STARTER_GROUPS = new Set(["explore", "edit", "execute"]);

// Tools that can modify the filesystem or execute arbitrary code.
// These require user approval before execution (unless auto-approve is on).
const DANGEROUS_TOOLS = new Set([
  "write_file", "replace_in_file", "run_command", "code_execution",
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
  set_snippet: "safe",
  find_agent_for_task: "safe",
  code_execution: "execute",
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

// ── Progressive Discovery API ───────────────────────────────────────

/** Return the starter group names. */
export function getStarterGroups() {
  return [...STARTER_GROUPS];
}

/** Return all group definitions (name → { tools, description }). */
export function getToolGroups() {
  return { ...TOOL_GROUPS };
}

/** Return names of groups that are not in the given activeGroups set. */
export function getInactiveGroups(activeGroups) {
  return Object.keys(TOOL_GROUPS).filter(g => !activeGroups.has(g));
}

/**
 * Return tools filtered to only those belonging to the given active groups.
 * Tools not assigned to any group are included if `includeUngrouped` is true.
 * @param {Set<string>} activeGroups - Set of active group names
 * @param {boolean} [includeUngrouped=false] - Include tools not in any group
 */
export function getToolsForGroups(activeGroups, includeUngrouped = false) {
  // Build the allowed tool name set from active groups
  const allowed = new Set();
  for (const groupName of activeGroups) {
    const group = TOOL_GROUPS[groupName];
    if (group) {
      for (const t of group.tools) allowed.add(t);
    }
  }

  // Find tools that aren't in any group
  const allGrouped = new Set();
  for (const group of Object.values(TOOL_GROUPS)) {
    for (const t of group.tools) allGrouped.add(t);
  }

  const out = [];
  for (const [name, tool] of tools) {
    if (allowed.has(name)) {
      out.push({ type: "function", function: { name, description: tool.description, parameters: tool.parameters } });
    } else if (includeUngrouped && !allGrouped.has(name)) {
      out.push({ type: "function", function: { name, description: tool.description, parameters: tool.parameters } });
    }
  }
  return out;
}

/**
 * Describe inactive groups as a compact string for the system prompt.
 * @param {Set<string>} activeGroups
 */
export function describeInactiveGroups(activeGroups) {
  const lines = [];
  for (const [name, group] of Object.entries(TOOL_GROUPS)) {
    if (activeGroups.has(name)) continue;
    lines.push(`- **${name}**: ${group.description} (${group.tools.length} tools)`);
  }
  return lines.join("\n");
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
  // Log argument details for key tools to aid debugging
  const argSummary = name === "run_command" ? (args?.command || "").slice(0, 200)
    : name === "git" ? (args?.args || []).join(" ")
    : name === "write_file" || name === "replace_in_file" ? args?.filePath || ""
    : Object.keys(args || {}).join(", ");
  logger.info(`Executing tool: ${name}(${argSummary.slice(0, 150)})`);

  try {
    const result = await tool.execute(args, { cwd });
    if (result?.error) {
      logger.warn(`Tool ${name} returned error: ${String(result.error).slice(0, 200)}`);
    } else {
      logger.info(`Tool ${name} completed successfully`);
    }
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
  getStarterGroups,
  getToolGroups,
  getInactiveGroups,
  getToolsForGroups,
  describeInactiveGroups,
};
