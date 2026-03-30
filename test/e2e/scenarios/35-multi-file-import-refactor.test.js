/**
 * E2E test: Multi-file import refactoring.
 *
 * Scenario: Two modules have duplicated utility functions (validateEmail,
 * sanitizeInput). Agent must extract these into a shared utils module
 * and update imports in both files without breaking functionality.
 *
 * Dependencies: ../config.js
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "multi-file-import-refactor", timeout: config.timeouts.complex, category: "code-transform", evalType: "capability", difficulty: "complex" };

const SEED_ROUTES = `function validateEmail(email) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

function sanitizeInput(str) {
  return str.replace(/[<>&"']/g, "");
}

function handleGetUsers(req, res) {
  const search = sanitizeInput(req.query.search || "");
  res.json({ users: [], search });
}

function handleCreateUser(req, res) {
  if (!validateEmail(req.body.email)) {
    return res.status(400).json({ error: "Invalid email" });
  }
  const name = sanitizeInput(req.body.name);
  res.json({ created: true, name });
}

module.exports = { handleGetUsers, handleCreateUser };
`;

const SEED_HANDLERS = `function validateEmail(email) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

function sanitizeInput(str) {
  return str.replace(/[<>&"']/g, "");
}

function processOrder(data) {
  if (!validateEmail(data.customerEmail)) {
    throw new Error("Invalid customer email");
  }
  const notes = sanitizeInput(data.notes || "");
  return { orderId: Date.now(), notes };
}

function processReturn(data) {
  const reason = sanitizeInput(data.reason);
  return { returnId: Date.now(), reason };
}

module.exports = { processOrder, processReturn };
`;

const SEED_MIDDLEWARE = `function validateEmail(email) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

function sanitizeInput(str) {
  return str.replace(/[<>&"']/g, "");
}

function authMiddleware(req, res, next) {
  const token = sanitizeInput(req.headers.authorization || "");
  if (!token) return res.status(401).json({ error: "No token" });
  next();
}

function validateUserMiddleware(req, res, next) {
  if (!validateEmail(req.body.email)) {
    return res.status(400).json({ error: "Bad email" });
  }
  next();
}

module.exports = { authMiddleware, validateUserMiddleware };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  collectEvents(agent);
  await seedFile(tmpDir, "routes.js", SEED_ROUTES);
  await seedFile(tmpDir, "handlers.js", SEED_HANDLERS);
  await seedFile(tmpDir, "middleware.js", SEED_MIDDLEWARE);

  try {
    await runWithTimeout(
      agent,
      `The files routes.js, handlers.js, and middleware.js all duplicate the same validateEmail and sanitizeInput helper functions. Extract them into a shared utils.js file and update all three files to import from utils.js instead. Make sure the existing functionality still works.`,
      meta.timeout,
    );

    const utils = (await readResult(tmpDir, "utils.js")) || "";
    const routes = (await readResult(tmpDir, "routes.js")) || "";
    const handlers = (await readResult(tmpDir, "handlers.js")) || "";
    const middleware = (await readResult(tmpDir, "middleware.js")) || "";

    // utils.js created with both helpers
    const utilsCreated = fileExists(tmpDir, "utils.js");
    const utilsHasValidate = /validateEmail/.test(utils);
    const utilsHasSanitize = /sanitizeInput/.test(utils);

    // All 3 files import from utils
    const routesImports = /require\(["']\.\/utils["']\)/.test(routes) ||
      /from\s+["']\.\/utils["']/.test(routes);
    const handlersImports = /require\(["']\.\/utils["']\)/.test(handlers) ||
      /from\s+["']\.\/utils["']/.test(handlers);
    const middlewareImports = /require\(["']\.\/utils["']\)/.test(middleware) ||
      /from\s+["']\.\/utils["']/.test(middleware);

    // No more inline duplication of the helper functions in the 3 files
    // (They should reference utils, not redefine them)
    const routesNoDup = !/function\s+validateEmail/.test(routes) &&
      !/function\s+sanitizeInput/.test(routes);
    const handlersNoDup = !/function\s+validateEmail/.test(handlers) &&
      !/function\s+sanitizeInput/.test(handlers);
    const middlewareNoDup = !/function\s+validateEmail/.test(middleware) &&
      !/function\s+sanitizeInput/.test(middleware);
    const noDuplication = routesNoDup && handlersNoDup && middlewareNoDup;

    // Original business logic preserved
    const routesPreserved = /handleGetUsers/.test(routes) && /handleCreateUser/.test(routes);
    const handlersPreserved = /processOrder/.test(handlers) && /processReturn/.test(handlers);
    const middlewarePreserved = /authMiddleware/.test(middleware) && /validateUserMiddleware/.test(middleware);
    const functionalityIntact = routesPreserved && handlersPreserved && middlewarePreserved;

    return scoreResult(meta.name, [
      check("utils.js created", utilsCreated, 2),
      check("utils has validateEmail", utilsHasValidate, 2, utils.slice(0, 120)),
      check("utils has sanitizeInput", utilsHasSanitize, 2, utils.slice(0, 120)),
      check("routes imports utils", routesImports, 2, routes.slice(0, 80)),
      check("handlers imports utils", handlersImports, 2, handlers.slice(0, 80)),
      check("middleware imports utils", middlewareImports, 2, middleware.slice(0, 80)),
      check("no duplication in original files", noDuplication, 3),
      check("original functionality intact", functionalityIntact, 2),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
