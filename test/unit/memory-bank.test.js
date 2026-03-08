import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readBankFile,
  writeBankFile,
  initializeBank,
  loadMemoryBank,
  getBankFileKeys,
} from "../../src/memory-bank.js";

describe("memory bank", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-bank-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getBankFileKeys returns expected keys", () => {
    const keys = getBankFileKeys();
    expect(keys).toContain("projectContext");
    expect(keys).toContain("techContext");
    expect(keys).toContain("progress");
    expect(keys).toContain("learnings");
  });

  it("initializeBank creates template files", async () => {
    await initializeBank(tmpDir);
    const bankDir = path.join(tmpDir, ".smol-agent", "memory-bank");
    expect(fs.existsSync(bankDir)).toBe(true);
    expect(fs.existsSync(path.join(bankDir, "projectContext.md"))).toBe(true);
    expect(fs.existsSync(path.join(bankDir, "techContext.md"))).toBe(true);
    expect(fs.existsSync(path.join(bankDir, "progress.md"))).toBe(true);
    expect(fs.existsSync(path.join(bankDir, "learnings.md"))).toBe(true);
  });

  it("writeBankFile and readBankFile round-trip", async () => {
    const content = "# Project Context\n\nThis is a test project.\n";
    await writeBankFile(tmpDir, "projectContext", content);
    const result = await readBankFile(tmpDir, "projectContext");
    expect(result).toBe(content);
  });

  it("readBankFile returns null for missing files", async () => {
    const result = await readBankFile(tmpDir, "projectContext");
    expect(result).toBeNull();
  });

  it("readBankFile returns null for invalid key", async () => {
    const result = await readBankFile(tmpDir, "nonexistent");
    expect(result).toBeNull();
  });

  it("writeBankFile throws for invalid key", async () => {
    await expect(writeBankFile(tmpDir, "nonexistent", "content"))
      .rejects.toThrow("Unknown bank file");
  });

  it("loadMemoryBank returns null for empty bank", async () => {
    const result = await loadMemoryBank(tmpDir);
    expect(result).toBeNull();
  });

  it("loadMemoryBank returns null for template-only bank", async () => {
    await initializeBank(tmpDir);
    // Templates have only comments and headers — should be treated as empty
    const result = await loadMemoryBank(tmpDir);
    expect(result).toBeNull();
  });

  it("loadMemoryBank returns content when files have data", async () => {
    await writeBankFile(tmpDir, "projectContext", "# Project Context\n\nThis is a Node.js agent for coding assistance.\n");
    const result = await loadMemoryBank(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Memory Bank");
    expect(result).toContain("Node.js agent");
  });

  it("initializeBank does not overwrite existing files", async () => {
    const custom = "# Custom Content\n\nAlready written.\n";
    await writeBankFile(tmpDir, "projectContext", custom);
    await initializeBank(tmpDir);
    const result = await readBankFile(tmpDir, "projectContext");
    expect(result).toBe(custom);
  });
});
