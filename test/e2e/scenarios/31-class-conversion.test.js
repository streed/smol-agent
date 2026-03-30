import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "class-conversion", timeout: config.timeouts.complex, category: "code-transform", evalType: "capability", difficulty: "complex" };

const SEED_CODE = `function Counter(initialValue = 0) {
  this.value = initialValue;
}

Counter.prototype.increment = function() {
  this.value++;
  return this.value;
};

Counter.prototype.decrement = function() {
  this.value--;
  return this.value;
};

Counter.prototype.reset = function() {
  this.value = 0;
};

module.exports = Counter;
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "Counter.js", SEED_CODE);

  try {
    await runWithTimeout(
      agent,
      "Convert this constructor function to use ES6 class syntax",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "Counter.js")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // Check for class syntax
    const hasClassKeyword = /class\s+Counter/.test(content);
    const hasConstructor = /constructor\s*\(/.test(content);

    // Check methods converted
    const hasIncrement = /increment\s*\(\s*\)\s*{/.test(content);
    const hasDecrement = /decrement\s*\(\s*\)\s*{/.test(content);
    const hasReset = /reset\s*\(\s*\)\s*{/.test(content);

    // No old prototype syntax
    const noPrototype = !/\.prototype\./.test(content);

    // Still exported
    const stillExported = /module\.exports|export\s+(default\s+)?class/.test(content);

    return scoreResult(meta.name, [
      check("read source file", didRead, 1),
      check("made edits", didEdit, 1),
      check("uses class keyword", hasClassKeyword, 3, content.slice(0, 150)),
      check("has constructor", hasConstructor, 2),
      check("has increment method", hasIncrement, 1),
      check("has decrement method", hasDecrement, 1),
      check("has reset method", hasReset, 1),
      check("removed prototype syntax", noPrototype, 1),
      check("class still exported", stillExported, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
