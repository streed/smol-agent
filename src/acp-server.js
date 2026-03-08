import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { Agent } from "./agent.js";
import { setAskHandler, getAskHandler } from "./tools/ask_user.js";
import { loadSettings } from "./settings.js";
import { logger } from "./logger.js";
import { requiresApproval } from "./tools/registry.js";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json");

// ── Tool kind mapping ───────────────────────────────────────────────

const TOOL_KIND_MAP = {
  read_file: "read",
  list_files: "read",
  grep: "search",
  write_file: "edit",
  replace_in_file: "edit",
  run_command: "execute",
  web_search: "fetch",
  web_fetch: "fetch",
  reflect: "think",
  remember: "think",
  recall: "think",
  delegate: "other",
  ask_user: "other",
  save_plan: "think",
  get_current_plan: "think",
  complete_plan_step: "think",
  load_plan_progress: "think",
  update_plan_status: "think",
};

function toolKind(name) {
  return TOOL_KIND_MAP[name] || "other";
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Constant-time string comparison to prevent timing attacks on auth tokens. */
function constantTimeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to consume constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Wrap sessionUpdate calls so a dropped connection doesn't produce unhandled rejections. */
function safeSessionUpdate(conn, params) {
  try {
    const result = conn.sessionUpdate(params);
    if (result && typeof result.catch === 'function') {
      result.catch((err) => logger.warn(`sessionUpdate failed: ${err.message}`));
    }
  } catch (err) {
    logger.warn(`sessionUpdate threw: ${err.message}`);
  }
}

// Session TTL — 30 minutes of inactivity
const SESSION_TTL_MS = 30 * 60 * 1000;

// Max concurrent sessions — limited to 1 because the Agent class uses global
// singletons (jailDirectory, searchClient, fetchClient, subAgentConfig) that
// would cause cross-session security contamination with multiple sessions.
const MAX_SESSIONS = 1;

// ── ACP Agent implementation ────────────────────────────────────────

class SmolACPAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map(); // sessionId → { agent, callCounter, lastActivity }
  }

  async initialize(params) {
    const clientInfo = params.clientInfo;
    logger.info(`[ACP] initialize — client: ${clientInfo?.name || "unknown"} ${clientInfo?.version || ""}, protocol: ${params.protocolVersion}`);
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      agentInfo: {
        name: "smol-agent",
        version: PACKAGE_VERSION,
      },
    };
  }

  async newSession(params) {
    const sessionId = crypto.randomUUID();
    const cwd = params.cwd || process.cwd();

    // Validate CWD to prevent jail escape via arbitrary system paths
    const resolved = path.resolve(cwd);
    const BLOCKED_ROOTS = ["/", "/etc", "/root", "/boot", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/dev", "/proc", "/sys", "/var"];
    if (BLOCKED_ROOTS.includes(resolved)) {
      throw new acp.RequestError(-32602, `Blocked: '${cwd}' is not allowed as a session working directory`);
    }

    // Reject if we already have an active session — global singletons make
    // concurrent sessions unsafe (see MAX_SESSIONS comment above).
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new acp.RequestError(-32602, `Maximum concurrent sessions (${MAX_SESSIONS}) reached. Close the existing session before opening a new one.`);
    }

    const agent = new Agent({
      host: this._host,
      model: this._model,
      provider: this._provider,
      apiKey: this._apiKey,
      jailDirectory: resolved,
      coreToolsOnly: this._coreToolsOnly,
    });

    // Load persisted settings
    const settings = await loadSettings(cwd);
    if (this._autoApprove || settings.autoApprove) {
      agent._approveAll = true;
    }

    this.sessions.set(sessionId, { agent, callCounter: 0, lastActivity: Date.now() });
    logger.info(`[ACP] session/new — id: ${sessionId}, cwd: ${cwd}, model: ${this._model || "default"}, autoApprove: ${agent._approveAll}`);
    return { sessionId };
  }

  async authenticate(params) {
    // If a token was configured, validate it with constant-time comparison
    if (this._authToken) {
      const provided = params?.token || params?.credentials?.token;
      if (!provided || !constantTimeEqual(this._authToken, provided)) {
        throw new acp.RequestError(-32600, "Authentication failed: invalid or missing token");
      }
    }
    return {};
  }

  async prompt(params) {
    const { sessionId, prompt: contentBlocks } = params;

    if (!Array.isArray(contentBlocks)) {
      throw new acp.RequestError(-32602, "prompt.prompt must be an array of content blocks");
    }

    // Sweep stale sessions
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (id !== sessionId && now - s.lastActivity > SESSION_TTL_MS) {
        logger.info(`[ACP] Sweeping stale session ${id.slice(0, 8)}… (inactive ${Math.round((now - s.lastActivity) / 1000)}s)`);
        s.agent.reset();
        this.sessions.delete(id);
      }
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new acp.RequestError(-32602, `Unknown session: ${sessionId}`);
    }

    session.lastActivity = now;
    const { agent } = session;

    // Extract text from content blocks
    const text = contentBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const promptPreview = text.length > 100 ? text.slice(0, 100) + "…" : text;
    logger.info(`[ACP] prompt — session: ${sessionId.slice(0, 8)}…, text: "${promptPreview}"`);

    if (!text) {
      logger.info(`[ACP] prompt — empty text, returning end_turn`);
      return { stopReason: "end_turn" };
    }

    // Wire up event listeners for this prompt turn
    const cleanup = this._attachListeners(sessionId, session);
    const startTime = Date.now();

    try {
      await agent.run(text);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[ACP] prompt complete — session: ${sessionId.slice(0, 8)}…, elapsed: ${elapsed}s, stopReason: end_turn`);
      return { stopReason: "end_turn" };
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (
        err.name === "AbortError" ||
        err.message === "Operation cancelled"
      ) {
        logger.info(`[ACP] prompt cancelled — session: ${sessionId.slice(0, 8)}…, elapsed: ${elapsed}s`);
        return { stopReason: "cancelled" };
      }
      logger.error(`[ACP] prompt error — session: ${sessionId.slice(0, 8)}…, elapsed: ${elapsed}s, error: ${err.message}`);
      // Send final error as agent message, then end
      safeSessionUpdate(this.connection, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Error: ${err.message}` },
        },
      });
      return { stopReason: "end_turn" };
    } finally {
      cleanup();
    }
  }

  async cancel(params) {
    const sessionId = params?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      throw new acp.RequestError(-32602, "cancel requires a valid sessionId");
    }
    logger.info(`[ACP] cancel — session: ${sessionId.slice(0, 8)}…`);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.agent.cancel();
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────

  _nextCallId(session) {
    return `call_${++session.callCounter}`;
  }

  _attachListeners(sessionId, session) {
    const { agent } = session;
    const conn = this.connection;

    // Track active tool calls so we can map tool_result back to its ID
    const pendingToolCalls = new Map(); // "name|argsHash" → callId

    const onToken = ({ content }) => {
      safeSessionUpdate(conn, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: content },
        },
      });
    };

    const onThinking = ({ content }) => {
      const preview = content.length > 80 ? content.slice(0, 80) + "…" : content;
      logger.debug(`[ACP] thinking — ${preview}`);
      safeSessionUpdate(conn, {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: content },
        },
      });
    };

    const onToolCall = ({ name, args }) => {
      // If this tool will go through the approval flow, skip — the approval
      // handler sends its own tool_call via requestPermission. Emitting here
      // too would create a duplicate callId that never gets completed, causing
      // ACP clients to think an edit is stuck "in_progress" and revert it.
      if (!agent._approveAll && agent._approvalHandler && requiresApproval(name)) {
        return;
      }

      const callId = this._nextCallId(session);
      const key = `${name}|${JSON.stringify(args)}`;
      pendingToolCalls.set(key, callId);

      // Log full params, but redact file content to keep logs readable
      const CONTENT_KEYS = new Set(["content", "newText", "oldText"]);
      const logArgs = {};
      for (const [k, v] of Object.entries(args || {})) {
        if (CONTENT_KEYS.has(k) && typeof v === "string") {
          logArgs[k] = `<${v.length} chars>`;
        } else {
          logArgs[k] = v;
        }
      }
      logger.info(`[ACP] tool_call — ${callId}: ${name} ${JSON.stringify(logArgs)}, kind: ${toolKind(name)}`);

      const locations = [];
      if (args?.filePath) {
        locations.push({ path: args.filePath });
      }

      safeSessionUpdate(conn, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          title: `${name}(${Object.keys(args || {}).join(", ")})`,
          kind: toolKind(name),
          status: "in_progress",
          locations: locations.length > 0 ? locations : undefined,
          rawInput: args,
        },
      });
    };

    const onToolResult = ({ name, args, result }) => {
      // Find the matching pending call — prefer exact key match when args are
      // available, otherwise fall back to name-prefix match.
      let callId = null;
      if (args !== undefined) {
        const exactKey = `${name}|${JSON.stringify(args)}`;
        if (pendingToolCalls.has(exactKey)) {
          callId = pendingToolCalls.get(exactKey);
          pendingToolCalls.delete(exactKey);
        }
      }
      if (!callId) {
        // Fallback: match first pending call for this tool name
        for (const [key, id] of pendingToolCalls) {
          if (key.startsWith(`${name}|`)) {
            callId = id;
            pendingToolCalls.delete(key);
            break;
          }
        }
      }

      if (!callId) {
        // Tool result without a matching call — shouldn't happen, but handle gracefully
        callId = this._nextCallId(session);
      }

      const status = result?.error ? "failed" : "completed";
      const resultPreview = result?.error
        ? `error: ${result.error.slice(0, 80)}`
        : JSON.stringify(result).slice(0, 100);
      logger.info(`[ACP] tool_result — ${callId}: ${name} → ${status} (${resultPreview})`);

      safeSessionUpdate(conn, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status,
          rawOutput: result,
        },
      });
    };

    // Approval handler — use ACP requestPermission
    if (!agent._approveAll) {
      agent.setApprovalHandler(async (name, args) => {
        const callId = this._nextCallId(session);
        const key = `${name}|${JSON.stringify(args)}`;
        pendingToolCalls.set(key, callId);

        logger.info(`[ACP] permission request — ${callId}: ${name}(${Object.keys(args || {}).join(", ")})`);

        try {
          const response = await conn.requestPermission({
            sessionId,
            toolCall: {
              toolCallId: callId,
              title: `${name}(${Object.keys(args || {}).join(", ")})`,
              kind: toolKind(name),
              status: "pending",
              rawInput: args,
              locations: args?.filePath
                ? [{ path: args.filePath }]
                : undefined,
            },
            options: [
              {
                optionId: "allow_once",
                name: "Allow",
                kind: "allow_once",
              },
              {
                optionId: "allow_always",
                name: "Allow always",
                kind: "allow_always",
              },
              {
                optionId: "reject",
                name: "Deny",
                kind: "reject_once",
              },
            ],
          });

          if (response.outcome.outcome === "cancelled") {
            logger.info(`[ACP] permission result — ${callId}: cancelled`);
            return { approved: false };
          }

          const selected = response.outcome.optionId;
          logger.info(`[ACP] permission result — ${callId}: ${selected}`);

          const approved = selected === "allow_once" || selected === "allow_always";
          if (approved) {
            // Notify client the tool is now executing
            safeSessionUpdate(conn, {
              sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: callId,
                status: "in_progress",
              },
            });
          }

          if (selected === "allow_always") {
            return { approved: true, approveAll: true };
          }
          return { approved };
        } catch (err) {
          logger.warn(`Permission request failed: ${err.message}`);
          return { approved: false };
        }
      });
    }

    // ask_user handler — complete the turn with the question as response,
    // client sends the answer as the next prompt
    const previousAskHandler = getAskHandler();
    const askHandler = async (question) => {
      // Send the question as an agent message so the client sees it
      safeSessionUpdate(conn, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: question },
        },
      });
      // We can't block for a response in the prompt flow, so return a placeholder
      return "(waiting for user response — please send your answer as the next prompt)";
    };
    setAskHandler(askHandler);

    const onRetry = ({ attempt, maxRetries, message }) => {
      logger.info(`[ACP] retry — attempt ${attempt}/${maxRetries}: ${message}`);
      safeSessionUpdate(conn, {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `[Retry ${attempt}/${maxRetries}] ${message}` },
        },
      });
    };

    const onSubAgentProgress = (event) => {
      const preview = typeof event === "string" ? event : JSON.stringify(event).slice(0, 120);
      logger.debug(`[ACP] sub_agent_progress — ${preview}`);
      safeSessionUpdate(conn, {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `[Sub-agent] ${preview}` },
        },
      });
    };

    // Attach listeners
    agent.on("token", onToken);
    agent.on("thinking", onThinking);
    agent.on("tool_call", onToolCall);
    agent.on("tool_result", onToolResult);
    agent.on("retry", onRetry);
    agent.on("sub_agent_progress", onSubAgentProgress);

    // Return cleanup function
    return () => {
      agent.off("token", onToken);
      agent.off("thinking", onThinking);
      agent.off("tool_call", onToolCall);
      agent.off("tool_result", onToolResult);
      agent.off("retry", onRetry);
      agent.off("sub_agent_progress", onSubAgentProgress);
      // Note: _approveAll is intentionally NOT reverted — "Allow always"
      // should persist across prompt turns within the same session.
      agent.setApprovalHandler(null);
      // Restore previous ask handler to avoid cross-session interference
      setAskHandler(previousAskHandler);
    };
  }
}

// ── Start the ACP server ────────────────────────────────────────────

export function startACPServer(options = {}) {
  const output = Writable.toWeb(process.stdout);
  const input = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(output, input);

  let acpAgent = null;
  const connection = new acp.AgentSideConnection((conn) => {
    acpAgent = new SmolACPAgent(conn);
    // Pass config through to agent creation
    acpAgent._host = options.host;
    acpAgent._model = options.model;
    acpAgent._provider = options.provider;
    acpAgent._apiKey = options.apiKey;
    acpAgent._contextSize = options.contextSize;
    acpAgent._coreToolsOnly = options.coreToolsOnly;
    acpAgent._autoApprove = options.autoApprove;
    acpAgent._authToken = options.authToken || process.env.SMOL_AGENT_AUTH_TOKEN || null;
    return acpAgent;
  }, stream);

  // Log to file (stdout is reserved for JSON-RPC)
  logger.info(`[ACP] server started — model: ${options.model || "default"}, host: ${options.host || "default"}, coreToolsOnly: ${options.coreToolsOnly}, autoApprove: ${options.autoApprove}`);

  // When the connection closes, cancel all active sessions and clean up
  connection.closed.then(() => {
    logger.info("[ACP] connection closed — cancelling active sessions");
    if (acpAgent) {
      for (const [id, session] of acpAgent.sessions) {
        logger.info(`[ACP] cancelling session ${id.slice(0, 8)}… on connection close`);
        session.agent.cancel();
        session.agent.reset();
      }
      acpAgent.sessions.clear();
    }
    process.exit(0);
  });

  return connection;
}
