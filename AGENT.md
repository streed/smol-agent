# AGENT.md — Agent Navigation Guide

## What this project is

smol-agent is a terminal-based coding agent powered by Ollama (local LLMs). It gives a language model tools to read/write/edit files, run shell commands, search code, and ask the user questions — then loops until the model produces a final text response. The UI is built with Ink (React for the terminal).

## Commands

```bash
npm install          # install dependencies
npm start            # run the agent (equivalent to: node src/index.js)
node src/index.js    # direct run
node src/index.js -m <model> "prompt here"  # one-shot with specific model
node src/index.js -d ./my-project "prompt"  # run in a specific directory
node src/index.js --all-tools "prompt"      # expose all tools (for smaller models)
```

No test suite exists yet. No build step — plain ES modules (Node >= 18).

### CLI Options

| Option | Description |
|--------|-------------|
| `-m, --model <name>` | Ollama model to use (default: qwen2.5-coder:32b) |
| `-H, --host <url>` | Ollama server URL (default: http://127.0.0.1:11434) |
| `-c, --context-size <num>` | Max lines for AGENT.md snippet (default: 100) |
| `-d, --directory <path>` | Set working directory and jail boundary (default: cwd) |
| `--all-tools` | Expose all tools (auto-detected for 30B+ models) |
| `--help` | Show help message |

## Architecture overview

```
User prompt → Agent.run() → Ollama chat API → tool calls → execute tools → feed results back → repeat until text response
```

The agent is an EventEmitter that drives a loop: send messages to Ollama, check for tool calls, execute them, push results back, and repeat (max 25 iterations). The Ink UI subscribes to events (`tool_call`, `tool_result`, `response`, `error`) to render progress.

## File map

### Core files (src/)

| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 113 | CLI entry point. Parses `--model`, `--host`, `--directory`, `--all-tools` args. Auto-detects tool exposure based on model size (30B+ gets all tools). Creates `Agent`, renders Ink `App`. |
| `agent.js` | 465 | **Core agent loop.** `Agent` class (extends EventEmitter). Holds conversation `messages[]`, calls Ollama, processes tool calls in a loop. Contains the system prompt. Also has `parseToolCallsFromContent()` fallback for models that emit tool calls as JSON in text instead of using Ollama's native `tool_calls` field. |
| `context.js` | 126 | **Project context gathering.** `gatherContext(cwd, contextSize)` builds a string with: working directory, project type detection, file tree (2 levels), git branch/status, and AGENT.md excerpt. Injected into the system prompt on first `run()`. |
| `context-manager.js` | 303 | **Context window management.** Tracks token usage, prunes conversation history when approaching limits, truncates large tool results, and handles context overflow errors from Ollama. |
| `ollama.js` | 266 | Ollama API wrapper with streaming, rate limiting, and retry logic. Exports `createClient(host)`, `chatStream()`, `chatWithRetry()`, and `DEFAULT_MODEL`. |
| `conversation-summarizer.js` | 83 | Token estimation utilities. `estimateTokenCount()` and `getTokenBreakdown()` for context management. |
| `errors.js` | 64 | Shared error classification. `isContextOverflowError()` detects context limit errors. `classifyError()` categorizes errors as transient/model_error/logic_error for retry logic. |
| `logger.js` | 159 | File-based logging to `.smol-agent/state/agent.log`. Log levels (debug/info/warn/error), controlled by `SMOL_AGENT_LOG_LEVEL` env var. |
| `path-utils.js` | 43 | Path validation utilities. `resolveJailedPath()` and `validateJailedPath()` ensure file operations stay within the jail directory. |
| `plan-tracker.js` | 148 | Plan progress tracking. `getCurrentPlan()`, `getPlanSummary()`, `hasActivePlan()`, `updatePlanStatus()`. Used for multi-step task execution. |

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

## Context management

The agent manages context window usage to prevent overflow errors from Ollama:

### Thresholds

- **55% usage**: Start LLM-based summarization of old messages
- **70% usage**: Prune messages using importance scoring
- **85% usage**: Aggressive pruning
- **Tool result limit**: 15k characters (prevents context bloat)

### Features

- **LLM-based summarization**: Uses the model to intelligently summarize old conversations, preserving file names, function names, and decisions. Falls back to simple extraction if LLM unavailable.
- **Importance-based pruning**: Messages are scored by importance before pruning:
  - System messages: highest priority
  - User messages: high priority (contain intent)
  - Assistant messages with tool calls: medium priority
  - Error messages: higher priority than success
  - Large tool results: deprioritized
- **Progressive intervention**: Earlier thresholds allow the agent to stay responsive during long tasks
- **Proactive pruning**: Removes old messages before hitting limits, keeping system prompt + recent conversation
- **Tool result truncation**: Large outputs (e.g., from `read_file` or `run_command`) are automatically truncated
- **Error recovery**: If Ollama returns a context overflow error, the agent prunes aggressively and informs the user to retry
- **Token tracking**: Uses real token counts from Ollama API when available, falls back to estimation

### Implementation

- `ContextManager` class in `context-manager.js` handles all context window logic
- `Agent.getTokenInfo()` returns current usage: `{ used, max, percentage, remaining }`
- UI displays percentage in status bar (yellow > 75%, red > 90%)

## Read-only mode

The agent has a read-only mode that blocks write tools (`write_file`, `replace_in_file`, `run_command`). Toggle with `/readonly` or `/ro` command, or press `Shift+Tab`.


