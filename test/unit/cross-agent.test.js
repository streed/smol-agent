import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We need dynamic imports so modules pick up the XDG_CONFIG_HOME override
let tmpConfig;
let repoA;
let repoB;

// Helper to load modules with cache-busting
async function loadModules() {
  const ts = Date.now();
  const registry = await import(`../../src/agent-registry.js?t=${ts}`);
  const crossAgent = await import(`../../src/cross-agent.js?t=${ts}`);
  return { registry, crossAgent };
}

describe("cross-agent protocol", () => {
  let mods;

  beforeEach(async () => {
    tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "cross-agent-config-"));
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), "cross-agent-a-"));
    repoB = fs.mkdtempSync(path.join(os.tmpdir(), "cross-agent-b-"));
    process.env.XDG_CONFIG_HOME = tmpConfig;

    mods = await loadModules();

    // Register both repos so path validation passes
    mods.registry.registerAgent({ repoPath: repoA, name: "repo-a" });
    mods.registry.registerAgent({ repoPath: repoB, name: "repo-b" });
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
    fs.rmSync(tmpConfig, { recursive: true, force: true });
  });

  // ── Serialization / Parsing ───────────────────────────────────────

  describe("serializeLetter / parseLetter", () => {
    it("round-trips a request letter", () => {
      const { serializeLetter, parseLetter } = mods.crossAgent;
      const letter = {
        id: "test-uuid-123",
        type: "request",
        title: "Add avatar field to GET /users",
        from: "/path/to/frontend",
        to: "/path/to/backend",
        status: "pending",
        priority: "high",
        createdAt: "2025-01-15T10:00:00.000Z",
        body: "Please add an `avatar_url` string field to the user response object.",
        acceptanceCriteria: [
          "GET /users returns avatar_url field",
          "avatar_url is a string or null",
        ],
        verificationSteps: [
          "Run npm test",
          "curl GET /users and verify avatar_url field exists",
        ],
        context: "We need this for the new profile page component.",
      };

      const markdown = serializeLetter(letter);
      const parsed = parseLetter(markdown);

      expect(parsed.id).toBe("test-uuid-123");
      expect(parsed.type).toBe("request");
      expect(parsed.title).toBe("Add avatar field to GET /users");
      expect(parsed.from).toBe("/path/to/frontend");
      expect(parsed.to).toBe("/path/to/backend");
      expect(parsed.status).toBe("pending");
      expect(parsed.priority).toBe("high");
      expect(parsed.createdAt).toBe("2025-01-15T10:00:00.000Z");
      expect(parsed.body).toBe(
        "Please add an `avatar_url` string field to the user response object.",
      );
      expect(parsed.acceptanceCriteria).toEqual([
        "GET /users returns avatar_url field",
        "avatar_url is a string or null",
      ]);
      expect(parsed.verificationSteps).toEqual([
        "Run npm test",
        "curl GET /users and verify avatar_url field exists",
      ]);
      expect(parsed.context).toBe(
        "We need this for the new profile page component.",
      );
    });

    it("handles empty acceptance criteria", () => {
      const { serializeLetter, parseLetter } = mods.crossAgent;
      const markdown = serializeLetter({
        id: "test-id",
        title: "Test",
        from: "/a",
        to: "/b",
        createdAt: "2025-01-01T00:00:00Z",
        body: "Do something",
        acceptanceCriteria: [],
      });
      const parsed = parseLetter(markdown);
      expect(parsed.acceptanceCriteria).toEqual([]);
    });

    it("handles empty context", () => {
      const { serializeLetter, parseLetter } = mods.crossAgent;
      const markdown = serializeLetter({
        id: "test-id",
        title: "Test",
        from: "/a",
        to: "/b",
        createdAt: "2025-01-01T00:00:00Z",
        body: "Do something",
        context: "",
      });
      const parsed = parseLetter(markdown);
      expect(parsed.context).toBe("");
    });
  });

  describe("serializeResponse / parseLetter (response)", () => {
    it("round-trips a response letter", () => {
      const { serializeResponse, parseLetter } = mods.crossAgent;
      const response = {
        id: "response-uuid-456",
        title: "Add avatar field to GET /users",
        from: "/path/to/backend",
        to: "/path/to/frontend",
        inReplyTo: "test-uuid-123",
        status: "completed",
        createdAt: "2025-01-15T12:00:00.000Z",
        changesMade:
          "Added avatar_url field to User model and GET /users response.",
        verificationResults:
          "npm test: 42 tests passed, 0 failed. curl GET /users returns avatar_url field.",
        apiContract:
          "GET /users now returns { id, name, email, avatar_url: string | null }",
        notes: "Migration needed: run `npm run migrate`",
      };

      const markdown = serializeResponse(response);
      const parsed = parseLetter(markdown);

      expect(parsed.id).toBe("response-uuid-456");
      expect(parsed.type).toBe("response");
      expect(parsed.inReplyTo).toBe("test-uuid-123");
      expect(parsed.status).toBe("completed");
      expect(parsed.changesMade).toBe(
        "Added avatar_url field to User model and GET /users response.",
      );
      expect(parsed.verificationResults).toBe(
        "npm test: 42 tests passed, 0 failed. curl GET /users returns avatar_url field.",
      );
      expect(parsed.apiContract).toBe(
        "GET /users now returns { id, name, email, avatar_url: string | null }",
      );
      expect(parsed.notes).toBe("Migration needed: run `npm run migrate`");
    });

    it("normalizes (none) to empty string", () => {
      const { serializeResponse, parseLetter } = mods.crossAgent;
      const markdown = serializeResponse({
        id: "r1",
        title: "Test",
        from: "/a",
        to: "/b",
        inReplyTo: "l1",
        createdAt: "2025-01-01T00:00:00Z",
        changesMade: "",
        verificationResults: "",
        apiContract: "",
        notes: "",
      });
      const parsed = parseLetter(markdown);
      expect(parsed.changesMade).toBe("");
      expect(parsed.verificationResults).toBe("");
      expect(parsed.apiContract).toBe("");
      expect(parsed.notes).toBe("");
    });
  });

  // ── Core operations ─────────────────────────────────────────────────

  describe("sendLetter", () => {
    it("writes letter to recipient inbox and sender outbox", () => {
      const { sendLetter, parseLetter } = mods.crossAgent;
      const result = sendLetter({
        from: repoA,
        to: repoB,
        title: "Need new endpoint",
        body: "Please create POST /widgets",
        acceptanceCriteria: ["Returns 201 on success"],
        priority: "high",
      });

      expect(result.id).toBeTruthy();
      expect(result.letterPath).toContain(repoB);

      // Letter should be in B's inbox
      const inboxFiles = fs.readdirSync(
        path.join(repoB, ".smol-agent/inbox"),
      );
      expect(inboxFiles).toContain(`${result.id}.letter.md`);

      // Letter copy should be in A's outbox
      const outboxFiles = fs.readdirSync(
        path.join(repoA, ".smol-agent/outbox"),
      );
      expect(outboxFiles).toContain(`${result.id}.letter.md`);

      // Content should be parseable
      const content = fs.readFileSync(result.letterPath, "utf-8");
      const parsed = parseLetter(content);
      expect(parsed.title).toBe("Need new endpoint");
      expect(parsed.body).toBe("Please create POST /widgets");
      expect(parsed.status).toBe("pending");
    });

    it("throws if target repo does not exist", () => {
      const { sendLetter } = mods.crossAgent;
      expect(() =>
        sendLetter({
          from: repoA,
          to: "/nonexistent/repo",
          title: "Test",
          body: "Test",
        }),
      ).toThrow("Unregistered");
    });

    it("rejects unregistered recipient", () => {
      const { sendLetter } = mods.crossAgent;
      const unregistered = fs.mkdtempSync(path.join(os.tmpdir(), "unregistered-"));
      try {
        expect(() =>
          sendLetter({
            from: repoA,
            to: unregistered,
            title: "Test",
            body: "Test",
          }),
        ).toThrow("Unregistered recipient");
      } finally {
        fs.rmSync(unregistered, { recursive: true, force: true });
      }
    });

    it("rejects unregistered sender", () => {
      const { sendLetter } = mods.crossAgent;
      const unregistered = fs.mkdtempSync(path.join(os.tmpdir(), "unregistered-"));
      try {
        expect(() =>
          sendLetter({
            from: unregistered,
            to: repoB,
            title: "Test",
            body: "Test",
          }),
        ).toThrow("Unregistered sender");
      } finally {
        fs.rmSync(unregistered, { recursive: true, force: true });
      }
    });
  });

  describe("readInbox / readOutbox", () => {
    it("reads incoming letters", () => {
      const { sendLetter, readInbox } = mods.crossAgent;
      sendLetter({
        from: repoA,
        to: repoB,
        title: "Request 1",
        body: "Body 1",
      });
      sendLetter({
        from: repoA,
        to: repoB,
        title: "Request 2",
        body: "Body 2",
      });

      const inbox = readInbox(repoB);
      expect(inbox).toHaveLength(2);
      expect(inbox.map((l) => l.title).sort()).toEqual([
        "Request 1",
        "Request 2",
      ]);
    });

    it("filters by type", () => {
      const { sendLetter, readInbox } = mods.crossAgent;
      sendLetter({
        from: repoA,
        to: repoB,
        title: "A request",
        body: "Body",
      });

      const requests = readInbox(repoB, { type: "request" });
      expect(requests).toHaveLength(1);

      const responses = readInbox(repoB, { type: "response" });
      expect(responses).toHaveLength(0);
    });

    it("filters by status", () => {
      const { sendLetter, readInbox } = mods.crossAgent;
      sendLetter({
        from: repoA,
        to: repoB,
        title: "Pending request",
        body: "Body",
      });

      const pending = readInbox(repoB, { status: "pending" });
      expect(pending).toHaveLength(1);

      const completed = readInbox(repoB, { status: "completed" });
      expect(completed).toHaveLength(0);
    });

    it("reads outgoing letters", () => {
      const { sendLetter, readOutbox } = mods.crossAgent;
      sendLetter({
        from: repoA,
        to: repoB,
        title: "Outgoing",
        body: "Body",
      });

      const outbox = readOutbox(repoA);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].title).toBe("Outgoing");
    });

    it("returns empty for repos with no inbox", () => {
      const { readInbox, readOutbox } = mods.crossAgent;
      expect(readInbox(repoA)).toEqual([]);
      expect(readOutbox(repoA)).toEqual([]);
    });
  });

  describe("sendReply / checkForReply", () => {
    it("creates response and delivers to sender inbox", () => {
      const { sendLetter, sendReply, readInbox, checkForReply } = mods.crossAgent;
      // Send a letter from A to B
      const { id } = sendLetter({
        from: repoA,
        to: repoB,
        title: "Add field",
        body: "Add email field",
      });

      // Read the letter in B's inbox
      const inbox = readInbox(repoB, { type: "request" });
      const letter = inbox[0];

      // B replies
      const reply = sendReply({
        repoPath: repoB,
        originalLetter: letter,
        changesMade: "Added email field to User model",
        apiContract: "GET /users now includes email: string",
        notes: "Run migrations",
      });

      expect(reply.id).toBeTruthy();

      // A should be able to check for the reply
      const response = checkForReply(repoA, id);
      expect(response).toBeTruthy();
      expect(response.status).toBe("completed");
      expect(response.changesMade).toBe("Added email field to User model");
      expect(response.apiContract).toBe(
        "GET /users now includes email: string",
      );

      // The original letter in B's inbox should be marked as completed
      const updatedInbox = readInbox(repoB, { status: "completed" });
      expect(updatedInbox.length).toBeGreaterThanOrEqual(1);
    });

    it("returns null when no reply exists", () => {
      const { sendLetter, checkForReply } = mods.crossAgent;
      const { id } = sendLetter({
        from: repoA,
        to: repoB,
        title: "Waiting",
        body: "Body",
      });

      expect(checkForReply(repoA, id)).toBeNull();
    });

    it("handles failed status", () => {
      const { sendLetter, sendReply, readInbox, checkForReply } = mods.crossAgent;
      const { id } = sendLetter({
        from: repoA,
        to: repoB,
        title: "Will fail",
        body: "Body",
      });

      const inbox = readInbox(repoB, { type: "request" });

      sendReply({
        repoPath: repoB,
        originalLetter: inbox[0],
        changesMade: "Could not complete - dependency issue",
        status: "failed",
      });

      const response = checkForReply(repoA, id);
      expect(response.status).toBe("failed");
    });

    it("skips delivery to unregistered sender (no throw)", () => {
      const { sendLetter, sendReply, readInbox, checkForReply } = mods.crossAgent;
      const { id: _id } = sendLetter({
        from: repoA,
        to: repoB,
        title: "Test",
        body: "Body",
      });

      const inbox = readInbox(repoB, { type: "request" });
      const letter = { ...inbox[0] };
      // Set from to unregistered path
      letter.from = "/nonexistent/unregistered/path";

      // Should not throw
      const reply = sendReply({
        repoPath: repoB,
        originalLetter: letter,
        changesMade: "Done",
      });

      expect(reply.id).toBeTruthy();
      // Reply should NOT be delivered to unregistered sender
      expect(checkForReply("/nonexistent/unregistered/path", letter.id)).toBeNull();
    });
  });

  // ── Verification fields ──────────────────────────────────────────────

  describe("verification steps and results", () => {
    it("includes verification steps in letter and results in response", () => {
      const { sendLetter, sendReply, readInbox, checkForReply } = mods.crossAgent;
      const { id } = sendLetter({
        from: repoA,
        to: repoB,
        title: "Add endpoint",
        body: "Add GET /health endpoint",
        verificationSteps: [
          "Run npm test",
          "curl GET /health returns 200",
        ],
      });

      const inbox = readInbox(repoB, { type: "request" });
      expect(inbox[0].verificationSteps).toEqual([
        "Run npm test",
        "curl GET /health returns 200",
      ]);

      sendReply({
        repoPath: repoB,
        originalLetter: inbox[0],
        changesMade: "Added /health endpoint",
        verificationResults: "npm test: all passed. curl /health: 200 OK",
      });

      const reply = checkForReply(repoA, id);
      expect(reply.verificationResults).toBe(
        "npm test: all passed. curl /health: 200 OK",
      );
    });

    it("handles empty verification steps", () => {
      const { serializeLetter, parseLetter } = mods.crossAgent;
      const markdown = serializeLetter({
        id: "test-id",
        title: "Test",
        from: "/a",
        to: "/b",
        createdAt: "2025-01-01T00:00:00Z",
        body: "Do something",
        verificationSteps: [],
      });
      const parsed = parseLetter(markdown);
      expect(parsed.verificationSteps).toEqual([]);
    });
  });

  // ── Inbox cleanup ──────────────────────────────────────────────────

  describe("clearStaleInbox", () => {
    it("moves pending letters to cleared directory", () => {
      const { sendLetter, readInbox, clearStaleInbox } = mods.crossAgent;
      sendLetter({
        from: repoA,
        to: repoB,
        title: "Stale request",
        body: "Old work",
      });

      const before = readInbox(repoB, { type: "request", status: "pending" });
      expect(before).toHaveLength(1);

      const cleared = clearStaleInbox(repoB);
      expect(cleared).toBe(1);

      const after = readInbox(repoB, { type: "request", status: "pending" });
      expect(after).toHaveLength(0);

      // Check cleared directory exists
      const clearedDir = path.join(repoB, ".smol-agent/inbox/cleared");
      const files = fs.readdirSync(clearedDir);
      expect(files).toHaveLength(1);
    });

    it("does not clear in-progress or completed letters", () => {
      const { sendLetter, clearStaleInbox } = mods.crossAgent;
      const { id } = sendLetter({
        from: repoA,
        to: repoB,
        title: "Active request",
        body: "In progress work",
      });

      // Manually mark as in-progress
      const letterPath = path.join(repoB, ".smol-agent/inbox", `${id}.letter.md`);
      let content = fs.readFileSync(letterPath, "utf-8");
      content = content.replace(/^status: pending$/m, "status: in-progress");
      fs.writeFileSync(letterPath, content);

      const cleared = clearStaleInbox(repoB);
      expect(cleared).toBe(0);
    });

    it("returns 0 for empty inbox", () => {
      const { clearStaleInbox } = mods.crossAgent;
      expect(clearStaleInbox(repoB)).toBe(0);
    });
  });

  // ── Frontmatter sanitization ──────────────────────────────────────

  describe("frontmatter injection prevention", () => {
    it("prevents newline injection in title from corrupting frontmatter", () => {
      const { serializeLetter, parseLetter } = mods.crossAgent;
      const markdown = serializeLetter({
        id: "inject-test",
        title: "foo\nstatus: hacked",
        from: "/a",
        to: "/b",
        status: "pending",
        priority: "medium",
        createdAt: "2025-01-01T00:00:00Z",
        body: "test body",
      });
      const parsed = parseLetter(markdown);
      // The status should still be "pending", not "hacked"
      expect(parsed.status).toBe("pending");
      // Title should have newline stripped
      expect(parsed.title).not.toContain("\n");
    });

    it("prevents newline injection in response frontmatter", () => {
      const { serializeResponse, parseLetter } = mods.crossAgent;
      const markdown = serializeResponse({
        id: "resp-inject",
        title: "normal\nid: evil-id",
        from: "/a",
        to: "/b",
        inReplyTo: "req-1",
        status: "completed",
        createdAt: "2025-01-01T00:00:00Z",
      });
      const parsed = parseLetter(markdown);
      expect(parsed.id).toBe("resp-inject");
      expect(parsed.title).not.toContain("\n");
    });
  });

  // ── Inbox limits ──────────────────────────────────────────────────

  describe("enforceInboxLimits", () => {
    it("deletes oldest cleared files when inbox exceeds limit", () => {
      const { enforceInboxLimits } = mods.crossAgent;
      // Set low limit
      process.env.SMOL_AGENT_MAX_INBOX = "2";

      const inboxDir = path.join(repoA, ".smol-agent/inbox");
      const clearedDir = path.join(inboxDir, "cleared");
      fs.mkdirSync(clearedDir, { recursive: true });

      // Create 3 active inbox files
      fs.writeFileSync(path.join(inboxDir, "a.letter.md"), "test");
      fs.writeFileSync(path.join(inboxDir, "b.letter.md"), "test");
      fs.writeFileSync(path.join(inboxDir, "c.letter.md"), "test");

      // Create 2 cleared files (oldest first)
      fs.writeFileSync(path.join(clearedDir, "old1.letter.md"), "old1");
      // Small delay to ensure different mtime
      const oldStat = path.join(clearedDir, "old1.letter.md");
      fs.utimesSync(oldStat, new Date(2020, 0, 1), new Date(2020, 0, 1));
      fs.writeFileSync(path.join(clearedDir, "old2.letter.md"), "old2");

      enforceInboxLimits(repoA);

      // Should have deleted 1 from cleared (3 active - 2 limit = 1 to delete)
      const remaining = fs.readdirSync(clearedDir);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toBe("old2.letter.md");

      delete process.env.SMOL_AGENT_MAX_INBOX;
    });
  });

  // ── Full workflow ───────────────────────────────────────────────────

  describe("end-to-end workflow", () => {
    it("simulates frontend requesting backend work with verification", () => {
      const { sendLetter, sendReply, readInbox, readOutbox, checkForReply } = mods.crossAgent;
      // 1. Frontend sends a letter to backend with verification steps
      const { id } = sendLetter({
        from: repoA,
        to: repoB,
        title: "Add pagination to GET /products",
        body: [
          "The products list endpoint needs pagination support.",
          "Add `page` and `per_page` query parameters.",
          "Response should include `total`, `page`, `per_page`, and `data` array.",
        ].join("\n"),
        acceptanceCriteria: [
          "GET /products?page=1&per_page=10 returns paginated results",
          "Response includes total count",
          "Default per_page is 20",
        ],
        verificationSteps: [
          "Run npm test",
          "curl GET /products?page=1&per_page=10 returns paginated JSON",
        ],
        context: "Frontend ProductList component needs this for infinite scroll.",
        priority: "high",
      });

      // 2. Backend checks inbox
      const backendInbox = readInbox(repoB, {
        type: "request",
        status: "pending",
      });
      expect(backendInbox).toHaveLength(1);
      expect(backendInbox[0].title).toBe("Add pagination to GET /products");
      expect(backendInbox[0].priority).toBe("high");
      expect(backendInbox[0].verificationSteps).toHaveLength(2);

      // 3. Backend does the work, verifies, and replies
      sendReply({
        repoPath: repoB,
        originalLetter: backendInbox[0],
        changesMade: [
          "- Added pagination to ProductController.list()",
          "- Added page/per_page query param parsing",
          "- Updated product repository with offset/limit support",
        ].join("\n"),
        verificationResults: [
          "npm test: 48 tests passed, 0 failed",
          "curl GET /products?page=1&per_page=10: returns {total: 150, page: 1, per_page: 10, data: [...]}",
        ].join("\n"),
        apiContract: [
          "GET /products?page=1&per_page=10",
          "",
          "Response: {",
          '  "total": 150,',
          '  "page": 1,',
          '  "per_page": 10,',
          '  "data": [{ "id": 1, "name": "Widget", ... }, ...]',
          "}",
        ].join("\n"),
        notes: "Default per_page is 20 as requested. Max per_page is 100.",
      });

      // 4. Frontend checks for the reply
      const reply = checkForReply(repoA, id);
      expect(reply).toBeTruthy();
      expect(reply.status).toBe("completed");
      expect(reply.apiContract).toContain("per_page");
      expect(reply.changesMade).toContain("ProductController");
      expect(reply.verificationResults).toContain("48 tests passed");

      // 5. Frontend outbox shows the sent letter
      const outbox = readOutbox(repoA);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].id).toBe(id);
    });
  });
});
