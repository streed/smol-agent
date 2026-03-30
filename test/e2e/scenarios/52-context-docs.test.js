/**
 * E2E test: Context docs (save_context tool).
 *
 * Tests that the agent can use the save_context tool to persist
 * dense summaries of explored code areas for future reference.
 * The context docs are loaded in subsequent sessions via gatherContext.
 *
 * Dependencies: node:fs, node:path, ../config.js, bcrypt, jsonwebtoken, ./auth
 */
import fs from "node:fs";
import path from "node:path";
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "context-docs", timeout: config.timeouts.complex, category: "context", evalType: "capability", difficulty: "complex" };

export async function run() {
  const { agent, tmpDir } = createTestAgent({ coreToolsOnly: false });
  const events = collectEvents(agent);

  // Seed a small codebase to analyze
  await seedFile(tmpDir, "src/auth.js", `
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "dev-secret";

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function generateToken(userId) {
  return jwt.sign({ userId }, SECRET, { expiresIn: "24h" });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken };
`.trim());

  await seedFile(tmpDir, "src/users.js", `
const { hashPassword, verifyPassword, generateToken } = require("./auth");

const users = new Map();

async function createUser(username, password) {
  if (users.has(username)) throw new Error("User exists");
  const hash = await hashPassword(password);
  users.set(username, { username, hash, createdAt: new Date() });
  return { username };
}

async function login(username, password) {
  const user = users.get(username);
  if (!user) throw new Error("User not found");
  const valid = await verifyPassword(password, user.hash);
  if (!valid) throw new Error("Invalid password");
  return { token: generateToken(username) };
}

module.exports = { createUser, login };
`.trim());

  try {
    const response = await runWithTimeout(
      agent,
      'Analyze the src/ directory (auth.js and users.js) and save a context document summarizing the authentication architecture using the save_context tool. Include what modules exist, their key functions, and how they relate to each other.',
      meta.timeout,
    );

    // Check if save_context was used
    const usedSaveContext = events.anyToolCalled(["save_context"]);

    // Check if context doc was saved
    const docsDir = path.join(tmpDir, ".smol-agent", "docs");
    let docsExist = false;
    let docContent = "";
    if (fs.existsSync(docsDir)) {
      const docs = fs.readdirSync(docsDir);
      docsExist = docs.length > 0;
      if (docsExist) {
        docContent = fs.readFileSync(path.join(docsDir, docs[0]), "utf-8");
      }
    }

    // Check response quality
    const mentionsAuth = /auth|authentication/i.test(response);
    const mentionsUsers = /users?/i.test(response);
    const mentionsBcrypt = /bcrypt|hash|password/i.test(response);
    const mentionsJWT = /jwt|token/i.test(response);

    return scoreResult(meta.name, [
      check("used save_context", usedSaveContext, 3),
      check("context doc created", docsExist, 2, docContent.slice(0, 100)),
      check("mentions auth module", mentionsAuth, 1),
      check("mentions users module", mentionsUsers, 1),
      check("mentions hashing", mentionsBcrypt, 1),
      check("mentions JWT/tokens", mentionsJWT, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
