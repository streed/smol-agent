import fs from 'node:fs';
import path from 'node:path';
import { classifyError } from './errors.js';

// Log levels in order of severity
export const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Get log level from environment or default to info
const LOG_LEVEL = process.env.SMOL_AGENT_LOG_LEVEL || 'info';

// Deferred log path resolution — resolves on first write or when setBaseDir is called.
// This prevents writing logs to the wrong directory when -d flag is used.
let _baseDir = null;
let _logFilePath = null;

function getLogFilePath() {
  if (_logFilePath) return _logFilePath;
  const base = _baseDir || process.cwd();
  const stateDir = path.join(base, '.smol-agent', 'state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  _logFilePath = path.join(stateDir, 'agent.log');
  return _logFilePath;
}

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
    fs.appendFileSync(getLogFilePath(), formatted + '\n', 'utf-8');
  } catch {
    // Silently ignore log write failures — don't pollute stderr
  }
}

/**
 * Set the base directory for log files.
 * Call this early in startup when the jail directory is known.
 */
export function setLogBaseDir(dir) {
  _baseDir = dir;
  _logFilePath = null; // Reset so next write re-resolves
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
 * Check if an error is transient (recoverable with retry).
 * @deprecated Use classifyError() from errors.js instead.
 */
export function isTransientError(err) {
  return classifyError(err) === 'transient';
}

/**
 * Read recent log entries from the log file.
 * @param {number} maxLines - Maximum number of lines to read (from end of file)
 * @returns {string} Log content or empty string if file doesn't exist
 */
export function readRecentLogs(maxLines = 500) {
  try {
    const content = fs.readFileSync(getLogFilePath(), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Get the current log file path.
 * @returns {string} Path to the log file
 */
export function getLogPath() {
  return getLogFilePath();
}

export default {
  createLogger,
  logger,
  formatError,
  isTransientError,
  LEVELS,
  readRecentLogs,
  getLogPath,
  setLogBaseDir,
};
