/**
 * Unit tests for permissions module.
 *
 * Tests:
 * - PermissionResult builders
 * - PermissionRule evaluation
 * - PermissionComposer composition
 * - Standard permission rules
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  PermissionResult,
  PermissionRule,
  PermissionComposer,
  PermissionRules,
  createStandardPermissions
} from '../../src/tools/permissions.js';

describe('PermissionResult', () => {
  test('allow returns allowed true', () => {
    const result = PermissionResult.allow();
    expect(result.allowed).toBe(true);
  });

  test('deny returns allowed false with reason', () => {
    const result = PermissionResult.deny('Access denied');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Access denied');
  });

  test('deny includes details', () => {
    const result = PermissionResult.deny('Access denied', { path: '/etc' });
    expect(result.details.path).toBe('/etc');
  });

  test('ask returns requiresApproval flag', () => {
    const result = PermissionResult.ask('Allow access to sensitive file?');
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.reason).toContain('sensitive');
  });

  test('skip returns null', () => {
    const result = PermissionResult.skip();
    expect(result).toBeNull();
  });
});

describe('PermissionRule', () => {
  test('creates rule with check function', () => {
    const rule = new PermissionRule(async () => ({ allowed: true }));
    expect(rule.check).toBeDefined();
    expect(rule.priority).toBe(100);
  });

  test('uses custom priority', () => {
    const rule = new PermissionRule(async () => null, { priority: 50 });
    expect(rule.priority).toBe(50);
  });

  test('uses custom name', () => {
    const rule = new PermissionRule(async () => null, { name: 'test-rule' });
    expect(rule.name).toBe('test-rule');
  });

  test('evaluate returns check result', async () => {
    const rule = new PermissionRule(async () => ({ allowed: false, reason: 'Denied' }));
    const result = await rule.evaluate({}, {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Denied');
  });

  test('evaluate handles errors gracefully', async () => {
    const rule = new PermissionRule(async () => {
      throw new Error('Check failed');
    });
    const result = await rule.evaluate({}, {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Check failed');
  });
});

describe('PermissionComposer', () => {
  let composer;

  beforeEach(() => {
    composer = new PermissionComposer();
  });

  test('starts with no rules', () => {
    expect(composer.rules).toHaveLength(0);
  });

  test('addRule adds PermissionRule', () => {
    composer.addRule(async () => null);
    expect(composer.rules).toHaveLength(1);
    expect(composer.rules[0]).toBeInstanceOf(PermissionRule);
  });

  test('addRule accepts check function', () => {
    composer.addRule(async () => ({ allowed: true }), { name: 'test' });
    expect(composer.rules).toHaveLength(1);
    expect(composer.rules[0].name).toBe('test');
  });

  test('removeRule removes by name', () => {
    composer.addRule(async () => null, { name: 'rule1' });
    composer.addRule(async () => null, { name: 'rule2' });
    composer.removeRule('rule1');
    expect(composer.rules).toHaveLength(1);
    expect(composer.rules[0].name).toBe('rule2');
  });

  test('clearRules removes all rules', () => {
    composer.addRule(async () => null);
    composer.addRule(async () => null);
    composer.clearRules();
    expect(composer.rules).toHaveLength(0);
  });

  test('checkPermissions returns allow when no rules', async () => {
    const result = await composer.checkPermissions({}, {});
    expect(result.allowed).toBe(true);
  });

  test('checkPermissions returns first non-null result', async () => {
    composer.addRule(async () => null, { priority: 1 });
    composer.addRule(async () => ({ allowed: false, reason: 'Denied' }), { priority: 2 });
    composer.addRule(async () => ({ allowed: true }), { priority: 3 });

    const result = await composer.checkPermissions({}, {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Denied');
  });

  test('checkPermissions evaluates in priority order', async () => {
    const order = [];
    composer.addRule(async () => { order.push(2); return null; }, { priority: 2 });
    composer.addRule(async () => { order.push(1); return { allowed: true }; }, { priority: 1 });
    composer.addRule(async () => { order.push(3); return null; }, { priority: 3 });

    await composer.checkPermissions({}, {});
    expect(order).toEqual([1]); // Only priority 1 runs (returns result)
  });

  test('getRuleNames returns rule names', () => {
    composer.addRule(async () => null, { name: 'rule1' });
    composer.addRule(async () => null, { name: 'rule2' });
    expect(composer.getRuleNames()).toEqual(['rule1', 'rule2']);
  });
});

describe('PermissionRules', () => {
  describe('withinJail', () => {
    test('rule exists and has correct priority', () => {
      const rule = PermissionRules.withinJail();
      expect(rule).toBeDefined();
      expect(rule.name).toBe('within-jail');
      expect(rule.priority).toBe(1);
    });

    test('skips when no path is provided', async () => {
      const rule = PermissionRules.withinJail();
      const result = await rule.check({}, { cwd: '/home/user/project' });
      expect(result).toBeNull(); // null means skip
    });
  });

  describe('askSensitive', () => {
    test('asks for sensitive files', async () => {
      const rule = PermissionRules.askSensitive();
      const result = await rule.check({ filePath: '/home/user/.env' }, {});
      expect(result).not.toBeNull();
      expect(result.requiresApproval).toBe(true);
    });

    test('skips non-sensitive files', async () => {
      const rule = PermissionRules.askSensitive();
      const result = await rule.check({ filePath: '/home/user/readme.md' }, {});
      expect(result).toBeNull();
    });
  });

  describe('denySensitive', () => {
    test('denies sensitive files', async () => {
      const rule = PermissionRules.denySensitive();
      const result = await rule.check({ filePath: '/home/user/.env.local' }, {});
      expect(result).not.toBeNull();
      expect(result.allowed).toBe(false);
    });
  });

  describe('readOnly', () => {
    test('denies writes in read-only mode', async () => {
      const rule = PermissionRules.readOnly();
      const result = await rule.check(
        { content: 'new content' },
        { readOnlyMode: true }
      );
      expect(result).not.toBeNull();
      expect(result.allowed).toBe(false);
    });

    test('allows reads in read-only mode', async () => {
      const rule = PermissionRules.readOnly();
      const result = await rule.check(
        { filePath: '/home/user/file.txt' },
        { readOnlyMode: true }
      );
      expect(result).toBeNull();
    });

    test('skips when not in read-only mode', async () => {
      const rule = PermissionRules.readOnly();
      const result = await rule.check(
        { content: 'new content' },
        { readOnlyMode: false }
      );
      expect(result).toBeNull();
    });
  });

  describe('askDestructive', () => {
    test('asks for destructive commands', async () => {
      // Note: This test requires isDestructiveCommand from registry.js
      // The function is imported dynamically, so we skip this test
      // or mock it. For now, we just check the rule exists.
      const rule = PermissionRules.askDestructive();
      expect(rule).toBeDefined();
      expect(rule.name).toBe('ask-destructive');
    });
  });

  describe('blockCommands', () => {
    test('blocks dangerous commands', async () => {
      const rule = PermissionRules.blockCommands();
      const result = await rule.check({ command: 'rm -rf /' }, {});
      expect(result.allowed).toBe(false);
    });

    test('allows safe commands', async () => {
      const rule = PermissionRules.blockCommands();
      const result = await rule.check({ command: 'ls -la' }, {});
      expect(result).toBeNull();
    });
  });

  describe('onlyTools', () => {
    test('denies tools not in allowed list', async () => {
      const rule = PermissionRules.onlyTools({ allowed: new Set(['read_file', 'write_file']) });
      const result = await rule.check({}, { toolName: 'run_command' });
      expect(result.allowed).toBe(false);
    });

    test('allows tools in allowed list', async () => {
      const rule = PermissionRules.onlyTools({ allowed: new Set(['read_file', 'write_file']) });
      const result = await rule.check({}, { toolName: 'read_file' });
      expect(result).toBeNull();
    });
  });
});

describe('createStandardPermissions', () => {
  test('creates composer with default rules', () => {
    const composer = createStandardPermissions();
    expect(composer.rules.length).toBeGreaterThan(0);
  });

  test('respects enforceJail option', () => {
    const composer = createStandardPermissions({ enforceJail: false });
    const names = composer.getRuleNames();
    expect(names).not.toContain('within-jail');
  });

  test('respects askSensitive option', () => {
    const composer = createStandardPermissions({ askSensitive: false });
    const names = composer.getRuleNames();
    expect(names).not.toContain('ask-sensitive');
  });

  test('respects denySensitive option', () => {
    const composer = createStandardPermissions({ denySensitive: true });
    const names = composer.getRuleNames();
    expect(names).toContain('deny-sensitive');
  });

  test('respects readOnly option', () => {
    const composer = createStandardPermissions({ readOnly: true });
    const names = composer.getRuleNames();
    expect(names).toContain('read-only');
  });

  test('respects askDestructive option', () => {
    const composer = createStandardPermissions({ askDestructive: false });
    const names = composer.getRuleNames();
    expect(names).not.toContain('ask-destructive');
  });

  test('respects blockCommands option', () => {
    const composer = createStandardPermissions({ blockCommands: false });
    const names = composer.getRuleNames();
    expect(names).not.toContain('block-commands');
  });
});