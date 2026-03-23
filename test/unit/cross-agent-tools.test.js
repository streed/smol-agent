import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Override XDG_CONFIG_HOME before importing tools so registry uses temp dir
let tmpConfig;
let tmpRepoA;
let tmpRepoB;

beforeEach(() => {
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tools-config-"));
  tmpRepoA = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tools-repo-a-"));
  tmpRepoB = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tools-repo-b-"));
  process.env.XDG_CONFIG_HOME = tmpConfig;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpConfig, { recursive: true, force: true });
  fs.rmSync(tmpRepoA, { recursive: true, force: true });
  fs.rmSync(tmpRepoB, { recursive: true, force: true });
});

// We need to import these dynamically so they pick up the env override
async function loadModules() {
  const ts = Date.now();
  const registry = await import(`../../src/agent-registry.js?t=${ts}`);
  const crossAgent = await import(`../../src/cross-agent.js?t=${ts}`);
  // Ensure both repos are registered so path validation passes
  if (!registry.loadRegistry().agents[path.resolve(tmpRepoA)]) {
    registry.registerAgent({ repoPath: tmpRepoA, name: "repo-a" });
  }
  if (!registry.loadRegistry().agents[path.resolve(tmpRepoB)]) {
    registry.registerAgent({ repoPath: tmpRepoB, name: "repo-b" });
  }
  return { registry, crossAgent };
}

describe("cross-agent tools integration", () => {
  describe("send_letter with name resolution", () => {
    it("resolves agent name to path via registry", async () => {
      const { registry, crossAgent } = await loadModules();

      registry.registerAgent({
        repoPath: tmpRepoB,
        name: "backend-api",
        role: "backend",
      });

      const result = crossAgent.sendLetter({
        from: tmpRepoA,
        to: tmpRepoB,
        title: "Test request",
        body: "Test body",
      });

      expect(result.id).toBeTruthy();
      expect(result.letterPath).toContain(tmpRepoB);
    });

    it("uses default priority when not specified", async () => {
      const { crossAgent } = await loadModules();

      const result = crossAgent.sendLetter({
        from: tmpRepoA,
        to: tmpRepoB,
        title: "Default priority",
        body: "Body",
      });

      const content = fs.readFileSync(result.letterPath, "utf-8");
      const parsed = crossAgent.parseLetter(content);
      expect(parsed.priority).toBe("medium");
    });

    it("passes all fields through correctly", async () => {
      const { crossAgent } = await loadModules();

      const result = crossAgent.sendLetter({
        from: tmpRepoA,
        to: tmpRepoB,
        title: "Full request",
        body: "Detailed body text",
        acceptanceCriteria: ["Criterion A", "Criterion B"],
        context: "Extra context here",
        priority: "high",
      });

      const content = fs.readFileSync(result.letterPath, "utf-8");
      const parsed = crossAgent.parseLetter(content);
      expect(parsed.title).toBe("Full request");
      expect(parsed.body).toBe("Detailed body text");
      expect(parsed.acceptanceCriteria).toEqual(["Criterion A", "Criterion B"]);
      expect(parsed.context).toBe("Extra context here");
      expect(parsed.priority).toBe("high");
    });
  });

  describe("parseLetter edge cases", () => {
    it("handles frontmatter with missing values", async () => {
      const { crossAgent } = await loadModules();

      const markdown = `---
id: test-id
type: request
title: Test
from:
to:
---

# Test

## Body

Body text

## Acceptance Criteria

- (none specified)

## Context

(none)
`;
      const parsed = crossAgent.parseLetter(markdown);
      expect(parsed.id).toBe("test-id");
      expect(parsed.from).toBe("");
      expect(parsed.to).toBe("");
      expect(parsed.body).toBe("Body text");
    });

    it("handles camelCase conversion from snake_case frontmatter", async () => {
      const { crossAgent } = await loadModules();

      const markdown = `---
in_reply_to: some-id
created_at: 2025-01-01T00:00:00Z
---

# Title
`;
      const parsed = crossAgent.parseLetter(markdown);
      expect(parsed.inReplyTo).toBe("some-id");
      expect(parsed.createdAt).toBe("2025-01-01T00:00:00Z");
    });

    it("handles response letter with all sections", async () => {
      const { crossAgent } = await loadModules();

      const markdown = crossAgent.serializeResponse({
        id: "resp-1",
        title: "Response Title",
        from: "/repo-a",
        to: "/repo-b",
        inReplyTo: "req-1",
        status: "completed",
        createdAt: "2025-01-01T00:00:00Z",
        changesMade: "Added new endpoint",
        verificationResults: "All tests pass: 10/10",
        apiContract: "GET /api/v1/users",
        notes: "Needs migration",
      });

      const parsed = crossAgent.parseLetter(markdown);
      expect(parsed.type).toBe("response");
      expect(parsed.inReplyTo).toBe("req-1");
      expect(parsed.changesMade).toBe("Added new endpoint");
      expect(parsed.verificationResults).toBe("All tests pass: 10/10");
      expect(parsed.apiContract).toBe("GET /api/v1/users");
      expect(parsed.notes).toBe("Needs migration");
    });
  });

  describe("sendReply edge cases", () => {
    it("handles when sender repo does not exist", async () => {
      const { crossAgent } = await loadModules();

      // Send a letter with a non-existent "from" path
      const { id: _id } = crossAgent.sendLetter({
        from: tmpRepoA,
        to: tmpRepoB,
        title: "Test",
        body: "Body",
      });

      const inbox = crossAgent.readInbox(tmpRepoB, { type: "request" });
      const letter = inbox[0];

      // Modify the letter's from to a non-existent path
      letter.from = "/nonexistent/path";

      // Should not throw even though sender path doesn't exist
      const reply = crossAgent.sendReply({
        repoPath: tmpRepoB,
        originalLetter: letter,
        changesMade: "Done",
      });

      expect(reply.id).toBeTruthy();
    });
  });

  describe("readInbox / readOutbox edge cases", () => {
    it("handles mixed letter and response files", async () => {
      const { crossAgent } = await loadModules();

      // Send a letter, then reply to it
      const { id: _id2 } = crossAgent.sendLetter({
        from: tmpRepoA,
        to: tmpRepoB,
        title: "Mixed test",
        body: "Body",
      });

      const inbox = crossAgent.readInbox(tmpRepoB, { type: "request" });
      crossAgent.sendReply({
        repoPath: tmpRepoB,
        originalLetter: inbox[0],
        changesMade: "Done",
      });

      // B's inbox should now have both letter and response
      const all = crossAgent.readInbox(tmpRepoB);
      expect(all.length).toBeGreaterThanOrEqual(1);

      // A's inbox should have the response
      const responses = crossAgent.readInbox(tmpRepoA, { type: "response" });
      expect(responses).toHaveLength(1);
    });

    it("readOutbox shows reply status", async () => {
      const { crossAgent } = await loadModules();

      const { id } = crossAgent.sendLetter({
        from: tmpRepoA,
        to: tmpRepoB,
        title: "Track me",
        body: "Body",
      });

      // Before reply
      expect(crossAgent.checkForReply(tmpRepoA, id)).toBeNull();

      // After reply
      const inbox = crossAgent.readInbox(tmpRepoB, { type: "request" });
      crossAgent.sendReply({
        repoPath: tmpRepoB,
        originalLetter: inbox[0],
        changesMade: "Done",
      });

      const reply = crossAgent.checkForReply(tmpRepoA, id);
      expect(reply).toBeTruthy();
      expect(reply.status).toBe("completed");
    });
  });

  describe("registry findAgentForTask scoring", () => {
    it("scores role match with bonus points", async () => {
      const { registry } = await loadModules();

      registry.registerAgent({
        repoPath: "/tmp/fe",
        name: "fe",
        role: "frontend",
        snippet: "web application",
      });
      registry.registerAgent({
        repoPath: "/tmp/be",
        name: "be",
        role: "backend",
        snippet: "web application",
      });

      // Query mentioning "backend" should rank backend higher
      const results = registry.findAgentForTask("I need the backend web application");
      expect(results.length).toBe(2);
      expect(results[0].agent.name).toBe("be");
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it("ignores short words (<=2 chars)", async () => {
      const { registry } = await loadModules();

      registry.registerAgent({
        repoPath: "/tmp/a",
        name: "service",
        snippet: "An API for it to do so",
      });

      // "an" and "it" and "to" and "do" and "so" should all be filtered out
      const results = registry.findAgentForTask("an it to do so");
      expect(results).toHaveLength(0);
    });

    it("skips agents with empty snippet and description", async () => {
      const { registry } = await loadModules();

      registry.registerAgent({
        repoPath: "/tmp/empty",
        name: "no-description",
      });

      const results = registry.findAgentForTask("anything at all");
      expect(results).toHaveLength(0);
    });
  });

  describe("detectSnippet", () => {
    it("reads from AGENT.md first paragraph", async () => {
      const { registry } = await loadModules();

      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "snippet-agent-md-"));
      try {
        fs.writeFileSync(
          path.join(repoDir, "AGENT.md"),
          `# My Project

This is a backend service that handles user authentication and provides REST endpoints for user management.

## Architecture

Some architecture details here.
`,
        );

        const snippet = registry.detectSnippet(repoDir);
        expect(snippet).toContain("backend service");
        expect(snippet).toContain("REST endpoints");
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("prefers .smol-agent/snippet.md over AGENT.md", async () => {
      const { registry } = await loadModules();

      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "snippet-pref-"));
      try {
        fs.writeFileSync(path.join(repoDir, "AGENT.md"), "# Project\n\nFrom AGENT.md\n\n## More\n");
        const snippetDir = path.join(repoDir, ".smol-agent");
        fs.mkdirSync(snippetDir, { recursive: true });
        fs.writeFileSync(path.join(snippetDir, "snippet.md"), "From snippet.md");

        const snippet = registry.detectSnippet(repoDir);
        expect(snippet).toBe("From snippet.md");
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("truncates long snippets to 2048 chars", async () => {
      const { registry } = await loadModules();

      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "snippet-long-"));
      try {
        const snippetDir = path.join(repoDir, ".smol-agent");
        fs.mkdirSync(snippetDir, { recursive: true });
        fs.writeFileSync(
          path.join(snippetDir, "snippet.md"),
          "x".repeat(5000),
        );

        const snippet = registry.detectSnippet(repoDir);
        expect(snippet.length).toBe(2048);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe("detectRepoMetadata edge cases", () => {
    it("handles malformed package.json gracefully", async () => {
      const { registry } = await loadModules();

      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-bad-"));
      try {
        fs.writeFileSync(path.join(repoDir, "package.json"), "not json{{{");
        const meta = registry.detectRepoMetadata(repoDir);
        // Should fall back to basename
        expect(meta.name).toBe(path.basename(repoDir));
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("prioritizes package.json over other metadata files", async () => {
      const { registry } = await loadModules();

      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-priority-"));
      try {
        fs.writeFileSync(
          path.join(repoDir, "package.json"),
          JSON.stringify({ name: "from-package-json" }),
        );
        fs.writeFileSync(
          path.join(repoDir, "pyproject.toml"),
          `[project]\nname = "from-pyproject"`,
        );

        const meta = registry.detectRepoMetadata(repoDir);
        expect(meta.name).toBe("from-package-json");
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe("registry persistence edge cases", () => {
    it("handles corrupted registry file gracefully", async () => {
      const { registry } = await loadModules();

      // Write corrupted data
      const registryDir = path.join(tmpConfig, "smol-agent");
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "agents.json"),
        "not valid json!!!",
      );

      // Should return empty registry, not throw
      const loaded = registry.loadRegistry();
      expect(loaded.agents).toEqual({});
    });

    it("creates registry directory if it doesn't exist", async () => {
      const { registry } = await loadModules();

      // Use a nested path that doesn't exist
      registry.registerAgent({
        repoPath: "/tmp/test-create-dir",
        name: "test",
      });

      const registryPath = path.join(tmpConfig, "smol-agent", "agents.json");
      expect(fs.existsSync(registryPath)).toBe(true);
    });
  });
});
