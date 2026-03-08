import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createCheckpoint, listCheckpoints, rollbackToCheckpoint } from "../../src/checkpoint.js";

describe("checkpoint system", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
    // Initialize a git repo (disable signing to work in test environments)
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "pipe" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmpDir, stdio: "pipe" });
    // Create initial commit
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\n");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createCheckpoint returns false for clean working tree", () => {
    const result = createCheckpoint(tmpDir);
    expect(result.created).toBe(false);
    expect(result.message).toContain("clean");
  });

  it("createCheckpoint creates a checkpoint when there are changes", () => {
    fs.writeFileSync(path.join(tmpDir, "test.js"), "const x = 1;");
    const result = createCheckpoint(tmpDir, "test label");
    expect(result.created).toBe(true);
    expect(result.message).toContain("smol-agent-checkpoint");
    expect(result.message).toContain("test label");
  });

  it("createCheckpoint preserves working tree changes", () => {
    fs.writeFileSync(path.join(tmpDir, "test.js"), "const x = 1;");
    createCheckpoint(tmpDir);
    // File should still exist after checkpoint
    expect(fs.existsSync(path.join(tmpDir, "test.js"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "test.js"), "utf-8")).toBe("const x = 1;");
  });

  it("createCheckpoint uses shadow repo in .smol-agent/checkpoints", () => {
    fs.writeFileSync(path.join(tmpDir, "test.js"), "const x = 1;");
    createCheckpoint(tmpDir);
    // Shadow repo should exist
    const shadowGit = path.join(tmpDir, ".smol-agent", "checkpoints", ".git");
    expect(fs.existsSync(shadowGit)).toBe(true);
  });

  it("createCheckpoint does not touch main repo stash", () => {
    fs.writeFileSync(path.join(tmpDir, "test.js"), "const x = 1;");
    createCheckpoint(tmpDir);
    // Main repo stash should be empty
    const stash = execFileSync("git", ["stash", "list"], {
      cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    expect(stash).toBe("");
  });

  it("listCheckpoints returns created checkpoints with hash", () => {
    fs.writeFileSync(path.join(tmpDir, "test.js"), "const x = 1;");
    createCheckpoint(tmpDir, "first");

    const checkpoints = listCheckpoints(tmpDir);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0].message).toContain("first");
    expect(checkpoints[0].hash).toBeDefined();
    expect(checkpoints[0].hash.length).toBe(40); // full SHA
  });

  it("rollbackToCheckpoint restores previous state", () => {
    // Create a file and checkpoint
    fs.writeFileSync(path.join(tmpDir, "original.txt"), "original content");
    createCheckpoint(tmpDir, "before changes");

    // Make more changes
    fs.writeFileSync(path.join(tmpDir, "original.txt"), "modified content");
    fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "new content");

    // Rollback
    const result = rollbackToCheckpoint(tmpDir);
    expect(result.restored).toBe(true);

    // Original file should be restored
    expect(fs.readFileSync(path.join(tmpDir, "original.txt"), "utf-8")).toBe("original content");
    // New file should be removed
    expect(fs.existsSync(path.join(tmpDir, "new-file.txt"))).toBe(false);
  });

  it("rollbackToCheckpoint fails when no checkpoints exist", () => {
    const result = rollbackToCheckpoint(tmpDir);
    expect(result.restored).toBe(false);
    expect(result.error).toContain("No checkpoints");
  });

  it("createCheckpoint returns error for non-git directory", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-"));
    try {
      const result = createCheckpoint(nonGitDir);
      expect(result.created).toBe(false);
      expect(result.error).toContain("Not a git repository");
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
