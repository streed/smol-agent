#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { Agent } from "./agent.js";
import App from "./ui/App.js";
import path from "node:path";
import fs from "node:fs";

// ── CLI argument parsing ─────────────────────────────────────────────
const args = process.argv.slice(2);
let host = undefined;
let model = undefined;
let contextSize = undefined;
let promptText = undefined;
let jailDirectory = process.cwd();
let allTools = undefined; // undefined = auto-detect from model size

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if ((a === "--host" || a === "-H") && args[i + 1]) {
    host = args[++i];
  } else if ((a === "--model" || a === "-m") && args[i + 1]) {
    model = args[++i];
  } else if ((a === "--context-size" || a === "-c") && args[i + 1]) {
    contextSize = parseInt(args[++i]);
  } else if ((a === "--directory" || a === "-d") && args[i + 1]) {
    jailDirectory = path.resolve(args[++i]);
    if (!fs.existsSync(jailDirectory) || !fs.statSync(jailDirectory).isDirectory()) {
      console.error(`Error: Directory '${jailDirectory}' does not exist or is not a directory`);
      process.exit(1);
    }
  } else if (a === "--all-tools") {
    allTools = true;
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
  -c, --context-size <num>  Max lines for AGENT.md snippet (default: 100)
  -d, --directory <path>    Set working directory and jail boundary (default: cwd)
      --all-tools           Expose all tools (auto-detected for 30B+ models)
      --help                Show this help message

Interactive Commands:
  /readonly or /ro   Toggle read-only mode (disables write tools)
  /reset             Clear conversation history
  /inspect           Dump current context to CONTEXT.md
  shift+tab          Toggle read-only mode
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
const agent = new Agent({ host, model, contextSize, jailDirectory, coreToolsOnly });

const isRawModeSupported = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";

let renderOptions = {};
if (!isRawModeSupported) {
  const mockStdin = {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    ref: () => {},
    unref: () => {},
    on: (event, cb) => { if (event === "data") process.stdin.on(event, cb); },
    removeListener: (event, cb) => { if (event === "data") process.stdin.removeListener(event, cb); },
    resume: () => {},
    pause: () => {},
    addListener: () => {},
  };
  renderOptions = { stdin: mockStdin, exitOnCtrlC: false };
} else {
  renderOptions = { exitOnCtrlC: false };
}

render(React.createElement(App, { agent, initialPrompt: promptText }), renderOptions);
