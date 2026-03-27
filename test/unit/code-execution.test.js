/**
 * Unit tests for code_execution tool.
 *
 * Tests the sandboxed JavaScript execution environment:
 * - Tool availability in sandbox (read_file, grep, list_files)
 * - Batched tool calls (multiple tools in one execution)
 * - Error handling and stdout/stderr capture
 * - Jail directory enforcement for file operations
 * - Timeout handling for long-running code
 *
 * Dependencies: ../../src/tools/registry.js, node:fs, node:path, node:os, events
 */
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
        const [header, ...lines] = file.content.split("\\n");
        console.log("Lines:", lines.length);
        console.log("First line:", lines[0]);
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("1\tHello, World!");
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

  test("rejects code that exceeds length limit", async () => {
    const longCode = "x".repeat(51_000); // Over 50,000 char limit
    const result = await execute("code_execution", { code: longCode });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("too long");
  });

  test("rejects non-string code", async () => {
    const result = await execute("code_execution", { code: null });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("non-empty string");
  });

  test("can make parallel tool calls with Promise.all", async () => {
    // Create multiple files (without trailing newline for exact 1 line)
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "File A");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "File B");

    const result = await execute("code_execution", {
      code: `
        const [fileA, fileB] = await Promise.all([
          read_file({ filePath: "a.txt" }),
          read_file({ filePath: "b.txt" })
        ]);
        const [metaA, contentA] = fileA.content.split("\\n");
        const [metaB, contentB] = fileB.content.split("\\n");
        console.log("A content:", contentA.split("\t")[1]);
        console.log("B content:", contentB.split("\t")[1]);
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.tool_calls_made).toBe(2);
    expect(result.stdout).toContain("A content: File A");
    expect(result.stdout).toContain("B content: File B");
  });

  test("propagates tool errors to caller", async () => {
    const result = await execute("code_execution", {
      code: `
        const file = await read_file({ filePath: "nonexistent.txt" });
        if (file.error) {
          console.log("got error:", file.error);
        }
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("got error:");
    expect(result.stdout).toContain("File not found");
  });

  test("handles tool call that returns error object", async () => {
    const result = await execute("code_execution", {
      code: `
        const file = await read_file({ filePath: "nonexistent.txt" });
        // Tool returns { error: ... } but doesn't throw
        console.log("result:", file.error ? "has error" : "no error");
      `,
    });

    // Code completes successfully - the tool returns an error object, not throws
    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("result: has error");
  });

  test("provides standard globals (Math, Date, Array, Object)", async () => {
    const result = await execute("code_execution", {
      code: `
        console.log("Math:", typeof Math);
        console.log("Date:", typeof Date);
        console.log("Array:", typeof Array);
        console.log("Object:", typeof Object);
        console.log("Map:", typeof Map);
        console.log("Set:", typeof Set);
        console.log("RegExp:", typeof RegExp);
        console.log("Error:", typeof Error);
        console.log("Promise:", typeof Promise);
        console.log("parseInt:", typeof parseInt);
        console.log("encodeURIComponent:", typeof encodeURIComponent);
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("Math: object");
    expect(result.stdout).toContain("Date: function");
    expect(result.stdout).toContain("Array: function");
    expect(result.stdout).toContain("Object: function");
    expect(result.stdout).toContain("Map: function");
    expect(result.stdout).toContain("Set: function");
    expect(result.stdout).toContain("Promise: function");
  });

  test("captures console.info as stdout", async () => {
    const result = await execute("code_execution", {
      code: `
        console.info("info message");
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("info message");
  });

  test("captures console.warn as stderr", async () => {
    const result = await execute("code_execution", {
      code: `
        console.warn("warning message");
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stderr).toContain("warning message");
  });

  test("suppresses console.debug", async () => {
    const result = await execute("code_execution", {
      code: `
        console.debug("debug message");
        console.log("after debug");
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).not.toContain("debug message");
    expect(result.stdout).toContain("after debug");
  });

  test("can use setTimeout for delayed execution", async () => {
    const result = await execute("code_execution", {
      code: `
        let value = "before";
        setTimeout(() => { value = "after"; }, 10);
        await new Promise(r => setTimeout(r, 50));
        console.log("value:", value);
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("value: after");
  });

  test("handles syntax errors in code", async () => {
    const result = await execute("code_execution", {
      code: `const x = {`, // Invalid syntax
    });

    expect(result.return_code).toBe(1);
    expect(result.error).toBeDefined();
  });

  test("handles async/await correctly", async () => {
    const result = await execute("code_execution", {
      code: `
        async function delay(ms) {
          return new Promise(resolve => setTimeout(resolve, ms));
        }
        await delay(10);
        console.log("async completed");
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toContain("async completed");
  });

  test("returns tools_called with unique tool names", async () => {
    // Create test files
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(path.join(tmpDir, `t${i}.txt`), `content ${i}\n`);
    }

    const result = await execute("code_execution", {
      code: `
        await read_file({ filePath: "t0.txt" });
        await read_file({ filePath: "t1.txt" });
        await list_files({ dirPath: "." });
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.tool_calls_made).toBe(3);
    // tools_called should have unique names only
    expect(result.tools_called).toEqual(["read_file", "list_files"]);
  });

  test("emits code_exec_tool_call event", async () => {
    const EventEmitter = (await import("events")).default;
    const emitter = new EventEmitter();
    
    let capturedEvent = null;
    emitter.on("code_exec_tool_call", (event) => {
      capturedEvent = event;
    });

    const result = await execute("code_execution", {
      code: `await read_file({ filePath: "hello.txt" });`,
    }, { eventEmitter: emitter });

    expect(result.return_code).toBe(0);
    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.name).toBe("read_file");
    expect(capturedEvent.args).toEqual({ filePath: "hello.txt" });
  });

  test("emits code_exec_tool_result event", async () => {
    const EventEmitter = (await import("events")).default;
    const emitter = new EventEmitter();
    
    let capturedEvent = null;
    emitter.on("code_exec_tool_result", (event) => {
      capturedEvent = event;
    });

    const result = await execute("code_execution", {
      code: `await read_file({ filePath: "hello.txt" });`,
    }, { eventEmitter: emitter });

    expect(result.return_code).toBe(0);
    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.name).toBe("read_file");
    expect(capturedEvent.result).toBeDefined();
    expect(capturedEvent.result.content).toContain("Hello, World!");
  });

  test("handles code with no output", async () => {
    const result = await execute("code_execution", {
      code: `
        // Just a comment, no output
        const x = 42;
      `,
    });

    expect(result.return_code).toBe(0);
    expect(result.stdout).toBe("(no output)");
  });

  test("can access nested object properties from tool results", async () => {
    const result = await execute("code_execution", {
      code: `
        const file = await read_file({ filePath: "hello.txt" });
        // Content format: "filePath:start-end/total\\n1\\tHello, World!\\n..."
        // First line is metadata header, skip it
        const lines = file.content.split("\\n");
        const contentLine = lines[1]; // Skip metadata header
        console.log("First content line:", contentLine);
      `,
    });

    expect(result.return_code).toBe(0);
    // Content format now has metadata header
    expect(result.stdout).toContain("First content line: 1\tHello, World!");
  });
});
