import { exec } from "node:child_process";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";

register("run_command", {
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
    const resolvedCwd = cwd
      ? resolveJailedPath(process.cwd(), cwd)
      : process.cwd();

    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: resolvedCwd,
          timeout: timeout || 30_000,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              exit_code: err.code,
              stdout: (stdout || "").trim(),
              stderr: (stderr || "").trim(),
            });
          } else {
            resolve({ stdout: (stdout || "").trim() });
          }
        },
      );
    });
  },
});
