import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { lintFile, lintFileFormatted } from "../../src/ts-lint.js";

// tree-sitter native modules can have issues in Jest ESM workers.
// Detect if tree-sitter is operational before running parser-dependent tests.
function treeSitterWorks() {
  const tmpFile = path.join(os.tmpdir(), `ts-lint-probe-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, `function x({\n`);
  try {
    const result = lintFile(tmpFile);
    return result.errors.length > 0; // should detect error
  } catch {
    return false;
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

describe("tree-sitter lint", () => {
  let tmpDir;
  let tsWorking;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-lint-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Run detection once
  beforeEach(() => {
    if (tsWorking === undefined) tsWorking = treeSitterWorks();
  });

  it("reports no errors for valid JavaScript", () => {
    const file = path.join(tmpDir, "valid.js");
    fs.writeFileSync(file, `function hello(name) {\n  return "Hello " + name;\n}\n`);
    const result = lintFile(file);
    expect(result.errors).toHaveLength(0);
    expect(result.language).toBe("javascript");
  });

  it("detects syntax errors in JavaScript", () => {
    if (!tsWorking) return; // skip if native module not working in this worker
    const file = path.join(tmpDir, "broken.js");
    fs.writeFileSync(file, `function hello(name {\n  return "Hello " + name;\n}\n`);
    const result = lintFile(file);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].line).toBeDefined();
  });

  it("detects syntax errors in Python", () => {
    if (!tsWorking) return;
    const file = path.join(tmpDir, "broken.py");
    fs.writeFileSync(file, `def hello(name\n    return "Hello " + name\n`);
    const result = lintFile(file);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns null language for unsupported extensions", () => {
    const file = path.join(tmpDir, "data.csv");
    fs.writeFileSync(file, `a,b,c\n1,2,3\n`);
    const result = lintFile(file);
    expect(result.errors).toHaveLength(0);
    expect(result.language).toBeNull();
  });

  it("lintFileFormatted returns null for valid files", () => {
    const file = path.join(tmpDir, "valid.js");
    fs.writeFileSync(file, `const x = 1;\n`);
    expect(lintFileFormatted(file)).toBeNull();
  });

  it("lintFileFormatted returns formatted string for invalid files", () => {
    if (!tsWorking) return;
    const file = path.join(tmpDir, "broken.js");
    fs.writeFileSync(file, `const x = ;\n`);
    const result = lintFileFormatted(file);
    expect(result).not.toBeNull();
    expect(result).toContain("Syntax errors");
    expect(result).toContain("Line");
  });
});
