import { execFileSync } from "node:child_process";
import { register } from "./registry.js";

const MAX_BUFFER = 100 * 1024;
const TIMEOUT_MS = 30_000;

const BLOCKED_COMMANDS = new Set(["push", "filter-branch"]);
const BLOCKED_FLAGS = new Set(["--force", "-f", "--force-with-lease", "-D", "--delete"]);

const DESTRUCTIVE_SUBCOMMANDS = {
  reset: (args) => {
    if (args.includes("--hard") || args.includes("--keep")) {
      const idx = args.includes("--hard") ? args.indexOf("--hard") : args.indexOf("--keep");
      const remaining = args.slice(idx + 1);
      if (remaining.length === 0 || remaining[0] === "HEAD") return null;
      return "reset --hard/--keep to non-HEAD commit";
    }
    return null;
  },
  checkout: (args) => {
    // Block "checkout -- ." and "checkout -- *" (discards all working tree changes)
    const dashDashIdx = args.indexOf("--");
    if (dashDashIdx !== -1) {
      const after = args.slice(dashDashIdx + 1);
      if (after.includes(".") || after.includes("*")) {
        return "checkout -- . / * discards all working tree changes";
      }
    }
    return null;
  },
  clean: () => "git clean can permanently delete untracked files",
  stash: (args) => {
    const subarg = args[1];
    if (subarg === "drop" || subarg === "clear") {
      return `stash ${subarg} permanently deletes stashed changes`;
    }
    return null;
  },
};

register("git", {
  description: "Execute git commands with safety restrictions. Blocks 'push' and '--force'. Commits auto-include change summary.",
  parameters: {
    type: "object",
    required: ["args"],
    properties: {
      args: {
        type: "array",
        items: { type: "string" },
        description: "Git command arguments (e.g., ['add', '--all'], ['commit', '-m', 'msg']).",
      },
    },
  },
  async execute({ args }, { cwd = process.cwd() } = {}) {
    if (!Array.isArray(args) || args.length === 0) {
      return { error: "args must be a non-empty array" };
    }

    const subcommand = args[0];
    if (BLOCKED_COMMANDS.has(subcommand)) {
      return { error: `Blocked: 'git ${subcommand}' is not allowed` };
    }

    for (const arg of args) {
      if (BLOCKED_FLAGS.has(arg)) {
        return { error: `Blocked: '${arg}' flag is not allowed` };
      }
    }

    // Block git config alias modifications (can bypass command blocks)
    if (subcommand === "config" && args.some(a => a.startsWith("alias."))) {
      return { error: "Blocked: modifying git aliases is not allowed" };
    }

    if (DESTRUCTIVE_SUBCOMMANDS[subcommand]) {
      const reason = DESTRUCTIVE_SUBCOMMANDS[subcommand](args);
      if (reason) return { error: `Blocked: ${reason}` };
    }

    if (subcommand === "commit") return handleCommit(args, cwd);

    return runGit(args, cwd);
  },
});

function handleCommit(args, cwd) {
  const msgIdx = args.indexOf("-m") !== -1 ? args.indexOf("-m") : args.indexOf("--message");
  const userMsg = msgIdx !== -1 && args[msgIdx + 1] ? args[msgIdx + 1] : "";
  const summary = getChangeSummary(cwd);
  const fullMsg = userMsg ? `${userMsg}\n\n${summary}` : summary;

  const newArgs = ["commit"];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-m" || args[i] === "--message") { i++; continue; }
    newArgs.push(args[i]);
  }
  newArgs.push("-m", fullMsg);

  const result = runGit(newArgs, cwd);
  if (result.success) result.summary = summary;
  return result;
}

function getChangeSummary(cwd) {
  try {
    const status = execFileSync("git", ["diff", "--cached", "--name-status"], { cwd, encoding: "utf-8", timeout: TIMEOUT_MS });
    const stat = execFileSync("git", ["diff", "--cached", "--stat"], { cwd, encoding: "utf-8", timeout: TIMEOUT_MS });

    if (!status.trim()) return "No staged changes";

    const files = status.trim().split("\n");
    const added = files.filter(f => f.startsWith("A")).map(f => f.slice(1).trim());
    const modified = files.filter(f => f.startsWith("M")).map(f => f.slice(1).trim());
    const deleted = files.filter(f => f.startsWith("D")).map(f => f.slice(1).trim());

    const parts = [];
    if (added.length) parts.push(`Added (${added.length}): ${added.join(", ")}`);
    if (modified.length) parts.push(`Modified (${modified.length}): ${modified.join(", ")}`);
    if (deleted.length) parts.push(`Deleted (${deleted.length}): ${deleted.join(", ")}`);

    const statLine = stat.trim().split("\n").pop();
    if (statLine) parts.push(statLine.trim());

    return parts.join("\n");
  } catch {
    return "Unable to generate change summary";
  }
}

function runGit(args, cwd) {
  try {
    const output = execFileSync("git", args, { cwd, encoding: "utf-8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    return { success: true, command: `git ${args.join(" ")}`, output: output.trim() };
  } catch (err) {
    if (err.message?.includes("not a git repository")) return { error: "Not a git repository" };
    return { error: err.stderr?.trim() || err.message, command: `git ${args.join(" ")}` };
  }
}