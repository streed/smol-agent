/**
 * Cross-Agent Communication Tools
 *
 * Exposes the inbox/letter protocol to agents as tool calls:
 *   - send_letter: Send a work request to another agent's inbox
 *   - check_reply: Check if a reply has arrived for a sent letter
 *   - read_inbox: Read all letters in this agent's inbox
 *   - read_outbox: Read letters this agent has sent
 *   - reply_to_letter: Send a response back to a requesting agent
 */

import { register } from "./registry.js";
import {
  sendLetter,
  checkForReply,
  readInbox,
  readOutbox,
  sendReply,
  parseLetter,
} from "../cross-agent.js";
import { logger } from "../logger.js";
import fs from "node:fs";
import path from "node:path";

// ── send_letter ───────────────────────────────────────────────────────

register("send_letter", {
  description:
    "Send a work request letter to another agent working in a different repository. " +
    "The letter describes what you need (e.g., a new API endpoint, new fields in a response). " +
    "The target agent will pick up the letter from its inbox and do the work.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "Absolute path to the target agent's repository (e.g., /home/user/backend-api)",
      },
      title: {
        type: "string",
        description:
          "Short title describing the request (e.g., 'Add user avatar field to GET /users')",
      },
      body: {
        type: "string",
        description:
          "Detailed description of the work needed. Be specific about what you need and why.",
      },
      acceptance_criteria: {
        type: "array",
        items: { type: "string" },
        description:
          "List of criteria that must be met for the work to be considered done",
      },
      context: {
        type: "string",
        description:
          "Additional context like relevant file paths, data structures, or constraints",
      },
      priority: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Priority level (default: medium)",
      },
    },
    required: ["to", "title", "body"],
  },
  async execute(args, { cwd }) {
    try {
      const result = sendLetter({
        from: cwd,
        to: args.to,
        title: args.title,
        body: args.body,
        acceptanceCriteria: args.acceptance_criteria || [],
        context: args.context || "",
        priority: args.priority || "medium",
      });

      return {
        success: true,
        letter_id: result.id,
        message: `Letter sent to ${args.to}. Letter ID: ${result.id}. Use check_reply with this ID to see when the work is done.`,
      };
    } catch (err) {
      logger.error(`send_letter failed: ${err.message}`);
      return { error: err.message };
    }
  },
});

// ── check_reply ───────────────────────────────────────────────────────

register("check_reply", {
  description:
    "Check if a reply has arrived for a letter you previously sent. " +
    "Returns the response details if the work is done, or null if still pending.",
  parameters: {
    type: "object",
    properties: {
      letter_id: {
        type: "string",
        description: "The ID of the letter you sent (returned by send_letter)",
      },
    },
    required: ["letter_id"],
  },
  async execute(args, { cwd }) {
    try {
      const reply = checkForReply(cwd, args.letter_id);
      if (!reply) {
        return {
          status: "pending",
          message:
            "No reply yet. The other agent may still be working on it.",
        };
      }
      return {
        status: reply.status || "completed",
        title: reply.title,
        changes_made: reply.changesMade,
        api_contract: reply.apiContract,
        notes: reply.notes,
        completed_at: reply.createdAt,
      };
    } catch (err) {
      logger.error(`check_reply failed: ${err.message}`);
      return { error: err.message };
    }
  },
});

// ── read_inbox ────────────────────────────────────────────────────────

register("read_inbox", {
  description:
    "Read letters in this agent's inbox. Shows incoming requests from other agents " +
    "and any replies to letters you've sent.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["request", "response", "all"],
        description: "Filter by letter type (default: all)",
      },
      status: {
        type: "string",
        enum: ["pending", "in-progress", "completed", "failed", "all"],
        description: "Filter by status (default: all)",
      },
    },
  },
  async execute(args, { cwd }) {
    try {
      const filter = {};
      if (args.type && args.type !== "all") filter.type = args.type;
      if (args.status && args.status !== "all") filter.status = args.status;

      const letters = readInbox(cwd, filter);

      if (letters.length === 0) {
        return { letters: [], message: "Inbox is empty." };
      }

      return {
        count: letters.length,
        letters: letters.map((l) => ({
          id: l.id,
          type: l.type,
          title: l.title,
          from: l.from,
          status: l.status,
          priority: l.priority,
          created_at: l.createdAt,
          body: l.body || undefined,
          changes_made: l.changesMade || undefined,
          api_contract: l.apiContract || undefined,
        })),
      };
    } catch (err) {
      logger.error(`read_inbox failed: ${err.message}`);
      return { error: err.message };
    }
  },
});

// ── read_outbox ───────────────────────────────────────────────────────

register("read_outbox", {
  description:
    "Read letters this agent has sent to other agents. " +
    "Use check_reply to see if a specific letter has been answered.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args, { cwd }) {
    try {
      const letters = readOutbox(cwd);

      if (letters.length === 0) {
        return { letters: [], message: "Outbox is empty. No letters sent." };
      }

      // For each outgoing letter, check if a reply exists
      const withStatus = letters.map((l) => {
        const reply = checkForReply(cwd, l.id);
        return {
          id: l.id,
          title: l.title,
          to: l.to,
          priority: l.priority,
          created_at: l.createdAt,
          reply_received: !!reply,
          reply_status: reply?.status || null,
        };
      });

      return { count: withStatus.length, letters: withStatus };
    } catch (err) {
      logger.error(`read_outbox failed: ${err.message}`);
      return { error: err.message };
    }
  },
});

// ── reply_to_letter ───────────────────────────────────────────────────

register("reply_to_letter", {
  description:
    "Send a reply to an incoming work request letter after completing the work. " +
    "The reply is delivered to the requesting agent's inbox.",
  parameters: {
    type: "object",
    properties: {
      letter_id: {
        type: "string",
        description: "The ID of the incoming letter to reply to",
      },
      changes_made: {
        type: "string",
        description: "Description of the changes you made to fulfill the request",
      },
      api_contract: {
        type: "string",
        description:
          "API surface, endpoints, types, or interfaces the requesting agent can use",
      },
      notes: {
        type: "string",
        description: "Any additional notes for the requesting agent",
      },
      status: {
        type: "string",
        enum: ["completed", "failed"],
        description: "Whether the work was completed successfully (default: completed)",
      },
    },
    required: ["letter_id", "changes_made"],
  },
  async execute(args, { cwd }) {
    try {
      // Find the original letter
      const letterPath = path.join(
        cwd,
        ".smol-agent/inbox",
        `${args.letter_id}.letter.md`,
      );
      if (!fs.existsSync(letterPath)) {
        return { error: `Letter not found: ${args.letter_id}` };
      }
      const originalLetter = parseLetter(
        fs.readFileSync(letterPath, "utf-8"),
      );

      const result = sendReply({
        repoPath: cwd,
        originalLetter,
        changesMade: args.changes_made,
        apiContract: args.api_contract || "",
        notes: args.notes || "",
        status: args.status || "completed",
      });

      return {
        success: true,
        response_id: result.id,
        message: `Reply sent for letter ${args.letter_id}. Response delivered to ${originalLetter.from}.`,
      };
    } catch (err) {
      logger.error(`reply_to_letter failed: ${err.message}`);
      return { error: err.message };
    }
  },
});
