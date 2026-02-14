import fs from "node:fs/promises";
import path from "node:path";

/**
 * Save a plan to a markdown file in the current directory.
 * Plans are named based on a short description and stored with a timestamp.
 */
export async function savePlan(description, planContent) {
  // Create a safe filename from the description
  const safeDescription = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  
  const timestamp = Date.now();
  const filename = `PLAN-${safeDescription}-${timestamp}.md`;
  const filepath = path.join(process.cwd(), filename);
  
  // Write the plan file
  await fs.writeFile(filepath, planContent, "utf-8");
  
  return { filename, filepath, success: true };
}

/**
 * Save plan progress tracking info to .smol-agent/state/plan-progress.json
 */
export async function savePlanProgress(planFilename, stepIndex, status, details = {}) {
  const stateDir = ".smol-agent/state";
  
  try {
    await fs.mkdir(stateDir, { recursive: true });
  } catch {
    // Directory already exists or can't be created
  }
  
  const progressFile = path.join(stateDir, "plan-progress.json");
  
  let progressData = {};
  try {
    const existing = await fs.readFile(progressFile, "utf-8");
    progressData = JSON.parse(existing);
  } catch {
    // File doesn't exist yet
  }
  
  progressData[planFilename] = {
    planFilename,
    currentStep: stepIndex,
    status, // "in-progress", "completed", "paused", "abandoned"
    details,
    updatedAt: Date.now(),
  };
  
  await fs.writeFile(progressFile, JSON.stringify(progressData, null, 2), "utf-8");
  
  return { success: true, planFilename, stepIndex };
}

/**
 * Load current plan progress
 */
export async function loadPlanProgress() {
  const progressFile = path.join(".smol-agent/state", "plan-progress.json");
  
  try {
    const content = await fs.readFile(progressFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Get the current plan filename (if any)
 */
export async function getCurrentPlan() {
  const progress = await loadPlanProgress();
  const filenames = Object.keys(progress);
  
  // Find the most recent in-progress plan
  for (const filename of filenames) {
    if (progress[filename].status === "in-progress") {
      return {
        filename,
        details: progress[filename],
      };
    }
  }
  
  // If no in-progress, return the most recent any
  if (filenames.length > 0) {
    const mostRecent = filenames.sort((a, b) => 
      progress[b].updatedAt - progress[a].updatedAt
    )[0];
    
    return {
      filename: mostRecent,
      details: progress[mostRecent],
    };
  }
  
  return null;
}

/**
 * Mark a plan as completed
 */
export async function markPlanCompleted(planFilename) {
  return savePlanProgress(planFilename, -1, "completed", {
    message: "Plan execution completed",
  });
}

/**
 * Update plan status
 */
export async function updatePlanStatus(planFilename, status, details = {}) {
  const progress = await loadPlanProgress();
  
  if (!progress[planFilename]) {
    return { success: false, error: "Plan not found" };
  }
  
  progress[planFilename].status = status;
  progress[planFilename].details = { ...progress[planFilename].details, ...details };
  progress[planFilename].updatedAt = Date.now();
  
  const progressFile = path.join(".smol-agent/state", "plan-progress.json");
  await fs.writeFile(progressFile, JSON.stringify(progress, null, 2), "utf-8");
  
  return { success: true, planFilename, status };
}
