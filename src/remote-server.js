/**
 * Remote control server for smol-agent.
 *
 * Exposes the agent via a RESTful HTTP interface, allowing remote machines
 * to control the agent as if the user was directly interacting with it.
 * Similar to ACP mode, but works over HTTP with a polling-based event model.
 *
 * Design:
 * - Each session maintains an event queue. Agent events (tokens, tool calls,
 *   tool results, thinking) are pushed to the queue as they occur.
 * - Clients poll GET /api/sessions/:id/events to drain the queue — the entire
 *   queue is returned in a single response.
 * - Prompts are non-blocking: POST /api/sessions/:id/prompt starts the agent
 *   loop and returns immediately. The client polls events to see progress.
 * - Tool approval is handled via polling: when a tool needs approval, an
 *   approval_request event appears in the queue. The client responds with
 *   POST /api/sessions/:id/approve.
 *
 * Endpoints:
 *   POST   /api/sessions              Create a new session
 *   DELETE  /api/sessions/:id          Destroy a session
 *   POST   /api/sessions/:id/prompt    Send a prompt (non-blocking)
 *   GET    /api/sessions/:id/events    Poll event queue (drains all pending events)
 *   POST   /api/sessions/:id/cancel    Cancel current operation
 *   POST   /api/sessions/:id/approve   Approve or deny a pending tool call
 *   GET    /api/status                 Server health check
 *
 * Authentication: Bearer token via Authorization header.
 *   Set via --auth-token flag or SMOL_AGENT_AUTH_TOKEN env var.
 *
 * Dependencies: node:http, node:crypto, node:path, ./agent.js, ./settings.js,
 *               ./logger.js, ./tools/registry.js, ./tools/ask_user.js,
 *               ../package.json
 * Depended on by: src/index.js
 *
 * @module remote-server
 */
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { setAskHandler, getAskHandler } from "./tools/ask_user.js";
import { loadSettings } from "./settings.js";
import { logger } from "./logger.js";
import { requiresApproval } from "./tools/registry.js";
import { createSessionAgent } from "./runtime/interactive-agent.js";
import { acpToolKind } from "./acp-content.js";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json");

// ── Constants ───────────────────────────────────────────────────────

/** Session TTL — 30 minutes of inactivity. */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Max concurrent sessions — limited to 1 (global singletons in Agent). */
const MAX_SESSIONS = 1;

/** Max events buffered per session before oldest are dropped. */
const MAX_EVENT_QUEUE_SIZE = 10000;

// ── Helpers ─────────────────────────────────────────────────────────

/** Constant-time string comparison to prevent timing attacks on auth tokens. */
function constantTimeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Read the full request body as a string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Parse JSON body, returning null on failure. */
async function parseJsonBody(req) {
  try {
    const raw = await readBody(req);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Send a JSON response. */
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Send a JSON error response. */
function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

/** Extract session ID from a URL path like /api/sessions/:id/... */
function extractSessionId(pathname) {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)/);
  return match ? match[1] : null;
}

// Blocked CWD roots to prevent jail escape
const BLOCKED_ROOTS = [
  "/", "/etc", "/root", "/boot", "/bin", "/sbin",
  "/usr", "/lib", "/lib64", "/dev", "/proc", "/sys", "/var",
];

// ── Session state ───────────────────────────────────────────────────

/**
 * Per-session state, including the agent instance and event queue.
 */
class RemoteSession {
  constructor(id, agent) {
    this.id = id;
    this.agent = agent;
    this.events = [];
    this.callCounter = 0;
    this.lastActivity = Date.now();
    this.status = "idle"; // "idle" | "running" | "awaiting_approval"
    this.pendingApproval = null; // { resolve, callId, name, args }
    this.pendingToolCalls = new Map(); // "name|argsHash" → callId
    this._listeners = null; // cleanup function for event listeners
  }

  /** Push an event to the queue, dropping oldest if over limit. */
  pushEvent(event) {
    this.events.push({ ...event, timestamp: Date.now() });
    if (this.events.length > MAX_EVENT_QUEUE_SIZE) {
      this.events.splice(0, this.events.length - MAX_EVENT_QUEUE_SIZE);
    }
  }

  /** Drain all events from the queue. */
  drainEvents() {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  /** Get next call ID. */
  nextCallId() {
    return `call_${++this.callCounter}`;
  }

  /** Touch last-activity timestamp. */
  touch() {
    this.lastActivity = Date.now();
  }

  /** Cleanup listeners and cancel agent. */
  destroy() {
    if (this._listeners) {
      this._listeners();
      this._listeners = null;
    }
    this.agent.cancel();
    this.agent.reset();
    if (this.pendingApproval) {
      this.pendingApproval.resolve({ approved: false });
      this.pendingApproval = null;
    }
  }
}

// ── Remote server ───────────────────────────────────────────────────

/**
 * Start the remote control HTTP server.
 *
 * @param {object} options
 * @param {string} [options.host] - LLM provider host
 * @param {string} [options.model] - Model name
 * @param {string} [options.provider] - Provider name
 * @param {string} [options.apiKey] - API key
 * @param {boolean} [options.coreToolsOnly] - Restrict to core tools
 * @param {boolean} [options.autoApprove] - Auto-approve all tool calls
 * @param {string} [options.authToken] - Auth token for Bearer auth
 * @param {number} [options.port] - HTTP port (default: 7700)
 * @param {string} [options.listenHost] - Listen address (default: "0.0.0.0")
 * @param {boolean} [options.quiet] - Suppress startup banner output
 * @returns {{ server: http.Server, close: () => Promise<void> }}
 */
export function startRemoteServer(options = {}) {
  const port = options.port || 7700;
  const listenHost = options.listenHost || "0.0.0.0";
  const quiet = options.quiet === true;
  const authToken = options.authToken || process.env.SMOL_AGENT_AUTH_TOKEN || null;
  const sessions = new Map();

  // ── Auth middleware ──────────────────────────────────────────────

  function checkAuth(req, res) {
    if (!authToken) return true; // No token configured — open access

    const header = req.headers["authorization"];
    if (!header || !header.startsWith("Bearer ")) {
      sendError(res, 401, "Missing or invalid Authorization header. Expected: Bearer <token>");
      return false;
    }
    const provided = header.slice(7);
    if (!constantTimeEqual(authToken, provided)) {
      sendError(res, 401, "Invalid authentication token");
      return false;
    }
    return true;
  }

  // ── Session sweep ───────────────────────────────────────────────

  function sweepStaleSessions(excludeId) {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (id !== excludeId && now - session.lastActivity > SESSION_TTL_MS) {
        logger.info(`[Remote] Sweeping stale session ${id.slice(0, 8)}… (inactive ${Math.round((now - session.lastActivity) / 1000)}s)`);
        session.destroy();
        sessions.delete(id);
      }
    }
  }

  // ── Attach agent event listeners ────────────────────────────────

  function attachListeners(session) {
    const { agent } = session;

    const onToken = ({ content }) => {
      session.pushEvent({ type: "token", content });
    };

    const onThinking = ({ content }) => {
      session.pushEvent({ type: "thinking", content });
    };

    const onToolCall = ({ name, args }) => {
      // If this tool will go through the approval flow, skip — the approval
      // handler sends its own event.
      if (!agent._approveAll && agent._approvalHandler && requiresApproval(name)) {
        return;
      }

      const callId = session.nextCallId();
      const key = `${name}|${JSON.stringify(args)}`;
      session.pendingToolCalls.set(key, callId);

      session.pushEvent({
        type: "tool_call",
        callId,
        name,
        args,
        kind: acpToolKind(name),
        status: "in_progress",
      });
    };

    const onToolResult = ({ name, args, result }) => {
      // Find the matching pending call
      let callId = null;
      if (args !== undefined) {
        const exactKey = `${name}|${JSON.stringify(args)}`;
        if (session.pendingToolCalls.has(exactKey)) {
          callId = session.pendingToolCalls.get(exactKey);
          session.pendingToolCalls.delete(exactKey);
        }
      }
      if (!callId) {
        for (const [key, id] of session.pendingToolCalls) {
          if (key.startsWith(`${name}|`)) {
            callId = id;
            session.pendingToolCalls.delete(key);
            break;
          }
        }
      }
      if (!callId) {
        callId = session.nextCallId();
      }

      const status = result?.error ? "failed" : "completed";
      const { _display, ...safeResult } = result || {};

      session.pushEvent({
        type: "tool_result",
        callId,
        name,
        status,
        result: safeResult,
      });
    };

    const onRetry = ({ attempt, maxRetries, message }) => {
      session.pushEvent({
        type: "retry",
        attempt,
        maxRetries,
        message,
      });
    };

    const onSubAgentProgress = (event) => {
      const preview = typeof event === "string" ? event : JSON.stringify(event).slice(0, 200);
      session.pushEvent({
        type: "sub_agent_progress",
        content: preview,
      });
    };

    const onResponse = ({ content }) => {
      session.pushEvent({
        type: "response",
        content,
      });
    };

    const onTokenUsage = (info) => {
      session.pushEvent({
        type: "token_usage",
        ...info,
      });
    };

    // Approval handler
    if (!agent._approveAll) {
      agent.setApprovalHandler(async (name, args) => {
        const callId = session.nextCallId();
        const key = `${name}|${JSON.stringify(args)}`;
        session.pendingToolCalls.set(key, callId);

        session.status = "awaiting_approval";
        session.pushEvent({
          type: "approval_request",
          callId,
          name,
          args,
          kind: acpToolKind(name),
        });

        logger.info(`[Remote] Approval request — ${callId}: ${name}(${Object.keys(args || {}).join(", ")})`);

        // Wait for the client to approve or deny
        return new Promise((resolve) => {
          session.pendingApproval = { resolve, callId, name, args };
        });
      });
    }

    // ask_user handler — queue as an event, the client will answer via the next prompt
    const previousAskHandler = getAskHandler();
    const askHandler = async (question) => {
      session.pushEvent({
        type: "ask_user",
        question,
      });
      return "(waiting for user response — please send your answer as the next prompt)";
    };
    setAskHandler(askHandler);

    // Attach listeners
    agent.on("token", onToken);
    agent.on("thinking", onThinking);
    agent.on("tool_call", onToolCall);
    agent.on("tool_result", onToolResult);
    agent.on("retry", onRetry);
    agent.on("sub_agent_progress", onSubAgentProgress);
    agent.on("response", onResponse);
    agent.on("token_usage", onTokenUsage);

    // Return cleanup function
    session._listeners = () => {
      agent.off("token", onToken);
      agent.off("thinking", onThinking);
      agent.off("tool_call", onToolCall);
      agent.off("tool_result", onToolResult);
      agent.off("retry", onRetry);
      agent.off("sub_agent_progress", onSubAgentProgress);
      agent.off("response", onResponse);
      agent.off("token_usage", onTokenUsage);
      agent.setApprovalHandler(null);
      setAskHandler(previousAskHandler);
    };
  }

  // ── Route handlers ──────────────────────────────────────────────

  async function handleCreateSession(req, res) {
    const body = await parseJsonBody(req);
    if (body === null) {
      return sendError(res, 400, "Invalid JSON body");
    }

    sweepStaleSessions(null);

    if (sessions.size >= MAX_SESSIONS) {
      return sendError(res, 409, `Maximum concurrent sessions (${MAX_SESSIONS}) reached. Close the existing session first.`);
    }

    const cwd = body.cwd || process.cwd();
    const resolved = path.resolve(cwd);
    if (BLOCKED_ROOTS.includes(resolved)) {
      return sendError(res, 400, `Blocked: '${cwd}' is not allowed as a session working directory`);
    }

    const sessionId = crypto.randomUUID();
    const { agent } = await createSessionAgent({
      host: options.host,
      model: options.model,
      provider: options.provider,
      apiKey: options.apiKey,
      jailDirectory: resolved,
      programmaticToolCalling: options.programmaticToolCalling,
    });

    // Load persisted settings
    const settings = await loadSettings(cwd);
    if (options.autoApprove || settings.autoApprove) {
      agent._approveAll = true;
    }

    const session = new RemoteSession(sessionId, agent);
    sessions.set(sessionId, session);

    // Attach event listeners immediately so events are captured from the start
    attachListeners(session);

    logger.info(`[Remote] Session created — id: ${sessionId}, cwd: ${cwd}, model: ${options.model || "default"}`);
    sendJson(res, 201, { sessionId });
  }

  async function handleDestroySession(req, res, sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return sendError(res, 404, `Session not found: ${sessionId}`);
    }

    session.destroy();
    sessions.delete(sessionId);
    logger.info(`[Remote] Session destroyed — id: ${sessionId}`);
    sendJson(res, 200, { ok: true });
  }

  async function handlePrompt(req, res, sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return sendError(res, 404, `Session not found: ${sessionId}`);
    }

    if (session.status === "running") {
      return sendError(res, 409, "Session is already processing a prompt. Wait for completion or cancel first.");
    }

    const body = await parseJsonBody(req);
    if (body === null) {
      return sendError(res, 400, "Invalid JSON body");
    }

    const content = body.content;
    if (!content || typeof content !== "string") {
      return sendError(res, 400, "Request body must include a 'content' string field");
    }

    session.touch();
    session.status = "running";

    session.pushEvent({ type: "prompt_started", content });
    logger.info(`[Remote] Prompt — session: ${sessionId.slice(0, 8)}…, text: "${content.slice(0, 100)}${content.length > 100 ? "…" : ""}"`);

    // Run the agent asynchronously — the client polls for events
    const startTime = Date.now();
    session.agent.run(content).then(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[Remote] Prompt complete — session: ${sessionId.slice(0, 8)}…, elapsed: ${elapsed}s`);
      session.status = "idle";
      session.pushEvent({ type: "prompt_complete", stopReason: "end_turn" });
    }).catch((err) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (err.name === "AbortError" || err.message === "Operation cancelled") {
        logger.info(`[Remote] Prompt cancelled — session: ${sessionId.slice(0, 8)}…, elapsed: ${elapsed}s`);
        session.status = "idle";
        session.pushEvent({ type: "prompt_complete", stopReason: "cancelled" });
      } else {
        logger.error(`[Remote] Prompt error — session: ${sessionId.slice(0, 8)}…, elapsed: ${elapsed}s, error: ${err.message}`);
        session.status = "idle";
        session.pushEvent({ type: "error", message: err.message });
        session.pushEvent({ type: "prompt_complete", stopReason: "error" });
      }
    });

    // Respond immediately — the prompt is running in the background
    sendJson(res, 202, { ok: true, message: "Prompt accepted. Poll /events for progress." });
  }

  function handlePollEvents(req, res, sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return sendError(res, 404, `Session not found: ${sessionId}`);
    }

    session.touch();
    const events = session.drainEvents();

    sendJson(res, 200, {
      sessionId,
      status: session.status,
      events,
    });
  }

  async function handleCancel(req, res, sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return sendError(res, 404, `Session not found: ${sessionId}`);
    }

    session.touch();
    session.agent.cancel();

    // If there's a pending approval, deny it
    if (session.pendingApproval) {
      session.pendingApproval.resolve({ approved: false });
      session.pendingApproval = null;
      session.status = "running"; // will transition to idle when agent finishes
    }

    logger.info(`[Remote] Cancel — session: ${sessionId.slice(0, 8)}…`);
    sendJson(res, 200, { ok: true });
  }

  async function handleApprove(req, res, sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return sendError(res, 404, `Session not found: ${sessionId}`);
    }

    if (!session.pendingApproval) {
      return sendError(res, 409, "No pending approval request");
    }

    const body = await parseJsonBody(req);
    if (body === null) {
      return sendError(res, 400, "Invalid JSON body");
    }

    const approved = body.approved === true;
    const approveAll = body.approveAll === true;

    const { resolve, callId, name } = session.pendingApproval;
    session.pendingApproval = null;
    session.status = "running";

    logger.info(`[Remote] Approval response — ${callId}: ${name} → ${approved ? (approveAll ? "allow_always" : "allow_once") : "deny"}`);

    if (approved) {
      session.pushEvent({
        type: "tool_call",
        callId,
        name,
        status: "in_progress",
        kind: acpToolKind(name),
      });
    }

    if (approveAll) {
      resolve({ approved: true, approveAll: true });
    } else {
      resolve({ approved });
    }

    sendJson(res, 200, { ok: true });
  }

  function handleStatus(req, res) {
    const sessionList = [];
    for (const [id, session] of sessions) {
      sessionList.push({
        sessionId: id,
        status: session.status,
        lastActivity: session.lastActivity,
        eventQueueSize: session.events.length,
      });
    }

    sendJson(res, 200, {
      agent: "smol-agent",
      version: PACKAGE_VERSION,
      uptime: process.uptime(),
      sessions: sessionList,
    });
  }

  // ── Request router ──────────────────────────────────────────────

  const server = http.createServer(async (req, res) => {
    // CORS headers for cross-origin access
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check (skip for OPTIONS which is handled above)
    if (!checkAuth(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // GET /api/status
      if (req.method === "GET" && pathname === "/api/status") {
        return handleStatus(req, res);
      }

      // POST /api/sessions
      if (req.method === "POST" && pathname === "/api/sessions") {
        return await handleCreateSession(req, res);
      }

      // Routes that need a session ID
      const sessionId = extractSessionId(pathname);
      if (!sessionId) {
        return sendError(res, 404, "Not found");
      }

      // DELETE /api/sessions/:id
      if (req.method === "DELETE" && pathname === `/api/sessions/${sessionId}`) {
        return await handleDestroySession(req, res, sessionId);
      }

      // POST /api/sessions/:id/prompt
      if (req.method === "POST" && pathname === `/api/sessions/${sessionId}/prompt`) {
        return await handlePrompt(req, res, sessionId);
      }

      // GET /api/sessions/:id/events
      if (req.method === "GET" && pathname === `/api/sessions/${sessionId}/events`) {
        return handlePollEvents(req, res, sessionId);
      }

      // POST /api/sessions/:id/cancel
      if (req.method === "POST" && pathname === `/api/sessions/${sessionId}/cancel`) {
        return await handleCancel(req, res, sessionId);
      }

      // POST /api/sessions/:id/approve
      if (req.method === "POST" && pathname === `/api/sessions/${sessionId}/approve`) {
        return await handleApprove(req, res, sessionId);
      }

      sendError(res, 404, "Not found");
    } catch (err) {
      logger.error(`[Remote] Request error: ${err.message}`);
      sendError(res, 500, `Internal server error: ${err.message}`);
    }
  });

  server.listen(port, listenHost, () => {
    const addr = `http://${listenHost}:${port}`;
    logger.info(`[Remote] Server listening on ${addr} — model: ${options.model || "default"}, host: ${options.host || "default"}`);
    if (!quiet) {
      console.log(`smol-agent remote server v${PACKAGE_VERSION}`);
      console.log(`Listening on ${addr}`);
      console.log(`Auth: ${authToken ? "enabled (token required)" : "disabled (open access)"}`);
      console.log("");
      console.log("Endpoints:");
      console.log(`  GET    ${addr}/api/status`);
      console.log(`  POST   ${addr}/api/sessions`);
      console.log(`  DELETE  ${addr}/api/sessions/:id`);
      console.log(`  POST   ${addr}/api/sessions/:id/prompt`);
      console.log(`  GET    ${addr}/api/sessions/:id/events`);
      console.log(`  POST   ${addr}/api/sessions/:id/cancel`);
      console.log(`  POST   ${addr}/api/sessions/:id/approve`);
      console.log("");
      if (!authToken) {
        console.log("WARNING: No auth token configured. The server is open to anyone who can reach it.");
        console.log("Set --auth-token <token> or SMOL_AGENT_AUTH_TOKEN env var to require authentication.");
        console.log("");
      }
    }
  });

  // Graceful shutdown — cancel all sessions
  const close = () => {
    for (const [id, session] of sessions) {
      logger.info(`[Remote] Shutting down session ${id.slice(0, 8)}…`);
      session.destroy();
    }
    sessions.clear();
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return { server, close };
}
