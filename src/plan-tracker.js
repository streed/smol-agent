import fs from "node:fs/promises";
import path from "node:path";
import { loadCachedRepoMap, getRepoMapSummary } from "./repo-map.js";

/**
 * Get the current plan filename and content if one exists
 */
export async function getCurrentPlan() {
  const progress = await loadPlanProgress();
  const filenames = Object.keys(progress);
  
  // Find the most recent in-progress or pending plan
  for (const filename of filenames) {
    const status = progress[filename].status;
    if (status === "in-progress" || status === "pending") {
      return {
        filename,
        details: progress[filename],
      };
    }
  }
  
  // If no active plan, return the most recent completed plan
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
 * Load plan progress from file
 */
async function loadPlanProgress() {
  const progressFile = path.join(".smol-agent/state", "plan-progress.json");
  
  try {
    const content = await fs.readFile(progressFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Get a plan summary for use in system prompt
 */
export async function getPlanSummary() {
  const current = await getCurrentPlan();
  
  if (!current) {
    return "";
  }
  
  try {
    const content = await fs.readFile(current.details.filepath, "utf-8");
    
    // Extract key sections for summary
    const lines = content.split("\n");
    const summaryLines = [];
    
    let inOverview = false;
    let inSteps = false;
    let stepCount = 0;
    
    for (const line of lines) {
      if (line.startsWith("# Plan:")) {
        summaryLines.push(`Current Plan: ${line.substring(7).trim()}`);
      } else if (line === "## Overview") {
        inOverview = true;
        inSteps = false;
      } else if (line === "## Files to Modify") {
        summaryLines.push("Files to modify: ");
        inOverview = false;
        inSteps = false;
      } else if (line === "## Implementation Steps") {
        inOverview = false;
        inSteps = true;
      } else if (line.startsWith("### Step")) {
        stepCount++;
        if (stepCount <= 3) {
          summaryLines.push(`- Step ${stepCount}: ${line.replace("### Step ", "").trim()}`);
        }
      } else if (line.startsWith("## ") && line !== "## Overview" && line !== "## Files to Modify" && line !== "## Implementation Steps" && line !== "## Risks & Considerations" && line !== "## Testing") {
        inOverview = false;
        inSteps = false;
      } else if (inOverview && line.trim() && !line.startsWith("###")) {
        summaryLines.push(line.trim());
      } else if (inSteps && stepCount >= 3) {
        break;
      }
    }
    
    // Add repo map info if available
    const cwd = process.cwd();
    const repoMap = loadCachedRepoMap(cwd);
    let repoMapSection = "";
    if (repoMap) {
      repoMapSection = "\n\n## Relevant Code Context\n\n" + getRepoMapSummary(repoMap, cwd);
    }
    
    return `## Active Plan

${summaryLines.join("\n")}

Plan file: ${current.filename}

You are executing this plan. Call complete_plan_step after each step is finished.${repoMapSection}`;
  } catch {
    return "";
  }
}

/**
 * Check if there's an active plan
 */
export async function hasActivePlan() {
  const current = await getCurrentPlan();
  return current !== null;
}
