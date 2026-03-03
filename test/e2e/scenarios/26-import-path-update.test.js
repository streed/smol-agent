import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "import-path-update", timeout: config.timeouts.medium };

const SEED_INDEX = `const { add, subtract } = require("./utils");
const { formatNumber } = require("./utils");

console.log(add(1, 2));
console.log(subtract(5, 3));
console.log(formatNumber(1234));
`;

const SEED_UTILS = `function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function formatNumber(n) { return n.toLocaleString(); }

module.exports = { add, subtract, formatNumber };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "index.js", SEED_INDEX);
  await seedFile(tmpDir, "utils.js", SEED_UTILS);

  try {
    const response = await runWithTimeout(
      agent,
      "Move the formatNumber function to a new file called formatters.js and update the import in index.js",
      meta.timeout,
    );

    const indexContent = (await readResult(tmpDir, "index.js")) || "";
    const formattersContent = (await readResult(tmpDir, "formatters.js")) || "";
    const utilsContent = (await readResult(tmpDir, "utils.js")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didWrite = events.anyToolCalled(["write_file", "replace_in_file"]);

    // New file created with formatNumber
    const formattersExists = formattersContent.length > 0;
    const hasFormatNumberInFormatters = /function formatNumber|formatNumber.*=>/.test(formattersContent);
    const exportedInFormatters = /module\.exports|exports\.formatNumber/.test(formattersContent);

    // Updated import in index.js
    const importsFromFormatters = /require\s*\(\s*["']\.\/formatters["']\s*\)/.test(indexContent);
    const stillImportsUtils = /require\s*\(\s*["']\.\/utils["']\s*\)/.test(indexContent);

    // formatNumber removed from utils
    const formatNumberRemovedFromUtils = !/formatNumber/.test(utilsContent);

    return scoreResult(meta.name, [
      check("read files", didRead, 1),
      check("wrote changes", didWrite, 1),
      check("created formatters.js", formattersExists, 2),
      check("formatNumber in formatters.js", hasFormatNumberInFormatters, 2, formattersContent.slice(0, 100)),
      check("exported from formatters.js", exportedInFormatters, 1),
      check("index.js imports from formatters", importsFromFormatters, 2, indexContent),
      check("index.js still imports utils", stillImportsUtils, 1),
      check("formatNumber removed from utils.js", formatNumberRemovedFromUtils, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
