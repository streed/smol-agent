/**
 * Plan persistence utilities for the planning tools.
 *
 * Saves plans to markdown files and tracks progress in a JSON state file.
 * Plans are stored in the project root as PLAN-{slug}-{timestamp}.md
 * Progress is tracked in .smol-agent/state/plan-progress.json
 *
 * Key exports:
 *   - savePlan(description, content, cwd): Create a plan file
 *   - savePlanProgress(filename, step, status, details, cwd): Update progress
 *   - loadPlanProgress(cwd): Load all plan progress
 *   - getCurrentPlan(cwd): Get the currently active plan
 *   - markPlanCompleted(filename, cwd): Mark a plan as done
 *   - updatePlanStatus(filename, status, cwd): Change plan status
 *
 * @file-doc
 * @module tools/save_plan
 * @dependencies node:fs/promises, node:path, ../path-utils.js
 * @dependents src/acp-server.js, src/agent.js, src/tools/plan_tools.js,
 *             src/tools/registry.js, test/e2e/scenarios/51-plan-tool.test.js,
 *             test/e2e/scenarios/53-progressive-discovery.test.js
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveJailedPath } from "../path-utils.js";

const STATE_DIR = ".smol-agent/state";
const PROGRESS_FILE = "plan-progress.json";

export interface PlanDetails {
  totalSteps?: number;
  description?: string;
  filepath?: string;
  message?: string;
}

export interface PlanProgressEntry {
  currentStep: number;
  status: string;
  details: PlanDetails;
  updatedAt: number;
}

export interface PlanProgressData {
  [filename: string]: PlanProgressEntry;
}

export interface PlanProgress {
  activePlan?: string;
  plans?: Array<{
    filename: string;
    status: string;
    currentStep: number;
    totalSteps: number;
    description?: string;
    filepath?: string;
    updatedAt: string;
  }>;
}

export interface CurrentPlan {
  filename: string;
  content?: string;
  status: string;
  currentStep: number;
  totalSteps: number;
  description?: string;
  filepath?: string;
}

/**
 * Ensure the state directory exists within the jail
 */
async function ensureStateDir(cwd: string): Promise<string> {
  const statePath = resolveJailedPath(cwd, STATE_DIR);
  await fs.mkdir(statePath, { recursive: true });
  return statePath;
}

/**
 * Save a plan to a markdown file within the jail directory
 */
export async function savePlan(
  description: string,
  planContent: string,
  cwd: string = process.cwd()
): Promise<{ filename: string; filepath: string }> {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `PLAN-${slug}-${Date.now()}.md`;
  const filepath = resolveJailedPath(cwd, filename);

  await fs.writeFile(filepath, planContent, "utf-8");

  return { filename, filepath };
}

/**
 * Save/update plan progress tracking
 */
export async function savePlanProgress(
  filename: string,
  currentStep: number,
  status: string,
  details: PlanDetails = {},
  cwd: string = process.cwd()
): Promise<PlanProgressEntry> {
  const statePath = await ensureStateDir(cwd);
  const progressFile = path.join(statePath, PROGRESS_FILE);
  const progress = await loadPlanProgress(cwd);

  progress[filename] = {
    ...(progress[filename] || {}),
    currentStep,
    status,
    details: { ...(progress[filename]?.details || {}), ...details },
    updatedAt: Date.now(),
  };

  await fs.writeFile(progressFile, JSON.stringify(progress, null, 2), "utf-8");
  return progress[filename];
}

/**
 * Load plan progress from file
 */
export async function loadPlanProgress(cwd: string = process.cwd()): Promise<PlanProgressData> {
  try {
    const statePath = resolveJailedPath(cwd, STATE_DIR);
    const progressFile = path.join(statePath, PROGRESS_FILE);
    const content = await fs.readFile(progressFile, "utf-8");
    return JSON.parse(content) as PlanProgressData;
  } catch {
    return {};
  }
}

/**
 * Get the current active plan
 */
export async function getCurrentPlan(cwd: string = process.cwd()): Promise<CurrentPlan | null> {
  const progress = await loadPlanProgress(cwd);
  const filenames = Object.keys(progress).filter(k => k !== "activePlan" && k !== "plans");

  for (const filename of filenames) {
    const entry = progress[filename];
    const status = entry?.status;
    if (status === "in-progress" || status === "pending") {
      // Read the plan content
      try {
        const filepath = entry.details?.filepath || resolveJailedPath(cwd, filename);
        const content = await fs.readFile(filepath, "utf-8");
        return {
          filename,
          content,
          status: entry.status,
          currentStep: entry.currentStep,
          totalSteps: entry.details?.totalSteps || 0,
          description: entry.details?.description,
          filepath: entry.details?.filepath,
        };
      } catch {
        return {
          filename,
          status: entry.status,
          currentStep: entry.currentStep,
          totalSteps: entry.details?.totalSteps || 0,
          description: entry.details?.description,
        };
      }
    }
  }

  if (filenames.length > 0) {
    const mostRecent = filenames.sort(
      (a, b) => (progress[b]?.updatedAt || 0) - (progress[a]?.updatedAt || 0)
    )[0];
    const entry = progress[mostRecent];
    try {
      const filepath = entry.details?.filepath || resolveJailedPath(cwd, mostRecent);
      const content = await fs.readFile(filepath, "utf-8");
      return {
        filename: mostRecent,
        content,
        status: entry.status,
        currentStep: entry.currentStep,
        totalSteps: entry.details?.totalSteps || 0,
        description: entry.details?.description,
      };
    } catch {
      return {
        filename: mostRecent,
        status: entry.status,
        currentStep: entry.currentStep,
        totalSteps: entry.details?.totalSteps || 0,
        description: entry.details?.description,
      };
    }
  }

  return null;
}

/**
 * Mark a plan as completed
 */
export async function markPlanCompleted(
  filename: string,
  message: string,
  cwd: string = process.cwd()
): Promise<{ success: boolean; planFilename?: string; status?: string; error?: string }> {
  return updatePlanStatusByFilename(filename, "completed", { message }, cwd);
}

/**
 * Update plan status (exported for tools - updates current active plan)
 */
export async function updatePlanStatus(
  status: string,
  details: PlanDetails = {},
  cwd: string = process.cwd()
): Promise<{ success: boolean; planFilename?: string; status?: string; error?: string }> {
  const currentPlan = await getCurrentPlan(cwd);
  if (!currentPlan) {
    return { success: false, error: "No active plan found" };
  }
  return updatePlanStatusByFilename(currentPlan.filename, status, details, cwd);
}

/**
 * Update plan status by filename (internal)
 */
async function updatePlanStatusByFilename(
  planFilename: string,
  status: string,
  details: PlanDetails = {},
  cwd: string = process.cwd()
): Promise<{ success: boolean; planFilename?: string; status?: string; error?: string }> {
  const statePath = await ensureStateDir(cwd);
  const progressFile = path.join(statePath, PROGRESS_FILE);
  const progress = await loadPlanProgress(cwd);

  if (!progress[planFilename]) {
    return { success: false, error: "Plan not found" };
  }

  progress[planFilename].status = status;
  progress[planFilename].details = {
    ...(progress[planFilename].details || {}),
    ...details,
  };
  progress[planFilename].updatedAt = Date.now();

  await fs.writeFile(progressFile, JSON.stringify(progress, null, 2), "utf-8");
  return { success: true, planFilename, status };
}