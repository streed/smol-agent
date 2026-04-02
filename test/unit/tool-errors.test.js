/**
 * Unit tests for tool errors module.
 *
 * Tests ToolError class and error utilities:
 * - ToolError creation and factory methods
 * - errorToResult conversion
 * - Error code checking utilities
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { ToolError, ToolErrorCode, errorToResult, isToolError, hasErrorCode, formatError } from '../../src/tools/errors.js';

describe('ToolError', () => {
  test('creates error with code and message', () => {
    const error = new ToolError(ToolErrorCode.FILE_NOT_FOUND, 'File not found');
    expect(error.code).toBe(ToolErrorCode.FILE_NOT_FOUND);
    expect(error.message).toBe('File not found');
    expect(error.name).toBe('ToolError');
  });

  test('creates error with details', () => {
    const error = new ToolError(ToolErrorCode.INVALID_INPUT, 'Bad input', { field: 'path' });
    expect(error.details).toEqual({ field: 'path' });
  });

  test('getDescription returns human-readable message', () => {
    const error = new ToolError(ToolErrorCode.FILE_NOT_FOUND, 'File not found');
    expect(error.getDescription()).toBe('The specified file was not found');
  });

  test('toJSON returns serializable object', () => {
    const error = new ToolError(ToolErrorCode.FILE_NOT_FOUND, 'File not found', { path: '/test' });
    const json = error.toJSON();
    expect(json.code).toBe(ToolErrorCode.FILE_NOT_FOUND);
    expect(json.message).toBe('File not found');
    expect(json.details).toEqual({ path: '/test' });
  });

  describe('factory methods', () => {
    test('fileNotFound creates correct error', () => {
      const error = ToolError.fileNotFound('/test/file.js');
      expect(error.code).toBe(ToolErrorCode.FILE_NOT_FOUND);
      expect(error.message).toContain('/test/file.js');
      expect(error.details.path).toBe('/test/file.js');
    });

    test('pathNotAllowed creates correct error', () => {
      const error = ToolError.pathNotAllowed('/etc/passwd', 'Outside jail directory');
      expect(error.code).toBe(ToolErrorCode.PATH_NOT_ALLOWED);
      expect(error.message).toBe('Outside jail directory');
      expect(error.details.path).toBe('/etc/passwd');
    });

    test('permissionDenied creates correct error', () => {
      const error = ToolError.permissionDenied('/secret', 'Access denied');
      expect(error.code).toBe(ToolErrorCode.PERMISSION_DENIED);
      expect(error.details.resource).toBe('/secret');
    });

    test('invalidInput creates correct error', () => {
      const error = ToolError.invalidInput('Invalid path', { path: '' });
      expect(error.code).toBe(ToolErrorCode.INVALID_INPUT);
      expect(error.message).toBe('Invalid path');
    });

    test('validationFailed creates correct error', () => {
      const error = ToolError.validationFailed(['Missing field', 'Invalid type']);
      expect(error.code).toBe(ToolErrorCode.VALIDATION_FAILED);
      expect(error.message).toContain('Missing field');
      expect(error.details.errors).toHaveLength(2);
    });

    test('timeout creates correct error', () => {
      const error = ToolError.timeout('run_command', 30000);
      expect(error.code).toBe(ToolErrorCode.TIMEOUT);
      expect(error.message).toContain('30000ms');
      expect(error.details.timeout).toBe(30000);
    });

    test('executionFailed creates correct error', () => {
      const error = ToolError.executionFailed('Command failed', { exitCode: 1 });
      expect(error.code).toBe(ToolErrorCode.EXECUTION_FAILED);
      expect(error.details.exitCode).toBe(1);
    });

    test('commandBlocked creates correct error', () => {
      const error = ToolError.commandBlocked('rm -rf /', 'Destructive command');
      expect(error.code).toBe(ToolErrorCode.COMMAND_BLOCKED);
      expect(error.details.command).toBe('rm -rf /');
    });

    test('notImplemented creates correct error', () => {
      const error = ToolError.notImplemented('web_search');
      expect(error.code).toBe(ToolErrorCode.NOT_IMPLEMENTED);
      expect(error.message).toContain('web_search');
    });

    test('toolNotFound creates correct error', () => {
      const error = ToolError.toolNotFound('unknown_tool');
      expect(error.code).toBe(ToolErrorCode.TOOL_NOT_FOUND);
      expect(error.details.tool).toBe('unknown_tool');
    });

    test('networkError creates correct error', () => {
      const error = ToolError.networkError('Connection refused');
      expect(error.code).toBe(ToolErrorCode.NETWORK_ERROR);
    });

    test('notFound creates correct error', () => {
      const error = ToolError.notFound('session_123');
      expect(error.code).toBe(ToolErrorCode.NOT_FOUND);
    });

    test('alreadyExists creates correct error', () => {
      const error = ToolError.alreadyExists('file.txt');
      expect(error.code).toBe(ToolErrorCode.ALREADY_EXISTS);
    });

    test('invalidState creates correct error', () => {
      const error = ToolError.invalidState('No active plan');
      expect(error.code).toBe(ToolErrorCode.INVALID_STATE);
    });
  });
});

describe('errorToResult', () => {
  test('converts ToolError to result', () => {
    const error = new ToolError(ToolErrorCode.FILE_NOT_FOUND, 'Not found', { path: '/test' });
    const result = errorToResult(error);
    expect(result.error.code).toBe(ToolErrorCode.FILE_NOT_FOUND);
    expect(result.error.message).toBe('Not found');
    expect(result.error.details.path).toBe('/test');
  });

  test('converts Error to result', () => {
    const error = new Error('Something went wrong');
    const result = errorToResult(error);
    expect(result.error.code).toBe(ToolErrorCode.EXECUTION_FAILED);
    expect(result.error.message).toBe('Something went wrong');
    expect(result.error.details).toBeNull();
  });

  test('handles Error with no message', () => {
    const error = new Error();
    const result = errorToResult(error);
    expect(result.error.message).toBe('Unknown error');
  });
});

describe('isToolError', () => {
  test('returns true for ToolError', () => {
    const error = new ToolError(ToolErrorCode.FILE_NOT_FOUND, 'Not found');
    expect(isToolError(error)).toBe(true);
  });

  test('returns false for Error', () => {
    const error = new Error('Not found');
    expect(isToolError(error)).toBe(false);
  });
});

describe('hasErrorCode', () => {
  test('returns true when code matches', () => {
    const error = new ToolError(ToolErrorCode.FILE_NOT_FOUND, 'Not found');
    expect(hasErrorCode(error, ToolErrorCode.FILE_NOT_FOUND)).toBe(true);
  });

  test('returns false when code does not match', () => {
    const error = new ToolError(ToolErrorCode.FILE_NOT_FOUND, 'Not found');
    expect(hasErrorCode(error, ToolErrorCode.INVALID_INPUT)).toBe(false);
  });

  test('returns false for non-ToolError', () => {
    const error = new Error('Not found');
    expect(hasErrorCode(error, ToolErrorCode.FILE_NOT_FOUND)).toBe(false);
  });
});

describe('formatError', () => {
  test('formats ToolError with code', () => {
    const error = new ToolError(ToolErrorCode.FILE_NOT_FOUND, 'Not found');
    expect(formatError(error)).toBe('[FILE_NOT_FOUND] Not found');
  });

  test('formats Error without code', () => {
    const error = new Error('Not found');
    expect(formatError(error)).toBe('Not found');
  });

  test('handles Error with no message', () => {
    const error = new Error();
    expect(formatError(error)).toBe('Unknown error');
  });
});

describe('ToolErrorCode', () => {
  test('has all expected codes', () => {
    expect(ToolErrorCode.FILE_NOT_FOUND).toBe('FILE_NOT_FOUND');
    expect(ToolErrorCode.PATH_NOT_ALLOWED).toBe('PATH_NOT_ALLOWED');
    expect(ToolErrorCode.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    expect(ToolErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
    expect(ToolErrorCode.VALIDATION_FAILED).toBe('VALIDATION_FAILED');
    expect(ToolErrorCode.TIMEOUT).toBe('TIMEOUT');
    expect(ToolErrorCode.EXECUTION_FAILED).toBe('EXECUTION_FAILED');
    expect(ToolErrorCode.COMMAND_BLOCKED).toBe('COMMAND_BLOCKED');
    expect(ToolErrorCode.NOT_IMPLEMENTED).toBe('NOT_IMPLEMENTED');
    expect(ToolErrorCode.TOOL_NOT_FOUND).toBe('TOOL_NOT_FOUND');
    expect(ToolErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
    expect(ToolErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ToolErrorCode.ALREADY_EXISTS).toBe('ALREADY_EXISTS');
    expect(ToolErrorCode.INVALID_STATE).toBe('INVALID_STATE');
  });
});