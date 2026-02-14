import { register } from "./registry.js";
import { loadAgentState } from "./agent_coordinator.js";

register("agent_status", {
  description: "Check the status of a specific agent instance. Can check own status or any child agent's status.",
  parameters: {
    type: "object",
    required: ["agent_id"],
    properties: {
      agent_id: {
        type: "string",
        description: "The identifier of the agent instance to check status for"
      }
    }
  },
  async execute({ agent_id }) {
    const state = loadAgentState(agent_id);
    
    if (!state) {
      return {
        result: `Agent ${agent_id} not found in registry`,
        agent_id: agent_id,
        status: "not_found"
      };
    }
    
    return {
      result: `Status for agent ${agent_id}`,
      agent_id: agent_id,
      status: state.status || "unknown",
      progress: state.progress || 0,
      parent_id: state.parent_id || null,
      start_time: state.startTime || null,
      end_time: state.endTime || null,
      exit_code: state.exitCode || null,
      has_error: !!state.error,
      error_message: state.error || null
    };
  }
});
