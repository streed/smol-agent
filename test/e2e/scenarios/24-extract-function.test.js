import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "extract-function", timeout: config.timeouts.complex, category: "code-transform", evalType: "capability", difficulty: "complex" };

const SEED_CODE = `function processUser(user) {
  // Validate user
  if (!user.name || user.name.length < 3) {
    throw new Error("Invalid name");
  }
  if (!user.email || !user.email.includes("@")) {
    throw new Error("Invalid email");
  }

  // Process user
  const normalized = {
    name: user.name.trim().toLowerCase(),
    email: user.email.trim().toLowerCase(),
    createdAt: new Date().toISOString(),
  };

  return normalized;
}

module.exports = { processUser };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "user.js", SEED_CODE);

  try {
    await runWithTimeout(
      agent,
      "Extract the validation logic into a separate 'validateUser' function",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "user.js")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // Check for new function with validation logic inside it
    const hasValidateFunction = /function\s+validateUser/.test(content);

    // validateUser should be called within processUser
    const processUserBody = content.match(/function\s+processUser[\s\S]*?\nfunction|\nmodule/)?.[0] || content;
    const processUserCallsValidate = /validateUser\s*\(/.test(processUserBody);

    // Check that original function still exists
    const hasProcessFunction = /function\s+processUser/.test(content);
    const stillReturnsNormalized = /return\s+normalized/.test(content);

    // Validation logic (name/email checks) should be in validateUser, not duplicated in processUser
    const validateFuncMatch = content.match(/function\s+validateUser[\s\S]*?(?=\nfunction|\nmodule)/);
    const validateHasChecks = validateFuncMatch &&
      (/name/.test(validateFuncMatch[0]) || /email/.test(validateFuncMatch[0]));

    return scoreResult(meta.name, [
      check("read source file", didRead, 1),
      check("made edits", didEdit, 1),
      check("created validateUser function", hasValidateFunction, 3, content.slice(0, 200)),
      check("processUser calls validateUser", processUserCallsValidate, 2),
      check("validateUser contains validation logic", validateHasChecks, 1),
      check("processUser still exists", hasProcessFunction, 1),
      check("still returns normalized object", stillReturnsNormalized, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
