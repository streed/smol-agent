import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";
import { glob } from "glob";

register("list_files", {
  description:
    "List files matching a glob pattern. Returns file paths relative to the project root. Use this to discover project structure, find files by extension, or explore directories.",
  parameters: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match files (e.g. '**/*.js', 'src/**/*.ts', '*.json').",
      },
      path: {
        type: "string",
        description:
          "Directory to search in, relative to project root (default: project root).",
      },
    },
  },
  async execute({ pattern, path: searchPath }) {
    const cwd = searchPath
      ? resolveJailedPath(process.cwd(), searchPath)
      : process.cwd();

    const files = await glob(pattern, {
      cwd,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/.smol-agent/**",
      ],
      nodir: true,
    });

    files.sort();

    const MAX = 500;
    return {
      pattern,
      count: files.length,
      files: files.slice(0, MAX),
      truncated: files.length > MAX,
    };
  },
});
