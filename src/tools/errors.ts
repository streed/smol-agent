/**
 * Standardized error codes and error class for tool execution.
 *
 * Provides consistent error structure across all tools, enabling:
 *   - Programmatic error handling and recovery
 *   - Better error logging and debugging
 *   - Agent can parse error codes for intelligent retry/recovery
 *
 * Error codes:
 *   - FILE_NOT_FOUND: File or path doesn't exist
 *   - PATH_NOT_ALLOWED: Path outside jail directory
 *   - PERMISSION_DENIED: User denied approval
 *   - INVALID_INPUT: Invalid tool arguments
 *   - VALIDATION_FAILED: Argument validation failed
 *   - TIMEOUT: Operation exceeded timeout
 *   - EXECUTION_FAILED: Command execution failed
 *   - COMMAND_BLOCKED: Command blocked by security policy
 *   - TOOL_NOT_FOUND: Unknown tool name
 *
 * Key exports:
 *   - ToolError class: Standardized error with code and message
 *   - ToolErrorCode enum: All error codes
 *   - isRetryable(code): Check if error is retryable
 *
 * @file-doc
 * @module tools/errors
 * @dependents src/agent.js, src/tools/base-tool.js, src/tools/file_tools.js,
 *             src/tools/registry.js, src/tools/sub_agent.js, test/unit/tool-errors.test.js
 */

/**
 * Standardized error codes for tool execution.
 * Enables programmatic error handling and recovery.
 */
export const ToolErrorCode = {
  // File operations
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',

  // Permissions
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  // Input validation
  INVALID_INPUT: 'INVALID_INPUT',
  VALIDATION_FAILED: 'VALIDATION_FAILED',

  // Execution
  TIMEOUT: 'TIMEOUT',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  COMMAND_BLOCKED: 'COMMAND_BLOCKED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',

  // Tool registry
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',

  // Network
  NETWORK_ERROR: 'NETWORK_ERROR',

  // State
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  INVALID_STATE: 'INVALID_STATE'
} as const;

export type ToolErrorCodeType = typeof ToolErrorCode[keyof typeof ToolErrorCode];

/**
 * Error code descriptions for human-readable messages.
 */
const ErrorCodeDescriptions: Record<string, string> = {
  [ToolErrorCode.FILE_NOT_FOUND]: 'The specified file was not found',
  [ToolErrorCode.PATH_NOT_ALLOWED]: 'The specified path is not allowed',
  [ToolErrorCode.PERMISSION_DENIED]: 'Permission denied for this operation',
  [ToolErrorCode.INVALID_INPUT]: 'Invalid input provided',
  [ToolErrorCode.VALIDATION_FAILED]: 'Validation failed',
  [ToolErrorCode.TIMEOUT]: 'Operation timed out',
  [ToolErrorCode.EXECUTION_FAILED]: 'Execution failed',
  [ToolErrorCode.COMMAND_BLOCKED]: 'Command is blocked for security',
  [ToolErrorCode.NOT_IMPLEMENTED]: 'Feature not implemented',
  [ToolErrorCode.TOOL_NOT_FOUND]: 'Requested tool not found',
  [ToolErrorCode.NETWORK_ERROR]: 'Network error occurred',
  [ToolErrorCode.NOT_FOUND]: 'Resource not found',
  [ToolErrorCode.ALREADY_EXISTS]: 'Resource already exists',
  [ToolErrorCode.INVALID_STATE]: 'Invalid state for this operation'
};

/**
 * Standardized error class for tools.
 * Provides consistent error structure with codes and details.
 *
 * @example
 * throw new ToolError(ToolErrorCode.FILE_NOT_FOUND, 'File not found', { path: '/test/file.js' });
 *
 * @example
 * const error = ToolError.fileNotFound('/test/file.js');
 * throw error;
 */
export class ToolError extends Error {
  code: ToolErrorCodeType;
  details: Record<string, unknown> | null;

  /**
   * Create a ToolError.
   * @param code - Error code from ToolErrorCode
   * @param message - Human-readable error message
   * @param details - Additional error details
   */
  constructor(code: ToolErrorCodeType, message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }

  /**
   * Get human-readable description of error code.
   */
  getDescription(): string {
    return ErrorCodeDescriptions[this.code] || 'Unknown error';
  }

  /**
   * Convert to JSON-serializable object.
   */
  toJSON(): { name: string; code: string; message: string; description: string; details: Record<string, unknown> | null } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      description: this.getDescription(),
      details: this.details
    };
  }

  // ============ Factory Methods ============

  /**
   * Create FILE_NOT_FOUND error.
   */
  static fileNotFound(path: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.FILE_NOT_FOUND,
      `File not found: ${path}`,
      { path, ...details }
    );
  }

  /**
   * Create PATH_NOT_ALLOWED error.
   */
  static pathNotAllowed(path: string, reason: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.PATH_NOT_ALLOWED,
      reason,
      { path, reason, ...details }
    );
  }

  /**
   * Create PERMISSION_DENIED error.
   */
  static permissionDenied(resource: string, reason: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.PERMISSION_DENIED,
      reason,
      { resource, reason, ...details }
    );
  }

  /**
   * Create INVALID_INPUT error.
   */
  static invalidInput(message: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.INVALID_INPUT,
      message,
      details
    );
  }

  /**
   * Create VALIDATION_FAILED error.
   */
  static validationFailed(errors: string[], details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.VALIDATION_FAILED,
      errors.join(', '),
      { errors, ...details }
    );
  }

  /**
   * Create TIMEOUT error.
   */
  static timeout(operation: string, timeoutMs: number, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.TIMEOUT,
      `${operation} timed out after ${timeoutMs}ms`,
      { operation, timeout: timeoutMs, ...details }
    );
  }

  /**
   * Create EXECUTION_FAILED error.
   */
  static executionFailed(message: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.EXECUTION_FAILED,
      message,
      details
    );
  }

  /**
   * Create COMMAND_BLOCKED error.
   */
  static commandBlocked(command: string, reason: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.COMMAND_BLOCKED,
      `Command blocked: ${reason}`,
      { command, reason, ...details }
    );
  }

  /**
   * Create TOOL_NOT_FOUND error.
   */
  static toolNotFound(toolName: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.TOOL_NOT_FOUND,
      `Tool not found: ${toolName}`,
      { tool: toolName, ...details }
    );
  }

  /**
   * Create NOT_IMPLEMENTED error.
   */
  static notImplemented(toolName: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.NOT_IMPLEMENTED,
      `Not implemented: ${toolName}`,
      { tool: toolName, ...details }
    );
  }

  /**
   * Create NETWORK_ERROR.
   */
  static networkError(operation: string, reason: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.NETWORK_ERROR,
      `Network error during ${operation}: ${reason}`,
      { operation, reason, ...details }
    );
  }

  /**
   * Create NOT_FOUND error.
   */
  static notFound(resource: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.NOT_FOUND,
      `${resource} not found`,
      { resource, ...details }
    );
  }

  /**
   * Create ALREADY_EXISTS error.
   */
  static alreadyExists(resource: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.ALREADY_EXISTS,
      `${resource} already exists`,
      { resource, ...details }
    );
  }

  /**
   * Create INVALID_STATE error.
   */
  static invalidState(state: string, expected: string, details: Record<string, unknown> | null = null): ToolError {
    return new ToolError(
      ToolErrorCode.INVALID_STATE,
      `Invalid state: ${state}. Expected: ${expected}`,
      { state, expected, ...details }
    );
  }
}

/**
 * Check if an error code is retryable.
 * Retryable errors are transient failures that may succeed on retry.
 */
export function isRetryable(code: ToolErrorCodeType): boolean {
  const RETRYABLE_CODES: Set<string> = new Set([
    ToolErrorCode.TIMEOUT,
    ToolErrorCode.NETWORK_ERROR,
    ToolErrorCode.EXECUTION_FAILED, // May be transient
  ]);
  return RETRYABLE_CODES.has(code);
}

/**
 * Convert any error to a standardized result object.
 * Used by tools to return consistent error responses.
 */
export interface ErrorResult {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function errorToResult(error: unknown): ErrorResult {
  if (error instanceof ToolError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details || undefined,
      }
    };
  }
  if (error instanceof Error) {
    return {
      error: {
        code: ToolErrorCode.EXECUTION_FAILED,
        message: error.message || 'Unknown error',
        details: null,
      }
    };
  }
  return {
    error: {
      code: ToolErrorCode.EXECUTION_FAILED,
      message: String(error) || 'Unknown error',
      details: null,
    }
  };
}

/**
 * Check if an error is a ToolError.
 */
export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

/**
 * Check if an error has a specific error code.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof ToolError && error.code === code;
}

/**
 * Format an error for display.
 */
export function formatError(error: unknown): string {
  if (error instanceof ToolError) {
    return `[${error.code}] ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message || 'Unknown error';
  }
  return String(error) || 'Unknown error';
}