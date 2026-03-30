import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "refactor-rename", timeout: config.timeouts.complex, category: "code-transform", evalType: "capability", difficulty: "complex" };

const SEED_UTILS = `function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

function formatTotal(items) {
  const total = calculateTotal(items);
  return "$" + total.toFixed(2);
}

module.exports = { calculateTotal, formatTotal };
`;

const SEED_MAIN = `const { calculateTotal, formatTotal } = require("./utils");

const items = [
  { name: "Widget", price: 9.99 },
  { name: "Gadget", price: 24.99 },
];

console.log("Total:", calculateTotal(items));
console.log("Formatted:", formatTotal(items));
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "utils.js", SEED_UTILS);
  await seedFile(tmpDir, "main.js", SEED_MAIN);

  try {
    await runWithTimeout(
      agent,
      'Rename the function "calculateTotal" to "sumPrices" in both utils.js and main.js. Make sure all references are updated.',
      meta.timeout,
    );

    const utils = (await readResult(tmpDir, "utils.js")) || "";
    const main = (await readResult(tmpDir, "main.js")) || "";

    const utilsRenamed = utils.includes("sumPrices") && !utils.includes("calculateTotal");
    const mainRenamed = main.includes("sumPrices") && !main.includes("calculateTotal");
    const formatTotalPreserved = utils.includes("formatTotal") && main.includes("formatTotal");

    // Verify both specific files were edited (not just any 2 edits)
    const editCalls = events.tool_calls.filter(
      (tc) => tc.name === "replace_in_file" || tc.name === "write_file",
    );
    const editedUtils = editCalls.some(tc => {
      const args = tc.args || tc.arguments || {};
      return /utils\.js/i.test(args.filePath || "");
    });
    const editedMain = editCalls.some(tc => {
      const args = tc.args || tc.arguments || {};
      return /main\.js/i.test(args.filePath || "");
    });

    // Verify the function definition was renamed (not just the name string)
    const hasSumPricesDef = /function\s+sumPrices|const\s+sumPrices/.test(utils);

    // formatTotal should still call sumPrices (previously called calculateTotal)
    const formatCallsRenamed = /sumPrices\s*\(/.test(utils);

    return scoreResult(meta.name, [
      check("utils.js renamed", utilsRenamed, 3, utils.slice(0, 160)),
      check("main.js renamed", mainRenamed, 3, main.slice(0, 160)),
      check("sumPrices function defined", hasSumPricesDef, 1),
      check("formatTotal calls sumPrices", formatCallsRenamed, 1),
      check("formatTotal preserved", formatTotalPreserved, 2),
      check("edited utils.js", editedUtils, 1),
      check("edited main.js", editedMain, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
