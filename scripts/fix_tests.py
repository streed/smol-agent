#!/usr/bin/env python3
"""Fix tests for compact tool result format."""

with open('test/unit/code-execution.test.js', 'r') as f:
    content = f.read()

# Fix test for read_file compact format
old_test = '''  test("can access nested object properties from tool results", async () => {
    const result = await execute("code_execution", {
      code: `
        const file = await read_file({ filePath: "hello.txt" });
        // Content is formatted with line numbers: "1\\tHello, World!\\n2\\tLine 2..."
        // First line is the line number prefix, then tab, then content
        const firstLine = file.content.split("\\n")[0];
        console.log("First line:", firstLine);
      `,
    });

    expect(result.return_code).toBe(0);
    // Content format is "1\\tHello, World!"
    expect(result.stdout).toContain("First line: 1\\tHello, World!");
  });'''

new_test = '''  test("can access nested object properties from tool results", async () => {
    const result = await execute("code_execution", {
      code: `
        const file = await read_file({ filePath: "hello.txt" });
        // Content format is now "filePath:start-end/total\\n1\\tHello, World!\\n..."
        // First line is metadata header, skip it
        const lines = file.content.split("\\n");
        const contentLine = lines[1]; // Skip metadata header
        console.log("First content line:", contentLine);
      `,
    });

    expect(result.return_code).toBe(0);
    // Content format now has metadata header: "filePath:start-end/total\\n1\\tHello, World!"
    expect(result.stdout).toContain("First content line: 1\\tHello, World!");
  });'''

content = content.replace(old_test, new_test)

# Fix test for write_file compact format
old_write_test = '''    expect(result.stdout).toContain("B lines: 1");'''

new_write_test = '''    expect(result.stdout).toContain("1 lines");'''

content = content.replace(old_write_test, new_write_test)

with open('test/unit/code-execution.test.js', 'w') as f:
    f.write(content)

print("Fixed tests successfully")