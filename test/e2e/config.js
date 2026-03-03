/**
 * E2E test configuration — model, host, timeout, and tuning constants.
 *
 * All values can be overridden via environment variables.
 */

export const config = {
  model: process.env.SMOL_TEST_MODEL || "glm-5:cloud",
  host: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",

  // Per-scenario timeout tiers (ms) — can be overridden via env vars
  // Defaults are generous for small/slow models
  timeouts: {
    simple: parseInt(process.env.SMOL_TEST_TIMEOUT_SIMPLE, 10) || 300_000,   // 5 min
    medium: parseInt(process.env.SMOL_TEST_TIMEOUT_MEDIUM, 10) || 600_000,   // 10 min
    complex: parseInt(process.env.SMOL_TEST_TIMEOUT_COMPLEX, 10) || 900_000, // 15 min
  },

  // Max agent loop iterations per run — prevents runaway loops
  maxIterations: parseInt(process.env.SMOL_TEST_MAX_ITER, 10) || 30,

  // Context size for test agents — smaller than default 128k for speed
  contextSize: parseInt(process.env.SMOL_TEST_CTX, 10) || 32768,

  // Number of retry attempts per scenario (best score wins)
  retries: parseInt(process.env.SMOL_TEST_RETRIES, 10) || 2,
};
