/**
 * Base class for tools with template method pattern.
 *
 * Provides consistent behavior across all tools:
 * - Input validation with JSON schema
 * - Permission checking before execution
 * - Input sanitization
 * - Standardized error handling
 * - Logging and progress reporting
 *
 * @module tools/base-tool
 */

import { ToolError, ToolErrorCode, errorToResult } from './errors.js';

export interface ToolConfig {
  name: string;
  description: string;
  parameters?: ToolParameters;
  category?: string;
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

export interface ToolContext {
  cwd?: string;
  eventEmitter?: unknown;
  allowedTools?: Set<string>;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ToolResult {
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Base class for tools implementing the template method pattern.
 *
 * Subclasses should:
 * 1. Implement executeImpl() for core logic
 * 2. Override checkPermissions() for custom permission logic
 * 3. Override sanitizeInput() for input normalization
 * 4. Override isReadOnly(), isDestructive(), isConcurrencySafe() for safety properties
 */
export class BaseTool {
  name: string;
  description: string;
  parameters: ToolParameters;
  category: string;

  /**
   * Create a BaseTool.
   */
  constructor(config: ToolConfig) {
    this.name = config.name;
    this.description = config.description;
    this.parameters = config.parameters || { type: 'object', properties: {} };
    this.category = config.category || 'other';
  }

  /**
   * Get the JSON schema for input validation.
   */
  getSchema(): ToolParameters | null {
    return this.parameters;
  }

  /**
   * Check permissions before execution.
   * Override for custom permission logic.
   */
  async checkPermissions(_input: Record<string, unknown>, _context: ToolContext): Promise<PermissionResult | null> {
    return null; // No permission check by default
  }

  /**
   * Sanitize input after permission check.
   */
  async sanitizeInput(input: Record<string, unknown>, _context: ToolContext): Promise<Record<string, unknown>> {
    return input;
  }

  /**
   * Core implementation. Must be implemented by subclass.
   */
  async executeImpl(_input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    throw new ToolError(
      ToolErrorCode.NOT_IMPLEMENTED,
      `Tool ${this.name} not implemented`
    );
  }

  /**
   * Check if operation is read-only based on input.
   */
  isReadOnly(_input: Record<string, unknown>): boolean {
    return false;
  }

  /**
   * Check if operation is destructive based on input.
   */
  isDestructive(_input: Record<string, unknown>): boolean {
    return false;
  }

  /**
   * Check if operation is concurrency-safe based on input.
   */
  isConcurrencySafe(input: Record<string, unknown>): boolean {
    // Default: read-only operations are concurrency-safe
    return this.isReadOnly(input);
  }

  /**
   * Get maximum result size for this tool.
   */
  getMaxResultSize(): number {
    return Infinity;
  }

  /**
   * Final execute method - template method that orchestrates the flow.
   * DO NOT OVERRIDE - use executeImpl() instead.
   */
  async execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    try {
      // 1. Validate input against schema
      const schema = this.getSchema();
      if (schema && Object.keys(schema.properties || {}).length > 0) {
        const { validateToolArgs } = await import('./registry.js');
        const validation = validateToolArgs(this.name, input, schema) as ValidationResult;
        if (!validation.valid) {
          return {
            error: {
              code: ToolErrorCode.VALIDATION_FAILED,
              message: `Validation failed: ${(validation.errors || []).join(', ')}`,
              details: { errors: validation.errors }
            }
          };
        }
      }

      // 2. Check permissions
      const permResult = await this.checkPermissions(input, context);
      if (permResult && !permResult.allowed) {
        return {
          error: {
            code: ToolErrorCode.PERMISSION_DENIED,
            message: permResult.reason || 'Permission denied',
            details: permResult.details
          }
        };
      }

      // 3. Sanitize input
      const sanitizedInput = await this.sanitizeInput(input, context);

      // 4. Execute implementation
      const result = await this.executeImpl(sanitizedInput, context);

      // 5. Return result
      return result;

    } catch (error) {
      // Convert error to standardized result
      return errorToResult(error);
    }
  }

  /**
   * Convert tool to registry format.
   */
  toRegistration(): {
    description: string;
    parameters: ToolParameters;
    execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
    category: string;
    isReadOnly: (input: Record<string, unknown>) => boolean;
    isDestructive: (input: Record<string, unknown>) => boolean;
    isConcurrencySafe: (input: Record<string, unknown>) => boolean;
    getMaxResultSize: () => number;
  } {
    return {
      description: this.description,
      parameters: this.parameters,
      execute: (args: Record<string, unknown>, context: ToolContext) => this.execute(args, context),
      category: this.category,
      isReadOnly: (input: Record<string, unknown>) => this.isReadOnly(input),
      isDestructive: (input: Record<string, unknown>) => this.isDestructive(input),
      isConcurrencySafe: (input: Record<string, unknown>) => this.isConcurrencySafe(input),
      getMaxResultSize: () => this.getMaxResultSize(),
    };
  }

  /**
   * Register this tool with the registry.
   */
  register(registry: { register: (name: string, def: unknown) => void }): void {
    registry.register(this.name, this.toRegistration());
  }
}

/**
 * Create a simple tool from a function.
 */
export function createTool(
  name: string,
  description: string,
  parameters: ToolParameters,
  executeFn: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>,
  options: {
    category?: string;
    isReadOnly?: (input: Record<string, unknown>) => boolean;
    isDestructive?: (input: Record<string, unknown>) => boolean;
    isConcurrencySafe?: (input: Record<string, unknown>) => boolean;
  } = {}
): BaseTool {
  const config: ToolConfig = {
    name,
    description,
    parameters,
    category: options.category || 'other'
  };

  class SimpleTool extends BaseTool {
    constructor() {
      super(config);
    }

    async executeImpl(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      return executeFn(input, context);
    }

    isReadOnly(input: Record<string, unknown>): boolean {
      return options.isReadOnly ? options.isReadOnly(input) : super.isReadOnly(input);
    }

    isDestructive(input: Record<string, unknown>): boolean {
      return options.isDestructive ? options.isDestructive(input) : super.isDestructive(input);
    }

    isConcurrencySafe(input: Record<string, unknown>): boolean {
      return options.isConcurrencySafe
        ? options.isConcurrencySafe(input)
        : super.isConcurrencySafe(input);
    }
  }

  return new SimpleTool();
}

export default BaseTool;