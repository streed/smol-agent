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
| `read_file.js` | `read_file` | Reads a file, returns numbered lines. Supports `offset`/`limit` params. |
| `list_files.js` | `list_files` | Glob-based file listing (uses `glob` npm package). Ignores `node_modules/` and `.git/`. |
| `run_command.js` | `run_command` | Runs a shell command via `execSync`. 30s default timeout, 1MB max buffer. |
| `grep.js` | `grep` | Regex search via `grep -rn`. Returns up to 200 matching lines. |
| `find_in_file.js` | `find_in_file` | Search for specific text within a file and return line numbers and content. Useful for locating where to make edits. |
| `web_search.js` | `web_search` | Web search via `ollama.webSearch()`. Requires `OLLAMA_API_KEY`. Needs client injected via `setOllamaClient()`. |
| `web_fetch.js` | `web_fetch` | Fetches a URL via `ollama.webFetch()`. Truncates to 12k chars. Needs client injected via `setOllamaClient()`. |
| `ask_user.js` | `ask_user` | Asks user a question. Works via a promise bridge: UI sets a handler with `setAskHandler()`, tool awaits it. |
| `spawn_agent.js` | `spawn_agent` | Spawns child agent with `--agent-id`. Child agents cannot spawn further sub-agents. Returns output from child process. |
| `agent_coordinator.js` | `agent_coordinator` | Manages child agents, handles state persistence in `.smol-agent/state/`. Coordinates spawn/monitor/sync/report actions. |
| `agent_monitor.js` | `agent_monitor` | Monitors progress of child agents. Returns status, progress, timing info. |
| `agent_status.js` | `agent_status` | Checks status of any agent instance (running, completed, failed, progress). |

## Module system

This project uses **ES modules** (`"type": "module"` in package.json). **Never use `require()`** — always use `import` / `export`. This includes conditional imports; use top-level `import` or dynamic `import()` instead of `require()`.

## Multi-Agent System

### Architecture

- **Single-level hierarchy**: Parent agents can spawn child agents, but child agents cannot spawn further sub-agents
- **State synchronization**: Agents share state via file-based coordination in `.smol-agent/state/`
- **Concurrent execution**: Child agents work independently while reporting progress back to parent

### Agent Types

| Agent Type | Capabilities |
|------------|-------------|
| **Parent** | Full tool access including `spawn_agent`, `agent_coordinator`, `agent_monitor`, `agent_status` |
| **Child** | Limited tools: cannot use `spawn_agent` or `agent_coordinator` (no sub-agent spawning) |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `AGENT_INSTANCE_ID` | Unique identifier for the agent instance |
| `SMOL_AGENT_PARENT_ID` | Parent agent ID (set automatically for child agents) |
| `AGENT_STATE_DIR` | Directory for agent state files (default: `.smol-agent/state/`) |

### Tool Usage

#### Spawning a Child Agent

```json
{
  "name": "spawn_agent",
  "arguments": {
    "prompt": "Solve sub-problem X",
    "child_agent_id": "child-1",
    "context": "Optional context from parent"
  }
}
```

#### Monitoring Agents

```json
{
  "name": "agent_coordinator",
  "arguments": {
    "action": "monitor",
    "agent_ids": ["child-1", "child-2"]
  }
}
```

#### Reporting Progress (Child Agents)

```json
{
  "name": "agent_coordinator",
  "arguments": {
    "action": "report",
    "update": {
      "progress": 50,
      "status": "running",
      "message": "Working on task..."
    }
  }
}
```

### State Files

Each agent's state is persisted in `.smol-agent/state/<agent_id>.json`:

```json
{
  "agent_id": "child-1",
  "status": "completed",
  "progress": 100,
  "parent_id": "agent-123",
  "start_time": 1712345678901,
  "end_time": 1712345689012,
  "exit_code": 0,
  "stdout": "Output from child process...",
  "stderr": "",
  "error": null
}
```

### When to Use Multi-Agent

- **Parallel processing**: Break complex tasks into independent sub-tasks
- **Specialization**: Assign different agents to different parts of a problem
- **Progress tracking**: Parent sees real-time progress from all children
- **Error isolation**: Child failures don't necessarily crash parent

## Self-Generated Tools

smol-agent supports creating custom tools that persist across sessions. Tools are stored in `.smol-agent/tools/`.

### Tool Management Tools

| Tool | Purpose |
|------|---------|
| `create_tool` | Create a new custom tool |
| `list_custom_tools` | List all available custom tools |
| `get_tool_code` | View source code of a custom tool |
| `delete_tool` | Delete a custom tool |

### Creating a Tool

Use `create_tool` with:
- `name`: Tool name (snake_case)
- `description`:
- `parameters What the tool does`: JSON Schema for arguments
- `code`: JavaScript code to execute

Example:
```
create_tool({
  name: "calculate_hash",
  description: "Calculate SHA-256 hash of a string",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "String to hash" }
    },
    required: ["input"]
  },
  code: "const crypto = require('crypto'); return crypto.createHash('sha256').update(input).digest('hex');"
})
```

### Reflection

After completing a task, the agent can reflect on what was done:

| Tool | Purpose |
|------|---------|
| `reflect` | Summarize work, identify what went well, areas for improvement |

The reflection is automatically triggered after each task completes (in coding mode). Use `agent.setReflection(false)` to disable.

## Planning mode

The agent supports two modes:

- **Coding mode** (default): Full access to all tools — read, write, edit files, run shell commands
- **Planning mode**: Read-only access — can explore codebase but cannot modify anything

### Implementation

- `Agent.mode` property tracks current mode ("coding" or "planning")
- `Agent.setMode(newMode)` switches modes and resets `_initialized` to rebuild system prompt
- `registry.ollamaTools(planningMode)` filters out write tools (`run_command`) when in planning mode
- Two separate system prompts: `SYSTEM_PROMPT` for coding, `PLANNING_SYSTEM_PROMPT` for planning
- UI commands: `/plan`, `/code`, `/mode` — handled in `App.js` submit callback

### When to use planning mode

Useful for:
- Analyzing a problem before making changes
- Getting a detailed implementation plan with file names and code snippets
- Reviewing code without risk of accidental modifications

## Key patterns

### Adding a new tool

1. Create `src/tools/your_tool.js`
2. Import and call `register()` from `./registry.js`:
   ```js
   import { register } from "./registry.js";
   register("tool_name", {
     description: "What it does",
     parameters: { type: "object", required: [...], properties: { ... } },
     async execute(args) { return { result: "..." }; }
   });
   ```
3. Add `import "./tools/your_tool.js";` in `agent.js` (around line 8-15) to trigger self-registration.

### Tool call parsing fallback

Some models don't use Ollama's native `tool_calls` field — they output tool calls as JSON in the message content. `parseToolCallsFromContent()` in `agent.js` handles this by scanning for `{"name": "...", "arguments": {...}}` patterns in code fences or bare JSON.

### ask_user bridge

`ask_user` is special — it needs to pause the agent loop and collect user input from the Ink UI. This works via a promise:
- `App.js` calls `setAskHandler(fn)` at mount time
- When the tool executes, it calls the handler which returns a Promise
- The UI resolves the promise when the user submits an answer
- The agent loop resumes with the answer

### Context injection

On first `Agent.run()`, `gatherContext()` collects project info and appends it to the system prompt. This runs once per session (or after `agent.reset()`). The gathered context includes file tree, git info, config files, and README excerpt.

### Event flow

```
Agent emits:
  "context_ready" → after gatherContext() finishes
  "tool_call"     → { name, args }     before executing a tool
  "tool_result"   → { name, result }   after tool finishes
  "response"      → { content }        final text response (loop done)
  "error"         → Error              on failure
```

## Smart Context Management (NEW!)

smol-agent now includes intelligent context management to reduce token usage while maintaining awareness of project state.

### Key Enhancements:

1. **File-touched tracking** - Tracks which files the agent has accessed/modified. Only updates context for changed files, not the entire file tree.

2. **Conversation summarization** - Automatically summarizes old conversation messages when context approaches 95% of max tokens.

3. **Repo map** - Creates a lightweight map of files to their top-level functions/classes without reading full file contents.

### New Modules:

| File | Lines | Purpose |
|------|-------|---------|
| `src/repo-map.js` | 200+ | Generate and maintain a map of files to functions/classes. Uses regex to detect declarations across multiple languages. |
| `src/context-tracker.js` | 100+ | Tracks file changes via mtime/checksum. Enables smart context updates by detecting what's changed. |
| `src/conversation-summarizer.js` | 100+ | Handles conversation history summarization. Prevents context overflow by summarizing old messages. |

### Repo Map:

The repo map provides a concise view of your project's structure:

```
## Repo Map

src/agent.js:
  - class Agent
  - function parseToolCallsFromContent

src/context.js:
  - function gatherContext
  - function fileTree
  - function gitInfo
```

Stored in `.smol-agent/state/repo-map.json` and updated incrementally when files change.

### Conversation Summarization:

When context approaches 95% of max tokens:
- The first ~70% of messages are replaced with a summary
- Recent messages (last 3-5) are kept for full context
- Uses simple heuristics (configurable in `conversation-summarizer.js`)

### Context Tracker:

Tracks file access in `.smol-agent/state/file-tracker.json`:
```json
{
  "src/agent.js": {
    "mtime": 1712345678901,
    "checksum": "abc123...",
    "lastTouched": 1712345678901
  }
}
```

### Integration:

- `gatherContext()` now accepts an optional `contextTracker` parameter
- `Agent.contextTracker` is automatically initialized
- File changes trigger context updates only for changed files
- Token usage is monitored and summarization is triggered automatically

### Benefits:

- **20%+ token savings** from repo map and incremental updates
- **Longer conversations** without hitting context limits
- **Faster context gathering** (only changed files)
- **Maintained awareness** of project state

### New Tool:

| File | Tool name | Purpose |
|------|-----------|---------|
| `src/tools/file_touched.js` | `file_touched` | Explicitly track when a file has been accessed. Helps with smart context updates. |

