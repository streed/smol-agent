import { register } from "./registry.js";
import {
  listSessions,
  deleteSession,
  renameSession,
} from "../sessions.js";

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
  execute: async (_args, { cwd }) => {
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
  execute: async ({ sessionId }, { cwd }) => {
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
  execute: async ({ sessionId, newName }, { cwd }) => {
    const renamed = await renameSession(cwd, sessionId, newName);
    if (renamed) {
      return { success: true, message: `Session ${sessionId} renamed to "${newName}".` };
    }
    return { error: `Session not found: ${sessionId}` };
  },
});
