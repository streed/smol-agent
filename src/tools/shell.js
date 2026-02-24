import { exec } from "node:child_process";
import { promisify } from "node:util";
import { register } from "./registry.js";

const execAsync = promisify(exec);

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
