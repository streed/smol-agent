Working directory: /home/reed/code/personal/small-coding-agent

Project: Node.js

Files:
AGENT.md
CONTEXT.md
package-lock.json
package.json
README.md
src/
  agent.js
  context.js
  conversation-summarizer.js
  index.js
  logger.js
  ollama.js
  path-utils.js
  plan-tracker.js
  tools/
  ui/
test/
  markdown-improved-test.js
  markdown-test.js

Git branch: main
Uncommitted changes (12 files):
M AGENT.md
 M package-lock.json
 M package.json
 M src/agent.js
 D src/context-tracker.js
 M src/conversation-summarizer.js
 D src/repo-map.js
 D src/tools/create_tool.js
 D src/tools/requirements_tools.js
 M src/ui/App.js
?? CONTEXT.md
?? src/ui/MultilineInput.js

## AGENT.md
# AGENT.md — Agent Navigation Guide

## What this project is

smol-agent is a terminal-based coding agent powered by Ollama (local LLMs). It gives a language model tools to read/write/edit files, run shell commands, search code, and ask the user questions — then loops until the model produces a final text response. The UI is built with Ink (React for the terminal).

## Commands

```bash
npm install          # install dependencies
npm start            # run the agent (equivalent to: node src/index.js)
node src/index.js    # direct run
node src/index.js -m <model> "prompt here"  # one-shot with specific model
```

No test suite exists yet. No build step — plain ES modules (Node >= 18).

## Architecture overview

```
User prompt → Agent.run() → Ollama chat API → tool calls → execute tools → feed results back → repeat until text response
```

The agent is an EventEmitter that drives a loop: send messages to Ollama, check for tool calls, execute them, push results back, and repeat (max 25 iterations). The Ink UI subscribes to events (`tool_call`, `tool_result`, `response`, `error`) to render progress.

## File map

### Core files (src/)

| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 49 | CLI entry point. Parses `--model`, `--host`, `--help` args. Creates `Agent`, renders Ink `App`. |
| `agent.js` | 234 | **Core agent loop.** `Agent` class (extends EventEmitter). Holds conversation `messages[]`, calls Ollama, processes tool calls in a loop. Contains the system prompt. Also has `parseToolCallsFromContent()` fallback for models that emit tool calls as JSON in text instead of using Ollama's native `tool_calls` field. |
| `context.js` | 164 | **Project context gathering.** `gatherContext(cwd)` builds a string with: working directory, file tree (2 levels), git branch/status/log, config file contents (package.json, tsconfig, etc.), and README excerpt. Injected into the system prompt on first `run()`. |
| `ollama.js` | 20 | Thin wrapper. Exports `createClient(host)`, `chat(client, model, messages, tools)`, and `DEFAULT_MODEL` (`qwen2.5-coder:7b`). |

### UI (src/ui/)

| File | Lines | Purpose |
|------|-------|---------|
| `App.js` | 204 | Ink (React) terminal UI. Manages message log, input field, spinner, ask_user flow. Uses `React.createElement` directly (no JSX). Subscribes to agent events. Handles `/reset`, `exit`/`quit`, `Ctrl-C`. Renders agent responses with rich markdown formatting. |
| `markdown.js` | 233 | Enhanced markdown renderer for terminal output. Converts markdown-style text to styled Text components with comprehensive support for headers, bold/italic text, inline code, code blocks, lists (ordered and unordered), blockquotes, links, and strikethrough formatting. |

### Tools (src/tools/)

All tools self-register by calling `register(name, { description, parameters, execute })` on import. The agent imports them in `agent.js` to trigger registration.

| File | Tool name | Purpose |
|------|-----------|---------|
| `registry.js` | — | Tool registry. `register()`, `execute()`, `ollamaTools()` (serializes to Ollama format), `list()`. |
| `file_tools.js` | `read_file`, `write_file`, `replace_in_file` | File operations: read with line numbers, write new files, find/replace in files. |
| `list_files.js` | `list_files` | Glob-based file listing (uses `glob` npm package). Ignores `node_modules/` and `.git/`. |
| `run_command.js` | `run_command` | Runs a shell command via `execSync`. 30s default timeout, 1MB max buffer. |
| `grep.js` | `grep` | Regex search via `grep -rn`. Returns up to 200 matching lines. |
| `web_search.js` | `web_search` | Web search via `ollama.webSearch()`. Requires `OLLAMA_API_KEY`. Needs client injected via `setOllamaClient()`. |
| `web_fetch.js` | `web_fetch` | Fetches a URL via `ollama.webFetch()`. Truncates to 12k chars. Needs client injected via `setOllamaClient()`. |
| `ask_user.js` | `ask_user` | Asks user a question. Works via a promise bridge: UI sets a handler with `setAskHandler()`, tool awaits it. |
| `plan_tools.js` | `save_plan`, `load_plan_progress`, `get_current_plan`, `complete_plan_step`, `update_plan_status` | Plan management for saving and tracking progress on implementation plans. |
| `reflection.js` | `reflect` | Summarize work done, identify what went well, areas for improvement. |

## Module system

This project uses **ES modules** (`"type": "module"` in package.json). **Never use `require()`** — always use `import` / `export`. This includes conditional imports; use top-level `import` or dynamic `import()` instead of `require()`.

## Reflection

The agent has a `reflect` tool that can summarize work done, identify what went well, and note areas for improvement. The model can call this tool when it wants to reflect on its work.

## Read-only mode

The agent has a read-only mode that blocks write tools (`write_file`, `replace_in_file`, `run_command`). Toggle with `/readonly` or `/ro` command, or press `Shift+Tab`.



