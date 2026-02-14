import { register } from "./registry.js";
import { loadAgentState } from "./agent_coordinator.js";

register("agent_monitor", {
  description: "Monitor the progress of child agents. This tool allows the parent agent to track the status and results of sub-agents working on different parts of a problem.",
  parameters: {
    type: "object",
    required: ["agent_ids"],
    properties: {
      agent_ids: {
        type: "array",
        items: {
          type: "string"
        },
        description: "Array of agent identifiers to monitor"
      }
    }
  },
  async execute({ agent_ids }) {
    const monitoring = [];
    
    for (const agentId of agent_ids) {
      const state = loadAgentState(agentId);
      
      monitoring.push({
        agent_id: agentId,
        status: state ? (state.status || "unknown") : "not_found",
        progress: state ? (state.progress || 0) : 0,
        parent_id: state ? state.parent_id : null,
        start_time: state ? state.startTime : null,
        end_time: state ? state.endTime : null,
        exit_code: state ? state.exitCode : null,
        has_error: state ? !!state.error : false
      });
    }
    
    return {
      result: `Monitoring ${agent_ids.length} agents`,
      agent_ids: agent_ids,
      monitoring: monitoring,
      total_active: monitoring.filter(m => m.status === "running").length,
      total_completed: monitoring.filter(m => m.status === "completed").length,
      total_failed: monitoring.filter(m => m.status === "failed").length,
      monitored: true
    };
  }
});
