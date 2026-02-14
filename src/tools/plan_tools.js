import { register } from "./registry.js";
import { savePlan, savePlanProgress, loadPlanProgress, getCurrentPlan, markPlanCompleted, updatePlanStatus } from "./save_plan.js";

/**
 * Save a plan to a markdown file and track progress.
 * 
 * This tool is used during the pre-plan phase to save a detailed plan
 * that will be executed later in coding mode.
 * 
 * @param {string} description - A short description for the plan filename
 * @param {string} planContent - The full markdown content of the plan
 */
async function execute({ description, planContent }) {
  if (!description || !planContent) {
    return {
      error: "Missing required parameters: 'description' and 'planContent' are required",
    };
  }
  
  try {
    const { filename, filepath } = await savePlan(description, planContent);
    
    // Initialize plan progress tracking
    await savePlanProgress(filename, 0, "pending", {
      totalSteps: 0,
      description,
      filepath,
    });
    
    return {
      success: true,
      filename,
      filepath,
      message: `Plan saved to ${filename}. Ready for review and approval.`,
    };
  } catch (err) {
    return { error: `Failed to save plan: ${err.message}` };
  }
}

register("save_plan", {
  description: `Save a plan to a markdown file and track progress. This tool is used during the pre-plan phase to save a detailed plan that will be executed later in coding mode.
  
Arguments:
- description: A short description for the plan filename (e.g., "add-user-authentication")
- planContent: The full markdown content of the plan including all steps, files to modify, and code snippets

The plan should be structured as markdown with:
# Plan: [Title]
## Overview
## Files to Modify
## Implementation Steps
### Step 1: [Title]
[Description and code]
### Step 2: [Title]
[Description and code]
## Risks & Considerations
## Testing

Returns success/failure with filename and filepath.`,
  parameters: {
    type: "object",
    required: ["description", "planContent"],
    properties: {
      description: {
        type: "string",
        description: "A short, descriptive filename for the plan (use hyphens, no spaces)",
      },
      planContent: {
        type: "string",
        description: "Full markdown content of the plan",
      },
    },
  },
  execute,
});

/**
 * Load the current plan progress
 */
async function executeLoadProgress() {
  try {
    const progress = await loadPlanProgress();
    const current = await getCurrentPlan();
    
    return {
      success: true,
      progress,
      currentPlan: current,
    };
  } catch (err) {
    return { error: `Failed to load plan progress: ${err.message}` };
  }
}

register("load_plan_progress", {
  description: "Load the current plan progress and state. Returns all saved plans and identifies the currently active plan if one exists.",
  parameters: {
    type: "object",
    required: [],
    properties: {},
  },
  execute: executeLoadProgress,
});

/**
 * Get the current plan content from a saved file
 */
async function executeGetCurrentPlanContent() {
  try {
    const current = await getCurrentPlan();
    
    if (!current) {
      return {
        success: false,
        message: "No current plan found. Use save_plan first.",
      };
    }
    
    const filepath = current.details.filepath;
    const content = await import("node:fs/promises").then(({ readFile }) => readFile(filepath, "utf-8"));
    
    return {
      success: true,
      filename: current.filename,
      content,
    };
  } catch (err) {
    return { error: `Failed to get current plan content: ${err.message}` };
  }
}

register("get_current_plan", {
  description: "Get the content of the currently active plan. Returns the full markdown content of the plan if one is in progress.",
  parameters: {
    type: "object",
    required: [],
    properties: {},
  },
  execute: executeGetCurrentPlanContent,
});

/**
 * Mark a step as completed in the current plan
 */
async function executeCompleteStep(stepNumber, stepDescription) {
  try {
    const current = await getCurrentPlan();
    
    if (!current) {
      return {
        error: "No current plan found. Cannot complete step.",
      };
    }
    
    const newStep = stepNumber + 1;
    await savePlanProgress(current.filename, newStep, "in-progress", {
      ...current.details,
      lastCompletedStep: stepNumber,
      lastCompletedDescription: stepDescription,
    });
    
    return {
      success: true,
      currentStep: newStep,
      message: `Step ${stepNumber} completed: ${stepDescription}`,
    };
  } catch (err) {
    return { error: `Failed to mark step as completed: ${err.message}` };
  }
}

register("complete_plan_step", {
  description: "Mark a plan step as completed. Call this after successfully implementing a step from the plan. Provides progress tracking and helps the agent stay on track.",
  parameters: {
    type: "object",
    required: ["stepNumber", "stepDescription"],
    properties: {
      stepNumber: {
        type: "integer",
        description: "The step number that was completed (1-indexed)",
      },
      stepDescription: {
        type: "string",
        description: "Brief description of what was completed",
      },
    },
  },
  execute: executeCompleteStep,
});

/**
 * Update the current plan status
 */
async function executeUpdatePlanStatus(status, message) {
  try {
    const current = await getCurrentPlan();
    
    if (!current) {
      return {
        error: "No current plan found. Cannot update status.",
      };
    }
    
    const result = await updatePlanStatus(current.filename, status, {
      message,
    });
    
    return result;
  } catch (err) {
    return { error: `Failed to update plan status: ${err.message}` };
  }
}

register("update_plan_status", {
  description: "Update the status of the current plan. Useful for marking plans as paused, abandoned, or completed.",
  parameters: {
    type: "object",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["in-progress", "completed", "paused", "abandoned"],
        description: "New status for the plan",
      },
      message: {
        type: "string",
        description: "Optional message explaining the status change",
      },
    },
  },
  execute: executeUpdatePlanStatus,
});
