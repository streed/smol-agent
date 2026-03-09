import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We need to mock the registry file location before importing
// Since the module uses a constant, we'll test via the exported functions
// and override XDG_CONFIG_HOME via env var.

describe("agent registry", () => {
  let tmpDir;
  let originalXDG;
  let registry;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-test-"));
    originalXDG = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir;

    // Dynamic import to pick up the env var change
    // Clear module cache by using a fresh import each time
    const timestamp = Date.now();
    registry = await import(`../../src/agent-registry.js?t=${timestamp}`);
  });

  afterEach(() => {
    if (originalXDG !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXDG;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("registerAgent / listAgents", () => {
    it("registers a new agent", () => {
      const repoPath = "/tmp/test-repo-a";
      const entry = registry.registerAgent({
        repoPath,
        name: "backend-api",
        role: "backend",
        description: "REST API service",
      });

      expect(entry.name).toBe("backend-api");
      expect(entry.path).toBe(repoPath);
      expect(entry.role).toBe("backend");
      expect(entry.description).toBe("REST API service");
      expect(entry.registeredAt).toBeTruthy();
      expect(entry.lastSeen).toBeTruthy();
    });

    it("lists registered agents", () => {
      registry.registerAgent({
        repoPath: "/tmp/repo-a",
        name: "frontend",
        role: "frontend",
      });
      registry.registerAgent({
        repoPath: "/tmp/repo-b",
        name: "backend",
        role: "backend",
      });

      const agents = registry.listAgents();
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.name).sort()).toEqual([
        "backend",
        "frontend",
      ]);
    });

    it("filters by role", () => {
      registry.registerAgent({
        repoPath: "/tmp/repo-a",
        name: "frontend",
        role: "frontend",
      });
      registry.registerAgent({
        repoPath: "/tmp/repo-b",
        name: "backend",
        role: "backend",
      });

      const backends = registry.listAgents({ role: "backend" });
      expect(backends).toHaveLength(1);
      expect(backends[0].name).toBe("backend");
    });

    it("preserves existing fields on re-registration", () => {
      registry.registerAgent({
        repoPath: "/tmp/repo-a",
        name: "my-api",
        role: "backend",
        description: "Original description",
      });

      // Re-register with only name
      registry.registerAgent({
        repoPath: "/tmp/repo-a",
        name: "my-api-v2",
      });

      const agents = registry.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("my-api-v2");
      // Role and description should be preserved
      expect(agents[0].role).toBe("backend");
      expect(agents[0].description).toBe("Original description");
    });

    it("uses directory basename as default name", () => {
      const entry = registry.registerAgent({
        repoPath: "/home/user/cool-project",
      });
      expect(entry.name).toBe("cool-project");
    });
  });

  describe("findAgent", () => {
    beforeEach(() => {
      registry.registerAgent({
        repoPath: "/tmp/frontend-app",
        name: "frontend",
        role: "frontend",
      });
      registry.registerAgent({
        repoPath: "/tmp/backend-api",
        name: "backend-api",
        role: "backend",
      });
      registry.registerAgent({
        repoPath: "/tmp/shared-lib",
        name: "shared",
        role: "library",
      });
    });

    it("finds by exact name", () => {
      const agent = registry.findAgent("backend-api");
      expect(agent).toBeTruthy();
      expect(agent.name).toBe("backend-api");
    });

    it("finds by case-insensitive name", () => {
      const agent = registry.findAgent("Backend-API");
      expect(agent).toBeTruthy();
      expect(agent.name).toBe("backend-api");
    });

    it("finds by partial name", () => {
      const agent = registry.findAgent("backend");
      expect(agent).toBeTruthy();
      expect(agent.name).toBe("backend-api");
    });

    it("finds by absolute path", () => {
      const agent = registry.findAgent("/tmp/frontend-app");
      expect(agent).toBeTruthy();
      expect(agent.name).toBe("frontend");
    });

    it("finds by directory basename", () => {
      const agent = registry.findAgent("shared-lib");
      expect(agent).toBeTruthy();
      expect(agent.name).toBe("shared");
    });

    it("returns null for unknown agent", () => {
      expect(registry.findAgent("nonexistent")).toBeNull();
    });
  });

  describe("touchAgent", () => {
    it("updates lastSeen for existing agent", () => {
      registry.registerAgent({
        repoPath: "/tmp/repo-a",
        name: "test",
      });
      const before = registry.listAgents()[0].lastSeen;

      // Small delay to ensure timestamp differs
      registry.touchAgent("/tmp/repo-a");
      const after = registry.listAgents()[0].lastSeen;

      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
        new Date(before).getTime(),
      );
    });

    it("auto-registers unknown repos", () => {
      registry.touchAgent("/tmp/new-repo");
      const agents = registry.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("new-repo");
    });
  });

  describe("unregisterAgent", () => {
    it("removes an agent", () => {
      registry.registerAgent({
        repoPath: "/tmp/repo-a",
        name: "test",
      });
      expect(registry.listAgents()).toHaveLength(1);

      const removed = registry.unregisterAgent("/tmp/repo-a");
      expect(removed).toBe(true);
      expect(registry.listAgents()).toHaveLength(0);
    });

    it("returns false for unknown agent", () => {
      expect(registry.unregisterAgent("/tmp/nonexistent")).toBe(false);
    });
  });

  describe("addRelation / getRelatedAgents", () => {
    beforeEach(() => {
      registry.registerAgent({
        repoPath: "/tmp/frontend",
        name: "frontend",
      });
      registry.registerAgent({
        repoPath: "/tmp/backend",
        name: "backend",
      });
    });

    it("adds a relationship", () => {
      registry.addRelation("/tmp/frontend", "/tmp/backend", "depends-on");

      const agents = registry.listAgents();
      const frontend = agents.find((a) => a.name === "frontend");
      expect(frontend.relations).toHaveLength(1);
      expect(frontend.relations[0]).toEqual({
        repo: "/tmp/backend",
        type: "depends-on",
      });
    });

    it("avoids duplicate relations", () => {
      registry.addRelation("/tmp/frontend", "/tmp/backend", "depends-on");
      registry.addRelation("/tmp/frontend", "/tmp/backend", "depends-on");

      const agents = registry.listAgents();
      const frontend = agents.find((a) => a.name === "frontend");
      expect(frontend.relations).toHaveLength(1);
    });

    it("allows different relation types", () => {
      registry.addRelation("/tmp/frontend", "/tmp/backend", "depends-on");
      registry.addRelation("/tmp/frontend", "/tmp/backend", "consumes");

      const agents = registry.listAgents();
      const frontend = agents.find((a) => a.name === "frontend");
      expect(frontend.relations).toHaveLength(2);
    });

    it("getRelatedAgents returns outgoing and incoming", () => {
      registry.addRelation("/tmp/frontend", "/tmp/backend", "depends-on");

      // From frontend's perspective: outgoing
      const fromFrontend = registry.getRelatedAgents("/tmp/frontend");
      expect(fromFrontend).toHaveLength(1);
      expect(fromFrontend[0].direction).toBe("outgoing");
      expect(fromFrontend[0].agent.name).toBe("backend");

      // From backend's perspective: incoming
      const fromBackend = registry.getRelatedAgents("/tmp/backend");
      expect(fromBackend).toHaveLength(1);
      expect(fromBackend[0].direction).toBe("incoming");
      expect(fromBackend[0].agent.name).toBe("frontend");
    });
  });

  describe("detectRepoMetadata", () => {
    let repoDir;

    beforeEach(() => {
      repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "detect-meta-test-"),
      );
    });

    afterEach(() => {
      fs.rmSync(repoDir, { recursive: true, force: true });
    });

    it("detects from package.json", () => {
      fs.writeFileSync(
        path.join(repoDir, "package.json"),
        JSON.stringify({
          name: "my-cool-app",
          description: "A cool application",
        }),
      );

      const meta = registry.detectRepoMetadata(repoDir);
      expect(meta.name).toBe("my-cool-app");
      expect(meta.description).toBe("A cool application");
    });

    it("detects from pyproject.toml", () => {
      fs.writeFileSync(
        path.join(repoDir, "pyproject.toml"),
        `[project]\nname = "my-python-lib"\ndescription = "A Python library"`,
      );

      const meta = registry.detectRepoMetadata(repoDir);
      expect(meta.name).toBe("my-python-lib");
      expect(meta.description).toBe("A Python library");
    });

    it("detects from Cargo.toml", () => {
      fs.writeFileSync(
        path.join(repoDir, "Cargo.toml"),
        `[package]\nname = "my-rust-crate"\ndescription = "A Rust crate"`,
      );

      const meta = registry.detectRepoMetadata(repoDir);
      expect(meta.name).toBe("my-rust-crate");
      expect(meta.description).toBe("A Rust crate");
    });

    it("detects from go.mod", () => {
      fs.writeFileSync(
        path.join(repoDir, "go.mod"),
        `module github.com/user/my-go-service\n\ngo 1.21`,
      );

      const meta = registry.detectRepoMetadata(repoDir);
      expect(meta.name).toBe("my-go-service");
    });

    it("falls back to directory basename", () => {
      const meta = registry.detectRepoMetadata(repoDir);
      expect(meta.name).toBe(path.basename(repoDir));
    });
  });
});
