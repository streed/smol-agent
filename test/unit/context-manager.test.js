/**
 * Unit tests for ContextManager — message ordering sanitization.
 *
 * Validates that pruneMessages, summarizeOldMessages, and handleOverflow
 * never produce sequences where a 'tool' message follows a 'user' message.
 */

import { describe, test, expect } from '@jest/globals';
import { ContextManager } from '../../src/context-manager.js';

/** Helper: check no tool message is preceded by a non-tool, non-assistant-with-tool_calls message */
function assertValidOrder(messages, _label) {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
      const prev = messages[i - 1];
      const ok = prev.role === 'tool' || (prev.role === 'assistant' && prev.tool_calls);
      expect(ok).toBeTruthy();
    }
  }
}

describe('ContextManager — message ordering after pruning', () => {
  test('pruneMessages drops orphaned tool messages', () => {
    const cm = new ContextManager(2000); // tiny budget to force pruning

    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: 'Sure', tool_calls: [{ function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: JSON.stringify({ output: 'x'.repeat(500) }) },
      { role: 'tool', content: JSON.stringify({ output: 'y'.repeat(500) }) },
      { role: 'user', content: 'Next thing' },
      { role: 'assistant', content: 'Ok', tool_calls: [{ function: { name: 'list_files', arguments: '{}' } }] },
      { role: 'tool', content: JSON.stringify({ output: 'z'.repeat(500) }) },
      { role: 'user', content: 'Latest request' },
      { role: 'assistant', content: 'Done!' },
    ];

    const { messages: pruned } = cm.pruneMessages(messages, { aggressive: true });
    assertValidOrder(pruned, 'pruneMessages aggressive');
  });

  test('handleOverflow produces valid ordering', () => {
    const cm = new ContextManager(1500);

    // Build a conversation where slicing from the end would start with tool messages
    const messages = [
      { role: 'system', content: 'System.' },
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'A1', tool_calls: [{ function: { name: 't1', arguments: '{}' } }] },
      { role: 'tool', content: JSON.stringify({ output: 'big'.repeat(200) }) },
      { role: 'tool', content: JSON.stringify({ output: 'big'.repeat(200) }) },
      { role: 'tool', content: JSON.stringify({ output: 'big'.repeat(200) }) },
      { role: 'user', content: 'Second' },
      { role: 'assistant', content: 'A2' },
    ];

    const result = cm.handleOverflow(messages);
    assertValidOrder(result, 'handleOverflow');
  });

  test('summarizeOldMessages produces valid ordering', async () => {
    const cm = new ContextManager(3000);

    // Create enough messages that summarization will trigger
    const messages = [
      { role: 'system', content: 'System prompt '.repeat(50) },
      { role: 'user', content: 'First request' },
      { role: 'assistant', content: 'Response 1', tool_calls: [{ function: { name: 'f1', arguments: '{}' } }] },
      { role: 'tool', content: JSON.stringify({ output: 'data '.repeat(100) }) },
      { role: 'user', content: 'Second request' },
      { role: 'assistant', content: 'Response 2', tool_calls: [{ function: { name: 'f2', arguments: '{}' } }] },
      { role: 'tool', content: JSON.stringify({ output: 'data '.repeat(100) }) },
      { role: 'user', content: 'Third request' },
      { role: 'assistant', content: 'Response 3', tool_calls: [{ function: { name: 'f3', arguments: '{}' } }] },
      { role: 'tool', content: JSON.stringify({ output: 'data '.repeat(100) }) },
      { role: 'user', content: 'Latest request' },
      { role: 'assistant', content: 'Final answer' },
    ];

    const { messages: result } = await cm.summarizeOldMessages(messages);
    assertValidOrder(result, 'summarizeOldMessages');
  });

  test('valid sequences are preserved unchanged', () => {
    const cm = new ContextManager(200000);

    const messages = [
      { role: 'system', content: 'System.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi', tool_calls: [{ function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', content: '{"ok":true}' },
      { role: 'assistant', content: 'Done' },
    ];

    const { messages: result, pruned } = cm.pruneMessages(messages);
    expect(pruned).toBe(0);
    expect(result.length).toBe(messages.length);
  });
});