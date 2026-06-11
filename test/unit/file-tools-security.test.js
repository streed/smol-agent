/**
 * Security regression tests for write_file's protected-path denylist.
 *
 * Regression target: the denylist used to be tested against the raw, un-normalized
 * input path, so a `..`-traversal or symlink could resolve to a protected file
 * (e.g. .git/hooks/*) while dodging the anchored `^\.git/hooks/` patterns. The fix
 * resolves the path first and tests the patterns on the jail-relative resolved path.
 */
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execute, setJailDirectory } from "../../src/tools/registry.js";
import "../../src/tools/file_tools.js";

describe("write_file protected-path denylist", () => {
  let jail;

  beforeEach(() => {
    jail = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sec-"));
    setJailDirectory(jail);
  });

  afterEach(() => {
    try { fs.rmSync(jail, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function isBlocked(result) {
    return !!(result && typeof result === "object" && "error" in result);
  }

  test("blocks direct writes to protected paths", async () => {
    expect(isBlocked(await execute("write_file", { filePath: ".git/hooks/pre-commit", content: "x" }))).toBe(true);
    expect(isBlocked(await execute("write_file", { filePath: ".git/config", content: "x" }))).toBe(true);
    expect(isBlocked(await execute("write_file", { filePath: ".env", content: "x" }))).toBe(true);
    expect(isBlocked(await execute("write_file", { filePath: ".env.local", content: "x" }))).toBe(true);
  });

  test("blocks `..`-traversal that resolves back into a protected path", async () => {
    // These all resolve to a protected file inside the jail but used to dodge the
    // anchored denylist because the raw string didn't start with `.git/`.
    expect(isBlocked(await execute("write_file", { filePath: "foo/../.git/hooks/post-checkout", content: "x" }))).toBe(true);
    expect(isBlocked(await execute("write_file", { filePath: ".git/../.git/config", content: "x" }))).toBe(true);
    expect(isBlocked(await execute("write_file", { filePath: "./a/b/../../.git/hooks/pre-push", content: "x" }))).toBe(true);

    // And none of them were actually written.
    expect(fs.existsSync(path.join(jail, ".git/hooks/post-checkout"))).toBe(false);
    expect(fs.existsSync(path.join(jail, ".git/hooks/pre-push"))).toBe(false);
  });

  test("allows ordinary writes inside the jail", async () => {
    const result = await execute("write_file", { filePath: "src/app.js", content: "export const x = 1;\n" });
    expect(isBlocked(result)).toBe(false);
    expect(fs.readFileSync(path.join(jail, "src/app.js"), "utf-8")).toContain("export const x");
  });
});
