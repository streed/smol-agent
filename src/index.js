#!/usr/bin/env node

import { Agent } from "./agent.js";
import { startApp } from "./ui/App.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadSettings } from "./settings.js";
import { cleanup as cleanupTiktoken } from "./token-estimator.js";
import { execSync } from "node:child_process";

// XDG-compliant global config directory
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const GLOBAL_CONFIG_DIR = path.join(XDG_CONFIG_HOME, "smol-agent");

// Free tiktoken WASM resources on exit
process.on("exit", () => { cleanupTiktoken().catch(() => {}); });

// ── Self-update ────────────────────────────────────────────────────────

function getInstallInfo() {
  const markerPath = path.join(GLOBAL_CONFIG_DIR, "install-info");
  if (!fs.existsSync(markerPath)) {
    return null;
  }
  const content = fs.readFileSync(markerPath, "utf-8");
  const info = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^([^=]+)=(.+)$/);
    if (match) {
      info[match[1]] = match[2];
    }
  }
  return info;
}

function runSelfUpdate() {
  const installInfo = getInstallInfo();
  
  if (!installInfo) {
    console.log("smol-agent was not installed via the installer script.");
    console.log("To update, pull the latest changes in your cloned repository:");
    console.log("  git pull && npm install");
    process.exit(1);
  }
  
  const installDir = installInfo.INSTALL_DIR;
  const installType = installInfo.INSTALL_TYPE;
  
  if (!installDir || !fs.existsSync(installDir)) {
    console.error("Could not find installation directory.");
    console.log("You may need to reinstall:");
    console.log("  curl -fsSL https://raw.githubusercontent.com/streed/smol-agent/main/install.sh | sh");
    process.exit(1);
  }
  
  console.log(`Updating smol-agent (installed via ${installType})...`);
  console.log(`Installation directory: ${installDir}`);
  
  try {
    process.chdir(installDir);
    
    // Fetch latest changes
    console.log("Fetching latest version...");
    execSync("git fetch origin", { stdio: "inherit" });
    
    // Check if we're behind
    const localCommit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    const remoteCommit = execSync("git rev-parse origin/main", { encoding: "utf-8" }).trim();
    
    if (localCommit === remoteCommit) {
      console.log("Already up to date!");
      process.exit(0);
    }
    
    // Pull and reinstall
    console.log("Pulling latest changes...");
    execSync("git pull --force origin main", { stdio: "inherit" });
    
    console.log("Reinstalling dependencies...");
    execSync("npm install", { stdio: "inherit" });
    
    // Re-link
    console.log("Re-linking globally...");
    execSync("npm link", { stdio: "inherit" });
    
    // Update marker with new timestamp
    const markerPath = path.join(GLOBAL_CONFIG_DIR, "install-info");
    const markerContent = fs.readFileSync(markerPath, "utf-8");
    const updatedMarker = markerContent.replace(
      /INSTALLED_AT=.*/,
      `INSTALLED_AT=${new Date().toISOString()}`
    );
    fs.writeFileSync(markerPath, updatedMarker);
    
    console.log("\n✓ smol-agent updated successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Update failed:", error.message);
    console.log("You can manually update by running:");
    console.log(`  cd ${installDir} && git pull && npm install`);
    process.exit(1);
  }
}

// ── CLI argument parsing ─────────────────────────────────────────────
const args = process.argv.slice(2);
let host = undefined;
let model = undefined;

let promptText = undefined;
let jailDirectory = process.cwd();
let allTools = undefined; // undefined = auto-detect from model size
let autoApprove = false;
let autoApproveWrites = false;
let autoApproveExecute = false;
let acpMode = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if ((a === "--host" || a === "-H") && args[i + 1]) {
    host = args[++i];
  } else if ((a === "--model" || a === "-m") && args[i + 1]) {
    model = args[++i];

  } else if ((a === "--directory" || a === "-d") && args[i + 1]) {
    jailDirectory = path.resolve(args[++i]);
    if (!fs.existsSync(jailDirectory) || !fs.statSync(jailDirectory).isDirectory()) {
      console.error(`Error: Directory '${jailDirectory}' does not exist or is not a directory`);
      process.exit(1);
    }
  } else if (a === "--all-tools") {
    allTools = true;
  } else if (a === "--auto-approve" || a === "--yolo") {
    autoApprove = true;
  } else if (a === "--approve-writes") {
    autoApproveWrites = true;
  } else if (a === "--approve-execute") {
    autoApproveExecute = true;
  } else if (a === "--acp") {
    acpMode = true;
  } else if (a === "--self-update") {
    runSelfUpdate();
  } else if (a === "--help") {
    printUsage();
    process.exit(0);
  } else if (!a.startsWith("-")) {
    promptText = args.slice(i).join(" ");
    break;
  }
}

function printUsage() {
  console.log(`smol-agent — a small coding agent powered by Ollama

Usage:
  smol-agent [options] [prompt]

Options:
  -m, --model <name>        Ollama model to use (default: qwen3.5:27b)
  -H, --host <url>          Ollama server URL (default: http://127.0.0.1:11434)

  -d, --directory <path>    Set working directory and jail boundary (default: cwd)
      --all-tools           Expose all tools (auto-detected for 30B+ models)
      --auto-approve        Skip approval prompts for write/command tools (alias: --yolo)
      --approve-writes      Auto-approve file write operations (but still prompt for commands)
      --approve-execute     Auto-approve shell command execution (but still prompt for writes)
      --acp                 Run as ACP (Agent Client Protocol) server over stdio
      --self-update         Update smol-agent to the latest version
      --help                Show this help message

Interactive Commands:
  /clear             Clear conversation history
  /inspect           Dump current context to CONTEXT.md
  Ctrl+C             Cancel current operation (double-tap to exit)
  exit / quit        Exit the agent

Examples:
  smol-agent "add error handling to src/index.js"
  smol-agent -m codellama "refactor the auth module"
  smol-agent -d ./my-project "add a new feature"
  smol-agent                                         # interactive mode`);
}

// ── Boot ─────────────────────────────────────────────────────────────

// Auto-detect: expose all tools for 30B+ models, core-only for smaller ones.
function shouldUseCoreOnly(modelName) {
  if (allTools === true) return false;
  if (!modelName) return true; // default to core-only
  // Extract parameter count from model name (e.g. "qwen2.5-coder:32b" → 32)
  const sizeMatch = modelName.match(/(\d+)[bB]/);
  if (sizeMatch) {
    const params = parseInt(sizeMatch[1]);
    return params < 30;
  }
  return true; // unknown size → be conservative
}

const coreToolsOnly = shouldUseCoreOnly(model);

// ── ACP mode ──────────────────────────────────────────────────────────
if (acpMode) {
  const { startACPServer } = await import("./acp-server.js");
  startACPServer({
    host,
    model,

    coreToolsOnly,
    autoApprove,
  });
} else {
  // ── TUI mode ────────────────────────────────────────────────────────
  const agent = new Agent({ host, model, jailDirectory, coreToolsOnly });

  // Load persisted settings, CLI flags override
  const settings = await loadSettings(jailDirectory);
  if (autoApprove || settings.autoApprove) {
    agent._approveAll = true;
  }

  // Granular auto-approve categories
  if (autoApproveWrites) agent.approveCategory("write");
  if (autoApproveExecute) agent.approveCategory("execute");

  startApp(agent, promptText);
}
