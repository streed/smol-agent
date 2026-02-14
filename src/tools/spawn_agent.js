import { register } from "./registry.js";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Child agent detection - if this env var is set, we're a child agent
export const IS_CHILD_AGENT = process.env.SMOL_AGENT_PARENT_ID !== undefined;
export const PARENT_ID = process.env.SMOL_AGENT_PARENT_ID || null;

// Register this agent's information for coordination
export const AGENT_INFO = {
  id: process.env.AGENT_INSTANCE_ID || `agent-${process.pid}-${Date.now()}`,
  pid: process.pid,
  isParent: !IS_CHILD_AGENT,
  parentId: PARENT_ID,
  isChild: IS_CHILD_AGENT
};

register("spawn_agent", {
  description: "Spawn a new smol-agent process to work on a sub-problem. Child agents cannot spawn further sub-agents (single-level hierarchy). The child will work concurrently and report back results.",
  parameters: {
    type: "object",
    required: ["prompt", "child_agent_id"],
    properties: {
      prompt: {
        type: "string",
        description: "The sub-problem task for the child agent to solve"
      },
      child_agent_id: {
        type: "string",
        description: "Unique identifier for this child agent instance"
      },
      context: {
        type: "string",
        description: "Optional context from parent to pass to child"
      }
    }
  },
  async execute({ prompt, child_agent_id, context }) {
    // Create a copy of the environment with child agent markers
    const env = { ...process.env };
    env.SMOL_AGENT_PARENT_ID = AGENT_INFO.id;
    env.AGENT_INSTANCE_ID = child_agent_id;
    
    // Spawn child agent with limited tools (no spawn_agent capability)
    const child = spawn("node", [
      join(__dirname, "..", "index.js"),
      "--prompt", prompt,
      "--agent-id", child_agent_id
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: env,
      detached: false
    });

    let stdout = "";
    let stderr = "";
    
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    return new Promise((resolve) => {
      child.on("close", (code) => {
        resolve({
          result: `Child agent ${child_agent_id} completed with exit code ${code}`,
          child_agent_id: child_agent_id,
          exit_code: code,
          stdout: stdout,
          stderr: stderr,
          parent_id: AGENT_INFO.id,
          context: context || null
        });
      });
      
      child.on("error", (error) => {
        resolve({
          result: `Failed to spawn child agent: ${error.message}`,
          child_agent_id: child_agent_id,
          exit_code: -1,
          error: error.message
        });
      });
    });
  }
});
