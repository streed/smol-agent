import { exec } from "node:child_process";
import { promisify } from "node:util";
import { register } from "./registry.js";

const execAsync = promisify(exec);

register("grep", {
  description:
    "Search file contents for a regular expression pattern. Returns matching lines with file paths and line numbers. Useful for finding usages, definitions, or patterns across a codebase.",
  parameters: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression pattern to search for.",
      },
      path: {
        type: "string",
        description:
          "File or directory to search in (default: current directory).",
      },
      include: {
        type: "string",
        description:
          "Glob pattern to filter files, e.g. '*.js' or '*.ts'.",
      },
    },
  },
  async execute({ pattern, path: searchPath, include }) {
    const args = ["-rn", "--color=never"];
    if (include) args.push(`--include=${include}`);
    args.push(pattern);
    args.push(searchPath || ".");
    const cmd = `grep ${args.map((a) => JSON.stringify(a)).join(" ")}`;

    try {
      const { stdout } = await execAsync(cmd, {
        timeout: 15_000,
        maxBuffer: 512 * 1024,
      });
      const lines = stdout.trim().split("\n");
      return { matches: lines.slice(0, 200) };
    } catch (err) {
      if (err.code === 1) {
        return { matches: [] }; // no matches
      }
      return { error: (err.stderr || err.message).trim() };
    }
  },
});
