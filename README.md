# smol-agent

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A small coding agent that runs in your terminal, powered by [Ollama](https://ollama.com) for local LLM hosting.

smol-agent gives a local language model the tools it needs to read, write, and edit code, run shell commands, search across a codebase, and ask you for clarification when it gets stuck — all wrapped in a colorful [Ink](https://github.com/vadimdemedes/ink)-based terminal UI.

## Table of Contents

- [What it looks like](#what-it-looks-like)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Usage](#usage)
- [Tools](#tools)
- [Context Management](#context-management)
- [Context Injection](#context-injection)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What it looks like

```
 smol-agent (model: qwen2.5-coder:7b)

 you> add error handling to the /users endpoint

   [tool] list_files(pattern: src/**)
   [tool] read_file(path: src/routes/users.js)
   [tool] run_command(command: src/routes/users.js, command: "sed -i s/const users/const safeUsers/ src/routes/users.js")
 ⠋ thinking...
```

Once the agent finishes its tool-call loop, it prints a response:

```
 smol-agent (model: qwen2.5-coder:7b)

 you> add error handling to the /users endpoint

   [tool] list_files(pattern: src/**)
   [tool] read_file(path: src/routes/users.js)
   [tool] run_command(command: src/routes/users.js, command: "sed -i s/const users/const safeUsers/ src/routes/users.js")

 agent> Done. I wrapped the database query in a try/catch and added a 500
        response with a JSON error body. The endpoint now returns
        { "error": "Internal server error" } on failure.

 you> █
```

When the agent needs clarification, it asks inline and waits for your answer:

```
 Agent asks: There are two /users endpoints (in routes/users.js and
 routes/admin.js). Which one should I update?

 answer> █
```

Errors are shown in red:

```
 error: connect ECONNREFUSED 127.0.0.1:11434
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

- **Node.js** >= 18
- **Ollama** running locally (default `http://127.0.0.1:11434`)
- A model pulled in Ollama — the default is `qwen2.5-coder:7b`:
  ```
  ollama pull qwen2.5-coder:7b
  ```
- An [Ollama API key](https://ollama.com/settings/keys) (free) — required for `web_search` and `web_fetch` tools. Set it as `OLLAMA_API_KEY` in your environment:
  ```
  export OLLAMA_API_KEY=your-key-here
  ```

## Install

### Quick Install (recommended)

```bash
git clone https://github.com/smol-ai/smol-agent.git
cd smol-agent
./install.sh
```

The installer will:
1. Check Node.js and npm are installed
2. Install npm dependencies
3. Link `smol-agent` globally

### Manual Install

```bash
git clone https://github.com/smol-ai/smol-agent.git
cd smol-agent
npm install
npm link   # makes `smol-agent` available globally
```

### Via npm (coming soon)

```bash
npm install -g smol-agent
```

## Update

To update to the latest version:

```bash
cd smol-agent
git pull
npm install
```

## Uninstall

```bash
npm unlink
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
| `-m, --model <name>` | Ollama model to use (default: `qwen2.5-coder:7b`) |
| `-H, --host <url>` | Ollama server URL (default: `http://127.0.0.1:11434`) |
| `--help` | Show help |

### Commands (interactive mode)

| Command | Description |
|---------|-------------|
| `/reset` | Clear conversation history |
| `exit` / `quit` | Exit the agent |
| `Ctrl-C` | Cancel current operation / Exit on double tap |

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

The model decides which tools to call and when. It will loop — calling tools and feeding results back in — until it produces a final text response.

## Context Management

smol-agent includes intelligent context management to handle large conversations without hitting token limits:

- **Proactive pruning** — Removes old messages when approaching 70% of context capacity
- **Aggressive pruning** — At 85% capacity, more aggressively prunes history
- **Tool result truncation** — Large outputs are automatically truncated to 15k characters
- **Error recovery** — If Ollama returns a context overflow error, the agent prunes and informs you to retry

The context manager keeps the system prompt and recent conversation while removing older messages as needed.

## Context Injection

When the agent starts (or after `/reset`), it automatically gathers context about the current project and injects it into the system prompt. This gives the model immediate awareness of:

- **Working directory** and **file tree** (top 2 levels, ignoring node_modules/.git/etc.)
- **Git status** — current branch, uncommitted changes, and recent commit history
- **Config files** — package.json, tsconfig.json, pyproject.toml, Cargo.toml, go.mod, Makefile, .env.example (whichever exist)
- **README excerpt** — first 80 lines of any README file

This means the model already knows your project layout, language, dependencies, and available scripts before you even ask your first question — so it can give better answers with fewer tool calls.

## Architecture

```
src/
├── index.js              CLI entry point, arg parsing, Ink render
├── agent.js              Agent loop (EventEmitter): prompt → LLM → tool calls → repeat
├── context.js            Project context gathering (file tree, git, configs, README)
├── context-manager.js    Token counting, context pruning, message summarization
├── conversation-summarizer.js  Token estimation utilities
├── logger.js             Logging with configurable levels
├── ollama.js             Thin wrapper around the ollama npm package
├── path-utils.js         Path resolution and jail security
├── plan-tracker.js       Plan state management and persistence
├── ui/
│   ├── App.js            Ink (React) terminal UI — message log, spinner, input
│   ├── MultilineInput.js Multiline text input with paste support
│   └── markdown.js       Rich markdown rendering for terminal output
└── tools/
    ├── registry.js       Tool registration and dispatch
    ├── file_tools.js     read_file, write_file, replace_in_file
    ├── list_files.js     Glob-based file listing
    ├── grep.js           Regex search across files
    ├── run_command.js    Shell command execution
    ├── web_search.js     Web search via Ollama API
    ├── web_fetch.js      URL fetch via Ollama API
    ├── ask_user.js       Ask the user for clarification
    ├── plan_tools.js     Plan management tools
    ├── save_plan.js      Plan persistence utilities
    └── reflection.js     Work reflection and summarization
```

Each tool file self-registers with the registry on import. The agent imports them all, and the registry serializes them into the format Ollama expects for tool-calling.

On first run, `context.js` gathers a snapshot of the project (file tree, git state, config files, README) and appends it to the system prompt. This gives the model grounding in the project before any tool calls happen.

The Ink UI subscribes to `tool_call`, `tool_result`, `response`, and `error` events emitted by the agent, rendering tool activity in real time with a spinner and status text. The `ask_user` tool is wired through a promise bridge so the Ink app collects the answer inline without readline conflicts.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- **Bug reports**: Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests**: Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- **Pull requests**: See the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

## Security

Please review our [Security Policy](SECURITY.md) before reporting vulnerabilities.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Ollama](https://ollama.com) for local LLM inference
- UI powered by [Ink](https://github.com/vadimdemedes/ink) (React for terminals)
- Inspired by the many AI coding assistants making development easier