import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SESSIONS_DIR = ".smol-agent/state/sessions";

/**
 * Generate a short, human-friendly session ID.
 * Format: 8-char hex string (e.g. "a3f1b2c4")
 */
function generateSessionId() {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Get the sessions directory for a given project root.
 */
function sessionsDir(cwd) {
  return path.join(cwd, SESSIONS_DIR);
}

/**
 * Get the file path for a session.
 */
function sessionPath(cwd, sessionId) {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

/**
 * Create a new session metadata object.
 */
export function createSession(name) {
  const now = new Date().toISOString();
  return {
    id: generateSessionId(),
    name: name || null,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    summary: null,
  };
}

/**
 * Save a session to disk.
 * @param {string} cwd - Project root directory
 * @param {object} session - Session metadata (id, name, createdAt, etc.)
 * @param {Array} messages - Conversation messages array
 */
export async function saveSession(cwd, session, messages) {
  const dir = sessionsDir(cwd);
  await fs.mkdir(dir, { recursive: true });

  // Filter out the system message (it's rebuilt on load) and
  // strip large tool results to keep session files manageable
  const storedMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool" && m.content && m.content.length > 10000) {
        return { ...m, content: m.content.slice(0, 10000) + "\n...(truncated)" };
      }
      return m;
    });

  const data = {
    ...session,
    updatedAt: new Date().toISOString(),
    messageCount: storedMessages.length,
    messages: storedMessages,
  };

  // Generate a summary from the first user message if we don't have one
  if (!data.summary) {
    const firstUser = storedMessages.find((m) => m.role === "user");
    if (firstUser) {
      const text = firstUser.content || "";
      data.summary = text.length > 120 ? text.slice(0, 117) + "..." : text;
    }
  }

  await fs.writeFile(sessionPath(cwd, session.id), JSON.stringify(data, null, 2), "utf-8");
  return data;
}

/**
 * Load a session from disk.
 * @param {string} cwd - Project root directory
 * @param {string} sessionId - Session ID to load
 * @returns {object|null} Session data with messages, or null if not found
 */
export async function loadSession(cwd, sessionId) {
  try {
    const filepath = sessionPath(cwd, sessionId);
    const raw = await fs.readFile(filepath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * List all saved sessions, sorted by most recently updated.
 * @param {string} cwd - Project root directory
 * @returns {Array} Array of session metadata (without messages)
 */
export async function listSessions(cwd) {
  const dir = sessionsDir(cwd);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const sessions = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf-8");
      const data = JSON.parse(raw);
      // Return metadata only (no messages)
      sessions.push({
        id: data.id,
        name: data.name,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messageCount: data.messageCount,
        summary: data.summary,
      });
    } catch {
      // Skip corrupted files
    }
  }

  // Sort by most recently updated
  sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return sessions;
}

/**
 * Delete a session from disk.
 * @param {string} cwd - Project root directory
 * @param {string} sessionId - Session ID to delete
 * @returns {boolean} True if deleted, false if not found
 */
export async function deleteSession(cwd, sessionId) {
  try {
    await fs.unlink(sessionPath(cwd, sessionId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename a session.
 * @param {string} cwd - Project root directory
 * @param {string} sessionId - Session ID to rename
 * @param {string} newName - New name for the session
 * @returns {boolean} True if renamed, false if not found
 */
export async function renameSession(cwd, sessionId, newName) {
  const data = await loadSession(cwd, sessionId);
  if (!data) return false;

  data.name = newName;
  data.updatedAt = new Date().toISOString();
  await fs.writeFile(sessionPath(cwd, sessionId), JSON.stringify(data, null, 2), "utf-8");
  return true;
}

/**
 * Find a session by partial ID or name match.
 * @param {string} cwd - Project root directory
 * @param {string} query - Partial ID or name to search for
 * @returns {object|null} Matching session metadata, or null
 */
export async function findSession(cwd, query) {
  const sessions = await listSessions(cwd);
  if (!query) return null;

  const lower = query.toLowerCase();

  // Exact ID match
  const exact = sessions.find((s) => s.id === query);
  if (exact) return exact;

  // Partial ID match (prefix)
  const partialId = sessions.find((s) => s.id.startsWith(lower));
  if (partialId) return partialId;

  // Name match (case-insensitive)
  const nameMatch = sessions.find(
    (s) => s.name && s.name.toLowerCase().includes(lower),
  );
  if (nameMatch) return nameMatch;

  return null;
}
