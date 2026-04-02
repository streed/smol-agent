/**
 * Git tool with safety restrictions.
 *
 * Provides git operations with guardrails:
 *   - Blocks dangerous commands: push, filter-branch
 *   - Blocks dangerous flags: --force, --force-with-lease, -D
 *   - Validates destructive operations: reset --hard, checkout -- ., stash drop
 *   - Auto-includes change summary in commit messages
 *
 * Security model: Allow safe read/write operations, block anything that could
 * destroy uncommitted work or push to remote.
 *
 * Key exports:
 *   - Tool registration: git
 *
 * Dependencies: node:child_process, ./registry.js
 * Depended on by: src/agent.js, src/checkpoint.js, src/context.js, src/index.js,
 *                 src/repo-map.js, src/tools/file_documentation.js, src/tools/file_tools.js,
 *                 src/tools/list_files.js, src/tools/registry.js, src/tools/run_command.js,
 *                 src/ui/App.js, src/ui/diff.js, test/e2e/runner.js,
 *                 test/e2e/scenarios/47-shift-left-lint.test.js,
 *                 test/e2e/scenarios/55-git-safety.test.js,
 *                 test/unit/agent-registry.test.js, test/unit/checkpoint.test.js,
 *                 test/unit/context.test.js, test/unit/cross-agent-security-integration.test.js
 */
import { execFileSync } from "node:child_process";
import { register } from "./registry.js";

const MAX_BUFFER = 100 * 1024;
const TIMEOUT_MS = 30_000;

const BLOCKED_COMMANDS = new Set(["push", "filter-branch"]);
const BLOCKED_FLAGS = new Set(["--force", "-f", "--force-with-lease", "-D", "--delete"]);

type DestructiveCheckFn = (args: string[]) => string | null;

const DESTRUCTIVE_SUBCOMMANDS: Record<string, DestructiveCheckFn> = {
  reset: (args: string[]) => {
    if (args.includes("--hard") || args.includes("--keep")) {
      const idx = args.includes("--hard") ? args.indexOf("--hard") : args.indexOf("--keep");
      const remaining = args.slice(idx + 1);
      if (remaining.length === 0 || remaining[0] === "HEAD") return null;
      return "reset --hard/--keep to non-HEAD commit";
    }
    return null;
  },
  checkout: (args: string[]) => {
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
  stash: (args: string[]) => {
    const subarg = args[1];
    if (subarg === "drop" || subarg === "clear") {
      return `stash ${subarg} permanently deletes stashed changes`;
    }
    return null;
  },
};

interface GitResult {
  success?: boolean;
  command?: string;
  output?: string;
  summary?: string;
  error?: string;
}

interface GitArgs {
  args: string[];
}

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
  async execute({ args }: GitArgs, { cwd = process.cwd() } = {}): Promise<GitResult> {
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

function handleCommit(args: string[], cwd: string): GitResult {
  const msgIdx = args.indexOf("-m") !== -1 ? args.indexOf("-m") : args.indexOf("--message");
  const userMsg = msgIdx !== -1 && args[msgIdx + 1] ? args[msgIdx + 1] : "";
  const summary = getChangeSummary(cwd);
  const fullMsg = userMsg ? `${userMsg}\n\n${summary}` : summary;

  const newArgs: string[] = ["commit"];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-m" || args[i] === "--message") { i++; continue; }
    newArgs.push(args[i]);
  }
  newArgs.push("-m", fullMsg);

  const result = runGit(newArgs, cwd);
  if (result.success) result.summary = summary;
  return result;
}

function getChangeSummary(cwd: string): string {
  try {
    const status = execFileSync("git", ["diff", "--cached", "--name-status"], { cwd, encoding: "utf-8", timeout: TIMEOUT_MS });
    const stat = execFileSync("git", ["diff", "--cached", "--stat"], { cwd, encoding: "utf-8", timeout: TIMEOUT_MS });

    if (!status.trim()) return "No staged changes";

    const files = status.trim().split("\n");
    const added = files.filter(f => f.startsWith("A")).map(f => f.slice(1).trim());
    const modified = files.filter(f => f.startsWith("M")).map(f => f.slice(1).trim());
    const deleted = files.filter(f => f.startsWith("D")).map(f => f.slice(1).trim());

    const parts: string[] = [];
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

function runGit(args: string[], cwd: string): GitResult {
  try {
    const output = execFileSync("git", args, { cwd, encoding: "utf-8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    return { success: true, command: `git ${args.join(" ")}`, output: output.trim() };
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string };
    if (error.message?.includes("not a git repository")) return { error: "Not a git repository" };
    return { error: (error.stderr?.trim() || error.message) as string, command: `git ${args.join(" ")}` };
  }
}