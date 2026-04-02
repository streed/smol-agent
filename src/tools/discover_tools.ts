/**
 * Progressive Tool Discovery — Meta-tool for activating tool groups.
 *
 * This meta-tool lets the agent request additional tool groups at runtime,
 * reducing context bloat by only loading tools when needed.
 *
 * Tool groups:
 *   - plan: save_plan, load_plan_progress, get_current_plan, complete_plan_step, update_plan_status
 *   - memory: remember, recall, memory_bank_read, memory_bank_write, memory_bank_init, save_context
 *   - web: web_search, web_fetch
 *   - multi_agent: delegate, send_letter, check_reply, read_inbox, read_outbox, reply_to_letter,
 *                  list_agents, link_repos, set_snippet, find_agent_for_task
 *
 * Key exports:
 *   - setActivateGroupCallback(cb): Set callback to activate groups on agent
 *   - Tool registration: discover_tools
 *
 * @file-doc
 * @module tools/discover_tools
 * @dependencies ./registry.js, ../logger.js
 * @dependents src/agent.js, src/lru-tool-cache.js,
 *             test/e2e/scenarios/53-progressive-discovery.test.js,
 *             test/e2e/scenarios/54-auto-discovery-context.test.js
 */
import { register, getToolGroups, getToolsForGroups } from "./registry.js";
import { logger } from "../logger.js";

interface ToolGroup {
  tools: string[];
  description: string;
}

interface ActivateResult {
  activated: string[];
  alreadyActive: string[];
  unknown: string[];
}

interface DiscoverToolsArgs {
  groups?: string[];
  list?: boolean;
}

interface DiscoverToolsResult {
  groups?: string;
  result?: string;
  error?: string;
}

let _activateGroupCallback: ((groups: string[]) => ActivateResult) | null = null;

/**
 * Install the callback the agent provides so discover_tools can
 * activate groups on the agent's behalf.
 * @param cb - Callback that activates groups and returns result
 */
export function setActivateGroupCallback(cb: (groups: string[]) => ActivateResult): void {
  _activateGroupCallback = cb;
}

register("discover_tools", {
  description:
    "Activate additional tool groups to unlock more capabilities. " +
    "Call this when you need tools beyond the currently active set. " +
    "Pass the group name(s) you want to activate.",
  parameters: {
    type: "object",
    required: ["groups"],
    properties: {
      groups: {
        type: "array",
        items: { type: "string" },
        description:
          "Tool group name(s) to activate — e.g. [\"plan\"], [\"web\", \"memory\"].",
      },
      list: {
        type: "boolean",
        description:
          "If true, return a listing of all available groups and their tools instead of activating.",
      },
    },
  },
  async execute({ groups, list: listMode }: DiscoverToolsArgs): Promise<DiscoverToolsResult> {
    const allGroups = getToolGroups() as Record<string, ToolGroup>;

    // List mode — just describe what's available
    if (listMode) {
      const lines = Object.entries(allGroups).map(
        ([name, g]) => `- **${name}**: ${g.description}\n  Tools: ${g.tools.join(", ")}`,
      );
      return { groups: lines.join("\n") };
    }

    if (!_activateGroupCallback) {
      logger.warn("discover_tools called but no activation callback is set");
      return { error: "Progressive discovery is not configured for this agent." };
    }

    if (!Array.isArray(groups) || groups.length === 0) {
      return { error: "Provide at least one group name. Call with list=true to see available groups." };
    }

    const result = _activateGroupCallback(groups);

    const parts: string[] = [];
    if (result.activated.length > 0) {
      // Return the newly available tool definitions so the model
      // immediately knows their schemas (avoids waiting for next turn).
      const newTools: string[] = [];
      for (const gName of result.activated) {
        const group = allGroups[gName];
        if (group) newTools.push(...group.tools);
      }
      const toolDescriptions = newTools.map(tName => {
        // Find tool in registry to get its description
        const found = getToolsForGroups(new Set(Object.keys(allGroups))).find(
          t => t.function.name === tName,
        );
        if (!found) return `- ${tName}`;
        const params = (found.function.parameters?.properties || {}) as Record<string, { type?: string }>;
        const paramList = Object.entries(params)
          .map(([k, v]) => `${k}: ${v.type || "string"}`)
          .join(", ");
        const desc = (found.function.description || "").split(".")[0];
        return `- **${tName}**(${paramList}): ${desc}.`;
      });

      parts.push(`Activated groups: ${result.activated.join(", ")}`);
      parts.push(`New tools now available:\n${toolDescriptions.join("\n")}`);
    }
    if (result.alreadyActive.length > 0) {
      parts.push(`Already active: ${result.alreadyActive.join(", ")}`);
    }
    if (result.unknown.length > 0) {
      parts.push(`Unknown groups: ${result.unknown.join(", ")}. Call with list=true to see available groups.`);
    }

    return { result: parts.join("\n") };
  },
});