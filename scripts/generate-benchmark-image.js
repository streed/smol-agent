#!/usr/bin/env node

/**
 * Generate a benchmark results image from GitHub Actions data.
 * 
 * Usage:
 *   node scripts/generate-benchmark-image.js
 * 
 * Output: docs/benchmark-results.svg
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fetch latest benchmark run results
async function fetchBenchmarkResults() {
  // Get all recent runs
  const runsRes = await fetch(
    `https://api.github.com/repos/streed/smol-agent/actions/runs?per_page=30`
  );
  const runs = await runsRes.json();
  
  // Find the latest completed run with multiple model tests
  // Try: look for named "Model Benchmark" workflow run (success or failure)
  let latestRun = runs.workflow_runs.find(r => 
    (r.conclusion === "success" || r.conclusion === "failure") && 
    r.head_branch === "main" &&
    r.name === "Model Benchmark"
  );
  
  // Fallback: find any completed run (success or failure) with multiple test jobs
  if (!latestRun) {
    console.log("Looking for benchmark run with test jobs...");
    for (const r of runs.workflow_runs) {
      if ((r.conclusion === "success" || r.conclusion === "failure") && r.head_branch === "main") {
        const jobsRes = await fetch(
          `https://api.github.com/repos/streed/smol-agent/actions/runs/${r.id}/jobs`
        );
        const jobs = await jobsRes.json();
        const testJobs = jobs.jobs.filter(j => j.name.startsWith("Test "));
        if (testJobs.length > 1) {
          console.log(`Found run #${r.run_number} with ${testJobs.length} test jobs`);
          const modelTests = testJobs.map(job => ({
            name: job.name.replace("Test ", "").replace(/:cloud$/, ""),
            status: job.conclusion === "success" ? "pass" : "fail",
          }));
          return {
            runNumber: r.run_number,
            date: r.created_at,
            sha: r.head_sha.substring(0, 7),
            conclusion: r.conclusion,
            models: modelTests,
          };
        }
      }
    }
    console.error("No benchmark run with model tests found");
    process.exit(1);
  }
  
  // Get jobs for this run
  const jobsRes = await fetch(
    `https://api.github.com/repos/streed/smol-agent/actions/runs/${latestRun.id}/jobs`
  );
  const jobs = await jobsRes.json();
  
  // Extract model results - filter out "Aggregate Results" and look for test jobs
  const modelTests = jobs.jobs
    .filter(job => job.name.startsWith("Test "))
    .map(job => ({
      name: job.name.replace("Test ", "").replace(/:cloud$/, ""),
      status: job.conclusion === "success" ? "pass" : "fail",
    }));

  return {
    runNumber: latestRun.run_number,
    date: latestRun.created_at,
    sha: latestRun.head_sha.substring(0, 7),
    conclusion: latestRun.conclusion,
    models: modelTests,
  };
}

// Generate SVG from results
function generateSVG(results) {
  const padding = 40;
  const rowHeight = 50;
  const barMaxWidth = 300;
  const nameWidth = 180;
  const statusWidth = 80;
  
  const svgHeight = padding * 2 + results.models.length * rowHeight + 60;
  const svgWidth = padding * 2 + nameWidth + barMaxWidth + statusWidth + 20;
  
  const dateStr = new Date(results.date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  
  // Determine overall status
  const hasFailures = results.models.some(m => m.status === "fail");
  const overallStatus = results.conclusion === "failure" || hasFailures ? "failed" : "passed";
  const statusEmoji = overallStatus === "passed" ? "✅" : "❌";
  
  let rows = results.models.map((model, i) => {
    const y = padding + 80 + i * rowHeight;
    const passRate = model.status === "pass" ? "100%" : "0%";
    const barWidth = model.status === "pass" ? barMaxWidth : barMaxWidth * 0.3;
    const barColor = model.status === "pass" ? "#22c55e" : "#ef4444";
    const statusColor = model.status === "pass" ? "#166534" : "#991b1b";
    const statusBg = model.status === "pass" ? "#dcfce7" : "#fee2e2";
    
    return `
    <g transform="translate(0, ${y})">
      <!-- Model name -->
      <text x="${padding}" y="20" class="model-name" fill="#1f2937">${model.name}</text>
      
      <!-- Progress bar background -->
      <rect x="${padding + nameWidth}" y="5" width="${barMaxWidth}" height="16" rx="4" fill="#e5e7eb"/>
      
      <!-- Progress bar fill -->
      <rect x="${padding + nameWidth}" y="5" width="${barWidth}" height="16" rx="4" fill="${barColor}"/>
      
      <!-- Percentage -->
      <text x="${padding + nameWidth + barMaxWidth + 15}" y="20" class="score" fill="${statusColor}">${passRate}</text>
      
      <!-- Status badge -->
      <rect x="${svgWidth - padding - statusWidth}" y="0" width="${statusWidth}" height="24" rx="4" fill="${statusBg}"/>
      <text x="${svgWidth - padding - statusWidth + 12}" y="17" class="status" fill="${statusColor}">${model.status.toUpperCase()}</text>
    </g>`;
  }).join("");
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <style>
    .title { font: bold 24px sans-serif; fill: #111827; }
    .subtitle { font: 14px sans-serif; fill: #6b7280; }
    .model-name { font: 500 14px sans-serif; }
    .score { font: bold 14px sans-serif; }
    .status { font: bold 11px sans-serif; }
  </style>
  
  <!-- Background -->
  <rect width="100%" height="100%" fill="white"/>
  
  <!-- Header -->
  <text x="${padding}" y="35" class="title">${statusEmoji} Model Benchmark Results</text>
  <text x="${padding}" y="55" class="subtitle">Run #${results.runNumber} • ${dateStr} • ${results.sha} • ${overallStatus.toUpperCase()}</text>
  
  <!-- Legend -->
  <g transform="translate(${padding}, ${padding + 65})">
    <rect width="12" height="12" rx="2" fill="#22c55e"/>
    <text x="18" y="10" font="12px sans-serif" fill="#374151">Pass</text>
    <rect x="50" width="12" height="12" rx="2" fill="#ef4444"/>
    <text x="68" y="10" font="12px sans-serif" fill="#374151">Fail</text>
  </g>
  
  <!-- Column headers -->
  <g transform="translate(0, ${padding + 80})">
    <text x="${padding}" y="0" font="bold 12px sans-serif" fill="#6b7280">MODEL</text>
    <text x="${padding + nameWidth}" y="0" font="bold 12px sans-serif" fill="#6b7280">RESULT</text>
  </g>
  
  <!-- Divider -->
  <line x1="${padding}" y1="${padding + 95}" x2="${svgWidth - padding}" y2="${padding + 95}" stroke="#e5e7eb" stroke-width="1"/>
  
  ${rows}
</svg>`;
}

async function main() {
  console.log("Fetching benchmark results from GitHub Actions...");
  
  const results = await fetchBenchmarkResults();
  
  console.log(`Found results for ${results.models.length} models:`);
  results.models.forEach(m => console.log(`  - ${m.name}: ${m.status}`));
  
  // Check if any model failed
  const failedModels = results.models.filter(m => m.status === "fail");
  const hasFailures = failedModels.length > 0;
  
  if (hasFailures) {
    console.error(`\n⚠️  ${failedModels.length} model(s) failed:`);
    failedModels.forEach(m => console.error(`  - ${m.name}`));
  }
  
  // Generate SVG
  const svg = generateSVG(results);
  
  // Write to docs directory
  const outputPath = path.join(__dirname, "..", "docs", "benchmark-results.svg");
  
  // Ensure docs directory exists
  const docsDir = path.dirname(outputPath);
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  
  fs.writeFileSync(outputPath, svg);
  console.log(`\n✓ Generated: ${outputPath}`);
  
  // Exit with non-zero code if there are failures
  if (hasFailures) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
