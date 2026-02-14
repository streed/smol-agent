import { register } from "./registry.js";

/**
 * Track that a file has been touched/seen by the agent
 * This helps with smart context updates - we only need to refresh
 * context for files that have changed since they were last touched.
 */
register("file_touched", {
  description: "Record that a file has been accessed or modified. This helps the agent track which files have been seen and only update context for changed files.",
  parameters: {
    type: "object",
    required: ["filePath"],
    properties: {
      filePath: {
        type: "string",
        description: "The path of the file that was touched (relative to current directory)"
      }
    }
  },
  async execute({ filePath }) {
    // The context tracker in agent.js handles this automatically
    // This tool is mainly for explicit tracking when needed
    return {
      success: true,
      message: `File "${filePath}" recorded as touched`
    };
  }
});
