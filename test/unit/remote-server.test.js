/**
 * Unit tests for remote-server module.
 *
 * Tests the REST API endpoints, event queue, session lifecycle,
 * authentication, and polling behavior.
 *
 * Dependencies: @jest/globals, node:http, ../../src/remote-server.js
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import http from "node:http";
import { startRemoteServer } from "../../src/remote-server.js";

// ── Helpers ─────────────────────────────────────────────────────────

function request(method, path, { port, body, token } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (token) {
      options.headers["Authorization"] = `Bearer ${token}`;
    }
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Remote Server", () => {
  describe("server lifecycle", () => {
    let serverHandle;
    const port = 17701;

    afterAll(async () => {
      if (serverHandle) await serverHandle.close();
    });

    test("starts and responds to health check", async () => {
      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      serverHandle = startRemoteServer({
        port,
        listenHost: "127.0.0.1",
        // Use bogus provider so we never actually call an LLM
        provider: "ollama",
        host: "http://127.0.0.1:1",
        model: "test-model",
        quiet: true,
      });

      // Wait for server to be listening
      await new Promise((resolve) => serverHandle.server.once("listening", resolve));

      const { status, json } = await request("GET", "/api/status", { port });
      expect(status).toBe(200);
      expect(json.agent).toBe("smol-agent");
      expect(json.version).toBeDefined();
      expect(Array.isArray(json.sessions)).toBe(true);
      expect(consoleLogSpy).not.toHaveBeenCalled();
      consoleLogSpy.mockRestore();
    });
  });

  describe("authentication", () => {
    let serverHandle;
    const port = 17702;
    const token = "test-secret-token-12345";

    beforeAll(async () => {
      serverHandle = startRemoteServer({
        port,
        listenHost: "127.0.0.1",
        authToken: token,
        provider: "ollama",
        host: "http://127.0.0.1:1",
        quiet: true,
      });
      await new Promise((resolve) => serverHandle.server.once("listening", resolve));
    });

    afterAll(async () => {
      if (serverHandle) await serverHandle.close();
    });

    test("rejects requests without auth token", async () => {
      const { status, json } = await request("GET", "/api/status", { port });
      expect(status).toBe(401);
      expect(json.error).toMatch(/Authorization/i);
    });

    test("rejects requests with wrong token", async () => {
      const { status } = await request("GET", "/api/status", {
        port,
        token: "wrong-token",
      });
      expect(status).toBe(401);
    });

    test("accepts requests with correct token", async () => {
      const { status, json } = await request("GET", "/api/status", {
        port,
        token,
      });
      expect(status).toBe(200);
      expect(json.agent).toBe("smol-agent");
    });
  });

  describe("session management", () => {
    let serverHandle;
    const port = 17703;

    beforeAll(async () => {
      serverHandle = startRemoteServer({
        port,
        listenHost: "127.0.0.1",
        provider: "ollama",
        host: "http://127.0.0.1:1",
        quiet: true,
      });
      await new Promise((resolve) => serverHandle.server.once("listening", resolve));
    });

    afterAll(async () => {
      if (serverHandle) await serverHandle.close();
    });

    test("creates a session", async () => {
      const { status, json } = await request("POST", "/api/sessions", {
        port,
        body: { cwd: process.cwd() },
      });
      expect(status).toBe(201);
      expect(json.sessionId).toBeDefined();
      expect(typeof json.sessionId).toBe("string");

      // Cleanup
      await request("DELETE", `/api/sessions/${json.sessionId}`, { port });
    });

    test("rejects creating session with blocked root cwd", async () => {
      const { status, json } = await request("POST", "/api/sessions", {
        port,
        body: { cwd: "/" },
      });
      expect(status).toBe(400);
      expect(json.error).toMatch(/Blocked/);
    });

    test("enforces max sessions limit", async () => {
      // Create first session
      const { json: s1 } = await request("POST", "/api/sessions", {
        port,
        body: { cwd: process.cwd() },
      });
      expect(s1.sessionId).toBeDefined();

      // Try to create second — should fail
      const { status, json: s2 } = await request("POST", "/api/sessions", {
        port,
        body: { cwd: process.cwd() },
      });
      expect(status).toBe(409);
      expect(s2.error).toMatch(/Maximum/);

      // Cleanup
      await request("DELETE", `/api/sessions/${s1.sessionId}`, { port });
    });

    test("destroys a session", async () => {
      const { json: created } = await request("POST", "/api/sessions", {
        port,
        body: { cwd: process.cwd() },
      });

      const { status } = await request(
        "DELETE",
        `/api/sessions/${created.sessionId}`,
        { port }
      );
      expect(status).toBe(200);

      // Verify it's gone
      const { status: eventsStatus } = await request(
        "GET",
        `/api/sessions/${created.sessionId}/events`,
        { port }
      );
      expect(eventsStatus).toBe(404);
    });

    test("returns 404 for unknown session", async () => {
      const { status } = await request(
        "GET",
        "/api/sessions/nonexistent-id/events",
        { port }
      );
      expect(status).toBe(404);
    });
  });

  describe("event polling", () => {
    let serverHandle;
    const port = 17704;
    let sessionId;

    beforeAll(async () => {
      serverHandle = startRemoteServer({
        port,
        listenHost: "127.0.0.1",
        provider: "ollama",
        host: "http://127.0.0.1:1",
        quiet: true,
      });
      await new Promise((resolve) => serverHandle.server.once("listening", resolve));
    });

    beforeEach(async () => {
      const { json } = await request("POST", "/api/sessions", {
        port,
        body: { cwd: process.cwd() },
      });
      sessionId = json.sessionId;
    });

    afterAll(async () => {
      if (serverHandle) await serverHandle.close();
    });

    test("returns empty events for idle session", async () => {
      const { status, json } = await request(
        "GET",
        `/api/sessions/${sessionId}/events`,
        { port }
      );
      expect(status).toBe(200);
      expect(json.status).toBe("idle");
      expect(json.events).toEqual([]);

      await request("DELETE", `/api/sessions/${sessionId}`, { port });
    });

    test("drains events on poll", async () => {
      // We can't easily send a real prompt (no LLM), but we can verify
      // the polling endpoint structure
      const { status, json } = await request(
        "GET",
        `/api/sessions/${sessionId}/events`,
        { port }
      );
      expect(status).toBe(200);
      expect(json.sessionId).toBe(sessionId);
      expect(Array.isArray(json.events)).toBe(true);
      expect(json.status).toBeDefined();

      await request("DELETE", `/api/sessions/${sessionId}`, { port });
    });
  });

  describe("CORS", () => {
    let serverHandle;
    const port = 17705;

    beforeAll(async () => {
      serverHandle = startRemoteServer({
        port,
        listenHost: "127.0.0.1",
        provider: "ollama",
        host: "http://127.0.0.1:1",
        quiet: true,
      });
      await new Promise((resolve) => serverHandle.server.once("listening", resolve));
    });

    afterAll(async () => {
      if (serverHandle) await serverHandle.close();
    });

    test("handles OPTIONS preflight request", async () => {
      const { status } = await request("OPTIONS", "/api/status", { port });
      expect(status).toBe(204);
    });
  });

  describe("error handling", () => {
    let serverHandle;
    const port = 17706;

    beforeAll(async () => {
      serverHandle = startRemoteServer({
        port,
        listenHost: "127.0.0.1",
        provider: "ollama",
        host: "http://127.0.0.1:1",
        quiet: true,
      });
      await new Promise((resolve) => serverHandle.server.once("listening", resolve));
    });

    afterAll(async () => {
      if (serverHandle) await serverHandle.close();
    });

    test("returns 404 for unknown routes", async () => {
      const { status } = await request("GET", "/api/nonexistent", { port });
      expect(status).toBe(404);
    });

    test("rejects prompt without content", async () => {
      const { json: created } = await request("POST", "/api/sessions", {
        port,
        body: { cwd: process.cwd() },
      });

      const { status, json } = await request(
        "POST",
        `/api/sessions/${created.sessionId}/prompt`,
        { port, body: {} }
      );
      expect(status).toBe(400);
      expect(json.error).toMatch(/content/);

      await request("DELETE", `/api/sessions/${created.sessionId}`, { port });
    });

    test("rejects approve when no pending approval", async () => {
      const { json: created } = await request("POST", "/api/sessions", {
        port,
        body: { cwd: process.cwd() },
      });

      const { status, json } = await request(
        "POST",
        `/api/sessions/${created.sessionId}/approve`,
        { port, body: { approved: true } }
      );
      expect(status).toBe(409);
      expect(json.error).toMatch(/No pending/);

      await request("DELETE", `/api/sessions/${created.sessionId}`, { port });
    });
  });

  describe("shutdown", () => {
    test("close resolves after the server has fully stopped", async () => {
      const port = 17707;
      const serverHandle = startRemoteServer({
        port,
        listenHost: "127.0.0.1",
        provider: "ollama",
        host: "http://127.0.0.1:1",
        quiet: true,
      });

      await new Promise((resolve) => serverHandle.server.once("listening", resolve));

      const closeResult = serverHandle.close();
      expect(closeResult).toBeInstanceOf(Promise);
      await closeResult;

      await expect(request("GET", "/api/status", { port })).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
    });
  });
});
