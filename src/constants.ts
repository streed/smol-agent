/**
 * Centralized constants for smol-agent.
 *
 * This file contains all magic numbers and configuration values
 * used throughout the codebase. Extracting them here makes it
 * easier to tune behavior and understand configuration.
 *
 * Categories of constants:
 * - Agent configuration: MAX_ITERATIONS, DEFAULT_CONTEXT_SIZE, LARGE_MODEL_THRESHOLD
 * - Context management: SUMMARIZE_THRESHOLD_PERCENT, PRUNE_THRESHOLD_PERCENT
 * - Tool settings: MAX_TOOL_FAILURES, MAX_TOOL_RESULT_SIZE
 * - Streaming: MAX_STREAM_RETRIES, STREAM_RETRY_DELAY_MS
 * - LRU cache: TOOL_HISTORY_SIZE
 *
 * Dependencies: None (pure constants)
 * Depended on by: src/agent.js, src/architect.js, src/context-manager.js,
 *                 src/providers/ollama.js, src/providers/openai-compatible.js,
 *                 src/repo-map.js, test/e2e/config.js
 */

// ── Agent Configuration ─────────────────────────────────────────────────────

/**
 * Maximum number of iterations in the agent loop before stopping.
 * Prevents infinite loops when the model keeps making tool calls.
 * Set to 1000 to allow complex multi-step tasks to complete.
 */
export const MAX_ITERATIONS = 1000;

/**
 * Default context window size in tokens for smaller models.
 * Used when provider doesn't report token limits.
 */
export const DEFAULT_CONTEXT_SIZE = 32000;

/**
 * Context window size for large models (30B+ parameters).
 * These models typically have larger context windows.
 */
export const LARGE_MODEL_CONTEXT_SIZE = 128000;

/**
 * Default max tokens for API requests.
 * Used when provider doesn't specify token limits.
 */
export const DEFAULT_MAX_TOKENS = 128000;

/**
 * Threshold (in parameters) to consider a model "large".
 * Models >= 30B parameters get expanded tool access.
 */
export const LARGE_MODEL_THRESHOLD = 30_000_000_000; // 30B

// ── Context Management ─────────────────────────────────────────────────────

/**
 * Percentage of context capacity to trigger summarization.
 * At this point, older messages are summarized to save space.
 */
export const SUMMARIZE_THRESHOLD_PERCENT = 0.55; // 55%

/**
 * Percentage of context capacity to trigger pruning.
 * At this point, older messages are removed entirely.
 */
export const PRUNE_THRESHOLD_PERCENT = 0.70; // 70%

/**
 * Minimum messages to keep when pruning context.
 * Ensures recent conversation isn't lost.
 */
export const MIN_MESSAGES_TO_KEEP = 4;

/**
 * Maximum characters for tool result truncation.
 * Large outputs are truncated to prevent context overflow.
 */
export const MAX_TOOL_RESULT_CHARS = 50000;

/**
 * Maximum tokens for a single tool result.
 * Approximate limit for streaming responses.
 */
export const MAX_TOOL_RESULT_TOKENS = 10000;

// ── Token Estimation ───────────────────────────────────────────────────────

/**
 * Characters per token approximation for estimation.
 * Used when exact token counting isn't available.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Overhead tokens per message (role, formatting).
 * Added to content tokens for total message size.
 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

// ── Tool Execution ─────────────────────────────────────────────────────────

/**
 * Default timeout for tool execution in milliseconds.
 * Tools that take longer are aborted.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Maximum timeout allowed for any tool.
 * Prevents excessively long timeouts.
 */
export const MAX_TOOL_TIMEOUT_MS = 300000; // 5 minutes

/**
 * Default timeout for shell commands.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

// ── Retry Configuration ────────────────────────────────────────────────────

/**
 * Maximum number of retry attempts for transient errors.
 */
export const MAX_RETRIES = 3;

/**
 * Base delay between retries in milliseconds.
 * Actual delay uses exponential backoff.
 */
export const RETRY_DELAY_MS = 1000;

/**
 * Maximum delay between retries.
 * Caps exponential backoff.
 */
export const MAX_RETRY_DELAY_MS = 10000;

// ── Circuit Breaker ────────────────────────────────────────────────────────

/**
 * Number of failures before opening circuit breaker.
 */
export const CIRCUIT_BREAKER_THRESHOLD = 5;

/**
 * Time in ms before attempting to close circuit breaker.
 */
export const CIRCUIT_BREAKER_RESET_MS = 60000; // 1 minute

// ── Rate Limiting ──────────────────────────────────────────────────────────

/**
 * Maximum requests per minute for API calls.
 */
export const RATE_LIMIT_REQUESTS_PER_MINUTE = 60;

/**
 * Maximum tokens per minute for API calls.
 */
export const RATE_LIMIT_TOKENS_PER_MINUTE = 100000;

// ── Session Management ─────────────────────────────────────────────────────

/**
 * Maximum number of sessions to keep in history.
 */
export const MAX_SESSIONS_HISTORY = 100;

/**
 * Session expiry time in milliseconds.
 * Sessions older than this are cleaned up.
 */
export const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Checkpoint Management ──────────────────────────────────────────────────

/**
 * Maximum checkpoints to retain per branch.
 */
export const MAX_CHECKPOINTS_PER_BRANCH = 50;

/**
 * Maximum tool failures before circuit breaking.
 */
export const MAX_TOOL_FAILURES = 3;

/**
 * Maximum stream retry attempts.
 */
export const MAX_STREAM_RETRIES = 2;

/**
 * Delay between stream retries in milliseconds.
 */
export const STREAM_RETRY_DELAY_MS = 1000;

/**
 * Tool call history size for loop detection.
 */
export const TOOL_HISTORY_SIZE = 12;

/**
 * Checkpoint directory name.
 */
export const CHECKPOINT_DIR = ".smol-agent/checkpoints";

// ── Memory Bank ────────────────────────────────────────────────────────────

/**
 * Memory bank file names.
 */
export const MEMORY_BANK_FILES = [
  "projectContext.md",
  "techContext.md",
  "progress.md",
  "learnings.md"
];

// ── UI Configuration ───────────────────────────────────────────────────────

/**
 * Maximum lines to display in scrollable areas.
 */
export const MAX_DISPLAY_LINES = 1000;

/**
 * Debounce time for UI updates in milliseconds.
 */
export const UI_DEBOUNCE_MS = 100;

/**
 * Spinner frame interval in milliseconds.
 */
export const SPINNER_INTERVAL_MS = 80;

// ── Cross-Agent Communication ──────────────────────────────────────────────

/**
 * Default timeout for cross-agent letter replies.
 */
export const DEFAULT_LETTER_TIMEOUT_MS = 600000; // 10 minutes

/**
 * Maximum timeout for letter delivery.
 */
export const MAX_LETTER_TIMEOUT_MS = 3600000; // 1 hour

/**
 * Directory for agent inboxes.
 */
export const INBOX_DIR = ".smol-agent/inbox";

/**
 * Directory for agent outboxes.
 */
export const OUTBOX_DIR = ".smol-agent/outbox";

/**
 * Directory for agent state.
 */
export const STATE_DIR = ".smol-agent/state";

/**
 * Directory for agent registry.
 */
export const REGISTRY_DIR = ".smol-agent/registry";

/**
 * Directory for agent memory.
 */
export const MEMORY_DIR = ".smol-agent/memory";

/**
 * Directory for memory bank.
 */
export const MEMORY_BANK_DIR = ".smol-agent/memory-bank";

/**
 * File for agent memory.
 */
export const MEMORY_FILE = "memory.json";

/**
 * Global registry file for agent discovery.
 */
export const REGISTRY_FILE = "registry.json";

/**
 * Global config directory for user-level settings.
 */
export const GLOBAL_CONFIG_DIR = ".config/smol-agent";

/**
 * Directory for skills.
 */
export const SKILLS_DIR = ".smol-agent/skills";

/**
 * Directory for documentation.
 */
export const DOCS_DIR = ".smol-agent/docs";