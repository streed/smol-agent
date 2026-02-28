import fs from 'node:fs';
import path from 'node:path';

// Log levels in order of severity
const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Get log level from environment or default to info
const LOG_LEVEL = process.env.SMOL_AGENT_LOG_LEVEL || 'info';
const MIN_LEVEL = LEVELS[LOG_LEVEL] || LEVELS.info;

// Ensure state directory exists
const stateDir = path.join(process.cwd(), '.smol-agent', 'state');
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}

const logFilePath = path.join(stateDir, 'agent.log');

/**
 * Format a log message with timestamp and level
 */
function formatMessage(level, message) {
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  return `[${timestamp}] [${level.toUpperCase().padEnd(7)}] [PID:${pid}] ${message}`;
}

/**
 * Write a log entry to the log file
 */
function writeLog(level, message) {
  try {
    const formatted = formatMessage(level, message);
    fs.appendFileSync(logFilePath, formatted + '\n', 'utf-8');
  } catch (err) {
    // Fallback: don't fail if log writing fails
    console.error(`Failed to write log: ${err.message}`);
  }
}

/**
 * Create a logger instance with configurable level
 */
export function createLogger(level = LOG_LEVEL) {
  let minLevel = LEVELS[level] || LEVELS.info;

  return {
    debug: (message) => {
      if (minLevel <= LEVELS.debug) {
        writeLog('debug', message);
      }
    },

    info: (message) => {
      if (minLevel <= LEVELS.info) {
        writeLog('info', message);
      }
    },

    warn: (message) => {
      if (minLevel <= LEVELS.warn) {
        writeLog('warn', message);
      }
    },

    error: (message) => {
      // Always log errors, regardless of level
      writeLog('error', message);
    },

    // Utility methods
    setLevel: (newLevel) => {
      // Closure captures `minLevel` from createLogger scope — must be `let`
      minLevel = LEVELS[newLevel] ?? LEVELS.info;
    },

    getLevel: () => {
      const levelName = Object.keys(LEVELS).find(key => LEVELS[key] === minLevel);
      return levelName || 'unknown';
    },

    // Advanced logging with metadata
    log: (level, message, metadata = {}) => {
      if (minLevel <= LEVELS[level]) {
        const metaStr = Object.keys(metadata).length > 0 
          ? ` ${JSON.stringify(metadata)}`
          : '';
        writeLog(level, `${message}${metaStr}`);
      }
    },
  };
}

/**
 * Get or create the default logger instance
 */
export const logger = createLogger();

/**
 * Format an error with stack trace for logging
 */
export function formatError(err) {
  if (!err || !err.stack) {
    return String(err);
  }
  
  const lines = [
    `${err.name || 'Error'}: ${err.message}`,
    '',
    'Stack trace:',
    err.stack,
  ];
  
  return lines.join('\n');
}

/**
 * Check if an error is transient (recoverable with retry)
 */
export function isTransientError(err) {
  if (!err) return false;
  
  // Network errors are typically transient
  if (err.code === 'ECONNREFUSED' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNRESET' ||
      err.code === 'ENOTFOUND' ||
      err.code === 'EAI_AGAIN') {
    return true;
  }
  
  // Ollama-specific errors that might be transient
  if (err.message?.includes('timeout') ||
      err.message?.includes('deadline')) {
    return true;
  }
  
  // HTTP 429 (rate limit) and 5xx errors are transient
  if (err.status === 429 ||
      (err.status >= 500 && err.status < 600)) {
    return true;
  }
  
  return false;
}

export default {
  createLogger,
  logger,
  formatError,
  isTransientError,
  LEVELS,
};
