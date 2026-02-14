import { register } from "./registry.js";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { AGENT_INFO, IS_CHILD_AGENT, PARENT_ID } from "./spawn_agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Agent state directory for coordination
const AGENT_STATE_DIR = process.env.AGENT_STATE_DIR || join(process.cwd(), ".smol-agent", "state");

// Ensure state directory exists
if (!existsSync(AGENT_STATE_DIR)) {
  mkdirSync(AGENT_STATE_DIR, { recursive: true });
}

// Registry for tracking child agents
const childAgents = new Map();

/**
 * Save agent state to disk for coordination
 */
function saveAgentState(agentId, state) {
  try {
    const stateFile = join(AGENT_STATE_DIR, `${agentId}.json`);
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`Failed to save state for ${agentId}:`, err.message);
  }
}

/**
 * Load agent state from disk
 */
function loadAgentState(agentId) {
  try {
    const stateFile = join(AGENT_STATE_DIR, `${agentId}.json`);
    if (existsSync(stateFile)) {
      return JSON.parse(readFileSync(stateFile, "utf8"));
    }
  } catch (err) {
    console.error(`Failed to load state for ${agentId}:`, err.message);
  }
  return null;
}

/**
 * Remove agent state file
 */
function removeAgentState(agentId) {
  try {
    const stateFile = join(AGENT_STATE_DIR, `${agentId}.json`);
    if (existsSync(stateFile)) {
      writeFileSync(stateFile, JSON.stringify({ ...loadAgentState(agentId), status: "completed" }, null, 2));
    }
  } catch (err) {
    console.error(`Failed to remove state for ${agentId}:`, err.message);
  }
}

// Shared state between parent and child agents
const SHARED_STATE = {
  get: () => {
    const state = loadAgentState(AGENT_INFO.id) || { status: "initialized", progress: 0, result: null };
    return state;
  },
  
  update: (updates) => {
    const current = SHARED_STATE.get();
    const newState = { ...current, ...updates, lastUpdated: Date.now() };
    saveAgentState(AGENT_INFO.id, newState);
    return newState;
  }
};

register("agent_coordinator", {
  description: "Coordinate multiple agent instances. Parent can spawn children, monitor progress, and sync results. Child agents report progress back to parent.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        description: "Action to perform: 'spawn', 'monitor', 'sync', 'report', or 'get_state'"
      },
      child_agents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            agent_id: { type: "string", description: "Child agent identifier" },
            prompt: { type: "string", description: "Task for child agent" }
          }
        },
        description: "Array of child agents to spawn"
      },
      agent_ids: {
        type: "array",
        items: { type: "string" },
        description: "Agent IDs to monitor"
      },
      update: {
        type: "object",
        description: "State updates to report (for child agents)"
      }
    }
  },
  async execute({ action, child_agents, agent_ids, update }) {
    // Child agents can only use 'report' and 'get_state' actions
    if (IS_CHILD_AGENT && !["report", "get_state"].includes(action)) {
      return {
        error: `Child agents cannot perform action '${action}'. Only 'report' and 'get_state' are allowed.`,
        allowed_actions: ["report", "get_state"]
      };
    }

    switch (action) {
      case "spawn": {
        if (!child_agents || child_agents.length === 0) {
          return { error: "No child agents specified for spawning" };
        }

        const spawned = [];
        for (const child of child_agents) {
          const { agent_id, prompt } = child;
          
          const childEnv = {
            ...process.env,
            SMOL_AGENT_PARENT_ID: AGENT_INFO.id,
            AGENT_INSTANCE_ID: agent_id
          };

          const childProcess = spawn("node", [
            join(__dirname, "..", "index.js"),
            "--prompt", prompt,
            "--agent-id", agent_id
          ], {
            stdio: ["pipe", "pipe", "pipe"],
            env: childEnv,
            detached: false
          });

          // Store child info
          childAgents.set(agent_id, {
            agent_id,
            pid: childProcess.pid,
            prompt,
            status: "running",
            startTime: Date.now(),
            parent_id: AGENT_INFO.id
          });

          // Initialize child state
          saveAgentState(agent_id, {
            agent_id,
            status: "running",
            progress: 0,
            prompt,
            parent_id: AGENT_INFO.id,
            startTime: Date.now()
          });

          // Capture output
          let stdout = "";
          let stderr = "";
          
          childProcess.stdout.on("data", (data) => {
            stdout += data.toString();
            // Update progress if we see progress markers
            if (stdout.includes("progress:")) {
              SHARED_STATE.update({ progress: 50, lastUpdate: Date.now() });
            }
          });
          
          childProcess.stderr.on("data", (data) => {
            stderr += data.toString();
          });

          childProcess.on("close", (code) => {
            const childState = loadAgentState(agent_id) || {};
            childState.status = code === 0 ? "completed" : "failed";
            childState.exitCode = code;
            childState.endTime = Date.now();
            childState.stdout = stdout;
            childState.stderr = stderr;
            saveAgentState(agent_id, childState);
            
            childAgents.delete(agent_id);
          });
          
          spawned.push({ agent_id, pid: childProcess.pid, status: "running" });
        }

        return {
          result: `Spawned ${spawned.length} child agent(s)`,
          spawned_agents: spawned,
          parent_id: AGENT_INFO.id,
          total_spawned: spawned.length
        };
      }

      case "monitor": {
        const agentsToMonitor = agent_ids || Array.from(childAgents.keys());
        const monitoring = [];

        for (const agentId of agentsToMonitor) {
          const childInfo = childAgents.get(agentId);
          const state = loadAgentState(agentId) || {};
          
          monitoring.push({
            agent_id: agentId,
            status: childInfo ? childInfo.status : (state.status || "unknown"),
            progress: state.progress || 0,
            parent_id: state.parent_id || PARENT_ID,
            startTime: state.startTime,
            endTime: state.endTime
          });
        }

        return {
          result: "Monitoring active agents",
          monitoring: monitoring,
          total_active: monitoring.length,
          parent_id: AGENT_INFO.id
        };
      }

      case "sync": {
        const results = [];
        for (const [agentId, child] of childAgents) {
          const state = loadAgentState(agentId) || {};
          results.push({
            agent_id: agentId,
            status: state.status || "unknown",
            progress: state.progress || 0,
            result: state.result || null
          });
        }
        
        // Clear completed agents
        for (const agentId of agent_ids || []) {
          removeAgentState(agentId);
        }

        return {
          result: "Synchronization complete",
          results: results,
          parent_id: AGENT_INFO.id,
          total_synced: results.length
        };
      }

      case "report": {
        // Child agents report their status and progress back to parent
        const state = SHARED_STATE.update(update || { progress: 100, status: "completed" });
        
        return {
          result: "Status report received",
          agent_id: AGENT_INFO.id,
          parent_id: PARENT_ID,
          state: state
        };
      }

      case "get_state": {
        const state = SHARED_STATE.get();
        
        return {
          result: "Current agent state",
          agent_id: AGENT_INFO.id,
          parent_id: PARENT_ID,
          state: state
        };
      }

      default:
        return { error: `Unknown action: ${action}`, allowed_actions: ["spawn", "monitor", "sync", "report", "get_state"] };
    }
  }
});

// Export the coordination utilities
export { AGENT_INFO, IS_CHILD_AGENT, PARENT_ID, AGENT_STATE_DIR, childAgents, saveAgentState, loadAgentState, removeAgentState, SHARED_STATE };