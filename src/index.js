#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { Agent } from "./agent.js";
import App from "./ui/App.js";

// ── CLI argument parsing ─────────────────────────────────────────────
const args = process.argv.slice(2);
let host = undefined;
let model = undefined;
let promptText = undefined;
let autoApprove = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if ((a === "--host" || a === "-H") && args[i + 1]) {
    host = args[++i];
  } else if ((a === "--model" || a === "-m") && args[i + 1]) {
    model = args[++i];
  } else if (a === "--yes" || a === "-y") {
    autoApprove = true;
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
  -m, --model <name>   Ollama model to use (default: qwen2.5-coder:7b)
  -H, --host <url>     Ollama server URL (default: http://127.0.0.1:11434)
  -y, --yes            Auto-approve all shell commands (skip permission prompts)
      --help           Show this help message

Examples:
  smol-agent "add error handling to src/index.js"
  smol-agent -m codellama "refactor the auth module"
  smol-agent -y "run the test suite and fix any failures"
  smol-agent                                         # interactive mode`);
}

// ── Boot ─────────────────────────────────────────────────────────────
const agent = new Agent({ host, model, autoApprove });

render(React.createElement(App, { agent, initialPrompt: promptText, autoApprove }));
