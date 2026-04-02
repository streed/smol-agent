/**
 * File-based logging utility for smol-agent.
 *
 * Writes structured logs to .smol-agent/state/agent.log with:
 *   - Timestamp in ISO format
 *   - Log level (debug, info, warn, error)
 *   - Process ID for debugging
 *
 * Log level controlled by SMOL_AGENT_LOG_LEVEL env var (default: info).
 *
 * Key exports:
 *   - logger: Main logger object with debug/info/warn/error methods
 *   - setLogBaseDir(dir): Set log directory (call early with jail dir)
 *
 * Dependencies: node:fs, node:path, ./errors.js
 * Depended on by: Most src/ files
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyError } from './errors.js';

// Log levels in order of severity
export const LEVELS: Record<LogLevelName, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Log level names type
export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

// Get log level from environment or default to info
const LOG_LEVEL = (process.env.SMOL_AGENT_LOG_LEVEL as LogLevelName) || 'info';

// Deferred log path resolution — resolves on first write or when setBaseDir is called.
// This prevents writing logs to the wrong directory when -d flag is used.
let _baseDir: string | null = null;
let _logFilePath: string | null = null;

function getLogFilePath(): string {
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
function formatMessage(level: LogLevelName, message: string): string {
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  return `[${timestamp}] [${level.toUpperCase().padEnd(7)}] [PID:${pid}] ${message}`;
}

/**
 * Write a log entry to the log file
 */
function writeLog(level: LogLevelName, message: string): void {
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
export function setLogBaseDir(dir: string): void {
  _baseDir = dir;
  _logFilePath = null; // Reset so next write re-resolves
}

/**
 * Logger interface
 */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setLevel(newLevel: LogLevelName): void;
  getLevel(): string;
  log(level: LogLevelName, message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Create a logger instance with configurable level
 */
export function createLogger(level: LogLevelName = LOG_LEVEL): Logger {
  let minLevel = LEVELS[level] ?? LEVELS.info;

  return {
    debug(message: string): void {
      if (minLevel <= LEVELS.debug) {
        writeLog('debug', message);
      }
    },

    info(message: string): void {
      if (minLevel <= LEVELS.info) {
        writeLog('info', message);
      }
    },

    warn(message: string): void {
      if (minLevel <= LEVELS.warn) {
        writeLog('warn', message);
      }
    },

    error(message: string): void {
      // Always log errors, regardless of level
      writeLog('error', message);
    },

    // Utility methods
    setLevel(newLevel: LogLevelName): void {
      // Closure captures `minLevel` from createLogger scope — must be `let`
      minLevel = LEVELS[newLevel] ?? LEVELS.info;
    },

    getLevel(): string {
      const levelName = (Object.keys(LEVELS) as LogLevelName[]).find(key => LEVELS[key] === minLevel);
      return levelName || 'unknown';
    },

    // Advanced logging with metadata
    log(level: LogLevelName, message: string, metadata: Record<string, unknown> = {}): void {
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
export const logger: Logger = createLogger();

/**
 * Format an error with stack trace for logging
 */
export function formatError(err: unknown): string {
  if (!err || !(err instanceof Error) || !err.stack) {
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
export function isTransientError(err: unknown): boolean {
  return classifyError(err) === 'transient';
}

/**
 * Read recent log entries from the log file.
 * @param maxLines - Maximum number of lines to read (from end of file)
 * @returns Log content or empty string if file doesn't exist
 */
export function readRecentLogs(maxLines: number = 500): string {
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
 * @returns Path to the log file
 */
export function getLogPath(): string {
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