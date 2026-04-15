/**
 * Composable permission rules for tools.
 *
 * Provides a framework for building reusable permission checks:
 * - PermissionRule: Single rule with priority
 * - PermissionComposer: Combines rules in priority order
 * - PermissionRules: Common rule factory
 * - PermissionResult: Standard result builders
 *
 * Key exports:
 *   - PermissionRule class: Single permission rule
 *   - PermissionComposer class: Combines multiple rules
 *   - PermissionRules factory: Common rule builders
 *   - PermissionResult builders: allow(), deny(), needsApproval()
 *
 * @file-doc
 * @module tools/permissions
 * @dependencies ../path-utils.js, ./registry.js (dynamic import)
 * @dependents src/tools/base-tool.js, test/unit/base-tool.test.js, test/unit/permissions.test.js
 */

import { resolveJailedPath } from '../path-utils.js';

// Import registry functions lazily to avoid circular dependency
let _isReadOnlyCommand: ((cmd: string) => boolean) | null = null;
let _isDestructiveCommand: ((cmd: string) => boolean) | null = null;

async function getRegistryFunctions(): Promise<{
  isReadOnlyCommand: (cmd: string) => boolean;
  isDestructiveCommand: (cmd: string) => boolean;
}> {
  if (!_isReadOnlyCommand || !_isDestructiveCommand) {
    const registry = await import('./registry.js');
    _isReadOnlyCommand = registry.isReadOnlyCommand;
    _isDestructiveCommand = registry.isDestructiveCommand;
  }
  return { isReadOnlyCommand: _isReadOnlyCommand!, isDestructiveCommand: _isDestructiveCommand! };
}

// ============ Permission Results ============

export interface PermissionAllowResult {
  allowed: true;
}

export interface PermissionDenyResult {
  allowed: false;
  reason: string;
  details?: Record<string, unknown>;
  requiresApproval?: boolean;
}

export type PermissionCheckResult = PermissionAllowResult | PermissionDenyResult | null;

/**
 * Permission result builders.
 * Use these to return permission decisions.
 */
export const PermissionResult = {
  /**
   * Allow the operation.
   */
  allow(): PermissionAllowResult {
    return { allowed: true };
  },

  /**
   * Deny the operation.
   */
  deny(reason: string, details: Record<string, unknown> | null = null): PermissionDenyResult {
    return { allowed: false, reason, details: details || undefined };
  },

  /**
   * Ask user for approval.
   */
  ask(message: string, details: Record<string, unknown> | null = null): PermissionDenyResult {
    return {
      allowed: false,
      reason: message,
      details: details || undefined,
      requiresApproval: true,
    };
  },

  /**
   * Rule doesn't apply - continue to next rule.
   */
  skip(): null {
    return null;
  },
};

// ============ Permission Rule ============

export interface PermissionRuleOptions {
  priority?: number;
  name?: string;
}

export interface ToolContext {
  cwd?: string;
  [key: string]: unknown;
}

export type PermissionCheckFn = (input: Record<string, unknown>, context: ToolContext) => Promise<PermissionCheckResult> | PermissionCheckResult;

/**
 * Single permission rule with priority.
 *
 * Rules return:
 * - null: Rule doesn't apply, continue to next rule
 * - { allowed: true }: Allow operation
 * - { allowed: false, reason, details }: Deny operation
 * - { allowed: false, reason, details, requiresApproval }: Ask user
 */
export class PermissionRule {
  check: PermissionCheckFn;
  priority: number;
  name: string;

  /**
   * Create a permission rule.
   * @param check - Check function (input, context) => result
   * @param options - Rule options
   */
  constructor(check: PermissionCheckFn, options: PermissionRuleOptions = {}) {
    this.check = check;
    this.priority = options.priority ?? 100;
    this.name = options.name ?? 'unnamed';
  }

  /**
   * Evaluate this rule.
   */
  async evaluate(input: Record<string, unknown>, context: ToolContext): Promise<PermissionCheckResult> {
    try {
      return await this.check(input, context);
    } catch (error) {
      const err = error as Error;
      return PermissionResult.deny(
        `Permission check failed: ${err.message}`,
        { rule: this.name, error: err.message }
      );
    }
  }
}

// ============ Permission Composer ============

/**
 * Compose multiple permission rules.
 * Rules are evaluated in priority order (lower = earlier).
 * First non-null result wins.
 */
export class PermissionComposer {
  private rules: PermissionRule[] = [];

  /**
   * Add a permission rule.
   */
  addRule(rule: PermissionRule | PermissionCheckFn, options: PermissionRuleOptions = {}): this {
    if (rule instanceof PermissionRule) {
      // Merge options - allow overriding name and priority
      if (options.name) {
        rule.name = options.name;
      }
      if (options.priority !== undefined) {
        rule.priority = options.priority;
      }
      this.rules.push(rule);
    } else {
      this.rules.push(new PermissionRule(rule, options));
    }
    return this;
  }

  /**
   * Remove rules by name.
   */
  removeRule(name: string): this {
    this.rules = this.rules.filter(r => r.name !== name);
    return this;
  }

  /**
   * Clear all rules.
   */
  clearRules(): this {
    this.rules = [];
    return this;
  }

  /**
   * Check permissions by evaluating all rules.
   */
  async checkPermissions(input: Record<string, unknown>, context: ToolContext): Promise<PermissionAllowResult | PermissionDenyResult> {
    // Sort by priority (lower = earlier)
    const sorted = [...this.rules].sort((a, b) => a.priority - b.priority);

    for (const rule of sorted) {
      const result = await rule.evaluate(input, context);
      if (result !== null) {
        return result;
      }
    }

    // Default: allow if no rules apply
    return PermissionResult.allow();
  }

  /**
   * Get rule names for debugging.
   */
  getRuleNames(): string[] {
    return this.rules.map(r => r.name);
  }
}

// ============ Common Rules Factory ============

/**
 * Common permission rules.
 * Use these to build permission composers.
 */
export const PermissionRules = {
  /**
   * Rule that allows everything.
   */
  allowAll(): PermissionRule {
    return new PermissionRule(() => PermissionResult.allow(), { priority: 1000, name: 'allowAll' });
  },

  /**
   * Rule that denies everything.
   */
  denyAll(reason = 'Operation not allowed'): PermissionRule {
    return new PermissionRule(() => PermissionResult.deny(reason), { priority: 0, name: 'denyAll' });
  },

  /**
   * Require approval for operations matching a predicate.
   */
  requireApprovalIf(
    predicate: (input: Record<string, unknown>, context: ToolContext) => boolean,
    message: string
  ): PermissionRule {
    return new PermissionRule(
      (input, context) => {
        if (predicate(input, context)) {
          return PermissionResult.ask(message);
        }
        return PermissionResult.skip();
      },
      { priority: 100, name: 'requireApprovalIf' }
    );
  },

  /**
   * Deny operations matching a predicate.
   */
  denyIf(
    predicate: (input: Record<string, unknown>, context: ToolContext) => boolean,
    reason: string
  ): PermissionRule {
    return new PermissionRule(
      (input, context) => {
        if (predicate(input, context)) {
          return PermissionResult.deny(reason);
        }
        return PermissionResult.skip();
      },
      { priority: 50, name: 'denyIf' }
    );
  },

  /**
   * Jail path rule - ensure paths stay within jail directory.
   */
  jailPath(fieldName = 'path'): PermissionRule {
    return new PermissionRule(
      (input, context) => {
        const path = input[fieldName];
        if (typeof path !== 'string') return PermissionResult.skip();

        const cwd = (context.cwd as string) || process.cwd();
        try {
          resolveJailedPath(cwd, path);
          return PermissionResult.skip();
        } catch {
          return PermissionResult.deny(
            `Path escapes jail directory`,
            { path, jail: cwd }
          );
        }
      },
      { priority: 10, name: 'jailPath' }
    );
  },

  /**
   * Jail path rule with standard name.
   */
  withinJail(): PermissionRule {
    return new PermissionRule(
      (input, context) => {
        const path = (input.path || input.filePath || input.file) as string | undefined;
        if (typeof path !== 'string') return PermissionResult.skip();

        const cwd = (context.cwd as string) || process.cwd();
        try {
          resolveJailedPath(cwd, path);
          return PermissionResult.skip();
        } catch {
          return PermissionResult.deny(
            `Path escapes jail directory`,
            { path, jail: cwd }
          );
        }
      },
      { priority: 1, name: 'within-jail' }
    );
  },

  /**
   * Read-only mode rule - deny write operations when in read-only mode.
   */
  async readOnlyMode(): Promise<PermissionRule> {
    const { isReadOnlyCommand, isDestructiveCommand } = await getRegistryFunctions();

    return new PermissionRule(
      (input, context) => {
        const readOnly = context.readOnly;
        if (!readOnly) return PermissionResult.skip();

        // Check if this is a write/destructive operation
        const command = input.command as string | undefined;
        if (command) {
          if (isDestructiveCommand(command) || !isReadOnlyCommand(command)) {
            return PermissionResult.deny('Write operation blocked in read-only mode');
          }
        }

        // Check for write-like inputs
        if (input.content !== undefined || input.text !== undefined) {
          return PermissionResult.deny('Write operation blocked in read-only mode');
        }

        return PermissionResult.skip();
      },
      { priority: 5, name: 'readOnlyMode' }
    );
  },

  /**
   * Read-only mode rule with standard name.
   */
  readOnly(): PermissionRule {
    return new PermissionRule(
      (input, context) => {
        const readOnly = context.readOnlyMode;
        if (!readOnly) return PermissionResult.skip();

        // Check for write-like inputs
        if (input.content !== undefined || input.text !== undefined || input.command) {
          return PermissionResult.deny('Write operation blocked in read-only mode');
        }

        return PermissionResult.skip();
      },
      { priority: 5, name: 'read-only' }
    );
  },

  /**
   * Destructive command rule - require approval for destructive commands.
   */
  async destructiveCommand(): Promise<PermissionRule> {
    const { isDestructiveCommand } = await getRegistryFunctions();

    return new PermissionRule(
      (input) => {
        const command = input.command as string | undefined;
        if (!command) return PermissionResult.skip();

        if (isDestructiveCommand(command)) {
          return PermissionResult.ask(
            `This command may be destructive: "${command.slice(0, 50)}..."`,
            { command }
          );
        }

        return PermissionResult.skip();
      },
      { priority: 50, name: 'destructiveCommand' }
    );
  },

  /**
   * Ask destructive rule with standard name.
   */
  askDestructive(): PermissionRule {
    return new PermissionRule(
      (input) => {
        const command = input.command as string | undefined;
        if (!command) return PermissionResult.skip();

        // Simple heuristic for destructive commands
        const destructivePatterns = [
          /rm\s+-rf/i,
          /rm\s+-r/i,
          /delete/i,
          /drop\s+table/i,
          /truncate/i,
          /format/i,
        ];

        for (const pattern of destructivePatterns) {
          if (pattern.test(command)) {
            return PermissionResult.ask(
              `This command may be destructive: "${command.slice(0, 50)}..."`,
              { command }
            );
          }
        }

        return PermissionResult.skip();
      },
      { priority: 50, name: 'ask-destructive' }
    );
  },

  /**
   * Sensitive file rule - deny access to sensitive files.
   */
  sensitiveFiles(): PermissionRule {
    const SENSITIVE_PATTERNS = [
      /\.env$/i,
      /\.env\./i,
      /credentials/i,
      /secrets?\.json$/i,
      /\.pem$/i,
      /\.key$/i,
      /id_rsa/i,
      /\.ssh\//i,
    ];

    return new PermissionRule(
      (input) => {
        const path = (input.path || input.filePath || input.file) as string | undefined;
        if (!path) return PermissionResult.skip();

        for (const pattern of SENSITIVE_PATTERNS) {
          if (pattern.test(path)) {
            return PermissionResult.deny(
              `Access to sensitive file blocked`,
              { path, pattern: pattern.source }
            );
          }
        }

        return PermissionResult.skip();
      },
      { priority: 20, name: 'sensitiveFiles' }
    );
  },

  /**
   * Ask for sensitive files.
   */
  askSensitive(): PermissionRule {
    const SENSITIVE_PATTERNS = [
      /\.env$/i,
      /\.env\./i,
      /credentials/i,
      /secrets?\.json$/i,
      /\.pem$/i,
      /\.key$/i,
      /id_rsa/i,
      /\.ssh\//i,
    ];

    return new PermissionRule(
      (input) => {
        const path = (input.path || input.filePath || input.file) as string | undefined;
        if (!path) return PermissionResult.skip();

        for (const pattern of SENSITIVE_PATTERNS) {
          if (pattern.test(path)) {
            return PermissionResult.ask(
              `This file may contain sensitive information`,
              { path, pattern: pattern.source }
            );
          }
        }

        return PermissionResult.skip();
      },
      { priority: 20, name: 'ask-sensitive' }
    );
  },

  /**
   * Deny sensitive files with standard name.
   */
  denySensitive(): PermissionRule {
    const SENSITIVE_PATTERNS = [
      /\.env$/i,
      /\.env\./i,
      /credentials/i,
      /secrets?\.json$/i,
      /\.pem$/i,
      /\.key$/i,
      /id_rsa/i,
      /\.ssh\//i,
    ];

    return new PermissionRule(
      (input) => {
        const path = (input.path || input.filePath || input.file) as string | undefined;
        if (!path) return PermissionResult.skip();

        for (const pattern of SENSITIVE_PATTERNS) {
          if (pattern.test(path)) {
            return PermissionResult.deny(
              `Access to sensitive file blocked`,
              { path, pattern: pattern.source }
            );
          }
        }

        return PermissionResult.skip();
      },
      { priority: 20, name: 'deny-sensitive' }
    );
  },

  /**
   * Block dangerous commands.
   */
  blockCommands(): PermissionRule {
    return new PermissionRule(
      (input) => {
        const command = input.command as string | undefined;
        if (!command) return PermissionResult.skip();

        const BLOCKED_PATTERNS = [
          /^rm\s+-rf\s+\//i,
          /^rm\s+-rf\s+~/i,
          /^format\s+/i,
          /^del\s+\/s/i,
          /^sudo\s+rm\s+/i,
          /^:\(\)\{.*:\(\);\}/i, // Fork bomb
          /^>\s*\/dev\/sd/i,
        ];

        for (const pattern of BLOCKED_PATTERNS) {
          if (pattern.test(command)) {
            return PermissionResult.deny('Dangerous command blocked', { command });
          }
        }

        return PermissionResult.skip();
      },
      { priority: 1, name: 'block-commands' }
    );
  },

  /**
   * Only allow specific tools.
   */
  onlyTools(options: { allowed: Set<string> }): PermissionRule {
    return new PermissionRule(
      (input, context) => {
        const toolName = context.toolName as string | undefined;
        if (!toolName) return PermissionResult.skip();

        if (!options.allowed.has(toolName)) {
          return PermissionResult.deny(
            `Tool "${toolName}" is not allowed`,
            { toolName, allowed: Array.from(options.allowed) }
          );
        }

        return PermissionResult.skip();
      },
      { priority: 100, name: 'onlyTools' }
    );
  },
};

// ============ Standard Permissions Factory ============

export interface StandardPermissionsOptions {
  enforceJail?: boolean;
  askSensitive?: boolean;
  denySensitive?: boolean;
  readOnly?: boolean;
  askDestructive?: boolean;
  blockCommands?: boolean;
}

/**
 * Create a standard permission composer with common rules.
 * 
 * Options:
 * - enforceJail: Add jail path rule (default: true)
 * - askSensitive: Ask for sensitive files (default: true)
 * - denySensitive: Deny sensitive files (default: false)
 * - readOnly: Enable read-only mode (default: false)
 * - askDestructive: Ask for destructive commands (default: true)
 * - blockCommands: Block dangerous commands (default: true)
 */
export function createStandardPermissions(options: StandardPermissionsOptions = {}): PermissionComposer {
  const {
    enforceJail = true,
    askSensitive = true,
    denySensitive: denySensitiveOpt = false,
    readOnly = false,
    askDestructive = true,
    blockCommands = true,
  } = options;

  const composer = new PermissionComposer();

  if (enforceJail) {
    composer.addRule(PermissionRules.withinJail(), { name: 'within-jail' });
  }

  if (denySensitiveOpt) {
    composer.addRule(PermissionRules.denySensitive(), { name: 'deny-sensitive' });
  } else if (askSensitive) {
    composer.addRule(PermissionRules.askSensitive(), { name: 'ask-sensitive' });
  }

  if (readOnly) {
    composer.addRule(PermissionRules.readOnly(), { name: 'read-only' });
  }

  if (askDestructive) {
    composer.addRule(PermissionRules.askDestructive(), { name: 'ask-destructive' });
  }

  if (blockCommands) {
    composer.addRule(PermissionRules.blockCommands(), { name: 'block-commands' });
  }

  return composer;
}