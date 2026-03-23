import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "add-error-handling", timeout: config.timeouts.complex };

const SEED_CODE = `# User service — in-memory store for simplicity
_users = {}
_next_id = 1

def get_user(user_id):
    return _users.get(user_id)

def create_user(data):
    global _next_id
    user = {
        "id": _next_id,
        "name": data["name"],
        "email": data["email"],
        "age": data.get("age"),
    }
    _users[_next_id] = user
    _next_id += 1
    return user

def delete_user(user_id):
    if user_id in _users:
        del _users[user_id]
        return True
    return False

def list_users():
    return list(_users.values())
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "user_service.py", SEED_CODE);

  try {
    await runWithTimeout(
      agent,
      `Add input validation and error handling to user_service.py:
- get_user: user_id must be a positive integer, raise TypeError/ValueError otherwise
- create_user: data must be a dict with required "name" (non-empty string) and "email" (non-empty string containing @), raise TypeError/ValueError for bad input
- delete_user: user_id must be a positive integer, raise TypeError/ValueError otherwise
Keep the happy path behavior unchanged. Do NOT modify the return values for valid inputs.`,
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "user_service.py")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // Type checking present
    const hasTypeCheck = /isinstance\s*\(/.test(content) || /type\s*\(/.test(content);

    // Raises exceptions
    const raisesTypeError = /raise\s+TypeError/.test(content);
    const raisesValueError = /raise\s+ValueError/.test(content);
    const raisesExceptions = raisesTypeError || raisesValueError;

    // Email validation — must check for "@" character in the email string
    const hasEmailValidation = /["']@["']\s*(not\s+)?in\s+/.test(content) ||
      /"@"/.test(content) || /'@'/.test(content) ||
      /\.count\s*\(\s*["']@["']\)/.test(content);

    // Descriptive error messages (not just bare raise)
    const hasDescriptiveErrors = /raise\s+\w+Error\s*\(\s*["'].+["']\s*\)/.test(content);

    // Happy path preserved — still has the core logic
    const happyPathPreserved = /_users\.get\(/.test(content) &&
      (content.includes("data[") || content.includes("data.get(")) &&
      /_next_id/.test(content);

    // Name validation — checks for empty/missing name
    const createUserSection = content.match(/def\s+create_user[\s\S]*?(?=\ndef\s|$)/)?.[0] || "";
    const hasNameValidation = /not\s+.*\bname\b/.test(createUserSection) ||
      /len\s*\(.*name/.test(createUserSection) ||
      /strip\s*\(\s*\)/.test(createUserSection) ||
      /if\s+not\s+data/.test(createUserSection);

    // Verify user_id validation in get_user and delete_user
    const getUserSection = content.match(/def\s+get_user[\s\S]*?(?=\ndef\s)/)?.[0] || "";
    const hasUserIdValidation = /isinstance|int|positive|<\s*=?\s*0|<=\s*0/.test(getUserSection);

    return scoreResult(meta.name, [
      check("read the file", didRead, 1),
      check("edited the file", didEdit, 2),
      check("has type checking (isinstance/type)", hasTypeCheck, 2, content.slice(0, 200)),
      check("raises TypeError or ValueError", raisesExceptions, 3),
      check("validates email contains @", hasEmailValidation, 2),
      check("descriptive error messages", hasDescriptiveErrors, 2),
      check("happy path preserved", happyPathPreserved, 3),
      check("validates name in create_user", hasNameValidation, 1),
      check("validates user_id in get_user", hasUserIdValidation, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
