import { register, getToolGroups, getToolsForGroups } from "./registry.js";
import { logger } from "../logger.js";

// ── Progressive Tool Discovery ──────────────────────────────────────
// This meta-tool lets the agent request additional tool groups at
// runtime, reducing context bloat by only loading tools when needed.

// The active groups set is managed by the Agent, but we need a
// callback so the tool execution can mutate the agent's state.
let _activateGroupCallback = null;

/**
 * Install the callback the agent provides so discover_tools can
 * activate groups on the agent's behalf.
 * @param {(groups: string[]) => { activated: string[], alreadyActive: string[], unknown: string[] }} cb
 */
export function setActivateGroupCallback(cb) {
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
  async execute({ groups, list: listMode }) {
    const allGroups = getToolGroups();

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

    const parts = [];
    if (result.activated.length > 0) {
      // Return the newly available tool definitions so the model
      // immediately knows their schemas (avoids waiting for next turn).
      const newTools = [];
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
        const params = found.function.parameters?.properties || {};
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
