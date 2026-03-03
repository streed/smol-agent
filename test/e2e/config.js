/**
 * E2E test configuration — model, host, timeout, and tuning constants.
 *
 * All values can be overridden via environment variables.
 */

export const config = {
  model: process.env.SMOL_TEST_MODEL || "glm-5:cloud",
  host: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",

  // Per-scenario timeout tiers (ms)
  timeouts: {
    simple: 60_000,
    medium: 120_000,
    complex: 180_000,
  },

  // Max agent loop iterations per run — prevents runaway loops
  maxIterations: parseInt(process.env.SMOL_TEST_MAX_ITER, 10) || 30,

  // Context size for test agents — smaller than default 128k for speed
  contextSize: parseInt(process.env.SMOL_TEST_CTX, 10) || 32768,

  // Number of retry attempts per scenario (best score wins)
  retries: parseInt(process.env.SMOL_TEST_RETRIES, 10) || 2,
};
