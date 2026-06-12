/**
 * Tests for the registry tool-execution policy (the single choke point in
 * registry.execute) and the code_execution nested-approval gate.
 *
 * Covers:
 *  - sensitive-file blocking (default ON) for read/write tools
 *  - no-exec mode (blocks command/code execution, allows file writes)
 *  - no-network mode (blocks web_search, web_fetch, send_letter)
 *  - read-only mode (blocks writes; allows read-only run_command)
 *  - opting out via denySensitiveFiles:false
 *  - code_execution: a nested dangerous call is gated by the `approve` callback
 */
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execute, setJailDirectory, setToolPolicy, resetToolPolicy } from "../../src/tools/registry.js";
import "../../src/tools/file_tools.js";
import "../../src/tools/run_command.js";
import "../../src/tools/code_execution.js";
import "../../src/tools/web_search.js";
import "../../src/tools/web_fetch.js";

function blocked(result) {
  return !!(result && typeof result === "object" && "error" in result);
}
function errorText(result) {
  const e = result?.error;
  if (!e) return "";
  return typeof e === "string" ? e : String(e.message ?? JSON.stringify(e));
}
function blockedByPolicy(result) {
  return blocked(result) && /blocked|sensitive/i.test(errorText(result));
}

describe("registry tool-execution policy", () => {
  let jail;

  beforeEach(() => {
    jail = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
    setJailDirectory(jail);
    resetToolPolicy();
  });

  afterEach(() => {
    resetToolPolicy();
    try { fs.rmSync(jail, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test("blocks sensitive-file reads/writes by default", async () => {
    expect(blockedByPolicy(await execute("read_file", { filePath: ".env" }))).toBe(true);
    expect(blockedByPolicy(await execute("read_file", { filePath: "config/id_rsa" }))).toBe(true);
    expect(blockedByPolicy(await execute("read_file", { filePath: "foo/../.ssh/known_hosts" }))).toBe(true);
    expect(blockedByPolicy(await execute("write_file", { filePath: "secrets.json", content: "x" }))).toBe(true);
    expect(blockedByPolicy(await execute("read_file", { filePath: "deploy/server.pem" }))).toBe(true);
  });

  test("allows non-sensitive reads/writes by default", async () => {
    const r = await execute("write_file", { filePath: "src/app.js", content: "const x = 1;\n" });
    expect(blocked(r)).toBe(false);
  });

  test("denySensitiveFiles:false opts out of sensitive-file blocking", async () => {
    setToolPolicy({ denySensitiveFiles: false });
    // .env doesn't exist → read_file returns a not-found error, but NOT a policy block.
    const r = await execute("read_file", { filePath: ".env" });
    expect(blockedByPolicy(r)).toBe(false);
  });

  test("no-exec mode blocks command/code execution but allows file writes", async () => {
    setToolPolicy({ noExec: true });
    expect(blockedByPolicy(await execute("run_command", { command: "echo hi" }))).toBe(true);
    expect(blockedByPolicy(await execute("code_execution", { code: "console.log(1)" }))).toBe(true);
    // Writes still allowed under no-exec.
    expect(blocked(await execute("write_file", { filePath: "note.txt", content: "ok" }))).toBe(false);
  });

  test("read-only mode blocks writes but allows read-only commands", async () => {
    setToolPolicy({ readOnly: true });
    expect(blockedByPolicy(await execute("write_file", { filePath: "note.txt", content: "x" }))).toBe(true);
    expect(blockedByPolicy(await execute("run_command", { command: "rm -rf build" }))).toBe(true);
    // A genuinely read-only command is permitted (it actually runs `ls`).
    const ls = await execute("run_command", { command: "ls" });
    expect(blockedByPolicy(ls)).toBe(false);
  });

  test("no-network mode blocks network tools but allows reads/writes", async () => {
    setToolPolicy({ noNetwork: true });
    // Network tools blocked
    expect(blockedByPolicy(await execute("web_search", { query: "test" }))).toBe(true);
    expect(blockedByPolicy(await execute("web_fetch", { url: "https://example.com" }))).toBe(true);
    // File operations still allowed
    expect(blocked(await execute("write_file", { filePath: "note.txt", content: "ok" }))).toBe(false);
    expect(blocked(await execute("read_file", { filePath: "note.txt" }))).toBe(false);
  });

  test("blockNetwork alias works same as noNetwork", async () => {
    setToolPolicy({ blockNetwork: true });
    expect(blockedByPolicy(await execute("web_search", { query: "test" }))).toBe(true);
  });

  test("blockExec alias works same as noExec", async () => {
    setToolPolicy({ blockExec: true });
    expect(blockedByPolicy(await execute("run_command", { command: "echo hi" }))).toBe(true);
  });

  test("expanded sensitive patterns block .npmrc, .netrc, .p12, .pfx", async () => {
    expect(blockedByPolicy(await execute("read_file", { filePath: ".npmrc" }))).toBe(true);
    expect(blockedByPolicy(await execute("read_file", { filePath: ".netrc" }))).toBe(true);
    expect(blockedByPolicy(await execute("read_file", { filePath: "certs/cert.p12" }))).toBe(true);
    expect(blockedByPolicy(await execute("read_file", { filePath: "certs/cert.pfx" }))).toBe(true);
    expect(blockedByPolicy(await execute("read_file", { filePath: "keys/key.asc" }))).toBe(true);
    expect(blockedByPolicy(await execute("read_file", { filePath: ".gcp/credentials.json" }))).toBe(true);
    expect(blockedByPolicy(await execute("read_file", { filePath: "service-account.json" }))).toBe(true);
  });
});

describe("code_execution nested-approval gate", () => {
  let jail;

  beforeEach(() => {
    jail = fs.mkdtempSync(path.join(os.tmpdir(), "ce-approve-"));
    setJailDirectory(jail);
    resetToolPolicy();
  });

  afterEach(() => {
    resetToolPolicy();
    try { fs.rmSync(jail, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const codeThatWrites = `const r = await write_file({ filePath: 'nested.txt', content: 'hi' }); console.log(JSON.stringify(r));`;

  test("denies a nested dangerous call when approve() returns false", async () => {
    const result = await execute("code_execution", { code: codeThatWrites }, { approve: async () => false });
    expect(result.return_code).toBe(0);
    expect(result.stdout).toMatch(/not approved/i);
    expect(fs.existsSync(path.join(jail, "nested.txt"))).toBe(false);
  });

  test("allows a nested dangerous call when approve() returns true", async () => {
    const result = await execute("code_execution", { code: codeThatWrites }, { approve: async () => true });
    expect(result.return_code).toBe(0);
    expect(fs.existsSync(path.join(jail, "nested.txt"))).toBe(true);
  });

  test("without an approve gate, nested calls run (backward-compatible)", async () => {
    const result = await execute("code_execution", { code: codeThatWrites });
    expect(result.return_code).toBe(0);
    expect(fs.existsSync(path.join(jail, "nested.txt"))).toBe(true);
  });
});