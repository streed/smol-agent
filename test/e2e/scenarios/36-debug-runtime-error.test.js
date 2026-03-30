/**
 * E2E test: Debug runtime error from stack trace.
 *
 * Scenario: Agent is given a Python script with a runtime error
 * and must debug it by reading the error message and stack trace,
 * then fixing the underlying issue.
 *
 * Dependencies: ../config.js
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "debug-runtime-error", timeout: config.timeouts.complex, category: "debugging", evalType: "capability", difficulty: "complex" };

const SEED_PROCESSOR = `import json
import sys

def load_data(filepath):
    with open(filepath) as f:
        return json.load(f)

def process_users(data):
    results = []
    for user in data["users"]:
        # Build summary for each user
        name = user["name"]
        email = user["contact"]["email"]
        city = user["address"]["city"]
        orders = sum(o["total"] for o in user["orders"])

        results.append({
            "name": name,
            "email": email,
            "city": city,
            "total_spent": orders
        })
    return results

def main():
    data = load_data("data.json")
    results = process_users(data)
    for r in results:
        print(f"{r['name']} ({r['email']}) - {r['city']} - spent {r['total_spent']:.2f}")
    print(f"\\nProcessed {len(results)} users successfully.")

if __name__ == "__main__":
    main()
`;

const SEED_DATA = JSON.stringify({
  users: [
    {
      name: "Alice",
      contact: { email: "alice@example.com", phone: "555-0001" },
      address: { city: "Portland", state: "OR" },
      orders: [{ id: 1, total: 29.99 }, { id: 2, total: 15.50 }],
    },
    {
      name: "Bob",
      contact: { email: "bob@example.com" },
      // no address key — will crash on user["address"]["city"]
      orders: [{ id: 3, total: 42.00 }],
    },
    {
      name: "Charlie",
      // no contact key — will crash on user["contact"]["email"]
      address: { city: "Seattle", state: "WA" },
      orders: [],
    },
    {
      name: "Diana",
      contact: { email: "diana@example.com" },
      address: { city: "Denver", state: "CO" },
      // no orders key — will crash on sum()
    },
  ],
}, null, 2);

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "data_processor.py", SEED_PROCESSOR);
  await seedFile(tmpDir, "data.json", SEED_DATA);

  try {
    await runWithTimeout(
      agent,
      "Run data_processor.py — it's crashing with an error. Debug the issue and fix the code so it handles all the data in data.json correctly. Run it again to verify it works.",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "data_processor.py")) || "";

    const ranCode = events.toolCallCount("run_command") >= 1;
    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);
    const ranAgain = events.toolCallCount("run_command") >= 2;

    // Check for null/missing-key guards (get(), if/else, try/except, or similar)
    const hasContactGuard = /\.get\s*\(\s*["']contact["']/.test(content) ||
      /if.*contact/.test(content) || /try:/.test(content) ||
      /\.get\s*\(\s*["']email["']/.test(content);
    const hasAddressGuard = /\.get\s*\(\s*["']address["']/.test(content) ||
      /if.*address/.test(content) ||
      /\.get\s*\(\s*["']city["']/.test(content);
    const hasOrdersGuard = /\.get\s*\(\s*["']orders["']/.test(content) ||
      /if.*orders/.test(content) ||
      /orders.*or\s*\[\]/.test(content) ||
      /\.get\s*\(\s*["']orders["']\s*,\s*\[\]/.test(content);

    // Check that the fixed version runs successfully
    const runResults = events.resultsFor("run_command")
      .map(r => [r?.stdout, r?.stderr, r?.content].filter(Boolean).join("\n")).join("\n");
    const runsSuccessfully = /Processed\s+\d+\s+users?\s+successfully/.test(runResults);

    return scoreResult(meta.name, [
      check("ran the code", ranCode, 2),
      check("read files", didRead, 1),
      check("edited the file", didEdit, 2),
      check("added contact/email guard", hasContactGuard, 2, content.slice(0, 300)),
      check("added address guard", hasAddressGuard, 2),
      check("added orders guard", hasOrdersGuard, 2),
      check("re-ran to verify", ranAgain, 2),
      check("program runs successfully", runsSuccessfully, 3, runResults.slice(-200)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
