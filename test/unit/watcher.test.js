/**
 * Unit tests for the directory watcher.
 *
 * Focus areas:
 * - File filtering (extensions + excluded directories/globs)
 * - Processing changes that occur after startup
 * - Not re-processing files that existed before startup
 * - Loop prevention: the agent's own writes must NOT re-trigger processing
 *
 * The agent runner is injected (`runAgent`) so no child processes are spawned.
 *
 * Dependencies: @jest/globals, ../../src/watcher.js, ../test-utils.js, node:fs, node:path
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { watchDirectory } from '../../src/watcher.js';
import { createTempDir, cleanupTempDir, createTestFile } from '../test-utils.js';
import fs from 'node:fs';
import path from 'node:path';

// Silence the watcher's console banner/progress during tests.
const origLog = console.log;
const origError = console.error;
beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
});
afterEach(() => {
  console.log = origLog;
  console.error = origError;
});

/** Poll `fn` until it returns truthy or the timeout elapses. */
async function waitFor(fn, { timeout = 3000, interval = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

const FAST = { debounceMs: 20, pollIntervalMs: 40 };

describe('watchDirectory', () => {
  let dir;
  let watcher;

  beforeEach(() => {
    dir = createTempDir();
    watcher = null;
  });

  afterEach(() => {
    watcher?.stop();
    cleanupTempDir(dir);
  });

  test('processes a matching file created after startup', async () => {
    const processed = [];
    watcher = watchDirectory({
      watchPath: dir,
      prompt: 'do something',
      ...FAST,
      runAgent: async ({ prompt }) => {
        processed.push(prompt);
        return 'ok';
      },
    });

    createTestFile(dir, 'new.js', 'console.log(1);');

    expect(await waitFor(() => processed.length === 1)).toBe(true);
    expect(processed[0]).toContain('new.js');
    expect(processed[0]).toContain('console.log(1);');
  });

  test('ignores files with non-watched extensions', async () => {
    let calls = 0;
    watcher = watchDirectory({
      watchPath: dir,
      prompt: 'p',
      ...FAST,
      extensions: ['.js'],
      runAgent: async () => {
        calls += 1;
        return 'ok';
      },
    });

    createTestFile(dir, 'image.png', 'not really an image');
    createTestFile(dir, 'notes.log', 'a log line');

    // Give the watcher several poll cycles; nothing should be processed.
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
  });

  test('ignores files inside excluded directories', async () => {
    let calls = 0;
    watcher = watchDirectory({
      watchPath: dir,
      prompt: 'p',
      ...FAST,
      runAgent: async () => {
        calls += 1;
        return 'ok';
      },
    });

    const nm = path.join(dir, 'node_modules', 'pkg');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'index.js'), 'module.exports = {};');

    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
  });

  test('does not process files that existed before startup', async () => {
    createTestFile(dir, 'preexisting.js', 'const a = 1;');

    let calls = 0;
    watcher = watchDirectory({
      watchPath: dir,
      prompt: 'p',
      ...FAST,
      runAgent: async () => {
        calls += 1;
        return 'ok';
      },
    });

    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
  });

  test("does not re-process the agent's own writes (no runaway loop)", async () => {
    const target = path.join(dir, 'target.js');
    let calls = 0;
    watcher = watchDirectory({
      watchPath: dir,
      prompt: 'add a comment',
      ...FAST,
      // Simulate an agent that edits the watched file, with a small delay so the
      // edit's change events race against the in-flight run.
      runAgent: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 60));
        fs.appendFileSync(target, `\n// edited by agent run #${calls}\n`);
        return 'ok';
      },
    });

    // External change kicks off the first (and only) run.
    fs.writeFileSync(target, 'const x = 1;\n');

    expect(await waitFor(() => calls >= 1)).toBe(true);

    // Wait through many debounce/poll cycles; the agent's own edit must not
    // trigger further runs.
    await new Promise((r) => setTimeout(r, 800));
    expect(calls).toBe(1);
  });

  test('processes a genuinely new external edit after a run completes', async () => {
    const target = path.join(dir, 'target.js');
    let calls = 0;
    watcher = watchDirectory({
      watchPath: dir,
      prompt: 'p',
      ...FAST,
      runAgent: async () => {
        calls += 1;
        return 'ok';
      },
    });

    fs.writeFileSync(target, 'v1\n');
    expect(await waitFor(() => calls === 1)).toBe(true);

    // A second, distinct external edit should be processed.
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(target, 'v2 different content\n');
    expect(await waitFor(() => calls === 2)).toBe(true);
  });

  test('stop() halts further processing', async () => {
    let calls = 0;
    watcher = watchDirectory({
      watchPath: dir,
      prompt: 'p',
      ...FAST,
      runAgent: async () => {
        calls += 1;
        return 'ok';
      },
    });

    watcher.stop();
    createTestFile(dir, 'after-stop.js', 'console.log(1);');
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
  });

  test('passes noExec:true to the runner by default (safe watcher children)', async () => {
    const seen = [];
    watcher = watchDirectory({
      watchPath: dir,
      prompt: 'p',
      ...FAST,
      runAgent: async (args) => {
        seen.push(args);
        return 'ok';
      },
    });

    createTestFile(dir, 'a.js', 'console.log(1);');
    expect(await waitFor(() => seen.length === 1)).toBe(true);
    expect(seen[0].noExec).toBe(true);
  });

  test('passes noExec:false when allowExec is set', async () => {
    const seen = [];
    watcher = watchDirectory({
      watchPath: dir,
      prompt: 'p',
      allowExec: true,
      ...FAST,
      runAgent: async (args) => {
        seen.push(args);
        return 'ok';
      },
    });

    createTestFile(dir, 'b.js', 'console.log(1);');
    expect(await waitFor(() => seen.length === 1)).toBe(true);
    expect(seen[0].noExec).toBe(false);
  });
});
