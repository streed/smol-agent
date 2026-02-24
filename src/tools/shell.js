import { exec } from "node:child_process";
import { promisify } from "node:util";
import { register } from "./registry.js";
import { requestPermission } from "./ask_user.js";

const execAsync = promisify(exec);

// Whether the user has already approved shell access this session.
let _approved = false;
// When true, skip the approval prompt entirely (--yes flag).
let _autoApprove = false;

/** Called by the agent when --yes is passed. */
export function setAutoApprove(value) {
  _autoApprove = value;
}

/** Called by agent.reset() so the prompt reappears after a conversation reset. */
export function resetApproval() {
  _approved = false;
}

register("shell", {
  description:
    "Execute a shell command and return its stdout/stderr. Use for running builds, tests, git commands, installing packages, etc. Commands run in the current working directory.",
  parameters: {
    type: "object",
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
      cwd: {
        type: "string",
        description: "Optional working directory for the command.",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000).",
      },
    },
  },
  async execute({ command, cwd, timeout }) {
    // Ask for shell access on first use (skipped when --yes is active).
    if (!_approved && !_autoApprove) {
      const preview =
        command.length > 80 ? command.slice(0, 77) + "..." : command;
      const granted = await requestPermission(
        `Allow the agent to run shell commands?\nFirst command: ${preview}\n(yes/no)`
      );
      if (!granted) {
        return { error: "Shell access denied by user." };
      }
      _approved = true;
    }

    try {
      const { stdout } = await execAsync(command, {
        cwd: cwd || process.cwd(),
        timeout: timeout || 30_000,
        maxBuffer: 1024 * 1024,
      });
      return { stdout: stdout.trim() };
    } catch (err) {
      return {
        exit_code: err.code,
        stdout: (err.stdout || "").trim(),
        stderr: (err.stderr || "").trim(),
      };
    }
  },
});
