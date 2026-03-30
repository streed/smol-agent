/**
 * E2E test: Implement EventEmitter class from tests.
 *
 * Scenario: Agent is given a test suite for an EventEmitter class
 * and must implement the class to pass all tests. Tests cover on(),
 * emit(), off(), once(), and edge cases.
 *
 * Dependencies: ../config.js
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "implement-event-emitter", timeout: config.timeouts.complex, category: "code-gen", evalType: "capability", difficulty: "complex" };

const SEED_TEST = `import unittest
from emitter import EventEmitter

class TestEventEmitter(unittest.TestCase):
    def test_on_and_emit(self):
        ee = EventEmitter()
        results = []
        ee.on("data", lambda x: results.append(x))
        ee.emit("data", "hello")
        ee.emit("data", "world")
        self.assertEqual(results, ["hello", "world"])

    def test_multiple_listeners(self):
        ee = EventEmitter()
        r1, r2 = [], []
        ee.on("evt", lambda x: r1.append(x))
        ee.on("evt", lambda x: r2.append(x))
        ee.emit("evt", 42)
        self.assertEqual(r1, [42])
        self.assertEqual(r2, [42])

    def test_off_removes_listener(self):
        ee = EventEmitter()
        results = []
        def handler(x):
            results.append(x)
        ee.on("data", handler)
        ee.emit("data", 1)
        ee.off("data", handler)
        ee.emit("data", 2)
        self.assertEqual(results, [1])

    def test_once_fires_once(self):
        ee = EventEmitter()
        results = []
        ee.once("ping", lambda x: results.append(x))
        ee.emit("ping", "a")
        ee.emit("ping", "b")
        self.assertEqual(results, ["a"])

    def test_emit_no_listeners(self):
        ee = EventEmitter()
        # Should not raise
        ee.emit("nothing", "data")

    def test_off_nonexistent(self):
        ee = EventEmitter()
        # Should not raise
        ee.off("nothing", lambda x: x)

    def test_emit_no_args(self):
        ee = EventEmitter()
        results = []
        ee.on("signal", lambda: results.append("fired"))
        ee.emit("signal")
        self.assertEqual(results, ["fired"])

    def test_mixed_once_and_on(self):
        ee = EventEmitter()
        results = []
        ee.on("mix", lambda x: results.append(f"on:{x}"))
        ee.once("mix", lambda x: results.append(f"once:{x}"))
        ee.emit("mix", 1)
        ee.emit("mix", 2)
        self.assertEqual(results, ["on:1", "once:1", "on:2"])

if __name__ == "__main__":
    unittest.main()
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "test_emitter.py", SEED_TEST);

  try {
    await runWithTimeout(
      agent,
      "There's a test file test_emitter.py that tests a custom EventEmitter class. Implement emitter.py with the EventEmitter class so that all tests pass. Run the tests to verify.",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "emitter.py")) || "";
    const created = fileExists(tmpDir, "emitter.py");
    const hasClass = /class\s+EventEmitter/.test(content);
    const hasOn = /def\s+on\s*\(/.test(content);
    const hasOff = /def\s+off\s*\(/.test(content);
    const hasEmit = /def\s+emit\s*\(/.test(content);
    const hasOnce = /def\s+once\s*\(/.test(content);
    const hasAllMethods = hasOn && hasOff && hasEmit && hasOnce;

    const didWrite = events.anyToolCalled(["write_file"]);
    const ranTests = events.anyToolCalled(["run_command"]);

    // Check if tests pass
    const runResults = events.resultsFor("run_command")
      .map(r => [r?.stdout, r?.stderr, r?.content].filter(Boolean).join("\n")).join("\n");
    const testsPass = /OK\b/.test(runResults) && !/FAIL/.test(runResults);

    // Check for listener storage mechanism — must use a dict or similar structure in __init__
    const initSection = content.match(/def\s+__init__[\s\S]*?(?=\n\s*def\s)/)?.[0] || "";
    const hasListenerStorage = /self\.\w+\s*=\s*(\{|dict|defaultdict|collections)/.test(initSection);

    return scoreResult(meta.name, [
      check("created emitter.py", created, 2),
      check("has EventEmitter class", hasClass, 2, content.slice(0, 80)),
      check("has all 4 methods (on/off/emit/once)", hasAllMethods, 3, content.slice(0, 400)),
      check("has listener storage", hasListenerStorage, 1),
      check("wrote the file", didWrite, 1),
      check("ran tests", ranTests, 2),
      check("tests pass", testsPass, 3, runResults.slice(-200)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
