/**
 * Tool registry — registers tools and provides them in standard tool-call format.
 *
 * Core responsibilities:
 *   - Register tools with descriptions, parameters, and execution functions
 *   - Provide tools in OpenAI function-calling format
 *   - Manage jail directory for path validation
 *   - Support progressive tool discovery with tool groups
 *   - Handle tool approval categories (read, write, execute, network, safe)
 *   - Per-input safety properties (isReadOnly, isDestructive, isConcurrencySafe)
 *   - Per-tool result size limits for context management
 *   - Approval info formatting for UI
 *
 * Tool groups:
 *   - core: Always available (read_file, write_file, replace_in_file, list_files, grep, run_command, ask_user)
 *   - plan: save_plan, load_plan_progress, get_current_plan, complete_plan_step, update_plan_status, reflect
 *   - memory: remember, recall, memory_bank_read, memory_bank_write, memory_bank_init, save_context
 *   - web: web_search, web_fetch
 *   - multi_agent: delegate, send_letter, check_reply, read_inbox, read_outbox, reply_to_letter, list_agents, link_repos, set_snippet, find_agent_for_task
 *
 * Key exports:
 *   - register(name, def): Register a tool
 *   - getTools(): Get all registered tools in OpenAI format
 *   - execute(name, args, options): Execute a tool by name
 *   - getToolProperties(name, args): Get safety properties for a tool call
 *   - getApprovalInfo(name, args): Get formatted info for approval UI
 *   - getMaxResultSize(name): Get max result size for a tool
 *   - setJailDirectory(dir), getJailDirectory(): Jail path management
 *   - getToolGroups(), getToolsForGroups(), describeInactiveGroups(): Tool discovery
 *
 * @file-doc
 * @module tools/registry
 * @dependencies node:path, ../logger.js, ./errors.js
 * @dependents src/acp-server.js, src/agent.js, src/ui/App.js, src/tools/*.js, test/unit/registry.test.js
 */
import path from 'node:path';
import { logger } from '../logger.js';
import { ToolError, ToolErrorCode, errorToResult } from './errors.js';

// ============ Types ============

export interface ToolDefinition {
  description: string;
  parameters: ToolParameters;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any, context: any) => Promise<unknown> | unknown;
  core?: boolean;
  extended?: boolean;
  requiresApproval?: boolean;
}

export interface ToolContext {
  cwd?: string;
  eventEmitter?: unknown;
  allowedTools?: Set<string>;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  items?: { type: string };
  enum?: string[];
}

export interface ToolFunction {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}

export interface ToolProperties {
  isReadOnly: boolean;
  isDestructive: boolean;
  isConcurrencySafe: boolean;
  category: string;
}

export interface ApprovalInfo {
  category: string;
  risk: string;
  riskIcon: string;
  riskColor: string;
  summary: string;
  details: string[];
  suggestion: string;
  isReadOnly: boolean;
  isDestructive: boolean;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  errors?: string[];
  sanitizedPath?: string;
}

export interface ToolGroup {
  tools: string[];
  description: string;
}

// ============ Registry State ============

const tools = new Map<string, ToolDefinition>();

/** Global jail directory - set by Agent, cannot be overridden by tool callers */
let _jailDirectory: string | null = null;

/**
 * Set the global jail directory. Called once by Agent during initialization.
 */
export function setJailDirectory(dir: string): void {
  _jailDirectory = path.resolve(dir);
  logger.debug(`Jail directory set to: ${_jailDirectory}`);
}

/**
 * Get the current jail directory
 */
export function getJailDirectory(): string {
  return _jailDirectory || process.cwd();
}

// ============ Tool Groups ============

/** Core tools — always shown to the model */
const CORE_TOOLS = new Set([
  "read_file", "write_file", "replace_in_file",
  "list_files", "grep", "run_command", "ask_user",
  "code_execution",
]);

/** Tool groups for progressive discovery */
const TOOL_GROUPS: Record<string, ToolGroup> = {
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

/** Starter groups always active at the beginning of a run */
const STARTER_GROUPS = new Set(["explore", "edit", "execute"]);

/** Tools that can modify the filesystem or execute arbitrary code */
const DANGEROUS_TOOLS = new Set([
  "write_file", "replace_in_file", "run_command", "code_execution",
]);

/** Approval categories for granular auto-approve */
const TOOL_CATEGORIES: Record<string, string> = {
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

// ============ Validation ============

/**
 * Validate and sanitize a file path to prevent jail escape
 */
export function validateFilePath(filePath: string, cwd: string): ValidationResult {
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
export function validateToolArgs(toolName: string, args: unknown, parameters?: ToolParameters): ValidationResult {
  const errors: string[] = [];

  if (!args || typeof args !== 'object') {
    errors.push('Tool arguments must be an object');
    return { valid: false, errors };
  }

  const argsObj = args as Record<string, unknown>;

  if (parameters && parameters.required) {
    for (const required of parameters.required) {
      if (argsObj[required] === undefined) {
        errors.push(`Missing required argument: ${required}`);
      }
    }
  }

  if (toolName === 'grep' && argsObj.pattern) {
    try { new RegExp(argsObj.pattern as string); } catch (err) {
      const error = err as Error;
      errors.push(`Invalid regex pattern: ${error.message}`);
    }
  }

  if (toolName === 'run_command' && argsObj.command) {
    if (typeof argsObj.command !== 'string') errors.push('Shell command must be a string');
    else if ((argsObj.command as string).length > 10000) errors.push('Command too long (max 10000 characters)');
  }

  if (errors.length > 0) {
    logger.warn(`Tool validation failed for ${toolName}: ${errors.join(', ')}`);
    return { valid: false, errors };
  }
  return { valid: true };
}

// ============ Command Safety Classification ============

/** Commands that are safe to run without approval (read-only) */
const READ_ONLY_COMMANDS = new Set([
  "ls", "dir", "cat", "head", "tail", "less", "more", "wc", "du", "find",
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "pwd", "whoami", "which", "type", "echo", "env", "printenv",
]);

/** Command patterns that are potentially destructive */
const DESTRUCTIVE_PATTERNS = [
  /^rm\s/, /^rm$/, /-rf/, /-r\s+-f/, /-f\s+-r/,
  /^dd\s/, /^mkfs/, /^fdisk/, /^format\s/,
  /^:\(\)\s*\{/, // Fork bomb pattern
  /\|\s*sh\b/, /\|\s*bash\b/, // Pipe to shell
];

/**
 * Check if a command is read-only and safe to run without approval.
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim().split(/\s+/)[0];
  const baseCmd = cmd.split("/").pop();

  if (READ_ONLY_COMMANDS.has(baseCmd || '') || READ_ONLY_COMMANDS.has(cmd)) {
    return true;
  }

  // Check for git read-only subcommands
  if (baseCmd === "git" || cmd === "git") {
    const args = command.trim().split(/\s+/);
    const subcmd = args[1];
    if (["status", "log", "diff", "show", "branch", "tag", "remote", "rev-parse"].includes(subcmd)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a command is potentially destructive.
 */
export function isDestructiveCommand(command: string): boolean {
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

// ============ Registration ============

/**
 * Register a tool.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function register(name: string, def: any): void {
  tools.set(name, {
    ...def,
    core: def.core ?? CORE_TOOLS.has(name),
  });
}

/**
 * Return the tools array in the standard format (OpenAI/Ollama-compatible).
 */
export function getTools(coreOnly = true): ToolFunction[] {
  const out: ToolFunction[] = [];
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
export function extendedToolNames(): string[] {
  return [...tools.entries()]
    .filter(([, t]) => !t.core)
    .map(([name]) => name);
}

// ============ Progressive Discovery API ============

/** Return the starter group names. */
export function getStarterGroups(): string[] {
  return [...STARTER_GROUPS];
}

/** Return all group definitions (name → { tools, description }). */
export function getToolGroups(): Record<string, ToolGroup> {
  return { ...TOOL_GROUPS };
}

/** Return names of groups that are not in the given activeGroups set. */
export function getInactiveGroups(activeGroups: Set<string>): string[] {
  return Object.keys(TOOL_GROUPS).filter(g => !activeGroups.has(g));
}

/**
 * Return tools filtered to only those belonging to the given active groups.
 */
export function getToolsForGroups(activeGroups: Set<string>, includeUngrouped = false): ToolFunction[] {
  const allowed = new Set<string>();
  for (const groupName of activeGroups) {
    const group = TOOL_GROUPS[groupName];
    if (group) {
      for (const t of group.tools) allowed.add(t);
    }
  }

  // Find tools that aren't in any group
  const allGrouped = new Set<string>();
  for (const group of Object.values(TOOL_GROUPS)) {
    for (const t of group.tools) allGrouped.add(t);
  }

  const out: ToolFunction[] = [];
  for (const [name, tool] of tools) {
    if (allowed.has(name)) {
      out.push({ type: "function", function: { name, description: tool.description, parameters: tool.parameters } });
    } else if (includeUngrouped && !allGrouped.has(name)) {
      out.push({ type: "function", function: { name, description: tool.description, parameters: tool.parameters } });
    }
  }
  return out;
}

/** Describe inactive groups as a compact string for the system prompt. */
export function describeInactiveGroups(activeGroups: Set<string>): string {
  const lines: string[] = [];
  for (const [name, group] of Object.entries(TOOL_GROUPS)) {
    if (activeGroups.has(name)) continue;
    lines.push(`- **${name}**: ${group.description} (${group.tools.length} tools)`);
  }
  return lines.join("\n");
}

// ============ Execution ============

/**
 * Execute a tool call by name with the given arguments.
 */
export async function execute(name: string, args: Record<string, unknown>, _options: { cwd?: string; eventEmitter?: unknown; allowedTools?: Set<string> } = {}): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) {
    logger.error(`Unknown tool: ${name}`);
    return errorToResult(new ToolError(ToolErrorCode.TOOL_NOT_FOUND, `Unknown tool: ${name}`, { tool: name }));
  }

  if (tool.parameters) {
    const validation = validateToolArgs(name, args, tool.parameters);
    if (!validation.valid) {
      return errorToResult(new ToolError(ToolErrorCode.VALIDATION_FAILED, `Validation failed: ${(validation.errors || []).join(', ')}`, { errors: validation.errors }));
    }
  }

  // Always use global jail directory, ignore options.cwd for security
  const cwd = _jailDirectory || process.cwd();
  const { eventEmitter, allowedTools } = _options;

  const argSummary = name === "run_command" ? ((args?.command as string) || "").slice(0, 200)
    : name === "git" ? (Array.isArray(args?.args) ? (args.args as string[]).join(" ") : String(args?.args || ""))
    : name === "write_file" || name === "replace_in_file" ? (args?.filePath as string) || ""
    : Object.keys(args || {}).join(", ");

  logger.info(`Executing tool: ${name}(${argSummary.slice(0, 150)})`);

  try {
    const result = await tool.execute(args, { cwd, eventEmitter, allowedTools });
    if (result && typeof result === 'object' && 'error' in result) {
      logger.warn(`Tool ${name} returned error: ${String((result as { error: unknown }).error).slice(0, 200)}`);
    }
    return result;
  } catch (err) {
    const error = err as Error;
    logger.error(`Tool ${name} failed: ${error.message}\n${error.stack}`);
    return errorToResult(err);
  }
}

// ============ Approval ============

/** Check whether a tool requires user approval before execution. */
export function requiresApproval(name: string): boolean {
  return DANGEROUS_TOOLS.has(name);
}

/** Get the approval category for a tool. */
export function getToolCategory(name: string): string {
  return TOOL_CATEGORIES[name] || "other";
}

/** Get all defined approval categories. */
export function getApprovalCategories(): string[] {
  return ["read", "write", "execute", "network", "safe", "other"];
}

// ============ Safety Properties ============

interface ToolPropertyHandlers {
  category: string;
  isReadOnly: (args: Record<string, unknown>) => boolean;
  isDestructive: (args: Record<string, unknown>) => boolean;
  isConcurrencySafe: (args: Record<string, unknown>) => boolean;
}

const TOOL_PROPERTIES: Record<string, ToolPropertyHandlers> = {
  read_file: {
    category: "read",
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
  },
  write_file: {
    category: "write",
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
  },
  replace_in_file: {
    category: "write",
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
  },
  list_files: {
    category: "read",
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
  },
  grep: {
    category: "read",
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
  },
  run_command: {
    category: "execute",
    isReadOnly: (args) => isReadOnlyCommand((args?.command as string) || ""),
    isDestructive: (args) => isDestructiveCommand((args?.command as string) || ""),
    isConcurrencySafe: (args) => isReadOnlyCommand((args?.command as string) || ""),
  },
  git: {
    category: "execute",
    isReadOnly: (args) => {
      const subcmd = (args?.args as string[] | undefined)?.[0];
      return subcmd ? ["status", "log", "diff", "show", "branch", "tag", "remote"].includes(subcmd) : false;
    },
    isDestructive: () => false,
    isConcurrencySafe: (args) => {
      const subcmd = (args?.args as string[] | undefined)?.[0];
      return subcmd ? ["status", "log", "diff", "show", "branch", "tag", "remote"].includes(subcmd) : false;
    },
  },
  ask_user: {
    category: "safe",
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
  },
  code_execution: {
    category: "execute",
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
  },
};

/**
 * Get safety properties for a tool based on its input.
 */
export function getToolProperties(name: string, args: Record<string, unknown> = {}): ToolProperties {
  const props = TOOL_PROPERTIES[name];
  if (!props) {
    const category = TOOL_CATEGORIES[name] || "other";
    return {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      category,
    };
  }
  return {
    isReadOnly: props.isReadOnly(args),
    isDestructive: props.isDestructive(args),
    isConcurrencySafe: props.isConcurrencySafe(args),
    category: props.category,
  };
}

// ============ Result Size Limits ============

const TOOL_RESULT_LIMITS: Record<string, number> = {
  read_file: Infinity,
  list_files: 50000,
  grep: 30000,
  run_command: 50000,
  delegate: 20000,
  default: 100000,
};

/** Get the maximum result size for a tool. */
export function getMaxResultSize(name: string): number {
  return TOOL_RESULT_LIMITS[name] ?? TOOL_RESULT_LIMITS.default;
}

// ============ Approval Info for UI ============

/**
 * Get approval information for a tool call.
 */
export function getApprovalInfo(name: string, args: Record<string, unknown> = {}): ApprovalInfo {
  const props = getToolProperties(name, args);
  const category = props.category;

  let risk = "low";
  let riskIcon = "✓";
  let riskColor = "green";

  if (props.isDestructive) {
    risk = "critical";
    riskIcon = "⚠";
    riskColor = "red";
  } else if (props.isReadOnly) {
    risk = "low";
    riskIcon = "✓";
    riskColor = "green";
  } else if (category === "execute") {
    risk = "medium";
    riskIcon = "⚡";
    riskColor = "yellow";
  } else if (category === "write") {
    risk = "medium";
    riskIcon = "✎";
    riskColor = "yellow";
  } else if (category === "network") {
    risk = "medium";
    riskIcon = "↗";
    riskColor = "yellow";
  }

  const summary = buildToolSummary(name, args);
  const details: string[] = [];

  if (props.isReadOnly) details.push("Read-only operation");
  if (props.isDestructive) details.push("⚠ Potentially destructive");
  if (props.isConcurrencySafe) details.push("Safe to run in parallel");

  if (name === "run_command" && args?.command) {
    const cmd = args.command as string;
    details.push(`Command: ${cmd.slice(0, 60)}${cmd.length > 60 ? "..." : ""}`);
  }
  if ((name === "write_file" || name === "replace_in_file") && args) {
    if (args.filePath) details.push(`File: ${args.filePath}`);
    if (args.content && typeof args.content === "string") {
      details.push(`${(args.content as string).split("\n").length} lines to write`);
    }
  }
  if (name === "read_file" && args?.filePath) {
    details.push(`File: ${args.filePath}`);
    if (args.startLine || args.endLine) {
      details.push(`Lines ${(args.startLine as number) || 1}-${(args.endLine as number) || "end"}`);
    }
  }

  let suggestion = "";
  if (category !== "safe" && category !== "read") {
    const catNames: Record<string, string> = { write: "write operations", execute: "shell commands", network: "network operations" };
    suggestion = `/approve ${category} to auto-approve all ${catNames[category] || category}`;
  }

  return { category, risk, riskIcon, riskColor, summary, details, suggestion, isReadOnly: props.isReadOnly, isDestructive: props.isDestructive };
}

function buildToolSummary(name: string, args: Record<string, unknown> = {}): string {
  switch (name) {
    case "read_file": {
      const file = (args?.filePath as string) || "file";
      if (args?.startLine || args?.endLine) return `${file} (lines ${(args.startLine as number) || 1}-${(args.endLine as number) || "end"})`;
      return file;
    }
    case "write_file": {
      const file = (args?.filePath as string) || "file";
      const len = ((args?.content as string)?.length) || 0;
      return `${file} (${len} bytes)`;
    }
    case "replace_in_file": {
      const file = (args?.filePath as string) || "file";
      const oldLen = ((args?.oldText as string)?.length) || 0;
      return `${file} (replace ${oldLen} chars)`;
    }
    case "run_command": {
      const cmd = (args?.command as string) || "";
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "git": {
      const subcmd = ((args?.args as string[])?.[0]) || "";
      return `git ${subcmd}`;
    }
    case "grep": {
      const pattern = (args?.pattern as string) || "";
      const path = (args?.path as string) || "";
      return `"${pattern}" in ${path || "."}`;
    }
    case "list_files": {
      const pattern = (args?.pattern as string) || "*";
      const path = (args?.path as string) || ".";
      return `${pattern} in ${path}`;
    }
    case "code_execution": {
      const code = (args?.code as string) || "";
      return code.length > 50 ? code.slice(0, 47) + "..." : code;
    }
    default: {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(args || {})) {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        parts.push(`${k}: ${s.length > 30 ? s.slice(0, 27) + "..." : s}`);
      }
      return parts.slice(0, 3).join(", ");
    }
  }
}

// ============ List ============

/** List all registered tool names */
export function list(): string[] {
  return [...tools.keys()];
}

/** Return the internal tool map (read-only access for LRU cache descriptions). */
export function getToolMap(): Map<string, ToolDefinition> {
  return tools;
}

// ============ Default Export ============

export default {
  register,
  getTools,
  ollamaTools,
  execute,
  list,
  getToolMap,
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
  getToolProperties,
  getMaxResultSize,
  getApprovalInfo,
};