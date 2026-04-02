#!/usr/bin/env node
/**
 * CLI entry point for smol-agent.
 *
 * Parses command-line arguments, initializes the LLM provider,
 * creates the Agent instance, and renders the terminal UI.
 *
 * CLI Options:
 *   -m, --model <name>       Model to use (default depends on provider)
 *   -p, --provider <name>    LLM provider: ollama, openai, anthropic, grok, groq, gemini
 *   -H, --host <url>         Provider host/base URL
 *   --api-key <key>          API key for cloud providers
 *   -d, --directory <path>   Working directory and jail boundary
 *   --auto-approve           Skip approval prompts (alias: --yolo)
 *   -s, --session <id>       Resume saved session
 *   -c, --continue           Resume most recent session
 *   --list-sessions          List all saved sessions
 *   --acp                    Run as ACP server over stdio
 *
 * Dependencies: ./agent.js, ./ui/App.js, node:path, node:fs, node:os,
 *               ./settings.js, ./sessions.js, ./token-estimator.js,
 *               node:child_process, ./acp-server.js, ./cross-agent.js
 * Depended on by: jest.config.js, scripts/update-benchmark-readme.js
 *                  src/agent.js (indirect), src/checkpoint.js,
 *                  src/context-manager.js, src/cross-agent.js, src/ollama.js,
 *                  src/providers/openai-compatible.js, src/repo-map.js, src/skills.js,
 *                  src/token-estimator.js, src/tools/code_execution.js,
 *                  src/tools/file_tools.js, src/tools/git.js, src/tools/plan_tools.js,
 *                  src/ui/App.js, src/ui/diff.js, test/e2e/compare-results.js,
 *                  test/e2e/runner.js, test/unit/*.test.js (extensive)
 *
 * @module index
 */

import { Agent } from "./agent.js";
import { startApp } from "./ui/App.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadSettings } from "./settings.js";
import { listSessions, findSession } from "./sessions.js";
import { cleanup as cleanupTiktoken } from "./token-estimator.js";
import { execSync } from "node:child_process";
import { createProvider } from "./providers/index.js";
import { gatherContext } from "./context.js";

// XDG-compliant global config directory
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const GLOBAL_CONFIG_DIR = path.join(XDG_CONFIG_HOME, "smol-agent");

// Free tiktoken WASM resources on exit
process.on("exit", () => { cleanupTiktoken().catch(() => {}); });

// ── Self-update ────────────────────────────────────────────────────────

interface InstallInfo {
  INSTALL_DIR?: string;
  INSTALL_TYPE?: string;
  INSTALLED_AT?: string;
}

function getInstallInfo(): InstallInfo | null {
  const markerPath = path.join(GLOBAL_CONFIG_DIR, "install-info");
  if (!fs.existsSync(markerPath)) {
    return null;
  }
  const content = fs.readFileSync(markerPath, "utf-8");
  const info: InstallInfo = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^([^=]+)=(.+)$/);
    if (match) {
      (info as Record<string, string>)[match[1]] = match[2];
    }
  }
  return info;
}

function runSelfUpdate(): void {
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
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Update failed:", err.message);
    console.log("You can manually update by running:");
    console.log(`  cd ${installDir} && git pull && npm install`);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`smol-agent — a small coding agent powered by local and cloud LLMs

Usage:
  smol-agent [options] [prompt]

Options:
  -m, --model <name>        Model to use (default depends on provider)
  -p, --provider <name>     LLM provider: ollama, openai, anthropic, grok (default: ollama)
  -H, --host <url>          Provider host/base URL (default: provider-specific)
      --api-key <key>       API key for cloud providers (or use env vars)

  -d, --directory <path>    Set working directory and jail boundary (default: cwd)
      --auto-approve        Skip approval prompts for write/command tools (alias: --yolo)
      --approve-writes      Auto-approve file write operations (but still prompt for commands)
      --approve-execute     Auto-approve shell command execution (but still prompt for writes)
      --programmatic-tools  Enable programmatic tool calling (Anthropic: server-side, others: client-side)
      --no-programmatic-tools  Disable programmatic tool calling
      --acp                 Run as ACP (Agent Client Protocol) server over stdio
      --review [branch]     Review changes on a branch (default: current branch) and exit
      --show-code-exec      Show internal tool calls made by code_execution tool
      --watch-inbox         Watch inbox for cross-agent letters and process them
      --progress-fd <n>    Write JSONL progress events to file descriptor n

  -s, --session <id>        Resume a saved session by ID or name
  -c, --continue            Resume the most recent session
      --list-sessions       List all saved sessions
      --session-name <name> Name for a new session (creates ~/.smol-agent/state/sessions/<name>.json)

      --self-update         Update smol-agent to the latest version
      --help                Show this help message

Providers:
  ollama (default)    Local LLMs via Ollama. Uses OLLAMA_HOST or http://localhost:11434
  openai              OpenAI GPT models. Uses OPENAI_API_KEY env var
  anthropic           Anthropic Claude models. Uses ANTHROPIC_API_KEY env var
  grok                xAI Grok models. Uses XAI_API_KEY env var
  groq                Groq-hosted models. Uses GROQ_API_KEY env var
  gemini              Google Gemini models. Uses GEMINI_API_KEY env var

Environment Variables:
  SMOL_AGENT_PROVIDER    Default provider (ollama, openai, anthropic, grok, groq, gemini)
  SMOL_AGENT_MODEL       Default model name
  SMOL_AGENT_HOST        Default host/base URL
  SMOL_AGENT_API_KEY     API key for cloud providers (alternative to --api-key)

Examples:
  smol-agent                      # Start interactive session
  smol-agent "fix the bug in src/index.js"   # One-shot prompt
  smol-agent -m llama3.2 "add tests"         # Use specific model
  smol-agent -d ./my-project "refactor"      # Work in specific directory
  smol-agent --session abc123                 # Resume session
  smol-agent --continue                       # Resume most recent session
`);
}

// ── CLI argument parsing ─────────────────────────────────────────────
const args = process.argv.slice(2);
let host: string | undefined = undefined;
let model: string | undefined = undefined;
let provider: string | undefined = undefined;       // --provider <name> (ollama, openai, anthropic, grok)
let apiKey: string | undefined = undefined;         // --api-key <key>

let promptText: string | undefined = undefined;
let jailDirectory = process.cwd();
// Note: All models now use the same tool set with progressive discovery
let autoApprove = false;
let autoApproveWrites = false;
let autoApproveExecute = false;
let acpMode = false;
let sessionId: string | undefined = undefined;      // --session <id> to resume
let listSessionsFlag = false;   // --list-sessions
let sessionName: string | undefined = undefined;    // --session-name <name> for new sessions
let continueSession = false;    // --continue to resume the most recent session
let watchInboxFlag = false;     // --watch-inbox to run inbox watcher
let reviewFlag = false;         // --review to run review mode
let reviewBranch: string | undefined = undefined;   // branch to review (optional arg after --review)
let progressFd: number | undefined = undefined;    // --progress-fd <n> to write JSONL progress events
let programmaticTools: boolean | undefined = undefined; // --programmatic-tools / --no-programmatic-tools
let showCodeExec = false;       // --show-code-exec to show internal code_execution tool calls

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if ((a === "--host" || a === "-H") && args[i + 1]) {
    host = args[++i];
  } else if ((a === "--model" || a === "-m") && args[i + 1]) {
    model = args[++i];
  } else if ((a === "--provider" || a === "-p") && args[i + 1]) {
    provider = args[++i];
  } else if (a === "--api-key" && args[i + 1]) {
    apiKey = args[++i];

  } else if ((a === "--directory" || a === "-d") && args[i + 1]) {
    jailDirectory = path.resolve(args[++i]);
    if (!fs.existsSync(jailDirectory) || !fs.statSync(jailDirectory).isDirectory()) {
      console.error(`Error: Directory '${jailDirectory}' does not exist or is not a directory`);
      process.exit(1);
    }
  } else if (a === "--auto-approve" || a === "--yolo") {
    autoApprove = true;
  } else if (a === "--approve-writes") {
    autoApproveWrites = true;
  } else if (a === "--approve-execute") {
    autoApproveExecute = true;
  } else if (a === "--acp") {
    acpMode = true;
  } else if ((a === "--session" || a === "-s") && args[i + 1]) {
    sessionId = args[++i];
  } else if (a === "--continue" || a === "-c") {
    continueSession = true;
  } else if (a === "--session-name" && args[i + 1]) {
    sessionName = args[++i];
  } else if (a === "--list-sessions" || a === "--sessions") {
    listSessionsFlag = true;
  } else if (a === "--watch-inbox") {
    watchInboxFlag = true;
  } else if (a === "--review") {
    reviewFlag = true;
    // Next arg is the branch name if it doesn't start with -
    if (args[i + 1] && !args[i + 1].startsWith("-")) {
      reviewBranch = args[++i];
    }
  } else if (a === "--progress-fd" && args[i + 1]) {
    progressFd = parseInt(args[++i], 10);
    if (!Number.isFinite(progressFd) || progressFd < 0) {
      console.error("Error: --progress-fd must be a non-negative integer");
      process.exit(1);
    }
  } else if (a === "--programmatic-tools") {
    programmaticTools = true;
  } else if (a === "--no-programmatic-tools") {
    programmaticTools = false;
  } else if (a === "--show-code-exec") {
    showCodeExec = true;
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

// Support API key via env var (used by cross-agent spawning to avoid
// exposing keys in process listings)
if (!apiKey && process.env.SMOL_AGENT_API_KEY) {
  apiKey = process.env.SMOL_AGENT_API_KEY;
}

// ── Main entry point ───────────────────────────────────────────────────

async function main(): Promise<void> {
  // Handle --list-sessions
  if (listSessionsFlag) {
    const sessions = await listSessions(jailDirectory);
    if (sessions.length === 0) {
      console.log("No saved sessions.");
    } else {
    console.log("Saved sessions:");
    for (const s of sessions) {
      const age = s.updatedAt ? ` (${Math.round((Date.now() - new Date(s.updatedAt).getTime()) / 60000)}m ago)` : "";
      console.log(`  ${s.id.slice(0, 8)}  ${s.name || "(unnamed)"}${age}`);
      }
    }
    process.exit(0);
  }

  // Handle --continue
  if (continueSession) {
    const sessions = await listSessions(jailDirectory);
    if (sessions.length === 0) {
      console.error("No saved sessions to resume.");
      process.exit(1);
    }
    // Most recent session
    sessionId = sessions[0].id;
    console.log(`Resuming most recent session: ${sessionId.slice(0, 8)}`);
  }

  // Handle --acp
  if (acpMode) {
    const { runACP } = await import("./acp-server.js");
    await runACP({
      jailDirectory,
      model,
      provider,
      host,
      apiKey,
    });
    return;
  }

  // Handle --watch-inbox
  if (watchInboxFlag) {
    const { watchInbox } = await import("./cross-agent.js");
    await watchInbox(jailDirectory);
    return;
  }

  // Handle --review
  if (reviewFlag) {
    const [{ reviewPass }, { createProvider }, { gatherContext }] = await Promise.all([
      import("./review.js"),
      import("./providers/index.js"),
      import("./context.js"),
    ]);
    
    const settings = await loadSettings(jailDirectory);
    const providerName = provider || (settings.provider as string | undefined) || process.env.SMOL_AGENT_PROVIDER || "ollama";
    const modelName = model || (settings.model as string | undefined) || process.env.SMOL_AGENT_MODEL;
    
    const prov = createProvider({
      provider: providerName,
      model: modelName,
      host,
      apiKey,
    });
    
    const contextSize = typeof settings.contextSize === 'number' ? settings.contextSize : undefined;
    const context = await gatherContext(jailDirectory, contextSize);
    
    const result = await reviewPass(prov, {
      cwd: jailDirectory,
      projectContext: context,
      branch: reviewBranch,
    });
    
    console.log(result);
    process.exit(0);
  }

  // Normal interactive mode
  const settings = await loadSettings(jailDirectory);
  
  // Provider selection order: CLI arg > settings > env var > default
  const providerName = provider || (settings.provider as string | undefined) || process.env.SMOL_AGENT_PROVIDER || "ollama";
  const modelName = model || (settings.model as string | undefined) || process.env.SMOL_AGENT_MODEL;
  
  const prov = createProvider({
    provider: providerName,
    model: modelName,
    host,
    apiKey,
  });
  
  const contextSize = typeof settings.contextSize === 'number' ? settings.contextSize : undefined;
  const context = await gatherContext(jailDirectory, contextSize);
  
  const agent = new Agent({
    provider: prov,
    model: modelName,
    jailDirectory,
    autoApprove,
    autoApproveWrites,
    autoApproveExecute,
    sessionId,
    sessionName,
    settings,
    programmaticTools,
    showCodeExec,
    progressFd,
    approvedCategories: settings.approvedCategories,
  });
  
  // Load session if resuming
  if (sessionId) {
    const found = await findSession(jailDirectory, sessionId);
    if (found) {
      agent.loadSession(found);
    } else {
      console.warn(`Session ${sessionId} not found. Starting fresh.`);
    }
  }
  
  // Start UI
  await startApp(agent, context, promptText);
}

main().catch((err: Error) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});