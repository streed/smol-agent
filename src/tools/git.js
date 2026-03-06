import { execFileSync } from "node:child_process";
import { register } from "./registry.js";

const MAX_BUFFER = 100 * 1024; // 100KB
const TIMEOUT_MS = 30_000;

// Blocked commands that could push changes to remote
const BLOCKED_COMMANDS = new Set(["push"]);

// Blocked flags that could cause destructive operations (exact match)
const BLOCKED_FLAGS = new Set(["--force", "-f", "--force-with-lease", "-D"]);

// Destructive subcommands that need special handling
const DESTRUCTIVE_SUBCOMMANDS = {
  reset: (args) => {
    // Block --hard and --keep with HEAD~ or commit references
    if (args.includes("--hard") || args.includes("--keep")) {
      const targetIndex = args.includes("--hard") ? args.indexOf("--hard") : args.indexOf("--keep");
      const remaining = args.slice(targetIndex + 1);
      // Block if targeting anything other than HEAD or empty (defaults to HEAD)
      if (remaining.length === 0 || remaining[0] === "HEAD") {
        return null; // Allow reset --hard HEAD
      }
      return "reset --hard/--keep to non-HEAD commit";
    }
    return null;
  },
};

register("git", {
  description:
    "Execute git commands with safety restrictions. Stages changes, shows diffs, commits, etc. Blocks 'push' and '--force' to prevent accidental remote changes.",
  parameters: {
    type: "object",
    required: ["args"],
    properties: {
      args: {
        type: "array",
        items: { type: "string" },
        description:
          "Git command arguments (e.g., ['add', '--all'] or ['diff', '--stat']). First element should be the git subcommand.",
      },
    },
  },
  async execute({ args }, { cwd = process.cwd() } = {}) {
    if (!Array.isArray(args) || args.length === 0) {
      return { error: "args must be a non-empty array of strings" };
    }

    // Check for blocked commands
    const subcommand = args[0];
    if (BLOCKED_COMMANDS.has(subcommand)) {
      return { error: `Blocked: 'git ${subcommand}' is not allowed (would push to remote)` };
    }

    // Check for blocked flags anywhere in args (exact match only)
    for (const arg of args) {
      if (BLOCKED_FLAGS.has(arg)) {
        return { error: `Blocked: '${arg}' flag is not allowed (destructive operation)` };
      }
    }

    // Check destructive subcommands
    if (DESTRUCTIVE_SUBCOMMANDS[subcommand]) {
      const blockReason = DESTRUCTIVE_SUBCOMMANDS[subcommand](args);
      if (blockReason) {
        return { error: `Blocked: ${blockReason} is not allowed` };
      }
    }

    try {
      const output = execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        stdio: ["pipe", "pipe", "pipe"],
      });

      return {
        success: true,
        command: `git ${args.join(" ")}`,
        output: output.trim(),
      };
    } catch (err) {
      if (err.message?.includes("not a git repository")) {
        return { error: "Not a git repository" };
      }
      // Return stderr for git errors (often informative)
      const stderr = err.stderr?.trim() || err.message;
      return { error: stderr, command: `git ${args.join(" ")}` };
    }
  },
});