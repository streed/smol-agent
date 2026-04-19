# AGENT.md — Agent Navigation Guide

## What this project is

smol-agent is a terminal-based coding agent powered by Ollama (local LLMs). It gives a language model tools to read/write/edit files, run shell commands, search code, and ask the user questions — then loops until the model produces a final text response. The UI is built with pi-tui and chalk for colorful terminal rendering.

## Commands

```bash
npm install          # install dependencies
npm start            # run the agent (equivalent to: node src/index.js)
node src/index.js    # direct run
node src/index.js -m <model> "prompt here"  # one-shot with specific model
node src/index.js -d ./my-project "prompt"  # run in a specific directory
npm test             # run unit tests (Jest)
npm run test:e2e     # run end-to-end tests
```

No build step — plain ES modules (Node >= 20).

### CLI Options

| Option | Description |
|--------|-------------|
| `-m, --model <name>` | Model to use (default depends on provider) |
| `-p, --provider <name>` | LLM provider: `ollama`, `openai`, `anthropic`, `grok`, `groq`, `gemini` (default: `ollama`) |
| `-H, --host <url>` | Provider host/base URL (default: provider-specific) |
| `--api-key <key>` | API key for cloud providers (or use env vars) |
| `-d, --directory <path>` | Set working directory and jail boundary (default: cwd) |
| `--auto-approve` | Skip approval prompts for write/command tools (alias: `--yolo`) |
| `--approve-writes` | Auto-approve file write operations only |
| `--approve-execute` | Auto-approve command execution only |
| `-s, --session <id>` | Resume a saved session by ID or name |
| `-c, --continue` | Resume the most recent session |
| `--list-sessions` | List all saved sessions |
| `--acp` | Run as ACP (Agent Client Protocol) server over stdio |
| `--help` | Show help message |

Providers: `ollama` (default), `openai`, `anthropic`, `grok`, `groq`, `gemini`
Env vars: `SMOL_AGENT_PROVIDER`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`

## Architecture overview

```
User prompt → Agent.run() → LLM Provider API → tool calls → execute tools → feed results back → repeat until text response
```

The agent is an EventEmitter that drives a loop: send messages to the LLM provider, check for tool calls, execute them, push results back, and repeat (max 25 iterations). The pi-tui UI subscribes to events (`tool_call`, `tool_result`, `response`, `error`) to render progress.

## File map

### Core files (src/)

| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 327 | CLI entry point. Parses args, creates provider via `createProvider()`, creates `Agent`, renders pi-tui `App`. Auto-detects tool exposure based on model size (30B+ gets all tools). |
| `agent.js` | 1261 | **Core agent loop.** `Agent` class (extends EventEmitter). Holds conversation `messages[]`, calls LLM provider, processes tool calls in a loop. Contains the system prompt. Also has `parseToolCallsFromContent()` fallback for models that emit tool calls as JSON in text. |
| `context.js` | 233 | **Project context gathering.** `gatherContext(cwd, contextSize)` builds a string with: working directory, project type detection, file tree (2 levels), git branch/status, AGENT.md excerpt, and loaded skills. Injected into the system prompt on first `run()`. |
| `context-manager.js` | 704 | **Context window management.** Tracks token usage, prunes conversation history when approaching limits, truncates large tool results, and handles context overflow errors. |
| `context-summarizer.js` | 216 | LLM-based summarization for context compression. Used by ContextManager for intelligent message summarization. |
| `ollama.js` | 55 | Ollama API wrapper with streaming. Exports `createClient(host)`, `chatStream()`, `chatWithRetry()`. |
| `errors.js` | 109 | Shared error classification. `isContextOverflowError()` detects context limit errors. `classifyError()` categorizes errors as transient/model_error/logic_error for retry logic. |
| `logger.js` | 178 | File-based logging to `.smol-agent/state/agent.log`. Log levels (debug/info/warn/error), controlled by `SMOL_AGENT_LOG_LEVEL` env var. |
| `path-utils.js` | 86 | Path validation utilities. `resolveJailedPath()` and `validateJailedPath()` ensure file operations stay within the jail directory. |
| `token-estimator.js` | 200 | Token counting utilities. Estimates tokens when provider doesn't return counts. Used by context management. |
| `tool-call-parser.js` | 96 | Parses tool calls from LLM responses. Handles both native tool_calls and JSON-in-text fallback. |
| `prehydrate.js` | 135 | Pre-generates context for first message. Speeds up initial response by computing file tree, repo map, etc. ahead of time. |
| `ts-lint.js` | 168 | TypeScript/JavaScript linting for shift-left error detection. |
| `skills.js` | 341 | **Agent Skills system.** Loads skill files from `.smol-agent/skills/` and global `~/.config/smol-agent/skills/`. Validates skill names, descriptions, and content. Skills are markdown files injected into the system prompt. |
| `sessions.js` | 199 | **Session persistence.** Saves/loads conversation sessions to `.smol-agent/state/sessions/`. Each session stores messages and metadata. |
| `memory-bank.js` | 190 | **Structured memory.** Manages `.smol-agent/memory-bank/` files: `projectContext.md`, `techContext.md`, `progress.md`, `learnings.md`. Provides cross-session project knowledge. |
| `checkpoint.js` | 372 | **Git checkpoint system.** Creates snapshots in `.smol-agent/checkpoints/` before agent runs. Enables `/undo` to rollback changes. Uses a shadow git repo to avoid polluting main repo. |
| `architect.js` | 170 | **Architect mode.** Two-pass approach: 1) read-only analysis produces a plan, 2) editor pass executes the plan. Separates planning from execution. |
| `acp-server.js` | 825 | **Agent Client Protocol server.** Implements ACP spec for IDE/editor integration. Exposes agent via JSON-RPC. Tool approvals, unstable session list/resume, `session/set_model` → `Agent#setModel` when idle. |
| `settings.js` | ~50 | User settings loaded from `.smol-agent/settings.json`. |

### Docs (`docs/`)

| File | Purpose |
|------|---------|
| `cross-agent-communication.md` | Cross-repo inbox/letter protocol between agents. |
| `acp-t3code-roadmap.md` | **Planning only:** ACP limitations, phased backlog, t3code’s existing OpenCode/Cursor-over-ACP pattern and planned smol-agent parity, experimenting with jail at `../t3code`; product wiring stays in t3code. |

### Providers (src/providers/)

Multi-provider support for different LLM backends:

| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 110 | **Provider factory.** `createProvider({ provider, model, host, apiKey })` returns the appropriate provider. Supports: `ollama` (default), `openai`, `grok`, `anthropic`, or custom URL. |
| `base.js` | 223 | Base class for LLM providers. Defines interface: `chat()`, `chatStream()`, `countTokens()`. |
| `ollama.js` | 164 | Ollama provider. Streaming chat, local inference. |
| `openai-compatible.js` | 305 | OpenAI-compatible provider. Works with OpenAI, Grok, and any OpenAI-compatible API. |
| `anthropic.js` | 364 | Anthropic provider. Claude models via Messages API. |

Provider selection: `--provider ollama|openai|grok|anthropic|<url>`
Env vars: `SMOL_AGENT_PROVIDER`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`

### UI (src/ui/)

| File | Lines | Purpose |
|------|-------|---------|
| `App.js` | 204 | pi-tui terminal UI. Manages message log, input field, spinner, ask_user flow. Subscribes to agent events. Handles `/clear`, `exit`/`quit`, `Ctrl-C`. Renders agent responses with rich markdown formatting via chalk. |
| `markdown.js` | 233 | Enhanced markdown renderer for terminal output. Converts markdown-style text to styled Text components with comprehensive support for headers, bold/italic text, inline code, code blocks, lists (ordered and unordered), blockquotes, links, and strikethrough formatting. |
| `diff.js` | 305 | Diff visualization for file changes. Shows unified diffs with syntax highlighting. |

### Tools (src/tools/)

All tools self-register by calling `register(name, { description, parameters, execute })` on import. The agent imports them in `agent.js` to trigger registration.

| File | Tool name | Purpose |
|------|-----------|---------|
| `registry.js` | — | Tool registry. `register()`, `execute()`, `ollamaTools()` (serializes to Ollama format), `list()`. Also has `requiresApproval()` for ACP. |
| `file_tools.js` | `read_file`, `write_file`, `replace_in_file` | File operations: read with line numbers, write new files, find/replace in files. |
| `list_files.js` | `list_files` | Glob-based file listing (uses `glob` npm package). Ignores `node_modules/` and `.git/`. |
| `run_command.js` | `run_command` | Runs a shell command via `execSync`. 30s default timeout, 1MB max buffer. |
| `grep.js` | `grep` | Regex search via `grep -rn`. Returns up to 200 matching lines. |
| `web_search.js` | `web_search` | Web search via `ollama.webSearch()`. Requires `OLLAMA_API_KEY`. Needs client injected via `setOllamaClient()`. |
| `web_fetch.js` | `web_fetch` | Fetches a URL via `ollama.webFetch()`. Truncates to 12k chars. Needs client injected via `setOllamaClient()`. |
| `ask_user.js` | `ask_user` | Asks user a question. Works via a promise bridge: UI sets a handler with `setAskHandler()`, tool awaits it. |
| `plan_tools.js` | `save_plan`, `load_plan_progress`, `get_current_plan`, `complete_plan_step`, `update_plan_status` | Plan management for saving and tracking progress on implementation plans. |
| `reflection.js` | `reflect` | Summarize work done, identify what went well, areas for improvement. Also analyzes edited files >100 lines for documentation needs. |
| `file_documentation.js` | — | Tracks edited files, extracts dependencies/dependents, analyzes files for documentation headers. Used by reflect tool and /reflect command. |
| `memory.js` | `remember`, `recall`, `memory_bank_read`, `memory_bank_write`, `memory_bank_init` | Persistent key-value memory and structured Memory Bank. |
| `git.js` | `git` | Safe git operations. Blocks `push`, `--force`, destructive resets. Auto-generates commit messages from change summaries. |
| `sub_agent.js` | `delegate` | Spawn a sub-agent with read-only tools for focused research tasks. Returns condensed results. |
| `context_docs.js` | — | Internal: Loads `.smol-agent/docs/*.md` context files. Used by context gathering. |
| `session_tools.js` | `list_sessions`, `delete_session`, `rename_session` | Session management tools. |
| `save_plan.js` | — | Legacy plan saving (being replaced by plan_tools.js). |

## Module system

This project uses **ES modules** (`"type": "module"` in package.json). **Never use `require()`** — always use `import` / `export`. This includes conditional imports; use top-level `import` or dynamic `import()` instead of `require()`.

## Reflection

The agent has a `reflect` tool that can summarize work done, identify what went well, and note areas for improvement. The model can call this tool when it wants to reflect on its work.

### File Documentation

As part of the reflection process, the agent analyzes all code files that were edited during the session. Files longer than 100 lines are flagged for documentation. The documentation header (placed at the top of each file) should include:

1. **Summary** — What the file does
2. **Dependencies** — What it imports/requires
3. **Depended on by** — Other files that import/reference it
4. **`@file-doc` marker** — So the header can be detected and updated later

The `/reflect` command in the UI and the `reflect` tool both trigger this analysis. The `file_documentation.js` module tracks which files were edited via `trackEditedFile()` (called automatically by `write_file` and `replace_in_file`), and `analyzeFilesForDocumentation()` produces a report of files needing documentation.

## Skills

The agent supports a **Skills system** — markdown files in `.smol-agent/skills/` that define reusable instructions. Skills are validated (name: lowercase, numbers, hyphens only; description: max 1024 chars) and loaded at startup. Global skills live in `~/.config/smol-agent/skills/`.

Skills are injected into the system prompt after project context, before tools. They allow project-specific or user-specific behaviors without modifying the core system prompt.

## Sessions

Sessions persist conversations to `.smol-agent/state/sessions/<id>.json`. Each session stores:
- `id`: 8-char hex identifier
- `name`: Optional human-friendly name
- `createdAt`, `updatedAt`: Timestamps
- `messageCount`: Number of messages
- `summary`: Auto-generated summary for quick reference
- `messages`: Full conversation history

Sessions can be listed, loaded, renamed, and deleted via UI commands or tools.

## Memory Bank

Structured cross-session knowledge in `.smol-agent/memory-bank/`:

| File | Purpose |
|------|---------|
| `projectContext.md` | What the project does, tech stack, key goals |
| `techContext.md` | Architecture, patterns, conventions, key files |
| `progress.md` | Current status, recent changes, known issues |
| `learnings.md` | What worked, what didn't, lessons learned |

The agent can read/write these files to maintain persistent knowledge about the project across sessions.

## Checkpoints

Git-based snapshots in `.smol-agent/checkpoints/`:
- Uses a shadow git repo (doesn't pollute main repo)
- Creates checkpoint before each agent run
- `/undo` restores from last checkpoint
- Preserves both tracked and untracked files

## Context management

The agent manages context window usage to prevent overflow errors from LLM providers:

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
- **Error recovery**: If the provider returns a context overflow error, the agent prunes aggressively and informs the user to retry
- **Token tracking**: Uses real token counts from provider API when available, falls back to estimation

### Implementation

- `ContextManager` class in `context-manager.js` handles all context window logic
- `Agent.getTokenInfo()` returns current usage: `{ used, max, percentage, remaining }`
- UI displays percentage in status bar (yellow > 75%, red > 90%)

## Read-only mode

The agent has a read-only mode that blocks write tools (`write_file`, `replace_in_file`, `run_command`). Toggle with `/readonly` or `/ro` command, or press `Shift+Tab`.

## Architect mode

Separates planning from execution:
1. **Architect pass**: Read-only analysis → produces structured plan
2. **Editor pass**: Executes the plan with write tools

This prevents the agent from jumping into code changes without understanding the problem. Available via `/architect` command.

## Cross-Agent Communication Protocol

Enables agents working in separate repositories to request work from each other using an inbox/letter model. No network protocol — just markdown files and process spawning.

### Directory layout (per repo)

```
.smol-agent/inbox/           ← incoming letters + responses
  <id>.letter.md             ← request from another agent
  <id>.response.md           ← response to a request
.smol-agent/outbox/          ← copies of sent letters (tracking)
  <id>.letter.md
```

### Letter format

Letters use YAML frontmatter + markdown body:
- **Frontmatter**: id, type (request/response), title, from, to, in_reply_to, status, priority, created_at
- **Body sections**: Body, Acceptance Criteria, Context (requests) or Changes Made, API Contract, Notes (responses)

### Global Agent Registry

Agents self-register in `~/.config/smol-agent/agents.json` on startup, auto-detecting name/description from `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`. This allows agents to discover each other by name instead of requiring absolute paths.

Registry entries include: name, path, role, description, **snippet**, relations (e.g., depends-on, serves), lastSeen timestamp.

**Snippets**: Each repo can provide a description snippet that describes what it offers (endpoints, services, data models). Other agents use `find_agent_for_task` to automatically find the right repo to communicate with. Snippets are auto-detected from `.smol-agent/snippet.md` or AGENT.md, or set manually via `/agent snippet` or `set_snippet` tool.

The `send_letter` tool resolves agent names via the registry, so you can write `send_letter({ to: "backend-api", ... })` instead of providing a full path.

### TUI commands

```
/agents                           List all registered agents with relations
/agent info <name>                Show detailed agent info
/agent add <path> [name]          Register a new agent manually
/agent remove <name>              Remove an agent from registry
/agent role <name> <role>         Set agent role (backend, frontend, etc.)
/agent snippet <name> <text...>   Set agent description snippet
/agent link <from> <to> <type>    Link two agents (depends-on, serves, consumes, related)
/agent unlink <from> <to> [type]  Remove a link between agents
```

### Tools

| Tool | Description | Category |
|------|-------------|----------|
| `send_letter` | Send a work request to another agent's inbox (supports name lookup) | network |
| `check_reply` | Check if a reply arrived for a sent letter | safe |
| `read_inbox` | Read letters in this agent's inbox | safe |
| `read_outbox` | Read sent letters and their reply status | safe |
| `reply_to_letter` | Reply to an incoming request after completing work | write |
| `list_agents` | List all registered agents (discover who to send letters to) | safe |
| `link_repos` | Create a relationship between two repos (depends-on, serves, etc.) | safe |
| `set_snippet` | Set this repo's description snippet for auto-discovery | safe |
| `find_agent_for_task` | Find the best agent for a task based on snippet matching | safe |

### Workflow

1. **Frontend agent** uses `send_letter` to drop a request in the backend repo's inbox
2. **Backend watcher** (`--watch-inbox`) detects the new letter and spawns a smol-agent
3. **Backend agent** reads the letter, does the work, writes a response to the inbox
4. Response is delivered back to the frontend repo's inbox
5. **Frontend agent** uses `check_reply` to read the response and continue

### Inbox listening is opt-in

Agents **ignore** inbox letters by default. To process incoming letters, you must explicitly run the inbox watcher:

```bash
# Run the inbox watcher (opt-in, monitors for incoming letters)
smol-agent --watch-inbox -d /path/to/repo -p anthropic
```

The watcher is a long-running process that monitors `.smol-agent/inbox/` for new `.letter.md` files and spawns an agent to handle each one. Without `--watch-inbox`, agents can still _send_ letters and _read_ their inbox, but won't automatically process incoming requests.

### Source files

| File | Purpose |
|------|---------|
| `src/cross-agent.js` | Core protocol: letter serialization, inbox/outbox ops, watcher, agent spawning |
| `src/agent-registry.js` | Global agent registry: registration, discovery, relations, metadata detection |
| `src/tools/cross_agent.js` | Tool registrations: send_letter, check_reply, read_inbox, read_outbox, reply_to_letter, list_agents, link_repos |
| `test/unit/cross-agent.test.js` | Unit tests (16 tests covering serialization, ops, e2e workflow) |
| `test/unit/agent-registry.test.js` | Unit tests (24 tests covering registration, discovery, relations, metadata) |


