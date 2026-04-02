import { execFileSync } from "node:child_process";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";

const MAX_MATCHES = 200;
const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 512 * 1024;

interface GrepArgs {
  pattern: string;
  path?: string;
  include?: string;
}

interface GrepResult {
  matches?: string[];
  total?: number;
  error?: string;
}

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
  async execute({ pattern, path: searchPath, include }: GrepArgs, { cwd = process.cwd() } = {}): Promise<GrepResult> {
    const resolvedSearchPath = searchPath
      ? resolveJailedPath(cwd, searchPath)
      : cwd;

    const args = ["-rn", "--color=never"];
    if (include) args.push(`--include=${include}`);
    args.push(pattern);
    args.push(resolvedSearchPath);

    try {
      const stdout = execFileSync("grep", args, {
        encoding: "utf-8",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = stdout.trim().split("\n");
      // Compact result: truncate long lines to save tokens
      const matches = lines.slice(0, MAX_MATCHES).map(line => {
        if (line.length > 200) {
          return line.slice(0, 200) + '...';
        }
        return line;
      });
      return { matches, total: lines.length };
    } catch (err: unknown) {
      const error = err as Error & { status?: number; stderr?: string };
      if (error.status === 1) {
        return { matches: [] }; // no matches
      }
      return { error: (error.stderr || error.message).trim() };
    }
  },
});