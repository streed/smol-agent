import { logger } from './logger.js';

/**
 * LRU (Least Recently Used) cache for tools.
 *
 * Tracks tool usage and evicts tools that haven't been used recently to free
 * up context space. Pinned tools (core/starter) are never evicted.
 *
 * Evicted tools remain registered and can be re-activated via discover_tools
 * or auto-discovery signals.
 */
export class LRUToolCache {
  /**
   * @param {object} options
   * @param {number}   [options.maxTools=25]        - Max non-pinned tools to keep active
   * @param {number}   [options.ttl=0]              - Time-to-live in ms (0 = no TTL, use count-based eviction only)
   * @param {Set<string>} [options.pinnedTools]     - Tools that should never be evicted
   */
  constructor({ maxTools = 25, ttl = 0, pinnedTools = new Set() } = {}) {
    /** @type {number} Maximum number of non-pinned tools to keep active */
    this.maxTools = maxTools;

    /** @type {number} TTL in ms — tools unused for longer than this are eligible for eviction (0 = disabled) */
    this.ttl = ttl;

    /** @type {Set<string>} Tools that are never evicted (core/starter tools) */
    this.pinnedTools = new Set(pinnedTools);

    /**
     * Ordered map of tool name → usage metadata.
     * Insertion/update order = LRU order (most recent at end).
     * @type {Map<string, { lastUsed: number, useCount: number }>}
     */
    this._usage = new Map();

    /** @type {Set<string>} Tools that have been evicted and are currently inactive */
    this._evicted = new Set();
  }

  /**
   * Pin a tool so it is never evicted.
   * @param {string} name
   */
  pin(name) {
    this.pinnedTools.add(name);
    this._evicted.delete(name);
  }

  /**
   * Pin multiple tools.
   * @param {Iterable<string>} names
   */
  pinAll(names) {
    for (const n of names) this.pin(n);
  }

  /**
   * Record a tool usage ("touch"). Moves it to the most-recently-used position.
   * Also re-activates the tool if it was previously evicted.
   * @param {string} name
   */
  touch(name) {
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
   * @param {string} name
   */
  warm(name) {
    if (this._usage.has(name)) return; // already tracked
    this._usage.set(name, {
      lastUsed: Date.now(),
      useCount: 0,
    });
    this._evicted.delete(name);
  }

  /**
   * Run eviction. Returns the names of tools that were evicted.
   * @returns {string[]} Names of newly evicted tools
   */
  evict() {
    const newlyEvicted = [];
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
    const nonPinnedActive = [];
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
   * @param {string} name
   * @returns {boolean}
   */
  isEvicted(name) {
    return this._evicted.has(name);
  }

  /**
   * Get the set of currently evicted tool names.
   * @returns {Set<string>}
   */
  getEvicted() {
    return new Set(this._evicted);
  }

  /**
   * Get the set of active (non-evicted) tool names that are being tracked.
   * @returns {Set<string>}
   */
  getActive() {
    const active = new Set();
    for (const [name] of this._usage) {
      if (!this._evicted.has(name)) active.add(name);
    }
    return active;
  }

  /**
   * Filter a tools array, removing evicted tools.
   * @param {Array<{type: string, function: {name: string}}>} tools
   * @returns {Array<{type: string, function: {name: string}}>}
   */
  filterTools(tools) {
    return tools.filter(t => !this._evicted.has(t.function.name));
  }

  /**
   * Describe evicted tools as a compact string for the system prompt.
   * @param {Map<string, {description: string}>} toolRegistry - Full tool registry for descriptions
   * @returns {string}
   */
  describeEvicted(toolRegistry) {
    if (this._evicted.size === 0) return '';
    const lines = [];
    for (const name of this._evicted) {
      const tool = toolRegistry.get(name);
      const desc = tool?.description?.split('.')[0] || 'No description';
      lines.push(`- ${name}: ${desc}`);
    }
    return lines.join('\n');
  }

  /**
   * Re-activate a previously evicted tool.
   * @param {string} name
   */
  reactivate(name) {
    if (this._evicted.has(name)) {
      this._evicted.delete(name);
      this.touch(name);
      logger.info(`LRU cache: manually re-activated "${name}"`);
    }
  }

  /**
   * Re-activate all tools in a group.
   * @param {string[]} names
   */
  reactivateAll(names) {
    for (const n of names) this.reactivate(n);
  }

  /**
   * Reset the cache — clears all usage tracking and evictions.
   */
  reset() {
    this._usage.clear();
    this._evicted.clear();
  }

  /**
   * Get usage stats for debugging/UI.
   * @returns {{ active: number, evicted: number, pinned: number, total: number }}
   */
  getStats() {
    return {
      active: this._usage.size - this._evicted.size,
      evicted: this._evicted.size,
      pinned: this.pinnedTools.size,
      total: this._usage.size,
    };
  }
}
