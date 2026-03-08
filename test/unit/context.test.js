/**
 * Unit tests for context module
 * Tests project context gathering
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createTempDir, cleanupTempDir, createTestFile } from '../test-utils.js';
import fs from 'node:fs';
import path from 'node:path';

// Mock repo-map to avoid loading tree-sitter native modules
// which cause issues when Jest runs multiple test files in the same worker.
jest.unstable_mockModule('../../src/repo-map.js', () => ({
  buildRepoMap: async () => null,
  clearRepoMapCache: () => {},
}));

const { gatherContext } = await import('../../src/context.js');

describe('gatherContext', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test('includes working directory', async () => {
    const context = await gatherContext(tempDir);
    expect(context).toContain('Working directory:');
    expect(context).toContain(tempDir);
  });

  test('detects Node.js project', async () => {
    createTestFile(tempDir, 'package.json', '{"name": "test"}');
    const context = await gatherContext(tempDir);
    expect(context).toContain('Node.js');
  });

  test('detects Python project', async () => {
    createTestFile(tempDir, 'pyproject.toml', '[project]\nname = "test"');
    const context = await gatherContext(tempDir);
    expect(context).toContain('Python');
  });

  test('detects Rust project', async () => {
    createTestFile(tempDir, 'Cargo.toml', '[package]\nname = "test"');
    const context = await gatherContext(tempDir);
    expect(context).toContain('Rust');
  });

  test('detects Go project', async () => {
    createTestFile(tempDir, 'go.mod', 'module test\n\ngo 1.21');
    const context = await gatherContext(tempDir);
    expect(context).toContain('Go');
  });

  test('includes top-level files', async () => {
    createTestFile(tempDir, 'README.md', '# Test');
    createTestFile(tempDir, 'src/index.js', '// code');
    const context = await gatherContext(tempDir);
    expect(context).toContain('Files:');
    expect(context).toContain('README.md');
  });

  test('ignores node_modules and .git', async () => {
    createTestFile(tempDir, 'package.json', '{}');
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'node_modules', 'some-package.json'), '{}');
    
    const context = await gatherContext(tempDir);
    expect(context).not.toContain('node_modules');
    expect(context).not.toContain('.git');
  });

  test('includes AGENT.md if present', async () => {
    createTestFile(tempDir, 'AGENT.md', '# Agent Instructions\n\nFollow these rules.');
    const context = await gatherContext(tempDir);
    expect(context).toContain('## AGENT.md');
    expect(context).toContain('Follow these rules');
  });

  test('includes skills if present', async () => {
    const skillsDir = path.join(tempDir, '.smol-agent', 'skills', 'test-skill');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: A test skill\n---\nTest content'
    );
    
    const context = await gatherContext(tempDir);
    expect(context).toContain('## Skills');
    expect(context).toContain('test-skill');
  });

  test('respects contextSize limit', async () => {
    // Create AGENT.md with many lines
    const lines = Array(200).fill(0).map((_, i) => `Line ${i}: some content here`);
    createTestFile(tempDir, 'AGENT.md', lines.join('\n'));
    
    // Request only 50 lines
    const context = await gatherContext(tempDir, 50);
    expect(context).toContain('## AGENT.md');
    // Should not have all 200 lines
    expect(context).not.toContain('Line 150');
  });

  test('returns sections in correct order', async () => {
    createTestFile(tempDir, 'package.json', '{}');
    createTestFile(tempDir, 'AGENT.md', 'Instructions');
    
    const context = await gatherContext(tempDir);
    const workingDirIndex = context.indexOf('Working directory:');
    const projectIndex = context.indexOf('Project:');
    const filesIndex = context.indexOf('Files:');
    const agentIndex = context.indexOf('## AGENT.md');
    
    expect(workingDirIndex).toBeLessThan(projectIndex);
    expect(projectIndex).toBeLessThan(filesIndex);
    expect(filesIndex).toBeLessThan(agentIndex);
  });

  test('handles empty directory', async () => {
    const context = await gatherContext(tempDir);
    expect(context).toContain('Working directory:');
  });
});