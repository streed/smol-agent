/**
 * Unit tests for BaseTool class.
 *
 * Tests:
 * - Tool creation and configuration
 * - Template method execution flow
 * - Input validation
 * - Permission checking
 * - Error handling
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { BaseTool, createTool } from '../../src/tools/base-tool.js';
import { ToolError, ToolErrorCode } from '../../src/tools/errors.js';

describe('BaseTool', () => {
  class TestTool extends BaseTool {
    constructor() {
      super({
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message to echo' }
          },
          required: ['message']
        },
        category: 'test'
      });
    }

    async executeImpl(input, _context) {
      return { result: input.message.toUpperCase() };
    }

    isReadOnly(_input) {
      return true;
    }
  }

  let tool;
  let context;

  beforeEach(() => {
    tool = new TestTool();
    context = { cwd: '/test' };
  });

  describe('constructor', () => {
    test('creates tool with name and description', () => {
      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.category).toBe('test');
    });

    test('defaults category to "other"', () => {
      const defaultTool = new (class extends BaseTool {
        constructor() {
          super({ name: 'default', description: 'Default tool' });
        }
        async executeImpl() { return {}; }
      })();
      expect(defaultTool.category).toBe('other');
    });
  });

  describe('execute', () => {
    test('validates input against schema', async () => {
      const result = await tool.execute({}, context);
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(ToolErrorCode.VALIDATION_FAILED);
    });

    test('executes successfully with valid input', async () => {
      const result = await tool.execute({ message: 'hello' }, context);
      expect(result.error).toBeUndefined();
      expect(result.result).toBe('HELLO');
    });

    test('handles errors from executeImpl', async () => {
      class FailingTool extends BaseTool {
        constructor() {
          super({ name: 'fail', description: 'Fails' });
        }
        async executeImpl() {
          throw new ToolError(ToolErrorCode.EXECUTION_FAILED, 'Something went wrong');
        }
      }

      const failingTool = new FailingTool();
      const result = await failingTool.execute({}, context);
      expect(result.error.code).toBe(ToolErrorCode.EXECUTION_FAILED);
      expect(result.error.message).toBe('Something went wrong');
    });

    test('converts regular errors to EXECUTION_FAILED', async () => {
      class ErrorTool extends BaseTool {
        constructor() {
          super({ name: 'error', description: 'Throws error' });
        }
        async executeImpl() {
          throw new Error('Unexpected error');
        }
      }

      const errorTool = new ErrorTool();
      const result = await errorTool.execute({}, context);
      expect(result.error.code).toBe(ToolErrorCode.EXECUTION_FAILED);
      expect(result.error.message).toBe('Unexpected error');
    });
  });

  describe('checkPermissions', () => {
    test('returns null by default (no permission check)', async () => {
      const permResult = await tool.checkPermissions({ message: 'test' }, context);
      expect(permResult).toBeNull();
    });
  });

  describe('sanitizeInput', () => {
    test('returns input unchanged by default', async () => {
      const input = { message: 'test' };
      const sanitized = await tool.sanitizeInput(input, context);
      expect(sanitized).toEqual(input);
    });
  });

  describe('isReadOnly', () => {
    test('returns false by default', () => {
      class DefaultTool extends BaseTool {
        constructor() {
          super({ name: 'default', description: 'Default' });
        }
        async executeImpl() { return {}; }
      }
      const defaultTool = new DefaultTool();
      expect(defaultTool.isReadOnly({})).toBe(false);
    });

    test('can be overridden', () => {
      expect(tool.isReadOnly({})).toBe(true);
    });
  });

  describe('isDestructive', () => {
    test('returns false by default', () => {
      expect(tool.isDestructive({})).toBe(false);
    });
  });

  describe('isConcurrencySafe', () => {
    test('returns true for read-only tools', () => {
      expect(tool.isConcurrencySafe({})).toBe(true);
    });

    test('returns false for non-read-only tools', () => {
      class WriteTool extends BaseTool {
        constructor() {
          super({ name: 'write', description: 'Write tool' });
        }
        async executeImpl() { return {}; }
        isReadOnly() { return false; }
      }
      const writeTool = new WriteTool();
      expect(writeTool.isConcurrencySafe({})).toBe(false);
    });
  });

  describe('toRegistration', () => {
    test('returns registration object', () => {
      const reg = tool.toRegistration();
      expect(reg.description).toBe('A test tool');
      expect(reg.parameters).toEqual(tool.parameters);
      expect(typeof reg.execute).toBe('function');
      expect(typeof reg.isReadOnly).toBe('function');
      expect(reg.category).toBe('test');
    });
  });
});

describe('createTool', () => {
  test('creates simple tool from function', async () => {
    const echoTool = createTool(
      'echo',
      'Echo input back',
      {
        type: 'object',
        properties: {
          message: { type: 'string' }
        },
        required: ['message']
      },
      async (input, _context) => ({ echoed: input.message }),
      { category: 'utility' }
    );

    expect(echoTool.name).toBe('echo');
    expect(echoTool.category).toBe('utility');

    const result = await echoTool.execute({ message: 'hello' }, { cwd: '/test' });
    expect(result.echoed).toBe('hello');
  });

  test('supports isReadOnly option', () => {
    const readOnlyTool = createTool(
      'read',
      'Read only',
      {},
      async () => ({}),
      { category: 'read', isReadOnly: () => true }
    );

    expect(readOnlyTool.isReadOnly({})).toBe(true);
  });

  test('supports isDestructive option', () => {
    const destructiveTool = createTool(
      'delete',
      'Delete files',
      {},
      async () => ({}),
      { category: 'edit', isDestructive: () => true }
    );

    expect(destructiveTool.isDestructive({})).toBe(true);
  });

  test('validates input', async () => {
    const tool = createTool(
      'needs_input',
      'Needs input',
      {
        type: 'object',
        properties: {
          value: { type: 'number' }
        },
        required: ['value']
      },
      async (input) => ({ doubled: input.value * 2 })
    );

    const result = await tool.execute({}, { cwd: '/test' });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(ToolErrorCode.VALIDATION_FAILED);
  });
});

describe('BaseTool with permissions', () => {
  class PermissionCheckingTool extends BaseTool {
    constructor() {
      super({
        name: 'protected_tool',
        description: 'Tool with permission check',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string' }
          },
          required: ['file']
        }
      });
    }

    async checkPermissions(input, _context) {
      if (input.file.includes('..')) {
        return {
          allowed: false,
          reason: 'Path traversal detected',
          details: { path: input.file }
        };
      }
      return null; // Allow
    }

    async executeImpl(input, _context) {
      return { content: `File: ${input.file}` };
    }
  }

  test('denies execution when permission check fails', async () => {
    const tool = new PermissionCheckingTool();
    const result = await tool.execute({ file: '../../../etc/passwd' }, { cwd: '/test' });

    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(ToolErrorCode.PERMISSION_DENIED);
    expect(result.error.message).toContain('Path traversal');
  });

  test('allows execution when permission check passes', async () => {
    const tool = new PermissionCheckingTool();
    const result = await tool.execute({ file: 'safe.txt' }, { cwd: '/test' });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain('safe.txt');
  });
});

describe('BaseTool with input sanitization', () => {
  class SanitizingTool extends BaseTool {
    constructor() {
      super({
        name: 'sanitize_tool',
        description: 'Tool with input sanitization',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          },
          required: ['path']
        }
      });
    }

    async sanitizeInput(input, context) {
      // Resolve relative paths
      if (input.path.startsWith('.')) {
        return { ...input, path: `${context.cwd}/${input.path}` };
      }
      return input;
    }

    async executeImpl(input, _context) {
      return { resolved: input.path };
    }
  }

  test('sanitizes input before execution', async () => {
    const tool = new SanitizingTool();
    const result = await tool.execute({ path: './file.txt' }, { cwd: '/home/user' });

    expect(result.resolved).toBe('/home/user/./file.txt');
  });
});