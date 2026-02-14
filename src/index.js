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
let agentId = undefined;

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
    // Validate that the directory exists
    if (!fs.existsSync(jailDirectory) || !fs.statSync(jailDirectory).isDirectory()) {
      console.error(`Error: Directory '${jailDirectory}' does not exist or is not a directory`);
      process.exit(1);
    }
  } else if ((a === "--agent-id" || a === "-a") && args[i + 1]) {
    agentId = args[++i];
  } else if (a === "--help") {
    printUsage();
    process.exit(0);
  } else if (!a.startsWith("-")) {
    promptText = args.slice(i).join(" ");
    break;
  }
}

// Set up agent instance ID (for multi-agent coordination)
if (agentId) {
  process.env.AGENT_INSTANCE_ID = agentId;
} else if (!process.env.AGENT_INSTANCE_ID) {
  // Generate a default ID if not provided
  process.env.AGENT_INSTANCE_ID = `agent-${process.pid}-${Date.now()}`;
}

function printUsage() {
  console.log(`smol-agent — a small coding agent powered by Ollama

Usage:
  smol-agent [options] [prompt]

Options:
  -m, --model <name>        Ollama model to use (default: qwen2.5-coder:7b)
  -H, --host <url>          Ollama server URL (default: http://127.0.0.1:11434)
  -c, --context-size <num>  Maximum number of lines to include in README/AGENT.md snippets (default: 100)
  -d, --directory <path>    Set working directory and jail boundary (default: current directory)
  -a, --agent-id <id>       Agent instance identifier (for multi-agent coordination)
      --help                Show this help message

Interactive Commands:
  /plan                     Switch to planning mode (read-only tools)
  /code                     Switch to coding mode (full access)
  /mode                     Show current mode
  /reset                    Clear conversation history
  exit / quit               Exit the agent

Multi-Agent Features:
  - Child agents are spawned with limited capabilities
  - Parent agents can spawn child agents using spawn_agent tool
  - Child agents report progress to parent via agent_coordinator
  - All agents share state via file-based coordination in .smol-agent/state/

Examples:
  smol-agent "add error handling to src/index.js"
  smol-agent -m codellama "refactor the auth module"
  smol-agent -a "agent-1" "work on this specific task"  # Named agent
  smol-agent -c 50 "update the documentation"
  smol-agent -d ./my-project "add a new feature"
  smol-agent                                         # interactive mode`);
}

// ── Boot ─────────────────────────────────────────────────────────────
const agent = new Agent({ host, model, contextSize, jailDirectory });

// Check if raw mode is supported
const isRawModeSupported = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';

// If raw mode is not supported, create a mock stdin to prevent Ink from trying to enable it
let renderOptions = {};
if (!isRawModeSupported) {
  // Create a mock stdin that pretends to support raw mode
  const mockStdin = {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    ref: () => {},
    unref: () => {},
    on: (event, callback) => {
      if (event === 'data') {
        process.stdin.on(event, callback);
      }
    },
    removeListener: (event, callback) => {
      if (event === 'data') {
        process.stdin.removeListener(event, callback);
      }
    },
    resume: () => {},
    pause: () => {},
    addListener: (event, callback) => {
      if (event === 'readable') {
        // Don't actually add a listener for readable events
      }
    },
    removeListener: (event, callback) => {
      if (event === 'readable') {
        // Don't actually remove a listener for readable events
      }
    }
  };
  renderOptions = { stdin: mockStdin, exitOnCtrlC: false };
} else {
  renderOptions = { exitOnCtrlC: true };
}

render(React.createElement(App, { agent, initialPrompt: promptText }), renderOptions);
