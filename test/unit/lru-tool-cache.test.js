/**
 * Unit tests for LRU tool cache.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { LRUToolCache } from '../../src/lru-tool-cache.js';

describe('LRUToolCache', () => {
  let cache;

  beforeEach(() => {
    cache = new LRUToolCache({ maxTools: 3 });
  });

  describe('basic operations', () => {
    test('touch tracks a tool', () => {
      cache.touch('read_file');
      expect(cache.getActive().has('read_file')).toBe(true);
    });

    test('warm adds tool without incrementing use count', () => {
      cache.warm('grep');
      const active = cache.getActive();
      expect(active.has('grep')).toBe(true);
    });

    test('warm does not overwrite existing tracking', () => {
      cache.touch('grep');
      cache.warm('grep'); // should not reset
      expect(cache.getActive().has('grep')).toBe(true);
    });

    test('pin prevents eviction', () => {
      cache.pin('read_file');
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d');
      cache.touch('read_file');

      const evicted = cache.evict();
      expect(evicted).not.toContain('read_file');
      expect(cache.isEvicted('read_file')).toBe(false);
    });

    test('pinAll pins multiple tools', () => {
      cache.pinAll(['read_file', 'write_file']);
      // Fill beyond capacity
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d');
      cache.touch('read_file');
      cache.touch('write_file');

      cache.evict();
      expect(cache.isEvicted('read_file')).toBe(false);
      expect(cache.isEvicted('write_file')).toBe(false);
    });
  });

  describe('eviction', () => {
    test('evicts LRU tools when over capacity', () => {
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d'); // 4 tools, max is 3

      const evicted = cache.evict();
      expect(evicted).toEqual(['a']); // oldest
      expect(cache.isEvicted('a')).toBe(true);
      expect(cache.isEvicted('d')).toBe(false);
    });

    test('evicts multiple tools when far over capacity', () => {
      cache = new LRUToolCache({ maxTools: 2 });
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d');
      cache.touch('e');

      const evicted = cache.evict();
      expect(evicted.length).toBe(3); // 5 - 2 = 3
      expect(evicted).toContain('a');
      expect(evicted).toContain('b');
      expect(evicted).toContain('c');
      expect(cache.isEvicted('d')).toBe(false);
      expect(cache.isEvicted('e')).toBe(false);
    });

    test('touch moves tool to most-recently-used', () => {
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('a'); // re-touch 'a', now 'b' is LRU
      cache.touch('d'); // 4 tools, need to evict 1

      const evicted = cache.evict();
      expect(evicted).toEqual(['b']); // 'b' is now the oldest
    });

    test('pinned tools are excluded from eviction count', () => {
      cache.pin('pinned1');
      cache.pin('pinned2');
      cache.warm('pinned1');
      cache.warm('pinned2');
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      // 5 total, but 2 are pinned → 3 non-pinned, at capacity
      const evicted = cache.evict();
      expect(evicted.length).toBe(0);
    });

    test('does not evict when at or under capacity', () => {
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      const evicted = cache.evict();
      expect(evicted.length).toBe(0);
    });
  });

  describe('TTL-based eviction', () => {
    test('evicts tools that exceed TTL', () => {
      cache = new LRUToolCache({ maxTools: 10, ttl: 100 });

      // Manually set old timestamps
      cache._usage.set('old_tool', { lastUsed: Date.now() - 200, useCount: 1 });
      cache._usage.set('new_tool', { lastUsed: Date.now(), useCount: 1 });

      const evicted = cache.evict();
      expect(evicted).toContain('old_tool');
      expect(evicted).not.toContain('new_tool');
    });

    test('TTL does not evict pinned tools', () => {
      cache = new LRUToolCache({ maxTools: 10, ttl: 100 });
      cache.pin('important');
      cache._usage.set('important', { lastUsed: Date.now() - 200, useCount: 1 });

      const evicted = cache.evict();
      expect(evicted).not.toContain('important');
    });
  });

  describe('reactivation', () => {
    test('touch re-activates evicted tool', () => {
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d');
      cache.evict(); // evicts 'a'
      expect(cache.isEvicted('a')).toBe(true);

      cache.touch('a'); // re-activate
      expect(cache.isEvicted('a')).toBe(false);
    });

    test('reactivate explicitly re-activates', () => {
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d');
      cache.evict();
      expect(cache.isEvicted('a')).toBe(true);

      cache.reactivate('a');
      expect(cache.isEvicted('a')).toBe(false);
    });

    test('reactivateAll re-activates multiple', () => {
      cache = new LRUToolCache({ maxTools: 1 });
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.evict();

      cache.reactivateAll(['a', 'b']);
      expect(cache.isEvicted('a')).toBe(false);
      expect(cache.isEvicted('b')).toBe(false);
    });
  });

  describe('filterTools', () => {
    test('removes evicted tools from array', () => {
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d');
      cache.evict(); // evicts 'a'

      const tools = [
        { type: 'function', function: { name: 'a' } },
        { type: 'function', function: { name: 'b' } },
        { type: 'function', function: { name: 'c' } },
        { type: 'function', function: { name: 'd' } },
      ];

      const filtered = cache.filterTools(tools);
      expect(filtered.length).toBe(3);
      expect(filtered.map(t => t.function.name)).toEqual(['b', 'c', 'd']);
    });

    test('passes all tools when none evicted', () => {
      cache.touch('a');
      cache.touch('b');

      const tools = [
        { type: 'function', function: { name: 'a' } },
        { type: 'function', function: { name: 'b' } },
      ];

      const filtered = cache.filterTools(tools);
      expect(filtered.length).toBe(2);
    });
  });

  describe('describeEvicted', () => {
    test('returns empty string when nothing evicted', () => {
      const registry = new Map();
      expect(cache.describeEvicted(registry)).toBe('');
    });

    test('describes evicted tools with descriptions', () => {
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d');
      cache.evict();

      const registry = new Map([
        ['a', { description: 'Tool A does stuff. More details.' }],
      ]);

      const desc = cache.describeEvicted(registry);
      expect(desc).toContain('a: Tool A does stuff');
    });
  });

  describe('stats and reset', () => {
    test('getStats returns correct counts', () => {
      cache.pin('pinned');
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d');
      cache.warm('pinned');
      cache.evict();

      const stats = cache.getStats();
      expect(stats.pinned).toBe(1);
      expect(stats.evicted).toBe(1);
      expect(stats.total).toBe(5);
      expect(stats.active).toBe(4); // 5 total - 1 evicted
    });

    test('reset clears all state', () => {
      cache.touch('a');
      cache.touch('b');
      cache.touch('c');
      cache.touch('d');
      cache.evict();

      cache.reset();
      expect(cache.getActive().size).toBe(0);
      expect(cache.getEvicted().size).toBe(0);
    });
  });
});
