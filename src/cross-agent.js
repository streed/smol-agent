/**
 * Cross-Agent Communication Protocol — Inbox / Letter Model
 *
 * Agents communicate by dropping markdown "letters" into each other's inboxes.
 * A watcher process monitors the inbox and kicks off the agent when a new letter arrives.
 *
 * Directory layout (per repo):
 *   .smol-agent/inbox/
 *     <id>.letter.md        ← incoming letters (requests from other agents)
 *     <id>.response.md      ← responses written by this agent
 *   .smol-agent/outbox/
 *     <id>.letter.md        ← copies of letters we sent (for tracking)
 *
 * Lifecycle:
 *   1. Agent A writes a letter to Agent B's inbox
 *   2. Agent B's watcher detects the new file
 *   3. Watcher spawns smol-agent to process the letter
 *   4. smol-agent reads the letter, does the work, writes a response to its own inbox
 *   5. smol-agent also writes a copy of the response to Agent A's inbox as a "reply"
 *   6. Agent A reads the reply and continues
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { logger } from "./logger.js";

const INBOX_DIR = ".smol-agent/inbox";
const OUTBOX_DIR = ".smol-agent/outbox";

// ── Directory helpers ─────────────────────────────────────────────────

function ensureInbox(repoPath) {
  const dir = path.join(repoPath, INBOX_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureOutbox(repoPath) {
  const dir = path.join(repoPath, OUTBOX_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Letter format ─────────────────────────────────────────────────────

/**
 * Serialize a letter (request) to markdown.
 */
export function serializeLetter({
  id,
  type = "request",
  title,
  from,
  to,
  inReplyTo = "",
  status = "pending",
  priority = "medium",
  createdAt,
  body,
  acceptanceCriteria = [],
  context = "",
}) {
  const criteria = acceptanceCriteria.length > 0
    ? acceptanceCriteria.map((c) => `- ${c}`).join("\n")
    : "- (none specified)";

  return `---
id: ${id}
type: ${type}
title: ${title}
from: ${from}
to: ${to}
in_reply_to: ${inReplyTo}
status: ${status}
priority: ${priority}
created_at: ${createdAt}
---

# ${title}

## Body

${body}

## Acceptance Criteria

${criteria}

## Context

${context || "(none)"}
`;
}

/**
 * Serialize a response letter to markdown.
 */
export function serializeResponse({
  id,
  title,
  from,
  to,
  inReplyTo,
  status = "completed",
  createdAt,
  changesMade = "",
  apiContract = "",
  notes = "",
}) {
  return `---
id: ${id}
type: response
title: ${title}
from: ${from}
to: ${to}
in_reply_to: ${inReplyTo}
status: ${status}
priority: normal
created_at: ${createdAt}
---

# Re: ${title}

## Changes Made

${changesMade || "(none)"}

## API Contract / Interface

${apiContract || "(none)"}

## Notes

${notes || "(none)"}
`;
}

/**
 * Parse a letter markdown file into a structured object.
 * Handles both request letters and response letters.
 */
export function parseLetter(markdown) {
  const result = {};

  // Parse frontmatter
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      // Convert snake_case to camelCase
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      result[camelKey] = value;
    }
  }

  // Parse title from heading
  const titleMatch = markdown.match(/^# (.+)$/m);
  if (titleMatch && !result.title) {
    result.title = titleMatch[1].trim();
  }

  // Parse body (for request letters)
  const bodyMatch = markdown.match(
    /## Body\s*\n([\s\S]*?)(?=\n## Acceptance Criteria|\n## Changes Made)/,
  );
  result.body = bodyMatch ? bodyMatch[1].trim() : "";

  // Parse acceptance criteria
  const criteriaMatch = markdown.match(
    /## Acceptance Criteria\s*\n([\s\S]*?)(?=\n## Context|\n## |$)/,
  );
  if (criteriaMatch) {
    result.acceptanceCriteria = criteriaMatch[1]
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.replace(/^- /, "").trim())
      .filter((l) => l !== "(none specified)");
  } else {
    result.acceptanceCriteria = [];
  }

  // Parse context
  const ctxMatch = markdown.match(/## Context\s*\n([\s\S]*?)(?=\n## |$)/);
  result.context = ctxMatch ? ctxMatch[1].trim() : "";
  if (result.context === "(none)") result.context = "";

  // Parse response-specific sections
  const changesMatch = markdown.match(
    /## Changes Made\s*\n([\s\S]*?)(?=\n## API Contract)/,
  );
  result.changesMade = changesMatch ? changesMatch[1].trim() : "";

  const apiMatch = markdown.match(
    /## API Contract \/ Interface\s*\n([\s\S]*?)(?=\n## Notes)/,
  );
  result.apiContract = apiMatch ? apiMatch[1].trim() : "";

  const notesMatch = markdown.match(/## Notes\s*\n([\s\S]*)$/);
  result.notes = notesMatch ? notesMatch[1].trim() : "";

  // Normalize "(none)" values
  for (const key of ["changesMade", "apiContract", "notes", "context", "body"]) {
    if (result[key] === "(none)") result[key] = "";
  }

  return result;
}

// ── Core operations ───────────────────────────────────────────────────

/**
 * Send a letter to another agent's inbox.
 *
 * @param {object} opts
 * @param {string} opts.from   - Absolute path to the sender's repo
 * @param {string} opts.to     - Absolute path to the recipient's repo
 * @param {string} opts.title  - Short title
 * @param {string} opts.body   - Detailed description of what's needed
 * @param {string[]} [opts.acceptanceCriteria]
 * @param {string} [opts.context]
 * @param {string} [opts.priority] - low | medium | high
 * @returns {{ id: string, letterPath: string }}
 */
export function sendLetter({
  from,
  to,
  title,
  body,
  acceptanceCriteria = [],
  context = "",
  priority = "medium",
}) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const fromResolved = path.resolve(from);
  const toResolved = path.resolve(to);

  if (!fs.existsSync(toResolved)) {
    throw new Error(`Target repo does not exist: ${toResolved}`);
  }

  const markdown = serializeLetter({
    id,
    type: "request",
    title,
    from: fromResolved,
    to: toResolved,
    status: "pending",
    priority,
    createdAt,
    body,
    acceptanceCriteria,
    context,
  });

  // Drop the letter in the recipient's inbox
  const inboxDir = ensureInbox(toResolved);
  const letterPath = path.join(inboxDir, `${id}.letter.md`);
  fs.writeFileSync(letterPath, markdown, "utf-8");

  // Keep a copy in our outbox for tracking
  const outboxDir = ensureOutbox(fromResolved);
  fs.writeFileSync(path.join(outboxDir, `${id}.letter.md`), markdown, "utf-8");

  logger.info(`Letter sent: ${id} from ${fromResolved} → ${toResolved}`);
  return { id, letterPath };
}

/**
 * Send a reply letter back to the original sender's inbox.
 *
 * @param {object} opts
 * @param {string} opts.repoPath  - This agent's repo path
 * @param {string} opts.originalLetter - The parsed original letter
 * @param {string} opts.changesMade
 * @param {string} opts.apiContract
 * @param {string} opts.notes
 * @param {string} [opts.status] - completed | failed
 * @returns {{ id: string, responsePath: string }}
 */
export function sendReply({
  repoPath,
  originalLetter,
  changesMade = "",
  apiContract = "",
  notes = "",
  status = "completed",
}) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const fromResolved = path.resolve(repoPath);

  const markdown = serializeResponse({
    id,
    title: originalLetter.title,
    from: fromResolved,
    to: originalLetter.from,
    inReplyTo: originalLetter.id,
    status,
    createdAt,
    changesMade,
    apiContract,
    notes,
  });

  // Write response to our own inbox (for our records)
  const localInbox = ensureInbox(fromResolved);
  const localPath = path.join(localInbox, `${originalLetter.id}.response.md`);
  fs.writeFileSync(localPath, markdown, "utf-8");

  // Deliver the reply to the original sender's inbox
  let replyPath = localPath;
  if (originalLetter.from && fs.existsSync(originalLetter.from)) {
    const senderInbox = ensureInbox(originalLetter.from);
    replyPath = path.join(senderInbox, `${originalLetter.id}.response.md`);
    fs.writeFileSync(replyPath, markdown, "utf-8");
    logger.info(`Reply delivered to ${originalLetter.from}`);
  }

  // Mark the original letter as completed
  const letterPath = path.join(
    localInbox,
    `${originalLetter.id}.letter.md`,
  );
  if (fs.existsSync(letterPath)) {
    let content = fs.readFileSync(letterPath, "utf-8");
    content = content.replace(/^status: .+$/m, `status: ${status}`);
    fs.writeFileSync(letterPath, content, "utf-8");
  }

  return { id, responsePath: replyPath };
}

/**
 * Read all letters from a repo's inbox.
 *
 * @param {string} repoPath
 * @param {object} [filter]
 * @param {string} [filter.type]   - "request" | "response"
 * @param {string} [filter.status] - "pending" | "in-progress" | "completed" | "failed"
 * @returns {Array} Parsed letters
 */
export function readInbox(repoPath, filter = {}) {
  const dir = path.join(repoPath, INBOX_DIR);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(
    (f) => f.endsWith(".letter.md") || f.endsWith(".response.md"),
  );

  let letters = files.map((f) => {
    const content = fs.readFileSync(path.join(dir, f), "utf-8");
    const parsed = parseLetter(content);
    parsed._filename = f;
    return parsed;
  });

  if (filter.type) {
    letters = letters.filter((l) => l.type === filter.type);
  }
  if (filter.status) {
    letters = letters.filter((l) => l.status === filter.status);
  }

  return letters;
}

/**
 * Read all letters from a repo's outbox (sent letters).
 */
export function readOutbox(repoPath) {
  const dir = path.join(repoPath, OUTBOX_DIR);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".letter.md"))
    .map((f) => {
      const content = fs.readFileSync(path.join(dir, f), "utf-8");
      const parsed = parseLetter(content);
      parsed._filename = f;
      return parsed;
    });
}

/**
 * Check if a response has arrived for a specific outgoing letter.
 *
 * @param {string} repoPath - The sender's repo
 * @param {string} letterId - The original letter ID
 * @returns {object|null} Parsed response or null
 */
export function checkForReply(repoPath, letterId) {
  const responsePath = path.join(
    repoPath,
    INBOX_DIR,
    `${letterId}.response.md`,
  );
  if (!fs.existsSync(responsePath)) return null;
  return parseLetter(fs.readFileSync(responsePath, "utf-8"));
}

// ── Inbox Watcher ─────────────────────────────────────────────────────

/**
 * Watch a repo's inbox for new letters and process them.
 *
 * Uses fs.watch to detect new .letter.md files. When one appears with
 * status "pending", it spawns a smol-agent to handle it.
 *
 * @param {object} opts
 * @param {string} opts.repoPath   - Repo to watch
 * @param {string} [opts.provider] - LLM provider for spawned agents
 * @param {string} [opts.model]    - Model for spawned agents
 * @param {string} [opts.apiKey]   - API key for spawned agents
 * @param {AbortSignal} [opts.signal] - Signal to stop watching
 * @param {function} [opts.onLetterReceived] - Callback when a letter is detected
 * @param {function} [opts.onAgentComplete]  - Callback when agent finishes
 * @returns {{ stop: function }}
 */
export function watchInbox({
  repoPath,
  provider,
  model,
  apiKey,
  signal,
  onLetterReceived,
  onAgentComplete,
}) {
  const inboxDir = ensureInbox(path.resolve(repoPath));
  const processing = new Set(); // Track letters being processed

  logger.info(`Watching inbox: ${inboxDir}`);

  // Process any existing pending letters on startup
  processExistingLetters();

  const watcher = fs.watch(inboxDir, async (eventType, filename) => {
    if (!filename || !filename.endsWith(".letter.md")) return;
    if (processing.has(filename)) return;

    // Small delay to ensure file is fully written
    await new Promise((r) => setTimeout(r, 200));

    const filePath = path.join(inboxDir, filename);
    if (!fs.existsSync(filePath)) return;

    const letter = parseLetter(fs.readFileSync(filePath, "utf-8"));
    if (letter.status !== "pending") return;

    processing.add(filename);
    onLetterReceived?.(letter);

    try {
      await processLetter({
        repoPath: path.resolve(repoPath),
        letter,
        provider,
        model,
        apiKey,
      });
      onAgentComplete?.(letter, null);
    } catch (err) {
      logger.error(`Failed to process letter ${letter.id}: ${err.message}`);
      onAgentComplete?.(letter, err);
    } finally {
      processing.delete(filename);
    }
  });

  if (signal) {
    signal.addEventListener("abort", () => watcher.close(), { once: true });
  }

  async function processExistingLetters() {
    const pending = readInbox(path.resolve(repoPath), {
      type: "request",
      status: "pending",
    });
    for (const letter of pending) {
      if (signal?.aborted) break;
      const filename = `${letter.id}.letter.md`;
      if (processing.has(filename)) continue;

      processing.add(filename);
      onLetterReceived?.(letter);

      try {
        await processLetter({
          repoPath: path.resolve(repoPath),
          letter,
          provider,
          model,
          apiKey,
        });
        onAgentComplete?.(letter, null);
      } catch (err) {
        logger.error(`Failed to process letter ${letter.id}: ${err.message}`);
        onAgentComplete?.(letter, err);
      } finally {
        processing.delete(filename);
      }
    }
  }

  return {
    stop() {
      watcher.close();
    },
  };
}

// ── Agent spawning ────────────────────────────────────────────────────

/**
 * Spawn a smol-agent to process a single letter.
 */
export function processLetter({
  repoPath,
  letter,
  provider,
  model,
  apiKey,
}) {
  // Mark letter as in-progress
  const letterPath = path.join(
    repoPath,
    INBOX_DIR,
    `${letter.id}.letter.md`,
  );
  if (fs.existsSync(letterPath)) {
    let content = fs.readFileSync(letterPath, "utf-8");
    content = content.replace(/^status: .+$/m, "status: in-progress");
    fs.writeFileSync(letterPath, content, "utf-8");
  }

  const responseFile = `${letter.id}.response.md`;

  const prompt = [
    `You have received a cross-agent work request letter. Here are the details:`,
    ``,
    `**Title**: ${letter.title}`,
    `**From**: ${letter.from}`,
    `**Priority**: ${letter.priority}`,
    ``,
    `**Request**:`,
    letter.body,
    ``,
    letter.acceptanceCriteria?.length > 0
      ? `**Acceptance Criteria**:\n${letter.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    letter.context ? `**Context**: ${letter.context}` : "",
    ``,
    `Complete the requested work. When finished:`,
    ``,
    `1. Create a response file at "${path.join(INBOX_DIR, responseFile)}" with this format:`,
    ``,
    "```markdown",
    `---`,
    `id: <generate-a-uuid>`,
    `type: response`,
    `title: ${letter.title}`,
    `from: ${repoPath}`,
    `to: ${letter.from}`,
    `in_reply_to: ${letter.id}`,
    `status: completed`,
    `priority: normal`,
    `created_at: <current ISO timestamp>`,
    `---`,
    ``,
    `# Re: ${letter.title}`,
    ``,
    `## Changes Made`,
    `<describe what you changed>`,
    ``,
    `## API Contract / Interface`,
    `<describe any API surface the requesting agent needs>`,
    ``,
    `## Notes`,
    `<any additional notes>`,
    "```",
    ``,
    `2. Update the status in "${path.join(INBOX_DIR, `${letter.id}.letter.md`)}" from "in-progress" to "completed"`,
    `3. Commit your changes`,
    ``,
    `Focus only on the requested work. Do not modify unrelated code.`,
  ]
    .filter(Boolean)
    .join("\n");

  const args = ["--directory", repoPath, "--auto-approve"];

  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (apiKey) args.push("--api-key", apiKey);
  args.push(prompt);

  logger.info(`Spawning agent for letter ${letter.id} in ${repoPath}`);

  return new Promise((resolve, reject) => {
    const localBin = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "index.js",
    );
    const command = fs.existsSync(localBin) ? "node" : "smol-agent";
    const spawnArgs = command === "node" ? [localBin, ...args] : args;

    const child = spawn(command, spawnArgs, {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn agent: ${err.message}`));
    });

    child.on("close", (code) => {
      logger.info(`Agent for letter ${letter.id} exited with code ${code}`);

      // After agent completes, deliver the response to the sender's inbox
      const localResponsePath = path.join(
        repoPath,
        INBOX_DIR,
        responseFile,
      );
      if (fs.existsSync(localResponsePath) && letter.from && fs.existsSync(letter.from)) {
        try {
          const senderInbox = ensureInbox(letter.from);
          fs.copyFileSync(
            localResponsePath,
            path.join(senderInbox, responseFile),
          );
          logger.info(`Response delivered to sender: ${letter.from}`);
        } catch (err) {
          logger.warn(`Could not deliver response to sender: ${err.message}`);
        }
      }

      resolve({ exitCode: code, stdout, stderr });
    });
  });
}
