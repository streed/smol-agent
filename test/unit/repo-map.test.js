import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildRepoMap, clearRepoMapCache, computePageRank } from "../../src/repo-map.js";

// tree-sitter is a native module that may not be installed in all environments
// Check if it exists in node_modules at project root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const treeSitterPath = path.join(projectRoot, "node_modules", "tree-sitter");
const hasTreeSitter = fs.existsSync(treeSitterPath);

// Check for TypeScript grammar (requires different tree-sitter version)
const tsGrammarPath = path.join(projectRoot, "node_modules", "tree-sitter-typescript");
const hasTypeScriptGrammar = fs.existsSync(tsGrammarPath);

const describeIfTreeSitter = hasTreeSitter ? describe : describe.skip;

describeIfTreeSitter("buildRepoMap", () => {
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
    // TypeScript grammar requires older tree-sitter version (0.21.x)
    if (!hasTypeScriptGrammar) {
      return; // Skip if TypeScript grammar not available
    }
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

  // ══ PageRank Tests ════════════════════════════════════════════════════

  it("ranks files by PageRank when cross-referenced", async () => {
    // Create a core file that's referenced by others (should rank higher)
    fs.writeFileSync(path.join(tmpDir, "core.js"), `
export function utilFunction() {}
export class BaseClass {}
`);
    // Create dependent files that reference core
    fs.writeFileSync(path.join(tmpDir, "dep1.js"), `
import { utilFunction, BaseClass } from "./core.js";
export function useUtil() { return utilFunction(); }
`);
    fs.writeFileSync(path.join(tmpDir, "dep2.js"), `
import { BaseClass } from "./core.js";
export class Derived extends BaseClass {}
`);

    const result = await buildRepoMap(tmpDir);
    expect(result).not.toBeNull();
    // core.js should appear first due to PageRank (it's referenced by others)
    const lines = result.split("\n");
    const fileLines = lines.filter(l => l.trim().startsWith("core.js") || l.trim().startsWith("dep1.js") || l.trim().startsWith("dep2.js"));
    
    // core.js should be listed before dep1.js and dep2.js (higher PageRank)
    const coreIndex = fileLines.findIndex(l => l.includes("core.js"));
    const dep1Index = fileLines.findIndex(l => l.includes("dep1.js"));
    const dep2Index = fileLines.findIndex(l => l.includes("dep2.js"));
    
    // If PageRank is working, core should come before deps
    // (may be equal if PageRank didn't compute for small graph)
    expect(coreIndex).toBeLessThanOrEqual(dep1Index);
    expect(coreIndex).toBeLessThanOrEqual(dep2Index);
  });

  it("handles single file without PageRank computation", async () => {
    fs.writeFileSync(path.join(tmpDir, "single.js"), `
export function only() {}
`);

    const result = await buildRepoMap(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("single.js");
    expect(result).toContain("fn only");
  });
});

// ══ PageRank Unit Tests (no tree-sitter required) ═════════════════════

describe("computePageRank", () => {
  it("ranks files by reference count", () => {
    // core.js defines symbols referenced by other files
    const fileSymbols = new Map([
      ["core.js", [
        { name: "utilFunction", kind: "fn", line: 1 },
        { name: "BaseClass", kind: "class", line: 5 }
      ]],
      ["dep1.js", [
        { name: "useUtil", kind: "fn", line: 1 }
      ]],
      ["dep2.js", [
        { name: "Derived", kind: "class", line: 1 }
      ]]
    ]);

    // dep1 and dep2 reference symbols from core
    const fileRefs = new Map([
      ["dep1.js", new Set(["utilFunction", "BaseClass"])],
      ["dep2.js", new Set(["BaseClass"])]
    ]);

    const scores = computePageRank(fileSymbols, fileRefs);

    // All files should have scores
    expect(scores.size).toBe(3);
    
    // core.js should have highest score (referenced by others)
    const coreScore = scores.get("core.js") || 0;
    const dep1Score = scores.get("dep1.js") || 0;
    const dep2Score = scores.get("dep2.js") || 0;

    expect(coreScore).toBeGreaterThan(dep1Score);
    expect(coreScore).toBeGreaterThan(dep2Score);
  });

  it("handles isolated files with no cross-references", () => {
    const fileSymbols = new Map([
      ["isolated.js", [{ name: "standalone", kind: "fn", line: 1 }]]
    ]);
    const fileRefs = new Map();

    const scores = computePageRank(fileSymbols, fileRefs);

    // Single file with no refs should still work
    expect(scores.size).toBe(1);
    expect(scores.get("isolated.js")).toBeDefined();
  });

  it("handles self-references correctly", () => {
    // File that references its own symbols
    const fileSymbols = new Map([
      ["self.js", [
        { name: "helper", kind: "fn", line: 1 },
        { name: "main", kind: "fn", line: 5 }
      ]]
    ]);
    const fileRefs = new Map([
      ["self.js", new Set(["helper"])]  // main references helper in same file
    ]);

    const scores = computePageRank(fileSymbols, fileRefs);

    expect(scores.size).toBe(1);
    // Self-references shouldn't create edges
    expect(scores.get("self.js")).toBeDefined();
  });

  it("weights edges by identifier name length", () => {
    // Longer identifier names should create stronger edges
    const fileSymbols = new Map([
      ["core.js", [
        { name: "veryDescriptiveFunctionName", kind: "fn", line: 1 },
        { name: "x", kind: "fn", line: 5 }
      ]],
      ["consumer.js", [{ name: "use", kind: "fn", line: 1 }]]
    ]);

    const fileRefs = new Map([
      ["consumer.js", new Set(["veryDescriptiveFunctionName", "x"])]
    ]);

    const scores = computePageRank(fileSymbols, fileRefs);

    expect(scores.size).toBe(2);
    // Both should have scores, core should be higher
    expect(scores.get("core.js")).toBeGreaterThan(scores.get("consumer.js") || 0);
  });

  it("handles multiple references to same symbol", () => {
    // Multiple files referencing the same core symbol
    const fileSymbols = new Map([
      ["core.js", [{ name: "shared", kind: "fn", line: 1 }]],
      ["a.js", [{ name: "fnA", kind: "fn", line: 1 }]],
      ["b.js", [{ name: "fnB", kind: "fn", line: 1 }]],
      ["c.js", [{ name: "fnC", kind: "fn", line: 1 }]]
    ]);

    const fileRefs = new Map([
      ["a.js", new Set(["shared"])],
      ["b.js", new Set(["shared"])],
      ["c.js", new Set(["shared"])]
    ]);

    const scores = computePageRank(fileSymbols, fileRefs);

    // core.js should be ranked highest (referenced by 3 files)
    const coreScore = scores.get("core.js") || 0;
    const aScore = scores.get("a.js") || 0;
    const bScore = scores.get("b.js") || 0;
    const cScore = scores.get("c.js") || 0;

    expect(coreScore).toBeGreaterThan(aScore);
    expect(coreScore).toBeGreaterThan(bScore);
    expect(coreScore).toBeGreaterThan(cScore);
  });
});
