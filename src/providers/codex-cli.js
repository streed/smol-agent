/**
 * Codex CLI provider.
 *
 * Uses the local `codex app-server` JSON-RPC transport so smol-agent can
 * delegate execution directly to Codex, matching the integration style used
 * in t3code. Codex performs its own file/command operations; this provider
 * streams Codex's assistant message deltas back through the normal provider
 * interface.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import { BaseLLMProvider, MAX_RETRIES } from "./base.js";

function createAsyncQueue() {
  const values = [];
  const waiters = [];
  let closed = false;
  let failure = null;

  return {
    push(value) {
      if (closed || failure) return;
      if (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter.resolve({ value, done: false });
        return;
      }
      values.push(value);
    },
    close() {
      if (closed || failure) return;
      closed = true;
      while (waiters.length > 0) {
        waiters.shift().resolve({ value: undefined, done: true });
      }
    },
    fail(error) {
      if (closed || failure) return;
      failure = error instanceof Error ? error : new Error(String(error));
      while (waiters.length > 0) {
        waiters.shift().reject(failure);
      }
    },
    async next() {
      if (failure) throw failure;
      if (values.length > 0) {
        return { value: values.shift(), done: false };
      }
      if (closed) {
        return { value: undefined, done: true };
      }
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function isObject(value) {
  return value && typeof value === "object";
}

function readObject(value, key) {
  const target =
    key === undefined
      ? value
      : isObject(value)
        ? value[key]
        : undefined;
  return isObject(target) ? target : undefined;
}

function readString(value, key) {
  if (!isObject(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readArray(value, key) {
  if (!isObject(value)) return undefined;
  const candidate = value[key];
  return Array.isArray(candidate) ? candidate : undefined;
}

function extractTextContent(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isObject(entry) && typeof entry.text === "string") return entry.text;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function readTurnId(params) {
  return readString(params, "turnId") ?? readString(readObject(params, "turn"), "id");
}

export class CodexCLIProvider extends BaseLLMProvider {
  constructor({
    model = "gpt-5.4",
    binaryPath = "codex",
    homePath,
    cwd = process.cwd(),
    spawnImpl,
    createInterfaceImpl,
  } = {}) {
    super({
      model,
      rateLimitConfig: {
        requestsPerMinute: 30,
        requestsPerSecond: 1,
        maxConcurrent: 1,
        rateLimitBackoffMs: 5000,
      },
    });

    this.binaryPath = binaryPath;
    this.homePath = homePath;
    this.cwd = cwd;
    this._spawnImpl = spawnImpl || spawn;
    this._createInterfaceImpl =
      createInterfaceImpl || ((child) => readline.createInterface({ input: child.stdout }));
    this._child = null;
    this._output = null;
    this._pending = new Map();
    this._nextRequestId = 1;
    this._sessionPromise = null;
    this._threadId = null;
    this._activeTurn = null;
    this._hasStartedConversation = false;
  }

  get name() {
    return "codex";
  }

  async *chatStream(messages, _tools, signal, _maxTokens, onRetry) {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const { turnId, queue } = await this._startTurn(messages, signal);
        try {
          for await (const event of queue) {
            if (signal?.aborted) {
              throw new Error("Request cancelled");
            }
            yield event;
          }
        } finally {
          if (this._activeTurn?.turnId === turnId) {
            this._activeTurn = null;
          }
        }
        return;
      } catch (error) {
        if (attempt >= MAX_RETRIES) {
          throw error;
        }
        const delayMs = this._rateLimitBackoff(attempt);
        onRetry?.({ attempt, maxRetries: MAX_RETRIES, error, delayMs });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async chatWithRetry(messages, tools, signal, maxTokens, onRetry) {
    const chunks = [];
    let finalToolCalls = [];

    for await (const event of this.chatStream(messages, tools, signal, maxTokens, onRetry)) {
      if (event.type === "token") {
        chunks.push(event.content);
      } else if (event.type === "done") {
        finalToolCalls = event.toolCalls || [];
      }
    }

    return {
      message: {
        content: chunks.join(""),
        tool_calls: finalToolCalls,
      },
    };
  }

  async listModels() {
    await this._ensureSession();
    const response = await this._sendRequest("model/list", {});
    const models = readArray(response, "models") ?? readArray(readObject(response, "result"), "models") ?? [];
    return models
      .map((entry) => readString(entry, "id") ?? readString(entry, "slug") ?? readString(entry, "name"))
      .filter(Boolean);
  }

  supportsVision() {
    return true;
  }

  async _ensureSession() {
    if (!this._sessionPromise) {
      this._sessionPromise = this._startSession();
    }
    return this._sessionPromise;
  }

  async _startTurn(messages, signal) {
    if (signal?.aborted) {
      throw new Error("Request cancelled");
    }

    await this._ensureSession();

    if (this._activeTurn) {
      throw new Error("Codex provider does not support concurrent turns.");
    }

    const prompt = this._buildPrompt(messages);
    const response = await this._sendRequest("turn/start", {
      threadId: this._threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: this._model,
    });

    const turnId = readString(readObject(response, "turn"), "id");
    if (!turnId) {
      throw new Error("turn/start response did not include a turn id.");
    }

    const queue = createAsyncQueue();
    this._activeTurn = {
      turnId,
      queue,
    };
    this._hasStartedConversation = true;
    return { turnId, queue };
  }

  async _startSession() {
    this._child = this._spawnImpl(this.binaryPath, ["app-server"], {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...(this.homePath ? { CODEX_HOME: this.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    this._output = this._createInterfaceImpl(this._child);
    this._output.on("line", (line) => this._handleStdoutLine(line));

    this._child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (!message) return;
      if (this._activeTurn) {
        this._activeTurn.queue.fail(new Error(message));
        this._activeTurn = null;
      }
    });

    this._child.on("error", (error) => {
      this._failAllPending(error);
    });

    this._child.on("exit", (code, signal) => {
      this._failAllPending(
        new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`),
      );
    });

    await this._sendRequest("initialize", {
      clientInfo: {
        name: "smol-agent",
        title: "smol-agent",
        version: "1.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this._writeMessage({ method: "initialized" });

    const response = await this._sendRequest("thread/start", {
      cwd: this.cwd,
      model: this._model,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: false,
    });
    const threadId =
      readString(readObject(response, "thread"), "id") ?? readString(response, "threadId");
    if (!threadId) {
      throw new Error("thread/start response did not include a thread id.");
    }
    this._threadId = threadId;
  }

  _buildPrompt(messages) {
    const usableMessages = Array.isArray(messages) ? messages : [];

    if (!this._hasStartedConversation) {
      const sections = [];
      const systemText = usableMessages
        .filter((msg) => msg?.role === "system")
        .map((msg) => extractTextContent(msg.content))
        .filter(Boolean)
        .join("\n\n");
      if (systemText) {
        sections.push(`System instructions:\n${systemText}`);
      }

      for (const msg of usableMessages) {
        if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
        const text = extractTextContent(msg.content);
        if (!text) continue;
        const label = msg.role === "assistant" ? "Assistant" : "User";
        sections.push(`${label}:\n${text}`);
      }

      if (sections.length > 0) {
        return sections.join("\n\n");
      }
    }

    for (let i = usableMessages.length - 1; i >= 0; i -= 1) {
      const msg = usableMessages[i];
      if (msg?.role !== "user") continue;
      const text = extractTextContent(msg.content);
      if (text) return text;
    }

    throw new Error("Codex provider requires at least one user message.");
  }

  _handleStdoutLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!isObject(parsed)) return;

    if (typeof parsed.method === "string" && ("id" in parsed)) {
      this._handleServerRequest(parsed);
      return;
    }

    if (typeof parsed.method === "string") {
      this._handleNotification(parsed);
      return;
    }

    if ("id" in parsed) {
      this._handleResponse(parsed);
    }
  }

  _handleServerRequest(request) {
    this._writeMessage({
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  _handleNotification(notification) {
    if (notification.method === "thread/started") {
      const threadId =
        readString(readObject(notification.params, "thread"), "id") ??
        readString(notification.params, "threadId");
      if (threadId) {
        this._threadId = threadId;
      }
      return;
    }

    const activeTurn = this._activeTurn;
    if (!activeTurn) return;

    const notificationTurnId = readTurnId(notification.params);
    if (notificationTurnId && notificationTurnId !== activeTurn.turnId) {
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const delta = readString(notification.params, "delta");
      if (delta) {
        activeTurn.queue.push({ type: "token", content: delta });
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const status = readString(readObject(notification.params, "turn"), "status");
      if (status === "failed") {
        const message =
          readString(readObject(readObject(notification.params, "turn"), "error"), "message") ||
          "Codex turn failed.";
        activeTurn.queue.fail(new Error(message));
      } else {
        activeTurn.queue.push({
          type: "done",
          toolCalls: [],
          tokenUsage: { promptTokens: 0, completionTokens: 0 },
        });
        activeTurn.queue.close();
      }
      this._activeTurn = null;
      return;
    }

    if (notification.method === "error") {
      const message =
        readString(readObject(notification.params, "error"), "message") ||
        "Codex app-server reported an error.";
      activeTurn.queue.fail(new Error(message));
      this._activeTurn = null;
    }
  }

  _handleResponse(response) {
    const pending = this._pending.get(String(response.id));
    if (!pending) return;
    clearTimeout(pending.timeout);
    this._pending.delete(String(response.id));

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message}`));
      return;
    }

    pending.resolve(response.result);
  }

  async _sendRequest(method, params, timeoutMs = 20000) {
    const id = this._nextRequestId;
    this._nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      this._pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });

      this._writeMessage({ id, method, params });
    });
  }

  _writeMessage(message) {
    if (!this._child?.stdin?.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }
    this._child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _failAllPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this._pending.clear();

    if (this._activeTurn) {
      this._activeTurn.queue.fail(error);
      this._activeTurn = null;
    }
  }
}
