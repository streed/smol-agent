import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildRepoMap, clearRepoMapCache } from "../../src/repo-map.js";

describe("buildRepoMap", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-map-test-"));
    clearRepoMapCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for empty directory", async () => {
    const result = await buildRepoMap(tmpDir);
    expect(result).toBeNull();
  });

  it("extracts JavaScript function declarations", async () => {
    fs.writeFileSync(path.join(tmpDir, "utils.js"), `
export function hello(name) {
  return "Hello " + name;
}

export class Greeter {
  greet() { return "hi"; }
}

function internalHelper() {}
`);

    const result = await buildRepoMap(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Repository map");
    expect(result).toContain("fn hello");
    expect(result).toContain("class Greeter");
    expect(result).toContain("utils.js");
  });

  it("extracts TypeScript types and interfaces", async () => {
    fs.writeFileSync(path.join(tmpDir, "types.ts"), `
export interface User {
  name: string;
  email: string;
}

export type UserRole = "admin" | "user";

export function createUser(name: string): User {
  return { name, email: "" };
}
`);

    const result = await buildRepoMap(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("iface User");
    expect(result).toContain("type UserRole");
    expect(result).toContain("fn createUser");
  });

  it("extracts Python classes and functions", async () => {
    fs.writeFileSync(path.join(tmpDir, "app.py"), `
class Application:
    def start(self):
        pass

    def stop(self):
        pass

def create_app():
    return Application()

def _private_helper():
    pass
`);

    const result = await buildRepoMap(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("class Application");
    expect(result).toContain("fn create_app");
    // Private functions should be excluded
    expect(result).not.toContain("_private_helper");
  });

  it("respects token budget", async () => {
    // Create many files to exceed the budget
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(tmpDir, `module${i}.js`), `
export function handler${i}() { return ${i}; }
export function processor${i}() { return ${i}; }
export function validator${i}() { return ${i}; }
`);
    }

    const result = await buildRepoMap(tmpDir, { maxTokens: 200 });
    expect(result).not.toBeNull();
    // Should truncate with "... and N more files"
    expect(result).toContain("more files");
  });

  it("skips node_modules and other ignored directories", async () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules", "lib.js"), `
export function shouldBeIgnored() {}
`);
    fs.writeFileSync(path.join(tmpDir, "app.js"), `
export function shouldBeIncluded() {}
`);

    const result = await buildRepoMap(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("shouldBeIncluded");
    expect(result).not.toContain("shouldBeIgnored");
  });

  it("caches results within TTL", async () => {
    fs.writeFileSync(path.join(tmpDir, "test.js"), `export function foo() {}`);

    const result1 = await buildRepoMap(tmpDir);
    // Modify file - should still get cached result
    fs.writeFileSync(path.join(tmpDir, "test.js"), `export function bar() {}`);
    const result2 = await buildRepoMap(tmpDir);

    expect(result1).toBe(result2); // Same reference = cached
  });
});
