import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  serializeLetter,
  serializeResponse,
  parseLetter,
  sendLetter,
  sendReply,
  checkForReply,
  readInbox,
  readOutbox,
  clearStaleInbox,
} from "../../src/cross-agent.js";

describe("cross-agent protocol", () => {
  let repoA; // "frontend" repo
  let repoB; // "backend" repo

  beforeEach(() => {
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), "cross-agent-a-"));
    repoB = fs.mkdtempSync(path.join(os.tmpdir(), "cross-agent-b-"));
  });

  afterEach(() => {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  });

  // ── Serialization / Parsing ───────────────────────────────────────

  describe("serializeLetter / parseLetter", () => {
    it("round-trips a request letter", () => {
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
      expect(() =>
        sendLetter({
          from: repoA,
          to: "/nonexistent/repo",
          title: "Test",
          body: "Test",
        }),
      ).toThrow("Target repo does not exist");
    });
  });

  describe("readInbox / readOutbox", () => {
    it("reads incoming letters", () => {
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
      expect(readInbox(repoA)).toEqual([]);
      expect(readOutbox(repoA)).toEqual([]);
    });
  });

  describe("sendReply / checkForReply", () => {
    it("creates response and delivers to sender inbox", () => {
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
      const { id } = sendLetter({
        from: repoA,
        to: repoB,
        title: "Waiting",
        body: "Body",
      });

      expect(checkForReply(repoA, id)).toBeNull();
    });

    it("handles failed status", () => {
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
  });

  // ── Verification fields ──────────────────────────────────────────────

  describe("verification steps and results", () => {
    it("includes verification steps in letter and results in response", () => {
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
      expect(clearStaleInbox(repoB)).toBe(0);
    });
  });

  // ── Full workflow ───────────────────────────────────────────────────

  describe("end-to-end workflow", () => {
    it("simulates frontend requesting backend work with verification", () => {
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
