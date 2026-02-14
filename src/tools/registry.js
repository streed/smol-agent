/** 
 * Tool registry — registers tools and provides them in Ollama's tool-call format. 
 */

const tools = new Map();

// Tools that modify files or run commands (blocked in planning/preplan modes)
const WRITE_TOOLS = new Set(["write_file", "edit_file", "shell"]);

// Tools that spawn sub-agents (blocked for child agents)
const SPAWN_TOOLS = new Set(["spawn_agent", "agent_coordinator"]);

export function register(name, { description, parameters, execute }) {
  tools.set(name, { description, parameters, execute });
}

/**
 * Return the tools array in the format Ollama expects.
 * @param {boolean} planningMode - If true, exclude write tools
 * @param {boolean} isChildAgent - If true, exclude spawn tools
 */
export function ollamaTools(planningMode = false, preplanMode = false, isChildAgent = false) {
  const out = [];
  for (const [name, tool] of tools) {
    // In planning/preplan modes, skip tools that modify files or run commands
    if ((planningMode || preplanMode) && WRITE_TOOLS.has(name)) continue;
    // Child agents cannot spawn sub-agents
    if (isChildAgent && SPAWN_TOOLS.has(name)) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: tool.description,
        parameters: tool.parameters,
      },
    });
  }
  return out;
}

/**
 * Execute a tool call by name with the given arguments.
 */
export async function execute(name, args) {
  const tool = tools.get(name);
  if (!tool) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    const result = await tool.execute(args);
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

export function list() {
  return [...tools.keys()];
}
