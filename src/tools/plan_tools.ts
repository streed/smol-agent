/**
 * Planning tools for structured task execution.
 *
 * Implements a two-phase workflow:
 *   1. Planning phase: Agent creates a detailed markdown plan
 *   2. Execution phase: Agent executes steps one at a time
 *
 * Tools:
 *   - save_plan: Save a plan to markdown file
 *   - load_plan_progress: Load the current plan and progress
 *   - get_current_plan: Get the content of the active plan
 *   - complete_plan_step: Mark a step as completed
 *   - update_plan_status: Update plan status (in-progress, completed, paused, abandoned)
 *
 * Plan files are stored in .smol-agent/plans/ with progress tracked in
 * .smol-agent/state/plan-progress.json
 *
 * Key exports:
 *   - Tool registrations: save_plan, load_plan_progress, get_current_plan,
 *                         complete_plan_step, update_plan_status
 *
 * @file-doc
 * @module tools/plan_tools
 * @dependencies ./registry.js, ./save_plan.js, node:fs/promises
 * @dependents src/agent.js, src/tools/registry.js
 */
import { register } from "./registry.js";
import { savePlan, savePlanProgress, loadPlanProgress, getCurrentPlan, updatePlanStatus } from "./save_plan.js";
import type { PlanProgressData } from "./save_plan.js";

interface SavePlanArgs {
  description: string;
  planContent: string;
}

interface SavePlanResult {
  success?: boolean;
  filename?: string;
  filepath?: string;
  message?: string;
  error?: string;
}

interface LoadPlanProgressResult {
  plans?: Array<{
    filename: string;
    status: string;
    currentStep: number;
    totalSteps: number;
    description: string;
    updatedAt: string;
  }>;
  active?: {
    filename: string;
    status: string;
    currentStep: number;
    totalSteps: number;
    description: string;
  };
  error?: string;
}

interface GetCurrentPlanResult {
  content?: string;
  filename?: string;
  status?: string;
  currentStep?: number;
  totalSteps?: number;
  description?: string;
  error?: string;
}

interface CompleteStepArgs {
  stepNumber: number;
  stepDescription: string;
}

interface CompleteStepResult {
  success?: boolean;
  message?: string;
  nextStep?: number;
  totalSteps?: number;
  isComplete?: boolean;
  error?: string;
}

interface UpdateStatusArgs {
  status: "in-progress" | "completed" | "paused" | "abandoned";
  message?: string;
}

interface UpdateStatusResult {
  success?: boolean;
  message?: string;
  error?: string;
}

// ── save_plan ──────────────────────────────────────────────────────

async function executeSavePlan(
  { description, planContent }: SavePlanArgs,
  { cwd = process.cwd() } = {}
): Promise<SavePlanResult> {
  if (!description || !planContent) {
    return {
      error: "Missing required parameters: 'description' and 'planContent' are required",
    };
  }

  try {
    const { filename, filepath } = await savePlan(description, planContent, cwd);

    // Initialize plan progress tracking
    await savePlanProgress(filename, 0, "pending", {
      totalSteps: 0,
      description,
      filepath,
    }, cwd);

    return {
      success: true,
      filename,
      filepath,
      message: `Plan saved to ${filename}. Ready for review and approval.`,
    };
  } catch (err: unknown) {
    const error = err as Error;
    return { error: `Failed to save plan: ${error.message}` };
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
        description: "The full markdown content of the plan including all steps, files to modify, and code snippets",
      },
    },
  },
  execute: executeSavePlan,
});

// ── load_plan_progress ─────────────────────────────────────────────

async function executeLoadPlanProgress(
  _args: Record<string, never>,
  { cwd = process.cwd() } = {}
): Promise<LoadPlanProgressResult> {
  try {
    const progress = await loadPlanProgress(cwd);

    const filenames = Object.keys(progress).filter(k => k !== "activePlan" && k !== "plans");
    if (filenames.length === 0) {
      return { plans: [], active: undefined };
    }

    const plans = filenames.map(fn => {
      const entry = progress[fn];
      return {
        filename: fn,
        status: entry.status,
        currentStep: entry.currentStep,
        totalSteps: entry.details?.totalSteps || 0,
        description: entry.details?.description || "",
        updatedAt: new Date(entry.updatedAt).toISOString(),
      };
    });

    const activeFilename = (progress as PlanProgressData & { activePlan?: string }).activePlan;
    const activePlan = activeFilename ? plans.find(p => p.filename === activeFilename) : undefined;

    return { plans, active: activePlan };
  } catch (err: unknown) {
    const error = err as Error;
    return { error: `Failed to load plan progress: ${error.message}` };
  }
}

register("load_plan_progress", {
  description: "Load the current plan progress and state. Returns all saved plans and identifies the currently active plan if one exists.",
  parameters: {
    type: "object",
    properties: {},
  },
  execute: executeLoadPlanProgress,
});

// ── get_current_plan ───────────────────────────────────────────────

async function executeGetCurrentPlan(
  _args: Record<string, never>,
  { cwd = process.cwd() } = {}
): Promise<GetCurrentPlanResult> {
  try {
    const plan = await getCurrentPlan(cwd);

    if (!plan) {
      return { content: "", error: "No active plan found" };
    }

    return {
      content: plan.content,
      filename: plan.filename,
      status: plan.status,
      currentStep: plan.currentStep,
      totalSteps: plan.totalSteps,
      description: plan.description,
    };
  } catch (err: unknown) {
    const error = err as Error;
    return { error: `Failed to get current plan: ${error.message}` };
  }
}

register("get_current_plan", {
  description: "Get the content of the currently active plan. Returns the full markdown content of the plan if one is in progress.",
  parameters: {
    type: "object",
    properties: {},
  },
  execute: executeGetCurrentPlan,
});

// ── complete_plan_step ─────────────────────────────────────────────

async function executeCompleteStep(
  { stepNumber, stepDescription }: CompleteStepArgs,
  { cwd = process.cwd() } = {}
): Promise<CompleteStepResult> {
  try {
    const progress = await loadPlanProgress(cwd);
    const filenames = Object.keys(progress).filter(k => k !== "activePlan" && k !== "plans");
    const activeFilename = (progress as PlanProgressData & { activePlan?: string }).activePlan;

    if (!activeFilename) {
      return { error: "No active plan found" };
    }

    const activePlan = progress[activeFilename];
    if (!activePlan) {
      return { error: "Active plan not found in progress" };
    }

    // Update the step
    activePlan.currentStep = stepNumber;
    activePlan.updatedAt = Date.now();

    // Check if complete
    const isComplete = stepNumber >= (activePlan.details?.totalSteps || 0);
    if (isComplete) {
      activePlan.status = "completed";
    }

    await savePlanProgress(activeFilename, stepNumber, activePlan.status, activePlan.details || {}, cwd);

    return {
      success: true,
      message: `Step ${stepNumber} completed: ${stepDescription}`,
      nextStep: stepNumber + 1,
      totalSteps: activePlan.details?.totalSteps || 0,
      isComplete,
    };
  } catch (err: unknown) {
    const error = err as Error;
    return { error: `Failed to complete step: ${error.message}` };
  }
}

register("complete_plan_step", {
  description: "Mark a plan step as completed. Call this after successfully implementing a step from the plan. Provides progress tracking and helps the agent stay on track.",
  parameters: {
    type: "object",
    required: ["stepNumber", "stepDescription"],
    properties: {
      stepNumber: {
        type: "number",
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

// ── update_plan_status ──────────────────────────────────────────────

async function executeUpdateStatus(
  { status, message }: UpdateStatusArgs,
  { cwd = process.cwd() } = {}
): Promise<UpdateStatusResult> {
  try {
    await updatePlanStatus(status, message ? { message } : {}, cwd);
    return {
      success: true,
      message: `Plan status updated to: ${status}${message ? ` (${message})` : ""}`,
    };
  } catch (err: unknown) {
    const error = err as Error;
    return { error: `Failed to update plan status: ${error.message}` };
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
        description: "New status for the plan",
        enum: ["in-progress", "completed", "paused", "abandoned"],
      },
      message: {
        type: "string",
        description: "Optional message explaining the status change",
      },
    },
  },
  execute: executeUpdateStatus,
});