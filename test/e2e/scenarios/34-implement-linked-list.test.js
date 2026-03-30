/**
 * E2E test: Implement linked list from tests.
 *
 * Scenario: Agent is given a test suite for a LinkedList class and must
 * implement the class to pass all tests. Tests cover append, prepend,
 * find, delete, and edge cases like deleting from empty list.
 *
 * Dependencies: ../config.js
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "implement-linked-list", timeout: config.timeouts.complex, category: "code-gen", evalType: "capability", difficulty: "complex" };

const SEED_TEST = `import unittest
from linked_list import LinkedList

class TestLinkedList(unittest.TestCase):
    def test_append(self):
        ll = LinkedList()
        ll.append(1)
        ll.append(2)
        ll.append(3)
        self.assertEqual(ll.to_list(), [1, 2, 3])

    def test_prepend(self):
        ll = LinkedList()
        ll.prepend(3)
        ll.prepend(2)
        ll.prepend(1)
        self.assertEqual(ll.to_list(), [1, 2, 3])

    def test_find(self):
        ll = LinkedList()
        ll.append(10)
        ll.append(20)
        ll.append(30)
        node = ll.find(20)
        self.assertIsNotNone(node)
        self.assertEqual(node.value, 20)
        self.assertIsNone(ll.find(99))

    def test_delete(self):
        ll = LinkedList()
        ll.append(1)
        ll.append(2)
        ll.append(3)
        ll.delete(2)
        self.assertEqual(ll.to_list(), [1, 3])

    def test_delete_head(self):
        ll = LinkedList()
        ll.append(1)
        ll.append(2)
        ll.delete(1)
        self.assertEqual(ll.to_list(), [2])

    def test_empty_list(self):
        ll = LinkedList()
        self.assertEqual(ll.to_list(), [])
        self.assertIsNone(ll.find(1))

    def test_delete_nonexistent(self):
        ll = LinkedList()
        ll.append(1)
        ll.delete(99)  # should not raise
        self.assertEqual(ll.to_list(), [1])

if __name__ == "__main__":
    unittest.main()
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "test_linked_list.py", SEED_TEST);

  try {
    await runWithTimeout(
      agent,
      "There's a test file test_linked_list.py that tests a LinkedList class. Implement linked_list.py so that all the tests pass. Run the tests to verify.",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "linked_list.py")) || "";
    const created = fileExists(tmpDir, "linked_list.py");
    const hasClass = /class\s+LinkedList/.test(content);
    // Verify actual method definitions with self parameter (not just keywords)
    const hasAppend = /def\s+append\s*\(\s*self/.test(content);
    const hasPrepend = /def\s+prepend\s*\(\s*self/.test(content);
    const hasToList = /def\s+to_list\s*\(\s*self/.test(content);
    const hasFind = /def\s+find\s*\(\s*self/.test(content);
    const hasDelete = /def\s+delete\s*\(\s*self/.test(content);
    const hasAllMethods = hasAppend && hasPrepend && hasToList && hasFind && hasDelete;

    const didWrite = events.anyToolCalled(["write_file"]);
    const ranTests = events.anyToolCalled(["run_command"]);

    // Check if tests pass — look for "OK" in unittest output
    const runResults = events.resultsFor("run_command")
      .map(r => [r?.stdout, r?.stderr, r?.content].filter(Boolean).join("\n")).join("\n");
    const testsPass = /OK\b/.test(runResults) && !/FAIL/.test(runResults);

    return scoreResult(meta.name, [
      check("created linked_list.py", created, 2),
      check("has LinkedList class", hasClass, 2, content.slice(0, 80)),
      check("has all 5 methods", hasAllMethods, 3, content.slice(0, 300)),
      check("wrote the file", didWrite, 1),
      check("ran tests", ranTests, 2),
      check("tests pass", testsPass, 3, runResults.slice(-200)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
