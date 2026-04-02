import { register } from "./registry.js";
import {
  listSessions,
  deleteSession,
  renameSession,
} from "../sessions.js";

interface SessionInfo {
  id: string;
  name: string;
  messageCount: number;
  updatedAt: string;
  summary?: string;
}

interface ListSessionsResult {
  sessions?: SessionInfo[];
  message?: string;
}

interface DeleteSessionArgs {
  sessionId: string;
}

interface DeleteSessionResult {
  success?: boolean;
  message?: string;
  error?: string;
}

interface RenameSessionArgs {
  sessionId: string;
  newName: string;
}

interface RenameSessionResult {
  success?: boolean;
  message?: string;
  error?: string;
}

// ── list_sessions ─────────────────────────────────────────────────────

register("list_sessions", {
  description:
    "List all saved conversation sessions. Returns session IDs, names, message counts, and summaries. Use this to help the user find and manage past sessions.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  extended: true,
  async execute(_args, { cwd }): Promise<ListSessionsResult> {
    const sessions = await listSessions(cwd);
    if (sessions.length === 0) {
      return { sessions: [], message: "No saved sessions found." };
    }
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        messageCount: s.messageCount,
        updatedAt: s.updatedAt,
        summary: s.summary,
      })),
    };
  },
});

// ── delete_session ────────────────────────────────────────────────────

register("delete_session", {
  description: "Delete a saved conversation session by ID.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "The session ID to delete",
      },
    },
    required: ["sessionId"],
  },
  extended: true,
  requiresApproval: true,
  async execute({ sessionId }: DeleteSessionArgs, { cwd }): Promise<DeleteSessionResult> {
    const deleted = await deleteSession(cwd, sessionId);
    if (deleted) {
      return { success: true, message: `Session ${sessionId} deleted.` };
    }
    return { error: `Session not found: ${sessionId}` };
  },
});

// ── rename_session ────────────────────────────────────────────────────

register("rename_session", {
  description: "Rename a saved conversation session.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "The session ID to rename",
      },
      newName: {
        type: "string",
        description: "The new name for the session",
      },
    },
    required: ["sessionId", "newName"],
  },
  extended: true,
  async execute({ sessionId, newName }: RenameSessionArgs, { cwd }): Promise<RenameSessionResult> {
    const renamed = await renameSession(cwd, sessionId, newName);
    if (renamed) {
      return { success: true, message: `Session ${sessionId} renamed to "${newName}".` };
    }
    return { error: `Session not found: ${sessionId}` };
  },
});