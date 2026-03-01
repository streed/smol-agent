import { register } from "./registry.js";
import * as ollama from "../ollama.js";
import * as registry from "./registry.js";
import { logger } from "../logger.js";

let agentHost = null;
let agentModel = null;
let agentMaxTokens = 32768;
let agentCwd = process.cwd();

/**
 * Configure the sub-agent with the parent agent's connection details.
 * Called from Agent constructor.
 */
export function setSubAgentConfig({ host, model, maxTokens, cwd }) {
  agentHost = host;
  agentModel = model;
  if (maxTokens) agentMaxTokens = Math.min(maxTokens, 32768);
  if (cwd) agentCwd = cwd;
}

const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep"]);
const MAX_ITERATIONS = 15;

register("delegate", {
  description:
    "Delegate a focused research subtask to a sub-agent with a clean context window. The sub-agent has read-only tools (read_file, list_files, grep) and returns a condensed result. Use for exploring unfamiliar code, searching across many files, or gathering information without polluting your main context.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Clear, specific description of what to research or find",
      },
      context: {
        type: "string",
        description:
          "Any relevant context the sub-agent needs (file paths, function names, etc.)",
      },
    },
    required: ["task"],
  },
  async execute({ task, context }) {
    if (!agentHost || !agentModel) {
      return {
        error:
          "Sub-agent not configured. Only available for 30B+ models.",
      };
    }

    const client = ollama.createClient(agentHost);
    const readOnlyTools = registry
      .ollamaTools(true)
      .filter((t) => READ_ONLY_TOOLS.has(t.function.name));

    const systemPrompt = `You are a focused research sub-agent. Explore the codebase and return a concise answer.
Working directory: ${agentCwd}

Rules:
- Use tools to explore, then return a clear, concise summary.
- Keep your final answer under 1000 tokens.
- Focus only on the task given.
- Do NOT narrate — use tools immediately.
${context ? `\nContext: ${context}` : ""}`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: task },
    ];

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await ollama.chatWithRetry(
          client,
          agentModel,
          messages,
          readOnlyTools,
          null,
          agentMaxTokens,
        );

        const msg = response.message;
        messages.push(msg);

        if (!msg.tool_calls?.length) {
          return { result: msg.content || "(no result)" };
        }

        // Execute read-only tool calls
        for (const tc of msg.tool_calls) {
          const name = tc.function.name;
          const args = tc.function.arguments;

          if (!READ_ONLY_TOOLS.has(name)) {
            messages.push({
              role: "tool",
              content: JSON.stringify({
                error: `Tool "${name}" not available to sub-agent`,
              }),
            });
            continue;
          }

          const result = await registry.execute(name, args);
          const str = JSON.stringify(result);
          // Truncate large results for sub-agent's smaller context
          const truncated =
            str.length > 8000
              ? str.substring(0, 8000) + "\n[truncated]"
              : str;
          messages.push({ role: "tool", content: truncated });
        }
      }

      // Iteration limit — return last assistant content
      const lastAssistant = messages
        .filter((m) => m.role === "assistant")
        .pop();
      return {
        result:
          lastAssistant?.content ||
          "(sub-agent reached iteration limit)",
      };
    } catch (err) {
      logger.error(`Sub-agent failed: ${err.message}`);
      return { error: `Sub-agent failed: ${err.message}` };
    }
  },
});
