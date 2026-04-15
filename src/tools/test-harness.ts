/**
 * Testing harness for tools with fluent API.
 *
 * Provides utilities for testing tools:
 * - Mock context and filesystem
 * - Fluent assertions
 * - Error code matching
 *
 * Key exports:
 *   - ToolTestHarness: Main test harness class
 *   - createTestHarness(ToolClass, options): Factory function
 *   - withFile(path, content): Add mock file
 *   - expectSuccess(args): Assert tool succeeds
 *   - expectError(args, code): Assert tool fails with code
 *
 * @file-doc
 * @module tools/test-harness
 * @dependencies ./registry.js
 * @dependents test/unit/base-tool.test.js
 */

import type { BaseTool } from './base-tool.js';

interface ToolContext {
  cwd?: string;
  eventEmitter?: NodeJS.EventEmitter | null;
  allowedTools?: Set<string> | null;
}

interface HarnessOptions {
  toolConfig?: Record<string, unknown>;
  defaultContext?: Partial<ToolContext>;
}

interface ToolResult {
  [key: string]: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  } | string;
}

interface ToolConstructor {
  new (config?: Record<string, unknown>): BaseTool;
}

/**
 * Test harness for tools with fluent API.
 */
export class ToolTestHarness {
  private ToolClass: ToolConstructor;
  private options: HarnessOptions;
  private context: ToolContext;
  private files: Map<string, string>;
  private tool: BaseTool | null;

  /**
   * Create a test harness.
   */
  constructor(ToolClass: ToolConstructor, options: HarnessOptions = {}) {
    this.ToolClass = ToolClass;
    this.options = options;
    this.context = {
      cwd: '/test',
      eventEmitter: null,
      allowedTools: null,
      ...options.defaultContext
    };
    this.files = new Map();
    this.tool = null;
  }

  /**
   * Set execution context.
   */
  withContext(partial: Partial<ToolContext>): this {
    this.context = { ...this.context, ...partial };
    return this;
  }

  /**
   * Set jail directory.
   */
  withJail(jail: string): this {
    this.context.cwd = jail;
    return this;
  }

  /**
   * Set event emitter for progress.
   */
  withEmitter(emitter: NodeJS.EventEmitter): this {
    this.context.eventEmitter = emitter;
    return this;
  }

  /**
   * Set allowed tools for sub-agents.
   */
  withAllowedTools(tools: string[]): this {
    this.context.allowedTools = new Set(tools);
    return this;
  }

  /**
   * Mock a file in the virtual filesystem.
   */
  withFile(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  /**
   * Mock multiple files.
   */
  withFiles(files: Record<string, string>): this {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, content);
    }
    return this;
  }

  /**
   * Build the tool instance.
   */
  build(): BaseTool {
    this.tool = new this.ToolClass(this.options.toolConfig);
    return this.tool;
  }

  /**
   * Execute the tool with current context.
   */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    if (!this.tool) {
      this.build();
    }

    // Note: For actual file operations, you'd need to mock fs
    // This is a simplified version for testing tool logic

    return this.tool.execute(input, this.context) as Promise<ToolResult>;
  }

  /**
   * Execute and expect success.
   */
  async expectSuccess(input: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.execute(input);
    if (result.error) {
      const message = typeof result.error === 'object' && result.error.message
        ? result.error.message
        : JSON.stringify(result.error);
      throw new Error(`Expected success but got error: ${message}`);
    }
    return result;
  }

  /**
   * Execute and expect a specific error code.
   */
  async expectError(input: Record<string, unknown>, expectedCode: string): Promise<ToolResult> {
    const result = await this.execute(input);
    if (!result.error) {
      throw new Error(`Expected error ${expectedCode} but operation succeeded`);
    }
    const code = typeof result.error === 'object' && result.error.code
      ? result.error.code
      : result.error;
    if (code !== expectedCode) {
      const message = typeof result.error === 'object' && result.error.message
        ? result.error.message
        : String(result.error);
      throw new Error(
        `Expected error code ${expectedCode} but got ${code}: ${message}`
      );
    }
    return result;
  }

  /**
   * Execute and expect error contains message.
   */
  async expectErrorMessage(input: Record<string, unknown>, messagePart: string): Promise<ToolResult> {
    const result = await this.execute(input);
    if (!result.error) {
      throw new Error(`Expected error containing "${messagePart}" but operation succeeded`);
    }
    const message = typeof result.error === 'object' && result.error.message
      ? result.error.message
      : String(result.error);
    if (!message.includes(messagePart)) {
      throw new Error(
        `Expected error containing "${messagePart}" but got: ${message}`
      );
    }
    return result;
  }

  /**
   * Execute and expect permission request.
   */
  async expectPermissionRequest(input: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.execute(input);
    if (!result.error || !(typeof result.error === 'object' && result.error.details?.requiresApproval)) {
      throw new Error('Expected permission request but got immediate result');
    }
    return result;
  }

  /**
   * Execute and expect result has specific property.
   */
  async expectProperty(input: Record<string, unknown>, property: string): Promise<ToolResult> {
    const result = await this.execute(input);
    if (result.error) {
      const message = typeof result.error === 'object' && result.error.message
        ? result.error.message
        : String(result.error);
      throw new Error(`Expected property ${property} but got error: ${message}`);
    }
    if (!(property in result)) {
      throw new Error(`Result missing property: ${property}`);
    }
    return result;
  }

  /**
   * Reset harness state.
   */
  reset(): this {
    this.context = {
      cwd: '/test',
      eventEmitter: null,
      allowedTools: null,
      ...this.options.defaultContext
    };
    this.files.clear();
    this.tool = null;
    return this;
  }

  /**
   * Create a snapshot of current state.
   */
  snapshot(): { context: ToolContext; files: Map<string, string>; tool: BaseTool | null } {
    return {
      context: { ...this.context },
      files: new Map(this.files),
      tool: this.tool
    };
  }

  /**
   * Restore from snapshot.
   */
  restore(snapshot: { context: ToolContext; files: Map<string, string>; tool: BaseTool | null }): this {
    this.context = snapshot.context;
    this.files = snapshot.files;
    this.tool = snapshot.tool;
    return this;
  }
}

/**
 * Create a test harness for a tool.
 */
export function createTestHarness(ToolClass: ToolConstructor, options: HarnessOptions = {}): ToolTestHarness {
  return new ToolTestHarness(ToolClass, options);
}

/**
 * Assert helper for tool results.
 */
export const Assert = {
  /**
   * Assert result is successful.
   */
  success(result: ToolResult): void {
    if (result.error) {
      const message = typeof result.error === 'object' && result.error.message
        ? result.error.message
        : String(result.error);
      throw new Error(`Expected success but got error: ${message}`);
    }
  },

  /**
   * Assert result has error.
   */
  error(result: ToolResult, code: string | null = null): void {
    if (!result.error) {
      throw new Error('Expected error but operation succeeded');
    }
    if (code && typeof result.error === 'object' && result.error.code !== code) {
      throw new Error(
        `Expected error code ${code} but got ${result.error.code}: ${result.error.message}`
      );
    }
  },

  /**
   * Assert result has property.
   */
  hasProperty(result: ToolResult, property: string): void {
    if (result.error) {
      const message = typeof result.error === 'object' && result.error.message
        ? result.error.message
        : String(result.error);
      throw new Error(`Expected property ${property} but got error: ${message}`);
    }
    if (!(property in result)) {
      throw new Error(`Result missing property: ${property}`);
    }
  },

  /**
   * Assert result matches expected shape.
   */
  matches(result: ToolResult, expected: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in result)) {
        throw new Error(`Result missing property: ${key}`);
      }
      if (result[key] !== value) {
        throw new Error(`Result.${key} expected ${value} but got ${result[key]}`);
      }
    }
  }
};