/**
 * Session persistence for smol-agent.
 *
 * Manages saving and loading of conversation sessions to disk.
 * Sessions are stored as JSON files in .smol-agent/state/sessions/
 *
 * Each session contains:
 * - Conversation messages
 * - Metadata (created time, model, provider)
 * - Session name for easy recall
 *
 * Key exports:
 *   - createSession(name): Create new session metadata
 *   - saveSession(cwd, session, messages): Persist session to disk
 *   - loadSession(cwd, sessionId): Load session by ID
 *   - listSessions(cwd): List all saved sessions
 *   - deleteSession(cwd, sessionId): Remove a session
 *   - renameSession(cwd, sessionId, newName): Rename a session
 *   - findMostRecentSession(cwd): Find latest session for --continue
 *
 * Dependencies: node:fs/promises, node:path, node:crypto
 * Depended by by: src/acp-server.js, src/agent.js, src/index.js, src/tools/session_tools.js, src/ui/App.js
 *
 * @module sessions
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SESSIONS_DIR = ".smol-agent/state/sessions";

/**
 * Session metadata
 */
export interface Session {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  summary: string | null;
}

/**
 * Session with messages (full session data)
 */
export interface SessionWithMessages extends Session {
  messages: SessionMessage[];
}

/**
 * Message in a session
 */
export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: string | Record<string, unknown>;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * Generate a short, human-friendly session ID.
 * Format: 8-char hex string (e.g. "a3f1b2c4")
 */
function generateSessionId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Get the sessions directory for a given project root.
 */
function sessionsDir(cwd: string): string {
  return path.join(cwd, SESSIONS_DIR);
}

/**
 * Get the file path for a session.
 */
function sessionPath(cwd: string, sessionId: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

/**
 * Create a new session metadata object.
 */
export function createSession(name?: string | null): Session {
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
 * @param cwd - Project root directory
 * @param session - Session metadata (id, name, createdAt, etc.)
 * @param messages - Conversation messages array
 */
export async function saveSession(
  cwd: string,
  session: Session,
  messages: SessionMessage[]
): Promise<SessionWithMessages> {
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

  const data: SessionWithMessages = {
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
 * @param cwd - Project root directory
 * @param sessionId - Session ID to load
 * @returns Session data with messages, or null if not found
 */
export async function loadSession(cwd: string, sessionId: string): Promise<SessionWithMessages | null> {
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
 * @param cwd - Project root directory
 * @returns Array of session metadata (without messages)
 */
export async function listSessions(cwd: string): Promise<Session[]> {
  const dir = sessionsDir(cwd);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf-8");
      const data = JSON.parse(raw) as SessionWithMessages;
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
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

/**
 * Delete a session from disk.
 * @param cwd - Project root directory
 * @param sessionId - Session ID to delete
 * @returns True if deleted, false if not found
 */
export async function deleteSession(cwd: string, sessionId: string): Promise<boolean> {
  try {
    await fs.unlink(sessionPath(cwd, sessionId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename a session.
 * @param cwd - Project root directory
 * @param sessionId - Session ID to rename
 * @param newName - New name for the session
 * @returns Updated session, or null if not found
 */
export async function renameSession(
  cwd: string,
  sessionId: string,
  newName: string
): Promise<SessionWithMessages | null> {
  const session = await loadSession(cwd, sessionId);
  if (!session) return null;

  session.name = newName;
  session.updatedAt = new Date().toISOString();

  await fs.writeFile(sessionPath(cwd, sessionId), JSON.stringify(session, null, 2), "utf-8");
  return session;
}

/**
 * Find the most recently updated session.
 * @param cwd - Project root directory
 * @returns Most recent session, or null if none exist
 */
export async function findMostRecentSession(cwd: string): Promise<Session | null> {
  const sessions = await listSessions(cwd);
  return sessions.length > 0 ? sessions[0] : null;
}

/**
 * Find a session by ID or name (partial match).
 * @param cwd - Project root directory
 * @param query - Session ID or name (partial match)
 * @returns Matching session, or null if not found
 */
export async function findSession(cwd: string, query: string): Promise<Session | null> {
  // First try exact ID match
  const byId = await loadSession(cwd, query);
  if (byId) return byId;

  // Then try partial name match
  const sessions = await listSessions(cwd);
  const match = sessions.find(
    (s) => s.name && s.name.toLowerCase().includes(query.toLowerCase())
  );
  return match || null;
}