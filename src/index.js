#!/usr/bin/env node

import { Agent } from "./agent.js";
import { startApp } from "./ui/App.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadSettings } from "./settings.js";
import { listSessions, findSession } from "./sessions.js";
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
let provider = undefined;       // --provider <name> (ollama, openai, anthropic, grok)
let apiKey = undefined;         // --api-key <key>

let promptText = undefined;
let jailDirectory = process.cwd();
let allTools = undefined; // undefined = auto-detect from model size
let autoApprove = false;
let autoApproveWrites = false;
let autoApproveExecute = false;
let acpMode = false;
let sessionId = undefined;      // --session <id> to resume
let listSessionsFlag = false;   // --list-sessions
let sessionName = undefined;    // --session-name <name> for new sessions
let continueSession = false;    // --continue to resume the most recent session
let watchInboxFlag = false;     // --watch-inbox to run inbox watcher
let progressFd = undefined;    // --progress-fd <n> to write JSONL progress events
let programmaticTools = undefined; // --programmatic-tools / --no-programmatic-tools

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

function printUsage() {
  console.log(`smol-agent — a small coding agent powered by local and cloud LLMs

Usage:
  smol-agent [options] [prompt]

Options:
  -m, --model <name>        Model to use (default depends on provider)
  -p, --provider <name>     LLM provider: ollama, openai, anthropic, grok (default: ollama)
  -H, --host <url>          Provider host/base URL (default: provider-specific)
      --api-key <key>       API key for cloud providers (or use env vars)

  -d, --directory <path>    Set working directory and jail boundary (default: cwd)
      --all-tools           Expose all tools (auto-detected for 30B+ models)
      --auto-approve        Skip approval prompts for write/command tools (alias: --yolo)
      --approve-writes      Auto-approve file write operations (but still prompt for commands)
      --approve-execute     Auto-approve shell command execution (but still prompt for writes)
      --programmatic-tools  Enable programmatic tool calling (Anthropic: server-side, others: client-side)
      --no-programmatic-tools  Disable programmatic tool calling
      --acp                 Run as ACP (Agent Client Protocol) server over stdio
      --watch-inbox         Watch inbox for cross-agent letters and process them
      --progress-fd <n>    Write JSONL progress events to file descriptor n
      --self-update         Update smol-agent to the latest version
      --help                Show this help message

Session Management:
  -s, --session <id>        Resume a saved session by ID or name
  -c, --continue            Resume the most recent session
      --session-name <name> Name for the new session
      --list-sessions       List all saved sessions
      --sessions            Alias for --list-sessions

Providers:
  ollama (default)   Local LLMs via Ollama (no API key needed)
  openai             OpenAI API (set OPENAI_API_KEY or use --api-key)
  anthropic          Anthropic Claude API (set ANTHROPIC_API_KEY or use --api-key)
  grok               xAI Grok API (set XAI_API_KEY or use --api-key)

Interactive Commands:
  /clear             Clear conversation history
  /sessions          List saved sessions
  /session save      Save the current session (with optional name)
  /session load <id> Load a saved session
  /session delete    Delete a saved session
  /session rename    Rename a session
  /inspect           Dump current context to CONTEXT.md
  Ctrl+C             Cancel current operation (double-tap to exit)
  exit / quit        Exit the agent

Examples:
  smol-agent "add error handling to src/index.js"
  smol-agent -m codellama "refactor the auth module"
  smol-agent -p openai -m gpt-4o "explain this codebase"
  smol-agent -p anthropic "refactor the auth module"
  smol-agent -p grok -m grok-3 "add tests"
  smol-agent -d ./my-project "add a new feature"
  smol-agent                                         # interactive mode`);
}

// ── Boot ─────────────────────────────────────────────────────────────

// Auto-detect: expose all tools for 30B+ models or cloud providers, core-only for smaller local models.
function shouldUseCoreOnly(modelName, providerName) {
  if (allTools === true) return false;
  // Cloud providers (openai, anthropic, grok) use large models — always expose all tools
  const cloudProviders = new Set(["openai", "anthropic", "grok"]);
  if (cloudProviders.has((providerName || "").toLowerCase())) return false;
  if (!modelName) return true; // default to core-only
  // Extract parameter count from model name (e.g. "qwen2.5-coder:32b" → 32)
  const sizeMatch = modelName.match(/(\d+)[bB]/);
  if (sizeMatch) {
    const params = parseInt(sizeMatch[1]);
    return params < 30;
  }
  return true; // unknown size → be conservative
}

const coreToolsOnly = shouldUseCoreOnly(model, provider);

// ── List sessions (non-interactive) ───────────────────────────────────
if (listSessionsFlag) {
  const sessions = await listSessions(jailDirectory);
  if (sessions.length === 0) {
    console.log("No saved sessions.");
  } else {
    console.log(`Saved sessions (${sessions.length}):\n`);
    for (const s of sessions) {
      const name = s.name ? ` "${s.name}"` : "";
      const date = new Date(s.updatedAt).toLocaleString();
      const msgs = s.messageCount || 0;
      console.log(`  ${s.id}${name}  (${msgs} msgs, ${date})`);
      if (s.summary) {
        const summary = s.summary.length > 80 ? s.summary.slice(0, 77) + "..." : s.summary;
        console.log(`    ${summary}`);
      }
    }
  }
  process.exit(0);
}

// ── ACP mode ──────────────────────────────────────────────────────────
if (acpMode) {
  const { startACPServer } = await import("./acp-server.js");
  startACPServer({
    host,
    model,
    provider,
    apiKey,
    coreToolsOnly,
    autoApprove,
  });
} else if (watchInboxFlag) {
  // ── Inbox watcher mode ───────────────────────────────────────────
  const { watchInbox } = await import("./cross-agent.js");
  console.log(`Watching inbox for cross-agent letters in: ${jailDirectory}`);
  console.log("Press Ctrl+C to stop.\n");

  const watcher = watchInbox({
    repoPath: jailDirectory,
    provider,
    model,
    apiKey,
    onLetterReceived(letter) {
      console.log(`\nNew letter received: "${letter.title}" (${letter.id})`);
      console.log(`  From: ${letter.from}`);
      console.log(`  Priority: ${letter.priority}`);
      console.log("  Spawning agent to handle...\n");
    },
    onAgentComplete(letter, err) {
      if (err) {
        console.error(`  Failed to process "${letter.title}": ${err.message}`);
      } else {
        console.log(`  Completed: "${letter.title}" (${letter.id})`);
      }
    },
    onProgress(event) {
      if (event.type === "tool_call") {
        console.log(`  [${event.letterTitle || "agent"}] ${event.name}(...)`);
      } else if (event.type === "tool_result" && !event.success) {
        console.log(`  [${event.letterTitle || "agent"}] ${event.name} failed`);
      }
    },
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nStopping inbox watcher...");
    watcher.stop();
    process.exit(0);
  });
} else if (progressFd !== undefined && promptText) {
  // ── Headless mode (spawned child agent) ─────────────────────────────
  // When --progress-fd is set with a prompt, run the agent without TUI.
  // This is used by processLetter() to spawn child agents that can
  // reliably execute tools without the overhead/fragility of a TUI on
  // a non-TTY stdin.
  const agent = new Agent({ host, model, provider, apiKey, jailDirectory, coreToolsOnly, programmaticToolCalling: programmaticTools });

  if (autoApprove) agent._approveAll = true;
  if (autoApproveWrites) agent.approveCategory("write");
  if (autoApproveExecute) agent.approveCategory("execute");

  // Write JSONL progress events to the given fd using synchronous writes
  // (fs.createWriteStream(null, { fd }) throws in Node 18+ since null isn't a valid path)
  const writeProgress = (event) => {
    try { fs.writeSync(progressFd, JSON.stringify(event) + "\n"); } catch { /* ignore write errors */ }
  };
  agent.on("tool_call", ({ name, args }) => writeProgress({ type: "tool_call", name, args }));
  agent.on("tool_result", ({ name, result }) => writeProgress({ type: "tool_result", name, success: !result?.error }));
  agent.on("stream_start", () => writeProgress({ type: "streaming" }));
  agent.on("stream_end", () => writeProgress({ type: "completed" }));

  // Diagnostic: log git status before exit so we can trace vanishing changes
  const logGitState = (label) => {
    try {
      const gitStatus = execSync("git status --porcelain", { cwd: jailDirectory, encoding: "utf-8", timeout: 5000 });
      const gitLog = execSync("git log --oneline -1", { cwd: jailDirectory, encoding: "utf-8", timeout: 5000 }).trim();
      if (gitStatus.trim()) {
        console.error(`[headless:${label}] Uncommitted changes:\n${gitStatus.trim()}`);
      } else {
        console.error(`[headless:${label}] Clean working tree. Last commit: ${gitLog}`);
      }
    } catch { /* git not available or not a repo */ }
  };

  try {
    await agent.run(promptText);
    logGitState("exit");
    process.exit(0);
  } catch (err) {
    console.error(`[headless] Agent error: ${err.message}`);
    if (err.stack) console.error(err.stack);
    logGitState("crash");
    process.exit(1);
  }
} else {
  // ── TUI mode ────────────────────────────────────────────────────────
  const agent = new Agent({ host, model, provider, apiKey, jailDirectory, coreToolsOnly, programmaticToolCalling: programmaticTools });

  // Load persisted settings, CLI flags override
  const settings = await loadSettings(jailDirectory);
  if (autoApprove || settings.autoApprove) {
    agent._approveAll = true;
  }

  // Granular auto-approve categories
  if (autoApproveWrites) agent.approveCategory("write");
  if (autoApproveExecute) agent.approveCategory("execute");

  // ── Session handling ──
  let resumedSession = false;

  if (sessionId) {
    // Resume a specific session by ID or name
    const match = await findSession(jailDirectory, sessionId);
    if (match) {
      resumedSession = await agent.resumeSession(match.id);
      if (!resumedSession) {
        console.error(`Failed to load session: ${sessionId}`);
        process.exit(1);
      }
    } else {
      console.error(`Session not found: ${sessionId}`);
      console.log("Use --list-sessions to see available sessions.");
      process.exit(1);
    }
  } else if (continueSession) {
    // Resume the most recent session
    const sessions = await listSessions(jailDirectory);
    if (sessions.length > 0) {
      resumedSession = await agent.resumeSession(sessions[0].id);
      if (!resumedSession) {
        console.error("Failed to resume most recent session.");
      }
    }
  }

  // Start a new session if not resuming (always track sessions)
  if (!resumedSession) {
    agent.startSession(sessionName);
  }

  startApp(agent, promptText);
}
