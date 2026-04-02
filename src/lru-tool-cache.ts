/**
 * LRU (Least Recently Used) cache for tool activation.
 *
 * Tracks tool usage and evicts tools that haven't been used recently to free
 * up context space. Pinned tools (core/starter) are never evicted.
 *
 * Evicted tools remain registered and can be re-activated via discover_tools
 * or auto-discovery signals.
 *
 * Key exports:
 *   - LRUToolCache class: Main cache implementation
 *   - Methods: pin(), record(), getEvicted(), maybeEvict(), touch()
 *
 * Eviction strategy:
 *   - Count-based: When maxTools limit reached, evict least recently used
 *   - TTL-based: Optionally evict tools unused for longer than ttl ms
 *   - Pinned tools always stay active
 *
 * Dependencies: ./logger.js
 * Depended on by: src/agent.js, test/unit/lru-tool-cache.test.js
 */

import { logger } from './logger.js';

export interface ToolUsageMeta {
  lastUsed: number;
  useCount: number;
}

export interface LRUToolCacheOptions {
  maxTools?: number;
  ttl?: number;
  pinnedTools?: Set<string>;
}

export interface ToolDefinition {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolRegistryEntry {
  description?: string;
}

/**
 * LRU (Least Recently Used) cache for tool activation.
 */
export class LRUToolCache {
  /** Maximum number of non-pinned tools to keep active */
  maxTools: number;

  /** TTL in ms — tools unused for longer than this are eligible for eviction (0 = disabled) */
  ttl: number;

  /** Tools that are never evicted (core/starter tools) */
  pinnedTools: Set<string>;

  /**
   * Ordered map of tool name → usage metadata.
   * Insertion/update order = LRU order (most recent at end).
   */
  private _usage: Map<string, ToolUsageMeta>;

  /** Tools that have been evicted and are currently inactive */
  private _evicted: Set<string>;

  /**
   * @param options - Configuration options
   */
  constructor({ maxTools = 25, ttl = 0, pinnedTools = new Set() }: LRUToolCacheOptions = {}) {
    this.maxTools = maxTools;
    this.ttl = ttl;
    this.pinnedTools = new Set(pinnedTools);
    this._usage = new Map();
    this._evicted = new Set();
  }

  /**
   * Pin a tool so it is never evicted.
   */
  pin(name: string): void {
    this.pinnedTools.add(name);
    this._evicted.delete(name);
  }

  /**
   * Pin multiple tools.
   */
  pinAll(names: Iterable<string>): void {
    for (const n of names) this.pin(n);
  }

  /**
   * Record a tool usage ("touch"). Moves it to the most-recently-used position.
   * Also re-activates the tool if it was previously evicted.
   */
  touch(name: string): void {
    const now = Date.now();
    // Delete + re-insert to move to end (most recent) in Map iteration order
    const existing = this._usage.get(name);
    this._usage.delete(name);
    this._usage.set(name, {
      lastUsed: now,
      useCount: (existing?.useCount || 0) + 1,
    });

    // Re-activate if evicted
    if (this._evicted.has(name)) {
      this._evicted.delete(name);
      logger.info(`LRU cache: re-activated evicted tool "${name}"`);
    }
  }

  /**
   * Record usage for a tool without incrementing the use count.
   * Useful for "warming" the cache when groups are activated.
   */
  warm(name: string): void {
    if (this._usage.has(name)) return; // already tracked
    this._usage.set(name, {
      lastUsed: Date.now(),
      useCount: 0,
    });
    this._evicted.delete(name);
  }

  /**
   * Run eviction. Returns the names of tools that were evicted.
   * @returns Names of newly evicted tools
   */
  evict(): string[] {
    const newlyEvicted: string[] = [];
    const now = Date.now();

    // Phase 1: TTL-based eviction
    if (this.ttl > 0) {
      for (const [name, meta] of this._usage) {
        if (this.pinnedTools.has(name)) continue;
        if (now - meta.lastUsed > this.ttl) {
          this._evicted.add(name);
          newlyEvicted.push(name);
          logger.info(`LRU cache: evicted "${name}" (TTL expired, unused for ${Math.round((now - meta.lastUsed) / 1000)}s)`);
        }
      }
    }

    // Phase 2: Count-based eviction (keep at most maxTools non-pinned tools)
    const nonPinnedActive: string[] = [];
    for (const [name] of this._usage) {
      if (this.pinnedTools.has(name) || this._evicted.has(name)) continue;
      nonPinnedActive.push(name);
    }

    if (nonPinnedActive.length > this.maxTools) {
      // nonPinnedActive is in Map insertion order (oldest first = LRU)
      const toEvict = nonPinnedActive.length - this.maxTools;
      for (let i = 0; i < toEvict; i++) {
        const name = nonPinnedActive[i];
        this._evicted.add(name);
        if (!newlyEvicted.includes(name)) {
          newlyEvicted.push(name);
        }
        logger.info(`LRU cache: evicted "${name}" (capacity overflow, ${nonPinnedActive.length} > ${this.maxTools})`);
      }
    }

    return newlyEvicted;
  }

  /**
   * Check whether a tool is currently evicted (should not be sent to LLM).
   */
  isEvicted(name: string): boolean {
    return this._evicted.has(name);
  }

  /**
   * Get the set of currently evicted tool names.
   */
  getEvicted(): Set<string> {
    return new Set(this._evicted);
  }

  /**
   * Get the set of active (non-evicted) tool names that are being tracked.
   */
  getActive(): Set<string> {
    const active = new Set<string>();
    for (const [name] of this._usage) {
      if (!this._evicted.has(name)) active.add(name);
    }
    return active;
  }

  /**
   * Filter a tools array, removing evicted tools.
   */
  filterTools(tools: ToolDefinition[]): ToolDefinition[] {
    return tools.filter(t => !this._evicted.has(t.function.name));
  }

  /**
   * Describe evicted tools as a compact string for the system prompt.
   */
  describeEvicted(toolRegistry: Map<string, ToolRegistryEntry>): string {
    if (this._evicted.size === 0) return '';
    const lines: string[] = [];
    for (const name of this._evicted) {
      const tool = toolRegistry.get(name);
      const desc = tool?.description?.split('.')[0] || 'No description';
      lines.push(`- ${name}: ${desc}`);
    }
    return `The following tools are currently inactive (evicted from cache):\n${lines.join('\n')}`;
  }

  /**
   * Reset the cache (clear all tracking).
   */
  reset(): void {
    this._usage.clear();
    this._evicted.clear();
  }

  /**
   * Get cache statistics.
   */
  stats(): { total: number; active: number; evicted: number; pinned: number } {
    return {
      total: this._usage.size,
      active: this._usage.size - this._evicted.size,
      evicted: this._evicted.size,
      pinned: this.pinnedTools.size,
    };
  }

  /**
   * Get cache statistics (alias for stats()).
   */
  getStats(): { total: number; active: number; evicted: number; pinned: number } {
    return this.stats();
  }

  /**
   * Reactivate multiple tools that were previously evicted.
   */
  reactivateAll(names: Iterable<string>): void {
    for (const name of names) {
      if (this._evicted.has(name)) {
        this._evicted.delete(name);
        this.touch(name);
      }
    }
  }

  /**
   * Reactivate a single tool that was previously evicted.
   */
  reactivate(name: string): void {
    if (this._evicted.has(name)) {
      this._evicted.delete(name);
      this.touch(name);
    }
  }
}