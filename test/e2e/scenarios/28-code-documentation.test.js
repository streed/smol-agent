import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "code-documentation", timeout: config.timeouts.medium };

const SEED_CODE = `function calculateDiscount(price, customerType, quantity) {
  let discount = 0;

  if (customerType === "premium") {
    discount = 0.2;
  } else if (customerType === "regular") {
    discount = 0.1;
  }

  if (quantity > 10) {
    discount += 0.05;
  }

  return price * (1 - discount);
}

module.exports = { calculateDiscount };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "pricing.js", SEED_CODE);

  try {
    await runWithTimeout(
      agent,
      "Add JSDoc comments to the calculateDiscount function documenting params and return value",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "pricing.js")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // Check for JSDoc
    const hasJSDoc = /\/\*\*/.test(content);
    const hasParamDocs = /@param/.test(content);
    const hasReturnDoc = /@returns?/.test(content);

    // Count documented params — should document all 3 (price, customerType, quantity)
    const paramMatches = content.match(/@param/g);
    const hasAllParams = paramMatches && paramMatches.length >= 3;

    // Verify the params documented match the actual function params
    const docsPriceParam = /@param\s*\{[^}]*\}\s*price/.test(content) || /@param\s+price/.test(content);
    const _docsCustomerParam = /@param\s*\{[^}]*\}\s*customerType/.test(content) || /@param\s+customerType/.test(content);
    const _docsQuantityParam = /@param\s*\{[^}]*\}\s*quantity/.test(content) || /@param\s+quantity/.test(content);

    // Function still works
    const functionIntact = /function calculateDiscount\s*\(price,\s*customerType,\s*quantity\)/.test(content);
    const logicPreserved = /customerType === ["']premium["']/.test(content) && /quantity > 10/.test(content);

    return scoreResult(meta.name, [
      check("read source file", didRead, 1),
      check("made edits", didEdit, 1),
      check("added JSDoc comment", hasJSDoc, 2, content.slice(0, 200)),
      check("has @param tags", hasParamDocs, 1),
      check("documented all 3 params", hasAllParams, 2, `found ${paramMatches?.length || 0} @param tags`),
      check("documents price param by name", docsPriceParam, 1),
      check("documented return value", hasReturnDoc, 2),
      check("function signature preserved", functionIntact, 1),
      check("logic unchanged", logicPreserved, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
