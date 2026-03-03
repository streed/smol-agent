/**
 * E2E test harness — Agent factory, event collector, scoring, file helpers.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Agent } from "../../src/agent.js";
import { config } from "./config.js";

// ── Agent factory ────────────────────────────────────────────────────

/**
 * Create a test agent with a fresh temp directory, auto-approve enabled,
 * and capped context/iterations for faster test runs.
 *
 * Returns { agent, tmpDir }.
 */
export function createTestAgent(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-e2e-"));
  const agent = new Agent({
    host: opts.host || config.host,
    model: opts.model || config.model,
    contextSize: opts.contextSize || config.contextSize,
    jailDirectory: tmpDir,
    coreToolsOnly: opts.coreToolsOnly ?? false,
  });
  agent._approveAll = true;
  return { agent, tmpDir };
}

// ── Run with timeout ─────────────────────────────────────────────────

/**
 * Run agent.run(prompt) with a wall-clock timeout.
 * On timeout, cancels the agent and returns "(Timeout exceeded)".
 * On abort/cancel, returns "(Operation cancelled)".
 * Never rejects for cancellation — only for real errors.
 */
export function runWithTimeout(agent, prompt, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      agent.cancel();
      resolve("(Timeout exceeded)");
    }, ms);
  });

  const run = agent.run(prompt).then(
    (result) => { clearTimeout(timer); return result; },
    (err) => {
      clearTimeout(timer);
      if (err.name === "AbortError" || err.message === "Operation cancelled") {
        return "(Operation cancelled)";
      }
      throw err;
    },
  );

  return Promise.race([run, timeout]);
}

// ── Event collector ──────────────────────────────────────────────────

/**
 * Attach an event collector to an agent. Returns an object with:
 *   - Typed arrays for each event kind
 *   - A unified `timeline` array with { ts, event, data } entries in order
 *   - Helper methods for querying events
 */
export function collectEvents(agent) {
  const t0 = Date.now();
  const events = {
    tool_calls: [],
    tool_results: [],
    responses: [],
    errors: [],
    thinking: [],
    token_usage: [],
    stream_starts: 0,
    stream_ends: 0,
    timeline: [],

    /** All tool names that were called, in order. */
    toolNames() {
      return this.tool_calls.map((tc) => tc.name);
    },

    /** How many times a specific tool was called. */
    toolCallCount(name) {
      return this.tool_calls.filter((tc) => tc.name === name).length;
    },

    /** Whether any tool in the given set was called. */
    anyToolCalled(names) {
      const set = new Set(names);
      return this.tool_calls.some((tc) => set.has(tc.name));
    },

    /** Get all tool_result payloads for a specific tool name. */
    resultsFor(name) {
      return this.tool_results
        .filter((tr) => tr.name === name)
        .map((tr) => tr.result);
    },
  };

  const push = (event, data) => {
    events.timeline.push({ ts: Date.now() - t0, event, data });
  };

  agent.on("tool_call", (e) => { events.tool_calls.push(e); push("tool_call", e); });
  agent.on("tool_result", (e) => { events.tool_results.push(e); push("tool_result", e); });
  agent.on("response", (e) => { events.responses.push(e); push("response", e); });
  agent.on("error", (e) => { events.errors.push(e); push("error", { message: e.message }); });
  agent.on("thinking", (e) => { events.thinking.push(e); push("thinking", e); });
  agent.on("token_usage", (e) => { events.token_usage.push(e); push("token_usage", e); });
  agent.on("stream_start", () => { events.stream_starts++; push("stream_start", null); });
  agent.on("stream_end", () => { events.stream_ends++; push("stream_end", null); });
  agent.on("sub_agent_progress", (e) => push("sub_agent_progress", e));
  agent.on("context_ready", () => push("context_ready", null));

  return events;
}

// ── Scoring ──────────────────────────────────────────────────────────

/**
 * Build a check object for scoreResult.
 * `actual` is an optional value stored for debugging (what the test saw).
 */
export function check(name, passed, weight = 1, actual = undefined) {
  return { name, passed: !!passed, weight, ...(actual !== undefined && { actual }) };
}

/**
 * Weighted scoring from an array of check objects.
 * Returns { name, score: 0-1, passed: score >= threshold, checks }.
 */
export function scoreResult(name, checks, threshold = 0.5) {
  const totalWeight = checks.reduce((sum, c) => sum + (c.weight || 1), 0);
  const earned = checks.reduce((sum, c) => sum + (c.passed ? (c.weight || 1) : 0), 0);
  const score = totalWeight > 0 ? earned / totalWeight : 0;
  return {
    name,
    score: Math.round(score * 1000) / 1000,
    passed: score >= threshold,
    checks,
  };
}

// ── File helpers ─────────────────────────────────────────────────────

export async function seedFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

export async function readResult(dir, relPath) {
  try {
    return await fsp.readFile(path.join(dir, relPath), "utf-8");
  } catch {
    return null;
  }
}

export function fileExists(dir, relPath) {
  return fs.existsSync(path.join(dir, relPath));
}

/**
 * List all files in dir (recursively), returning relative paths.
 * Useful for checking what the agent actually created.
 */
export async function listFiles(dir) {
  const results = [];
  async function walk(current, prefix) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), rel);
      } else {
        results.push(rel);
      }
    }
  }
  await walk(dir, "");
  return results.sort();
}

export async function cleanup(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// ── Debug helpers ────────────────────────────────────────────────────

/**
 * Dump the agent's conversation messages for post-mortem debugging.
 * Returns a compact string representation.
 */
export function dumpConversation(agent) {
  return agent.getMessages().map((m, i) => {
    const role = m.role.toUpperCase().padEnd(10);
    const content = (m.content || "").slice(0, 200);
    const tools = m.tool_calls
      ? ` [tools: ${m.tool_calls.map((tc) => tc.function.name).join(", ")}]`
      : "";
    return `[${i}] ${role} ${content}${tools}`;
  }).join("\n");
}
