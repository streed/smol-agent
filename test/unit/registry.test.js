/**
 * Unit tests for tool registry module
 * Tests tool registration, validation, and execution
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import registry, {
  getStarterGroups,
  getToolGroups,
  getInactiveGroups,
  getToolsForGroups,
  describeInactiveGroups,
} from '../../src/tools/registry.js';

// Reset registry state between tests
function setupRegistry() {
  // Registry is a singleton, so we can't fully reset it
  // Instead we use unique tool names for testing
  const prefix = `test_${Date.now()}_`;
  return prefix;
}

describe('register and list', () => {
  let prefix;

  beforeEach(() => {
    prefix = setupRegistry();
  });

  test('registers a tool and lists it', () => {
    const name = `${prefix}echo`;
    registry.register(name, {
      description: 'Echo test tool',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' }
        }
      },
      execute: async (args) => args.message
    });

    const tools = registry.list();
    expect(tools).toContain(name);
  });

  test('registers core tools', () => {
    const name = `${prefix}core_tool`;
    registry.register(name, {
      description: 'Core tool',
      parameters: {},
      execute: async () => 'ok',
      core: true
    });

    const ollamaTools = registry.ollamaTools(true);
    const names = ollamaTools.map(t => t.function.name);
    expect(names).toContain(name);
  });

  test('registers extended tools (non-core)', () => {
    const name = `${prefix}extended_tool`;
    registry.register(name, {
      description: 'Extended tool',
      parameters: {},
      execute: async () => 'ok',
      core: false
    });

    const ollamaTools = registry.ollamaTools(true);
    const names = ollamaTools.map(t => t.function.name);
    expect(names).not.toContain(name);
  });
});

describe('validateToolArgs', () => {
  test('validates required arguments', () => {
    const result = registry.validateToolArgs('test', {}, { required: ['foo'] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Missing required argument: foo');
  });

  test('passes with all required args', () => {
    const result = registry.validateToolArgs('test',
      { foo: 'bar' },
      { required: ['foo'], properties: { foo: { type: 'string' } } }
    );
    expect(result.valid).toBe(true);
  });

  test('validates grep regex pattern', () => {
    const result = registry.validateToolArgs('grep',
      { pattern: '[invalid(regex' },
      { properties: { pattern: { type: 'string' } } }
    );
    expect(result.valid).toBe(false);
  });

  test('validates run_command length', () => {
    const longCmd = 'x'.repeat(10001);
    const result = registry.validateToolArgs('run_command',
      { command: longCmd },
      { properties: { command: { type: 'string' } } }
    );
    expect(result.valid).toBe(false);
  });

  test('rejects non-object args', () => {
    const result = registry.validateToolArgs('test', null, {});
    expect(result.valid).toBe(false);
  });
});

describe('validateFilePath', () => {
  test('rejects non-string paths', () => {
    const result = registry.validateFilePath(123, '/base');
    expect(result.valid).toBe(false);
  });

  test('rejects null bytes in path', () => {
    const result = registry.validateFilePath('file\0.txt', '/base');
    expect(result.valid).toBe(false);
  });

  test('rejects path traversal', () => {
    const result = registry.validateFilePath('../escape.txt', '/base');
    expect(result.valid).toBe(false);
  });

  test('accepts valid relative paths', () => {
    const result = registry.validateFilePath('subdir/file.txt', '/base');
    expect(result.valid).toBe(true);
  });
});

describe('execute', () => {
  let prefix;

  beforeEach(() => {
    prefix = setupRegistry();
  });

  test('executes a registered tool', async () => {
    const name = `${prefix}add`;
    registry.register(name, {
      description: 'Add two numbers',
      parameters: {
        type: 'object',
        required: ['a', 'b'],
        properties: {
          a: { type: 'number' },
          b: { type: 'number' }
        }
      },
      execute: async ({ a, b }) => ({ result: a + b })
    });

    const result = await registry.execute(name, { a: 2, b: 3 });
    expect(result.result).toBe(5);
  });

  test('returns error for unknown tool', async () => {
    const result = await registry.execute('nonexistent_tool_xyz', {});
    expect(result.error).toContain('Unknown tool');
  });

  test('returns error for invalid args', async () => {
    const name = `${prefix}needs_arg`;
    registry.register(name, {
      description: 'Needs arg',
      parameters: {
        type: 'object',
        required: ['requiredArg'],
        properties: {
          requiredArg: { type: 'string' }
        }
      },
      execute: async () => 'ok'
    });

    const result = await registry.execute(name, {});
    expect(result.error).toContain('Missing required argument');
  });
});

describe('requiresApproval', () => {
  test('write_file requires approval', () => {
    expect(registry.requiresApproval('write_file')).toBe(true);
  });

  test('replace_in_file requires approval', () => {
    expect(registry.requiresApproval('replace_in_file')).toBe(true);
  });

  test('run_command requires approval', () => {
    expect(registry.requiresApproval('run_command')).toBe(true);
  });

  test('read_file does not require approval', () => {
    expect(registry.requiresApproval('read_file')).toBe(false);
  });
});

// ── Progressive Tool Discovery ──────────────────────────────────────

describe('progressive discovery: tool groups', () => {
  test('getStarterGroups returns expected starter groups', () => {
    const starters = getStarterGroups();
    expect(starters).toContain('explore');
    expect(starters).toContain('edit');
    expect(starters).toContain('execute');
    expect(starters).not.toContain('plan');
    expect(starters).not.toContain('web');
  });

  test('getToolGroups returns all group definitions', () => {
    const groups = getToolGroups();
    expect(groups).toHaveProperty('explore');
    expect(groups).toHaveProperty('edit');
    expect(groups).toHaveProperty('execute');
    expect(groups).toHaveProperty('plan');
    expect(groups).toHaveProperty('memory');
    expect(groups).toHaveProperty('web');
    expect(groups).toHaveProperty('multi_agent');

    // Each group has tools array and description
    for (const [, group] of Object.entries(groups)) {
      expect(Array.isArray(group.tools)).toBe(true);
      expect(group.tools.length).toBeGreaterThan(0);
      expect(typeof group.description).toBe('string');
    }
  });

  test('getInactiveGroups returns groups not in active set', () => {
    const active = new Set(['explore', 'edit', 'execute']);
    const inactive = getInactiveGroups(active);
    expect(inactive).toContain('plan');
    expect(inactive).toContain('memory');
    expect(inactive).toContain('web');
    expect(inactive).toContain('multi_agent');
    expect(inactive).not.toContain('explore');
    expect(inactive).not.toContain('edit');
  });

  test('getToolsForGroups returns only tools from active groups', () => {
    // Register some test tools that match group definitions
    const groups = getToolGroups();
    const exploreTool = groups.explore.tools[0]; // e.g. "read_file"
    const editTool = groups.edit.tools[0];       // e.g. "write_file"

    // These tools may already be registered by other imports, or may not be.
    // Register them explicitly for this test.
    registry.register(exploreTool, {
      description: 'test explore tool', parameters: {}, execute: async () => 'ok',
    });
    registry.register(editTool, {
      description: 'test edit tool', parameters: {}, execute: async () => 'ok',
    });

    const active = new Set(['explore']);
    const tools = getToolsForGroups(active);
    const names = tools.map(t => t.function.name);

    // Should include explore tools, not edit tools
    expect(names).toContain(exploreTool);
    expect(names).not.toContain(editTool);
  });

  test('getToolsForGroups includes ungrouped tools when flag is set', () => {
    const active = new Set(['explore']);
    const withUngrouped = getToolsForGroups(active, true);
    const withoutUngrouped = getToolsForGroups(active, false);

    // Ungrouped tools should make the list longer
    expect(withUngrouped.length).toBeGreaterThanOrEqual(withoutUngrouped.length);
  });

  test('describeInactiveGroups generates description for inactive groups', () => {
    const active = new Set(['explore', 'edit', 'execute']);
    const desc = describeInactiveGroups(active);

    expect(desc).toContain('plan');
    expect(desc).toContain('memory');
    expect(desc).toContain('web');
    expect(desc).toContain('multi_agent');
    expect(desc).not.toContain('explore');
  });

  test('describeInactiveGroups returns empty when all groups active', () => {
    const allGroups = Object.keys(getToolGroups());
    const active = new Set(allGroups);
    const desc = describeInactiveGroups(active);
    expect(desc).toBe('');
  });
});

describe('ollamaTools format', () => {
  let prefix;

  beforeEach(() => {
    prefix = setupRegistry();
  });

  test('returns tools in Ollama format', () => {
    const name = `${prefix}format_test`;
    registry.register(name, {
      description: 'Format test',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input value' }
        }
      },
      execute: async () => 'ok'
    });

    const tools = registry.ollamaTools(false);
    const tool = tools.find(t => t.function.name === name);

    expect(tool).toBeDefined();
    expect(tool.type).toBe('function');
    expect(tool.function.description).toBeTruthy();
    expect(tool.function.parameters).toBeTruthy();
  });
});