import { execSync } from "node:child_process";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";

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
    // Resolve the search path against the jail directory
    const resolvedSearchPath = searchPath 
      ? resolveJailedPath(process.cwd(), searchPath)
      : process.cwd();
      
    const args = ["-rn", "--color=never"];
    if (include) args.push(`--include=${include}`);
    args.push(pattern);
    args.push(resolvedSearchPath);
    const cmd = `grep ${args.map((a) => JSON.stringify(a)).join(" ")}`;

    try {
      const stdout = execSync(cmd, {
        encoding: "utf-8",
        timeout: 15_000,
        maxBuffer: 512 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = stdout.trim().split("\n");
      return { matches: lines.slice(0, 200) };
    } catch (err) {
      if (err.status === 1) {
        return { matches: [] }; // no matches
      }
      return { error: (err.stderr || err.message).trim() };
    }
  },
});
