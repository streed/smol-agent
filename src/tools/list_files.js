import { glob } from "glob";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";

register("list_files", {
  description:
    "List files and directories matching a glob pattern. Useful for understanding project structure. Defaults to listing everything in the current directory. Common patterns: '**/*.js' for all JS files, 'src/**' for everything under src/.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match (default: '*'). Examples: '**/*.ts', 'src/**', '*.json'.",
      },
      cwd: {
        type: "string",
        description: "Working directory for the glob (default: process cwd).",
      },
    },
  },
  async execute({ pattern, cwd }) {
    // Use the jail directory as the base if no cwd is provided
    const baseCwd = cwd || process.cwd();
    
    // Resolve the cwd to ensure it's within the jail
    const resolvedCwd = resolveJailedPath(process.cwd(), baseCwd);
    
    const matches = await glob(pattern || "*", {
      cwd: resolvedCwd,
      dot: false,
      ignore: ["node_modules/**", ".git/**"],
    });
    return { files: matches.sort() };
  },
});
