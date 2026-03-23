import { register as _register, execute, setJailDirectory } from "../../src/tools/registry.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Import code_execution tool to register it
import "../../src/tools/code_execution.js";
// Import file tools so read_file/grep/list_files are available in sandbox
import "../../src/tools/file_tools.js";
import "../../src/tools/list_files.js";
import "../../src/tools/grep.js";

describe("code_execution tool", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-exec-test-"));
    setJailDirectory(tmpDir);
    // Create a test file
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "Hello, World!\nLine 2\nLine 3\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("executes simple code and captures stdout", async () => {
    const result = await execute("code_execution", {
      code: `console.log("hello from sandbox");`,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("hello from sandbox");
    expect(result.tool_calls_made).toBe(0);
  });

  test("can call read_file tool from within code", async () => {
    const result = await execute("code_execution", {
      code: `
        const file = await read_file({ filePath: "hello.txt" });
        console.log("Lines:", file.totalLines);
        console.log("Content:", file.content);
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("Lines: 4");
    expect(result.stdout).toContain("Hello, World!");
    expect(result.tool_calls_made).toBe(1);
    expect(result.tools_called).toContain("read_file");
  });

  test("can call multiple tools and aggregate results", async () => {
    // Create another file
    fs.writeFileSync(path.join(tmpDir, "data.txt"), "TODO: fix bug\nTODO: add tests\nDone: refactor\n");

    const result = await execute("code_execution", {
      code: `
        const files = await list_files({ dirPath: "." });
        const grepResult = await grep({ pattern: "TODO", path: "." });
        console.log("Files found:", files.entries?.length || 0);
        console.log("Grep matches:", JSON.stringify(grepResult));
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.tool_calls_made).toBe(2);
    expect(result.tools_called).toEqual(expect.arrayContaining(["list_files", "grep"]));
  });

  test("handles errors gracefully", async () => {
    const result = await execute("code_execution", {
      code: `throw new Error("test error");`,
    });

    expect(result.return_code).toBe(1);
    expect(result.error).toBe("test error");
    expect(result.stderr).toContain("test error");
  });

  test("captures console.error as stderr", async () => {
    const result = await execute("code_execution", {
      code: `
        console.log("stdout line");
        console.error("stderr line");
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("stdout line");
    expect(result.stderr).toContain("stderr line");
  });

  test("can use loops to batch tool calls", async () => {
    // Create multiple files
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), `Content of file ${i}\n`);
    }

    const result = await execute("code_execution", {
      code: `
        const fileNames = ["file0.txt", "file1.txt", "file2.txt"];
        const results = [];
        for (const name of fileNames) {
          const file = await read_file({ filePath: name });
          results.push({ name, lines: file.totalLines });
        }
        console.log(JSON.stringify(results));
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.tool_calls_made).toBe(3);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveLength(3);
    expect(parsed[0].name).toBe("file0.txt");
  });

  test("rejects empty code", async () => {
    const result = await execute("code_execution", { code: "" });
    expect(result.error).toBeDefined();
  });

  test("prevents calling code_execution recursively", async () => {
    const result = await execute("code_execution", {
      code: `
        // code_execution should not be available as a function
        console.log("has code_execution:", typeof code_execution);
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("has code_execution: undefined");
  });

  test("provides JSON global", async () => {
    const result = await execute("code_execution", {
      code: `
        const obj = { a: 1, b: "two" };
        console.log(JSON.stringify(obj));
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain('{"a":1,"b":"two"}');
  });
});
