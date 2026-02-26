import { register } from "./registry.js";

/**
 * Reflection tool - allows the agent to reflect on its work after completing a task.
 * Can summarize what was done, what went well, and identify areas for improvement.
 * Optionally can ask for user feedback which will be displayed in the UI.
 */
register("reflect", {
  description: "Reflect on the work just completed. Summarize what was done, what went well, and identify areas for improvement. If askUserFeedback is true, the UI will prompt for user input.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Brief summary of what was accomplished"
      },
      whatWorkedWell: {
        type: "string",
        description: "Description of what went smoothly or exceeded expectations"
      },
      improvements: {
        type: "string",
        description: "Areas that could be improved for future similar tasks"
      },
      askUserFeedback: {
        type: "boolean",
        description: "Whether to ask the user for feedback on the work"
      },
      userQuestion: {
        type: "string",
        description: "Question to ask the user if askUserFeedback is true"
      }
    },
    required: ["summary"]
  },
  async execute(args) {
    const { summary, whatWorkedWell, improvements, askUserFeedback, userQuestion } = args;
    
    let reflection = `## Reflection\n\n**What was accomplished:**\n${summary}\n`;
    
    if (whatWorkedWell) {
      reflection += `\n**What went well:**\n${whatWorkedWell}\n`;
    }
    
    if (improvements) {
      reflection += `\n**Areas for improvement:**\n${improvements}\n`;
    }
    
    // If user feedback is requested, include that in the response
    // The UI will need to handle prompting for user input
    if (askUserFeedback && userQuestion) {
      reflection += `\n**Feedback requested:** ${userQuestion}\n`;
      // Return a special flag to indicate we need user input
      return { 
        reflection,
        needsUserFeedback: true,
        userQuestion
      };
    }
    
    return { reflection };
  }
});
