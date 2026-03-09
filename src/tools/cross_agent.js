/**
 * Cross-Agent Communication Tools
 *
 * Exposes the inbox/letter protocol and agent registry to agents as tool calls:
 *   - send_letter: Send a work request to another agent's inbox (supports name lookup)
 *   - check_reply: Check if a reply has arrived for a sent letter
 *   - read_inbox: Read all letters in this agent's inbox
 *   - read_outbox: Read letters this agent has sent
 *   - reply_to_letter: Send a response back to a requesting agent
 *   - list_agents: List all registered agents in the global registry
 *   - link_repos: Create a relationship between two repos in the registry
 *   - set_snippet: Set the snippet for this repo so other agents can find it
 *   - find_agent_for_task: Find the best agent to handle a task based on snippets
 */

import { register } from "./registry.js";
import {
  sendLetter,
  checkForReply,
  readInbox,
  readOutbox,
  sendReply,
  parseLetter,
  waitForReply,
} from "../cross-agent.js";
import {
  findAgent,
  listAgents,
  registerAgent,
  addRelation,
  getRelatedAgents,
  updateAgent,
  findAgentForTask,
} from "../agent-registry.js";
import { logger } from "../logger.js";
import fs from "node:fs";
import path from "node:path";

// ── send_letter ───────────────────────────────────────────────────────

register("send_letter", {
  description:
    "Send a work request letter to another agent working in a different repository. " +
    "The 'to' field can be an agent name (looked up in the global registry) or an absolute repo path. " +
    "Use list_agents first to see available agents.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "Agent name (e.g., 'backend-api') or absolute path to the target repo. " +
          "Names are resolved via the global agent registry.",
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
      wait_for_reply: {
        type: "boolean",
        description:
          "If true, block until the other agent sends a reply (up to 5 minutes). " +
          "If false (default), return immediately with a letter_id you can poll with check_reply. " +
          "Note: you'll also be notified automatically when a reply arrives.",
      },
      wait_timeout_ms: {
        type: "number",
        description:
          "Timeout in milliseconds when wait_for_reply is true (default: 300000 = 5 minutes)",
      },
    },
    required: ["to", "title", "body"],
  },
  async execute(args, { cwd }) {
    try {
      // Resolve 'to' — try registry lookup first, then treat as path
      let toPath = args.to;
      if (!path.isAbsolute(toPath)) {
        const agent = findAgent(toPath);
        if (agent) {
          toPath = agent.path;
        } else {
          return {
            error: `Agent "${args.to}" not found in registry. Use list_agents to see available agents, or provide an absolute path.`,
          };
        }
      }

      const result = sendLetter({
        from: cwd,
        to: toPath,
        title: args.title,
        body: args.body,
        acceptanceCriteria: args.acceptance_criteria || [],
        context: args.context || "",
        priority: args.priority || "medium",
      });

      // If wait_for_reply, block until the response arrives
      if (args.wait_for_reply) {
        try {
          const reply = await waitForReply({
            repoPath: cwd,
            letterId: result.id,
            timeoutMs: args.wait_timeout_ms || 300_000,
          });
          return {
            success: true,
            letter_id: result.id,
            delivered_to: toPath,
            reply: {
              status: reply.status || "completed",
              title: reply.title,
              changes_made: reply.changesMade,
              api_contract: reply.apiContract,
              notes: reply.notes,
              completed_at: reply.createdAt,
            },
            message: `Letter sent and reply received from ${toPath}.`,
          };
        } catch (waitErr) {
          return {
            success: true,
            letter_id: result.id,
            delivered_to: toPath,
            wait_error: waitErr.message,
            message: `Letter sent to ${toPath} but timed out waiting for reply. Use check_reply with letter_id to poll later.`,
          };
        }
      }

      return {
        success: true,
        letter_id: result.id,
        delivered_to: toPath,
        message: `Letter sent to ${toPath}. Letter ID: ${result.id}. ` +
          `You'll be notified when the reply arrives, or use check_reply to poll.`,
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
    "Returns the response details if the work is done, or null if still pending. " +
    "Note: you'll also be automatically notified when replies arrive, so you may " +
    "not need to call this unless you want to re-read a specific reply.",
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

// ── list_agents ───────────────────────────────────────────────────────

register("list_agents", {
  description:
    "List all agents registered in the global registry. " +
    "Shows agent names, paths, roles, and relationships. " +
    "Use this to discover agents you can send letters to.",
  parameters: {
    type: "object",
    properties: {
      role: {
        type: "string",
        description: "Filter by role (e.g., 'backend', 'frontend')",
      },
    },
  },
  async execute(args, { cwd }) {
    try {
      const filter = {};
      if (args.role) filter.role = args.role;

      const agents = listAgents(filter);

      if (agents.length === 0) {
        return {
          agents: [],
          message: "No agents registered. Agents self-register when they start up.",
        };
      }

      // Enrich with relationship info
      const enriched = agents.map((a) => {
        const related = getRelatedAgents(a.path);
        return {
          name: a.name,
          path: a.path,
          role: a.role || "(none)",
          description: a.description || "(none)",
          snippet: a.snippet || "(none)",
          last_seen: a.lastSeen,
          relations: related.map((r) => ({
            name: r.agent.name,
            path: r.agent.path,
            type: r.type,
            direction: r.direction,
          })),
        };
      });

      return { count: enriched.length, agents: enriched };
    } catch (err) {
      logger.error(`list_agents failed: ${err.message}`);
      return { error: err.message };
    }
  },
});

// ── link_repos ────────────────────────────────────────────────────────

register("link_repos", {
  description:
    "Create a relationship between two repos in the global agent registry. " +
    "This helps agents understand which repos are related. " +
    "Both repos must be registered (agents self-register on startup).",
  parameters: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description:
          "Source agent name or repo path (e.g., 'frontend' or '/path/to/frontend')",
      },
      to: {
        type: "string",
        description:
          "Target agent name or repo path (e.g., 'backend-api' or '/path/to/backend')",
      },
      type: {
        type: "string",
        enum: ["depends-on", "serves", "consumes", "related"],
        description:
          "Relationship type: depends-on (from needs to), serves (from provides to to), consumes (from uses to's output), related (general)",
      },
    },
    required: ["from", "to", "type"],
  },
  async execute(args) {
    try {
      // Resolve names to paths
      const resolveAgent = (query) => {
        if (path.isAbsolute(query)) return query;
        const agent = findAgent(query);
        if (agent) return agent.path;
        return null;
      };

      const fromPath = resolveAgent(args.from);
      if (!fromPath) {
        return { error: `Agent "${args.from}" not found in registry.` };
      }
      const toPath = resolveAgent(args.to);
      if (!toPath) {
        return { error: `Agent "${args.to}" not found in registry.` };
      }

      addRelation(fromPath, toPath, args.type);

      return {
        success: true,
        message: `Linked: ${args.from} --${args.type}--> ${args.to}`,
      };
    } catch (err) {
      logger.error(`link_repos failed: ${err.message}`);
      return { error: err.message };
    }
  },
});

// ── set_snippet ───────────────────────────────────────────────────────

register("set_snippet", {
  description:
    "Set a description snippet for this repo in the global agent registry. " +
    "The snippet describes what this repo provides (endpoints, services, data) " +
    "so other agents can automatically find the right repo to send requests to. " +
    "Example: 'REST API with /users, /products endpoints. Auth via JWT. PostgreSQL database.'",
  parameters: {
    type: "object",
    properties: {
      snippet: {
        type: "string",
        description:
          "Description of what this repo provides. Be specific about APIs, " +
          "endpoints, services, data models, or capabilities that other agents might need.",
      },
    },
    required: ["snippet"],
  },
  async execute(args, { cwd }) {
    try {
      const result = updateAgent(cwd, { snippet: args.snippet });
      if (!result) {
        return { error: "This repo is not registered. It will auto-register on next startup." };
      }
      return {
        success: true,
        message: `Snippet updated for ${result.name}. Other agents can now find this repo based on this description.`,
      };
    } catch (err) {
      logger.error(`set_snippet failed: ${err.message}`);
      return { error: err.message };
    }
  },
});

// ── find_agent_for_task ───────────────────────────────────────────────

register("find_agent_for_task", {
  description:
    "Find the best registered agent to handle a task based on their description snippets. " +
    "Describe what you need and this tool will rank agents by relevance. " +
    "Use this before send_letter when you're not sure which agent to contact.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Description of the task or capability you need. " +
          "e.g., 'I need a new REST endpoint for user avatars' or 'I need database migration support'",
      },
    },
    required: ["task"],
  },
  async execute(args, { cwd }) {
    try {
      const results = findAgentForTask(args.task, cwd);

      if (results.length === 0) {
        return {
          matches: [],
          message:
            "No matching agents found. Use list_agents to see all registered agents, " +
            "or ask the user which repo to target.",
        };
      }

      return {
        count: results.length,
        matches: results.map((r) => ({
          name: r.agent.name,
          path: r.agent.path,
          role: r.agent.role || "(none)",
          snippet: r.agent.snippet || r.agent.description || "(none)",
          relevance_score: r.score,
        })),
        suggestion: `Best match: "${results[0].agent.name}" (score: ${results[0].score}). Use send_letter with to="${results[0].agent.name}" to send a request.`,
      };
    } catch (err) {
      logger.error(`find_agent_for_task failed: ${err.message}`);
      return { error: err.message };
    }
  },
});
