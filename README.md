# smol-agent

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A small coding agent that runs in your terminal, powered by [Ollama](https://ollama.com) for local LLM hosting.

smol-agent gives a local language model the tools it needs to read, write, and edit code, run shell commands, search across a codebase, and ask you for clarification when it gets stuck — all wrapped in a colorful [pi-tui](https://github.com/mariozechner/pi-tui) and chalk-based terminal UI.

## Table of Contents

- [What it looks like](#what-it-looks-like)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Usage](#usage)
- [Tools](#tools)
- [Context Management](#context-management)
- [Context Injection](#context-injection)
- [Persistent Memory](#persistent-memory)
- [Skills](#skills)
- [Architecture](#architecture)
- [Cross-Agent Communication](#cross-agent-communication)
- [Advanced Features](#advanced-features)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What it looks like

```
smol-agent (model: qwen2.5-coder:32b)

 > add error handling to the /users endpoint

    ⎿  (project context gathered)
    ⎿  [tool] list_files(pattern: src/**)
    ⎿  [tool] read_file(filePath: src/routes/users.js)
    ⎿  [tool] replace_in_file(filePath: src/routes/users.js, oldText: ..., newText: ...)
 ⏋ thinking...
```

When the agent finishes, it streams a response:

```
 ▸  I've added error handling to the `/users` endpoint. The changes include:

    - Input validation for request body
    - Try-catch around database operations  
    - Proper error responses with status codes

    See src/routes/users.js for the implementation.
```

When the agent needs clarification:

```
 ?  Which /users endpoint should I modify? [answer]
    ⎿  (answer) the public one

 > continue...
```

Errors are shown in red:

```
 ✗ connect ECONNREFUSED 127.0.0.1:11434
```

### Rich Markdown Rendering

Agent responses are rendered with rich markdown formatting in the terminal:

- **Headers** (`#`, `##`, `###`) are displayed in different colors and weights
- **Bold text** (`**text**`) appears in bold
- **Italic text** (`*text*` or `_text_`) appears in italics
- **Inline code** (`` `code` ``) appears in cyan
- **Code blocks** (``` ```code``` ```) are displayed with gray text
- **Blockquotes** (`> quote`) appear in gray and italic
- **Lists** (`- item` or `1. item`) are displayed with bullet points or numbers
- **Links** (`[text](url)`) appear in blue with underlines, showing both text and URL
- **Strikethrough** (`~~text~~`) appears dimmed

This makes agent responses much easier to read and understand at a glance.

## Prerequisites

- **Node.js** >= 20.0.0
- **Ollama** running locally (default `http://127.0.0.1:11434`) **OR** API access to OpenAI, Anthropic, Grok, Groq, or Gemini

### Setting up Ollama

If using Ollama (the default provider):

1. Install Ollama from [ollama.com](https://ollama.com)
2. Pull a model:
   ```
   ollama pull qwen2.5-coder:32b
   ```
   > **Note**: For machines with limited RAM, `qwen2.5-coder:7b` or `qwen3-coder:14b` work well too.
3. (Optional) Get an [Ollama API key](https://ollama.com/settings/keys) for `web_search` and `web_fetch` tools:
   ```
   export OLLAMA_API_KEY=your-key-here
   ```

### Setting up OpenAI

To use OpenAI's models (GPT-4o, GPT-4, etc.):

1. Get an API key from [OpenAI's platform](https://platform.openai.com/api-keys)
2. Set the environment variable:
   ```bash
   export OPENAI_API_KEY=your-key-here
   ```
3. Run with the OpenAI provider:
   ```bash
   smol-agent -p openai "your prompt here"
   ```

Default model: `gpt-4o`

### Setting up Anthropic

To use Anthropic's Claude models:

1. Get an API key from [Anthropic's console](https://console.anthropic.com/)
2. Set the environment variable:
   ```bash
   export ANTHROPIC_API_KEY=your-key-here
   ```
3. Run with the Anthropic provider:
   ```bash
   smol-agent -p anthropic "your prompt here"
   ```

Default model: `claude-sonnet-4-20250514`

### Setting up Grok (xAI)

To use xAI's Grok models:

1. Get an API key from [xAI's console](https://console.x.ai/)
2. Set the environment variable:
   ```bash
   export XAI_API_KEY=your-key-here
   ```
3. Run with the Grok provider:
   ```bash
   smol-agent -p grok "your prompt here"
   ```

Default model: `grok-4-latest`

### Setting up Groq

To use Groq's fast inference:

1. Get an API key from [Groq's console](https://console.groq.com/)
2. Set the environment variable:
   ```bash
   export GROQ_API_KEY=your-key-here
   ```
3. Run with the Groq provider:
   ```bash
   smol-agent -p groq "your prompt here"
   ```

Default model: `openai/gpt-oss-120b`

### Setting up Gemini (Google)

To use Google's Gemini models:

1. Get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Set the environment variable:
   ```bash
   export GEMINI_API_KEY=your-key-here
   ```
3. Run with the Gemini provider:
   ```bash
   smol-agent -p gemini "your prompt here"
   ```

Default model: `gemini-2.5-pro`

### Custom OpenAI-Compatible Endpoints

You can use any OpenAI-compatible API by passing the base URL as the provider:

```bash
smol-agent -p https://your-api.example.com/v1 "your prompt here"
```

This works with self-hosted models (vLLM, LocalAI, etc.) and other OpenAI-compatible services.

### Optional: tree-sitter (for enhanced code analysis)

smol-agent can use [tree-sitter](https://tree-sitter.github.io/tree-sitter/) for enhanced code analysis:

- **Repository Map**: Builds a "table of contents" of your codebase showing key symbols (functions, classes, types) with their file locations. This gives the agent structural understanding without requiring multiple grep/read calls.
- **Syntax Validation**: After file edits, validates syntax to catch obvious errors before the agent proceeds.

**Requirements**: tree-sitter requires Node.js 18-22 (it does **not** build on Node 23+ due to C++20 requirements). To enable:

```bash
npm install tree-sitter tree-sitter-javascript tree-sitter-python tree-sitter-typescript tree-sitter-go
```

> **Note:** If installation fails, smol-agent will still work but without these enhanced features.

## Install

### Quick Install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/streed/smol-agent/main/install.sh | sh
```

This will:
1. Check Node.js, npm, and git are installed
2. Clone smol-agent to `~/.local/share/smol-agent`
3. Install npm dependencies
4. Link `smol-agent` globally

### Manual Install

```bash
git clone https://github.com/streed/smol-agent.git
cd smol-agent
npm install
npm link   # makes `smol-agent` available globally
```

### Via npm (coming soon)

```bash
npm install -g smol-agent
```

## Update

### Self-update (installed via curl | sh)

If you installed via the one-liner, update to the latest version with:

```bash
smol-agent --self-update
```

This pulls the latest changes and reinstalls dependencies automatically.

### Manual update (git clone)

If you cloned manually:

```bash
cd smol-agent
git pull
npm install
```

## Uninstall

If installed via `curl | sh`:

```bash
npm unlink -g smol-agent
rm -rf ~/.local/share/smol-agent
rm -rf ~/.config/smol-agent
```

If installed via git clone:

```bash
npm unlink -g smol-agent
rm -rf smol-agent
```

## Usage

```
smol-agent [options] [prompt]
```

**Interactive mode** — launch with no arguments to get a REPL:

```
smol-agent
```

**One-shot mode** — pass a prompt directly:

```
smol-agent "add input validation to src/api.js"
```

### Options

| Flag | Description |
|------|-------------|
| `-m, --model <name>` | Model to use (default depends on provider) |
| `-p, --provider <name>` | LLM provider: `ollama`, `openai`, `anthropic`, `grok`, `groq`, `gemini` (default: `ollama`) |
| `-H, --host <url>` | Provider host/base URL (default: provider-specific) |
| `--api-key <key>` | API key for cloud providers (or use env vars) |
| `-d, --directory <path>` | Set working directory and jail boundary (default: cwd) |
| `--all-tools` | Expose all tools (auto-detected for 30B+ models) |
| `--auto-approve` | Skip approval prompts for write/command tools (alias: `--yolo`) |
| `--acp` | Run as ACP (Agent Client Protocol) server over stdio |
| `--self-update` | Update smol-agent to the latest version |
| `--help` | Show help message |

### Session Management

| Flag | Description |
|------|-------------|
| `-s, --session <id>` | Resume a saved session by ID or name |
| `-c, --continue` | Resume the most recent session |
| `--session-name <name>` | Name for the new session |
| `--list-sessions` | List all saved sessions |
| `--sessions` | Alias for `--list-sessions` |

### Commands (interactive mode)

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history and start a new session |
| `/sessions` | List saved sessions |
| `/session save [name]` | Save the current session (with optional name) |
| `/session load <id>` | Load a saved session by ID |
| `/session delete <id>` | Delete a saved session by ID |
| `/session rename <id> <name>` | Rename a saved session |
| `/inspect` | Dump current context to CONTEXT.md |
| `/reload-skills` | Reload skills from global and local directories |
| `/skills` | List available skills |
| `/reflect` | Analyze recent logs for skill opportunities |
| `exit` / `quit` | Exit the agent |
| `Ctrl-C` | Cancel current operation (double-tap to exit) |

## Tools

The agent has access to the following tools:

### Core Tools (always available)

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with optional line offset/limit |
| `write_file` | Write content to a file (creates or overwrites) |
| `replace_in_file` | Find and replace text in a file |
| `list_files` | Glob-based file and directory listing |
| `grep` | Regex search across files with line numbers |
| `run_command` | Execute shell commands (builds, tests, git, etc.) |
| `git` | Git commands with safety restrictions (blocks push, --force) |
| `ask_user` | Ask the user a clarifying question and wait for a response |

### Extended Tools (available when needed)

| Tool | Description |
|------|-------------|
| `web_search` | Search the web via [Ollama's web search API](https://docs.ollama.com/capabilities/web-search) |
| `web_fetch` | Fetch a URL and return its content via [Ollama's web fetch API](https://docs.ollama.com/capabilities/web-search) |
| `save_plan` | Save a plan to a markdown file for tracking |
| `load_plan_progress` | Load current plan progress and state |
| `get_current_plan` | Get the content of the currently active plan |
| `complete_plan_step` | Mark a plan step as completed |
| `update_plan_status` | Update plan status (in-progress, completed, paused, abandoned) |
| `reflect` | Summarize work done, what went well, and areas for improvement |
| `remember` | Save a fact/pattern/preference to persistent memory across sessions |
| `recall` | Retrieve memories from persistent storage |
| `save_context` | Save a dense summary of a directory/code area for future sessions |
| `delegate` | Spawn a sub-agent for focused research tasks |

## Context Management

The agent manages context window limits automatically:

1. **Token tracking**: Monitors token usage throughout the conversation
2. **Intelligent pruning**: When approaching limits, removes less important messages first
3. **Context summarization**: Summarizes old conversation turns to compress context
4. **Result truncation**: Truncates large tool results while preserving key information

This allows the agent to work on large codebases without running into context window errors.

## Context Injection

smol-agent can inject project-specific context into the system prompt:

- **AGENT.md**: Place a file named `AGENT.md` in your project root. It will be included in the context sent to the LLM.
- **Skills**: Markdown files in `.smol-agent/skills/` or `~/.config/smol-agent/skills/` are loaded as skills.

## Persistent Memory

The agent can remember facts across sessions using the `remember` and `recall` tools:

- **remember**: Save a fact, pattern, or preference to persistent storage
- **recall**: Retrieve memories (optionally filtered by key or category)

Memories are stored in `~/.config/smol-agent/memories.json` and persist across sessions.

## Skills

Skills are markdown files that define reusable prompts for common tasks:

- **Location**: `.smol-agent/skills/` (project) or `~/.config/smol-agent/skills/` (global)
- **Format**: Markdown with `# Skill Name` and `Description: ...` in the header
- **Loading**: Skills are loaded on startup and injected into the system prompt

Example skill:

```markdown
# Fix Lint Errors
Description: Fix linting errors in the codebase

Find and fix all linting errors in the project. Run the linter first to identify issues, then fix each one systematically.
```

## Architecture

```
User prompt → Agent.run() → LLM Provider API → tool calls → execute tools → feed results back → repeat until text response
```

The agent is an EventEmitter that drives a loop: send messages to the LLM provider, check for tool calls, execute them, push results back, and repeat (max 25 iterations). The pi-tui UI subscribes to events (`tool_call`, `tool_result`, `response`, `error`) to render progress.

## Advanced Features

### ACP Server Mode

Run as an Agent Client Protocol server for IDE/editor integration:

```bash
smol-agent --acp
```

Communicates via JSON-RPC over stdio, compatible with ACP-compatible editors.

## Cross-Agent Communication

smol-agent instances can communicate across repositories using the **inbox/letter protocol**. This allows a frontend agent to request backend changes, a main agent to delegate to a documentation agent, etc.

### How It Works

```
Agent A                          Agent B
  |                                |
  |  1. find_agent_for_task()      |
  |  2. send_letter() --------->  inbox/.letter.md
  |                                |  3. watchInbox detects letter
  |                                |  4. Spawns agent, does work
  |                                |  5. reply_to_letter()
  |  inbox/.response.md  <------- |
  |  6. Auto-notified via watcher  |
  |  (injected into conversation)  |
```

### Agent Discovery

Agents self-register in a global registry (`~/.config/smol-agent/agents.json`) on startup. Use these tools to find and communicate with other agents:

| Tool | Description |
|------|-------------|
| `list_agents` | List all registered agents |
| `find_agent_for_task` | Find the best agent for a task (keyword matching against snippets) |
| `send_letter` | Send a work request to another agent (supports `wait_for_reply`) |
| `check_reply` | Poll for a response to a sent letter |
| `reply_to_letter` | Send a response back after completing work |
| `link_repos` | Create relationships between repos (depends-on, serves, etc.) |

### Response Delivery

Responses are delivered through three complementary mechanisms:

1. **Auto-notification** (default) -- A file watcher detects incoming `.response.md` files and injects the reply into the running conversation automatically.
2. **Blocking wait** -- `send_letter(wait_for_reply: true)` blocks until the reply arrives (up to 5 minutes).
3. **Manual poll** -- `check_reply(letter_id)` for explicit polling.

If a spawned agent exits without calling `reply_to_letter`, the system auto-generates a completed/failed response as a safety net.

### Inbox Watcher Mode

Run a persistent watcher that processes incoming letters:

```bash
smol-agent --watch-inbox
```

See [docs/cross-agent-communication.md](docs/cross-agent-communication.md) for the full protocol specification with Mermaid diagrams.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

smol-agent operates within a "jail" directory:

- All file operations are restricted to the jail directory
- Commands like `rm -rf /` are blocked
- Git push and `--force` are blocked

However, **you are responsible for reviewing changes** before approving tool calls. The agent will ask for approval before:

- Writing files
- Running shell commands

Use `--auto-approve` (or `--yolo`) to skip approvals (use with caution).

## License

[MIT](LICENSE)