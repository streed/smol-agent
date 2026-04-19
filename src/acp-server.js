/**
 * Agent Client Protocol (ACP) server for smol-agent.
 *
 * Implements the ACP specification for IDE/editor integration.
 * Exposes the agent via JSON-RPC over stdio, allowing external
 * clients to:
 * - Start and manage agent sessions
 * - Send messages and receive responses
 * - Handle tool approval requests
 * - Stream events in real-time
 *
 * Key components:
 * - SmolACPAgent: initialize, newSession, loadSession, resume (unstable), list (unstable),
 *   setSessionMode, setSessionConfigOption, unstable_setSessionModel, authenticate, prompt, cancel
 * - Prompt content: Text, resource_link (reads files inside jail), embedded text resources
 * - Tool kind mapping: ./acp-content.js (shared with remote-server.js)
 * - Session IDs: Same IDs as on-disk `.smol-agent` sessions (startSession on new)
 * - Session management: TTL-based cleanup, max 1 concurrent session (global singleton safety)
 * - Authentication: Optional token via authenticate._meta.token (constant-time compare)
 *
 * Dependencies: @agentclientprotocol/sdk, node:stream, node:crypto, node:path, node:module,
 *               ./runtime/interactive-agent.js, ./acp-content.js, ./sessions.js, ./tools/ask_user.js,
 *               ./settings.js, ./logger.js, ./tools/registry.js, ./ui/diff.js, ../package.json
 * Depended on by: src/index.js
 *
 * @module acp-server
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { setAskHandler, getAskHandler } from "./tools/ask_user.js";
import { loadSettings } from "./settings.js";
import { logger } from "./logger.js";
import { requiresApproval } from "./tools/registry.js";
import { formatDiff, formatReplaceDiff, formatNewFileDiff } from "./ui/diff.js";
import { createSessionAgent } from "./runtime/interactive-agent.js";
import { listSessions } from "./sessions.js";
import {
  acpToolKind,
  applySessionMode,
  getSessionModeState,
  promptBlocksToUserText,
} from "./acp-content.js";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json");

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
    const response = {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: "smol-agent",
        version: PACKAGE_VERSION,
      },
    };
    if (this._authToken) {
      response.authMethods = [
        {
          id: "smol_bearer",
          name: "Bearer token",
          description:
            "Pass the shared secret as authenticate._meta.token (same value as SMOL_AGENT_AUTH_TOKEN / --auth-token).",
        },
      ];
    }
    return response;
  }

  async newSession(params) {
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

    const settings = await loadSettings(resolved);
    const contextSize =
      typeof this._contextSize === "number"
        ? this._contextSize
        : typeof settings.contextSize === "number"
          ? settings.contextSize
          : undefined;

    const { agent } = await createSessionAgent({
      host: this._host,
      model: this._model,
      provider: this._provider,
      apiKey: this._apiKey,
      contextSize,
      coreToolsOnly: this._coreToolsOnly,
      jailDirectory: resolved,
      programmaticToolCalling: this._programmaticToolCalling,
    });

    if (this._autoApprove || settings.autoApprove) {
      agent._approveAll = true;
    }

    agent.startSession();
    const smolSession = agent.getSession();
    const sessionId = smolSession.id;

    this.sessions.set(sessionId, { agent, callCounter: 0, lastActivity: Date.now() });
    logger.info(`[ACP] session/new — id: ${sessionId}, cwd: ${cwd}, model: ${this._model || "default"}, autoApprove: ${agent._approveAll}`);
    return {
      sessionId,
      modes: getSessionModeState(agent),
    };
  }

  async loadSession(params) {
    const cwd = params.cwd || process.cwd();
    const resolved = path.resolve(cwd);
    const BLOCKED_ROOTS = ["/", "/etc", "/root", "/boot", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/dev", "/proc", "/sys", "/var"];
    if (BLOCKED_ROOTS.includes(resolved)) {
      throw new acp.RequestError(-32602, `Blocked: '${cwd}' is not allowed as a session working directory`);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new acp.RequestError(-32602, `Maximum concurrent sessions (${MAX_SESSIONS}) reached. Close the existing session before opening a new one.`);
    }

    const settings = await loadSettings(resolved);
    const contextSize =
      typeof this._contextSize === "number"
        ? this._contextSize
        : typeof settings.contextSize === "number"
          ? settings.contextSize
          : undefined;

    const { agent, resumed } = await createSessionAgent({
      host: this._host,
      model: this._model,
      provider: this._provider,
      apiKey: this._apiKey,
      contextSize,
      coreToolsOnly: this._coreToolsOnly,
      jailDirectory: resolved,
      programmaticToolCalling: this._programmaticToolCalling,
      sessionId: params.sessionId,
    });
    if (!resumed) {
      throw acp.RequestError.resourceNotFound(`Session not found: ${params.sessionId}`);
    }

    if (this._autoApprove || settings.autoApprove) {
      agent._approveAll = true;
    }

    const sessionId = params.sessionId;
    this.sessions.set(sessionId, { agent, callCounter: 0, lastActivity: Date.now() });

    await this._replayLoadedHistory(sessionId, agent);

    logger.info(`[ACP] session/load — id: ${sessionId}, cwd: ${cwd}, messages: ${agent.messages?.length || 0}`);
    return {
      modes: getSessionModeState(agent),
    };
  }

  async unstable_resumeSession(params) {
    const cwd = params.cwd || process.cwd();
    const resolved = path.resolve(cwd);
    const BLOCKED_ROOTS = ["/", "/etc", "/root", "/boot", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/dev", "/proc", "/sys", "/var"];
    if (BLOCKED_ROOTS.includes(resolved)) {
      throw new acp.RequestError(-32602, `Blocked: '${cwd}' is not allowed as a session working directory`);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new acp.RequestError(-32602, `Maximum concurrent sessions (${MAX_SESSIONS}) reached. Close the existing session before opening a new one.`);
    }

    const settings = await loadSettings(resolved);
    const contextSize =
      typeof this._contextSize === "number"
        ? this._contextSize
        : typeof settings.contextSize === "number"
          ? settings.contextSize
          : undefined;

    const { agent, resumed } = await createSessionAgent({
      host: this._host,
      model: this._model,
      provider: this._provider,
      apiKey: this._apiKey,
      contextSize,
      coreToolsOnly: this._coreToolsOnly,
      jailDirectory: resolved,
      programmaticToolCalling: this._programmaticToolCalling,
      sessionId: params.sessionId,
    });
    if (!resumed) {
      throw acp.RequestError.resourceNotFound(`Session not found: ${params.sessionId}`);
    }

    if (this._autoApprove || settings.autoApprove) {
      agent._approveAll = true;
    }

    const sessionId = params.sessionId;
    this.sessions.set(sessionId, { agent, callCounter: 0, lastActivity: Date.now() });

    logger.info(`[ACP] session/resume — id: ${sessionId}, cwd: ${cwd}`);
    return {
      modes: getSessionModeState(agent),
    };
  }

  async unstable_listSessions(params) {
    const cwd = params.cwd ? path.resolve(params.cwd) : process.cwd();
    const all = await listSessions(cwd);
    const offset = params.cursor ? parseInt(params.cursor, 10) : 0;
    const start = Number.isFinite(offset) ? offset : 0;
    const pageSize = 50;
    const slice = all.slice(start, start + pageSize);
    const sessions = slice.map((s) => ({
      sessionId: s.id,
      cwd,
      title: s.name || s.summary || null,
      updatedAt: s.updatedAt,
    }));
    const nextCursor = start + slice.length < all.length ? String(start + slice.length) : null;
    return { sessions, nextCursor };
  }

  async setSessionMode(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new acp.RequestError(-32602, `Unknown session: ${params.sessionId}`);
    }
    try {
      applySessionMode(session.agent, params.modeId);
    } catch (e) {
      throw new acp.RequestError(-32602, e.message || String(e));
    }
    this._notifyModeUpdate(params.sessionId, session.agent);
    return {};
  }

  async setSessionConfigOption(_params) {
    return { configOptions: [] };
  }

  /**
   * Unstable: `session/set_model` — switch the LLM model for an idle session (same provider family).
   * Delegates to Agent#setModel (see agent.js).
   */
  async unstable_setSessionModel(params) {
    const sessionId = params?.sessionId;
    const modelId = params?.modelId;
    if (!sessionId || typeof sessionId !== "string") {
      throw new acp.RequestError(-32602, "session/set_model requires sessionId");
    }
    if (!modelId || typeof modelId !== "string") {
      throw new acp.RequestError(-32602, "session/set_model requires modelId");
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new acp.RequestError(-32602, `Unknown session: ${sessionId}`);
    }
    const { agent } = session;
    if (agent.running) {
      throw new acp.RequestError(
        -32602,
        "Cannot change model while a prompt turn is in progress; cancel the turn first",
      );
    }
    try {
      agent.setModel(modelId);
    } catch (e) {
      throw new acp.RequestError(-32602, e?.message || String(e));
    }
    logger.info(`[ACP] session/set_model — session: ${sessionId.slice(0, 8)}…, model: ${modelId}`);
    await agent.saveSession?.().catch(() => {});
    return {};
  }

  _notifyModeUpdate(sessionId, agent) {
    const state = getSessionModeState(agent);
    safeSessionUpdate(this.connection, {
      sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: state.currentModeId,
      },
    });
  }

  async _replayLoadedHistory(sessionId, agent) {
    const conn = this.connection;
    for (const m of agent.messages || []) {
      if (m.role === "system") continue;
      const text =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      if (m.role === "user") {
        safeSessionUpdate(conn, {
          sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text },
          },
        });
      } else if (m.role === "assistant") {
        safeSessionUpdate(conn, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      } else if (m.role === "tool") {
        safeSessionUpdate(conn, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `[tool ${m.name || "result"}]\n${text}`,
            },
          },
        });
      }
    }
  }

  async authenticate(params) {
    if (!this._authToken) {
      return {};
    }
    const mid = params?.methodId;
    if (mid && mid !== "smol_bearer") {
      throw new acp.RequestError(-32600, `Unsupported authentication method: ${mid}`);
    }
    // zAuthenticateRequest only allows methodId + _meta; unknown top-level keys are stripped.
    // Clients should pass the secret in `_meta.token` (or set SMOL_AGENT_AUTH_TOKEN in the agent env).
    const meta = params?._meta;
    const fromMeta =
      meta && typeof meta === "object" && meta !== null && "token" in meta
        ? meta.token
        : undefined;
    const provided = params?.token ?? params?.credentials?.token ?? fromMeta;
    if (!provided || !constantTimeEqual(this._authToken, String(provided))) {
      throw new acp.RequestError(-32600, "Authentication failed: invalid or missing token");
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

    const text = await promptBlocksToUserText(contentBlocks, session.agent.jailDirectory, {
      embeddedContext: true,
    });

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
      logger.info(`[ACP] tool_call — ${callId}: ${name} ${JSON.stringify(logArgs)}, kind: ${acpToolKind(name)}`);

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
          kind: acpToolKind(name),
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

      // Log without _display to keep logs readable
      const { _display: _d, ...logResult } = result || {};
      const resultPreview = logResult?.error
        ? `error: ${logResult.error.slice(0, 80)}`
        : JSON.stringify(logResult).slice(0, 100);
      logger.info(`[ACP] tool_result — ${callId}: ${name} → ${status} (${resultPreview})`);

      // Generate a plain-text unified diff for edit tools, mirroring the TUI
      if (result?._display) {
        const d = result._display;
        let diffLines = [];
        const diffOpts = { plain: true };

        if (d.type === "new") {
          diffLines = formatNewFileDiff(d.newContent, d.filePath, diffOpts);
        } else if (d.type === "overwrite") {
          diffLines = formatDiff(d.oldContent, d.newContent, d.filePath, diffOpts);
        } else if (d.type === "replace") {
          diffLines = formatReplaceDiff(d.fileContent, d.oldText, d.newText, d.filePath, diffOpts);
        }

        if (diffLines.length > 0) {
          safeSessionUpdate(conn, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: diffLines.join("\n") + "\n" },
            },
          });
        }
      }

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
              kind: acpToolKind(name),
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

export { SmolACPAgent };

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
    acpAgent._programmaticToolCalling = options.programmaticToolCalling;
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
