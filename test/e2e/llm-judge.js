/**
 * LLM-as-Judge utilities for E2E test scenarios.
 *
 * Uses an LLM to semantically evaluate whether an agent performed the right
 * actions, replacing brittle regex checks. This allows more flexible scoring
 * of agent behavior that accounts for different valid approaches.
 *
 * Design principles (from Anthropic's "Demystifying Evals for AI Agents"):
 *   - Grade outputs, not paths: verify outcomes rather than step sequences
 *   - Isolated dimension-specific judges: each criterion judged independently
 *     to prevent cross-contamination between dimensions
 *   - Escape hatches: judges can respond "unknown" to avoid hallucinated verdicts
 *   - Calibration metadata: confidence tracking for future human calibration
 *
 * Key exports:
 *   - buildActionLog(events): Format events.timeline into readable action log
 *   - llmJudge(config, ...): Batch judge (original, backward-compatible)
 *   - llmJudgeIsolated(config, ...): Per-criterion isolated judging (recommended)
 *   - parseJudgeResponse(text): Parse JSON from judge LLM
 *
 * Dependencies: ../../src/ollama.js, ./config.js
 * Depended on by: test/e2e/scenarios/42-debug-broken-server.test.js,
 *                  test/e2e/scenarios/43-build-rest-api.test.js,
 *                  test/e2e/scenarios/44-python-server-fix.test.js,
 *                  test/e2e/scenarios/45-multi-file-server.test.js
 */

import { chatWithRetry, createClient } from "../../src/ollama.js";
import { config as _config } from "./config.js";

// ── Action log builder ──────────────────────────────────────────────

/**
 * Format events.timeline into a readable numbered action log.
 * Includes tool_call, tool_result, response, error events.
 * Truncates long tool results.
 */
export function buildActionLog(events) {
  const INCLUDE = new Set(["tool_call", "tool_result", "response", "error"]);
  const MAX_RESULT = 500;

  let idx = 0;
  const lines = [];

  for (const entry of events.timeline) {
    if (!INCLUDE.has(entry.event)) continue;
    idx++;

    if (entry.event === "tool_call") {
      const { name, args } = entry.data;
      lines.push(`[${idx}] TOOL_CALL: ${name}`);
      lines.push(`    args: ${JSON.stringify(args)}`);
    } else if (entry.event === "tool_result") {
      const { name, result } = entry.data;
      let text = typeof result === "string" ? result : JSON.stringify(result);
      if (text.length > MAX_RESULT) {
        text = text.slice(0, 250) + "\n    [...truncated...]\n    " + text.slice(-250);
      }
      lines.push(`[${idx}] TOOL_RESULT: ${name}`);
      lines.push(`    result: ${text}`);
    } else if (entry.event === "response") {
      const text = typeof entry.data === "string"
        ? entry.data
        : entry.data?.content || JSON.stringify(entry.data);
      lines.push(`[${idx}] RESPONSE:`);
      lines.push(`    ${text.slice(0, 500)}`);
    } else if (entry.event === "error") {
      lines.push(`[${idx}] ERROR: ${entry.data?.message || JSON.stringify(entry.data)}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ── Judge response parser ───────────────────────────────────────────

/**
 * Parse the judge LLM's response into an array of verdict objects.
 * Handles: raw JSON array, markdown-fenced JSON, or extracting [...] from text.
 */
export function parseJudgeResponse(text) {
  if (!text || typeof text !== "string") return null;

  // Try raw JSON parse first
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* expected */ }
  }

  // Try markdown-fenced JSON
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* expected */ }
  }

  // Extract first [...] from text
  const bracket = trimmed.match(/\[[\s\S]*\]/);
  if (bracket) {
    try { return JSON.parse(bracket[0]); } catch { /* expected */ }
  }

  return null;
}

// ── LLM Judge ───────────────────────────────────────────────────────

/**
 * Call an LLM to judge whether the agent met the given criteria.
 *
 * @param {object} config - Test config (model, host, etc.)
 * @param {string} taskPrompt - The original task given to the agent
 * @param {string} actionLog - Formatted action log from buildActionLog()
 * @param {Array<{name: string, weight: number, question: string}>} criteria
 * @param {object} [fileContents] - Map of filename → final file content
 * @returns {Array<{name, passed, weight, actual}>} check() objects for scoreResult()
 */
export async function llmJudge(cfg, taskPrompt, actionLog, criteria, fileContents) {
  const model = cfg.judgeModel || cfg.model;
  const client = createClient(cfg.host);

  const fileSections = fileContents
    ? Object.entries(fileContents)
        .map(([name, content]) => `### ${name}\n\`\`\`\n${content}\n\`\`\``)
        .join("\n\n")
    : "(no file contents provided)";

  const criteriaList = criteria
    .map((c, i) => `${i + 1}. "${c.name}" — ${c.question}`)
    .join("\n");

  const prompt = `You are a test evaluator judging whether a coding agent completed a task correctly.

## TASK
${taskPrompt}

## ACTION LOG
${actionLog}

## FINAL FILE CONTENTS
${fileSections}

## CRITERIA
For each criterion, answer whether it was met (pass/fail) based on the action log and file contents.

${criteriaList}

## RESPONSE FORMAT
Respond with ONLY a JSON array — no other text. Each element:
{"name": "<criterion name>", "pass": true/false, "reason": "<brief explanation>"}

Example:
[{"name": "fixed typo", "pass": true, "reason": "Changed createSever to createServer in line 3"}]`;

  try {
    const response = await chatWithRetry(client, model, [
      { role: "user", content: prompt },
    ], undefined, undefined, 16384);

    const text = response?.message?.content || "";
    const verdicts = parseJudgeResponse(text);

    if (!verdicts || !Array.isArray(verdicts)) {
      // Parse failure — return all criteria as failed
      return criteria.map(c => ({
        name: c.name,
        passed: false,
        weight: c.weight,
        actual: `judge parse error: ${text.slice(0, 200)}`,
      }));
    }

    // Map verdicts back to criteria
    return criteria.map(c => {
      const verdict = verdicts.find(v => v.name === c.name);
      if (!verdict) {
        return {
          name: c.name,
          passed: false,
          weight: c.weight,
          actual: "no verdict from judge",
        };
      }
      return {
        name: c.name,
        passed: !!verdict.pass,
        weight: c.weight,
        ...(verdict.reason && !verdict.pass && { actual: verdict.reason }),
      };
    });
  } catch (err) {
    // LLM call failure — return all criteria as failed with error info
    return criteria.map(c => ({
      name: c.name,
      passed: false,
      weight: c.weight,
      actual: `judge error: ${err.message}`,
    }));
  }
}

// ── Isolated per-dimension judge ─────────────────────────────────────

/**
 * Judge each criterion in isolation using separate LLM calls.
 *
 * This prevents cross-contamination between dimensions — a mistake in
 * judging one criterion won't affect others. Each judge call focuses on
 * exactly one question, producing more reliable results.
 *
 * Includes an "unknown" escape hatch: if the judge can't determine the
 * answer, it returns unknown rather than hallucinating a verdict.
 *
 * @param {object} cfg - Test config (model, host, etc.)
 * @param {string} taskPrompt - The original task given to the agent
 * @param {string} actionLog - Formatted action log from buildActionLog()
 * @param {Array<{name: string, weight: number, question: string}>} criteria
 * @param {object} [fileContents] - Map of filename → final file content
 * @returns {Array<{name, passed, weight, actual, confidence}>} check objects
 */
export async function llmJudgeIsolated(cfg, taskPrompt, actionLog, criteria, fileContents) {
  const model = cfg.judgeModel || cfg.model;
  const client = createClient(cfg.host);

  const fileSections = fileContents
    ? Object.entries(fileContents)
        .map(([name, content]) => `### ${name}\n\`\`\`\n${content}\n\`\`\``)
        .join("\n\n")
    : "(no file contents provided)";

  // Judge each criterion independently
  const results = await Promise.all(criteria.map(async (criterion) => {
    const prompt = `You are a test evaluator judging ONE specific criterion for a coding agent task.

## TASK
${taskPrompt}

## ACTION LOG
${actionLog}

## FINAL FILE CONTENTS
${fileSections}

## CRITERION
${criterion.name}: ${criterion.question}

## INSTRUCTIONS
Evaluate ONLY this criterion. Respond with a JSON object (no other text):
{"pass": true/false/null, "confidence": "high"/"medium"/"low", "reason": "<brief explanation>"}

IMPORTANT:
- If you cannot determine the answer from the evidence, set "pass" to null (not true or false).
- "confidence" indicates how certain you are: "high" = clear evidence, "medium" = reasonable inference, "low" = uncertain.
- Focus on the OUTCOME, not the specific steps taken. Different valid approaches should all count as passing.`;

    try {
      const response = await chatWithRetry(client, model, [
        { role: "user", content: prompt },
      ], undefined, undefined, 16384);

      const text = response?.message?.content || "";
      const parsed = parseSingleVerdict(text);

      if (!parsed) {
        return {
          name: criterion.name,
          passed: false,
          weight: criterion.weight,
          actual: `judge parse error: ${text.slice(0, 200)}`,
          confidence: "low",
        };
      }

      // Handle "unknown" escape hatch (pass === null)
      if (parsed.pass === null) {
        return {
          name: criterion.name,
          passed: false,
          weight: criterion.weight,
          actual: `unknown: ${parsed.reason || "judge could not determine"}`,
          confidence: parsed.confidence || "low",
        };
      }

      return {
        name: criterion.name,
        passed: !!parsed.pass,
        weight: criterion.weight,
        ...(!parsed.pass && parsed.reason && { actual: parsed.reason }),
        confidence: parsed.confidence || "medium",
      };
    } catch (err) {
      return {
        name: criterion.name,
        passed: false,
        weight: criterion.weight,
        actual: `judge error: ${err.message}`,
        confidence: "low",
      };
    }
  }));

  return results;
}

/**
 * Parse a single verdict JSON object from judge response text.
 */
function parseSingleVerdict(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();

  // Try raw JSON
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch { /* expected */ }
  }

  // Try markdown-fenced JSON
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* expected */ }
  }

  // Extract first {...} from text
  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced) {
    try { return JSON.parse(braced[0]); } catch { /* expected */ }
  }

  return null;
}
