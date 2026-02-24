# smol-agent

A small coding agent that runs in your terminal, powered by [Ollama](https://ollama.com) for local LLM hosting.

smol-agent gives a local language model the tools it needs to read, write, and edit code, run shell commands, search across a codebase, and ask you for clarification when it gets stuck — all wrapped in a colorful [Ink](https://github.com/vadimdemedes/ink)-based terminal UI.

## What it looks like

```
 smol-agent (model: qwen2.5-coder:7b)

 you> add error handling to the /users endpoint

   [tool] list_files(pattern: src/**)
   [tool] read_file(path: src/routes/users.js)
   [tool] edit_file(path: src/routes/users.js, old_string: const users = db.q...)
 ⠋ thinking...
```

Once the agent finishes its tool-call loop, it prints a response:

```
 smol-agent (model: qwen2.5-coder:7b)

 you> add error handling to the /users endpoint

   [tool] list_files(pattern: src/**)
   [tool] read_file(path: src/routes/users.js)
   [tool] edit_file(path: src/routes/users.js, old_string: const users = db.q...)

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

```bash
git clone <repo-url> && cd small-coding-agent
npm install

# Option A: run directly
npm start

# Option B: install globally as a CLI
npm link
smol-agent
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
| `/help` | Show available commands |
| `exit` / `quit` | Exit the agent |
| `Ctrl-C` | Exit the agent |

## Tools

The agent has access to the following tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with optional line offset/limit |
| `write_file` | Create or overwrite files (creates parent directories) |
| `edit_file` | Find-and-replace editing within a file |
| `delete_file` | Delete a file |
| `list_files` | Glob-based file and directory listing |
| `shell` | Execute shell commands (builds, tests, git, etc.) |
| `grep` | Regex search across files with line numbers |
| `web_search` | Search the web via [Ollama's web search API](https://docs.ollama.com/capabilities/web-search) |
| `web_fetch` | Fetch a URL and return its content via [Ollama's web fetch API](https://docs.ollama.com/capabilities/web-search) |
| `ask_user` | Ask the user a clarifying question and wait for a response |

The model decides which tools to call and when. It will loop — calling tools and feeding results back in — until it produces a final text response.

## Context injection

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
├── ollama.js             Thin wrapper around the ollama npm package
├── ui/
│   └── App.js            Ink (React) terminal UI — message log, spinner, input
└── tools/
    ├── registry.js       Tool registration and dispatch
    ├── read_file.js      Read file contents
    ├── write_file.js     Write/create files
    ├── edit_file.js      Find-and-replace editing
    ├── delete_file.js    Delete a file
    ├── list_files.js     Glob-based file listing
    ├── shell.js          Shell command execution
    ├── grep.js           Regex search across files
    ├── web_search.js     Web search via Ollama API
    ├── web_fetch.js      URL fetch via Ollama API
    └── ask_user.js       Ask the user for clarification
```

Each tool file self-registers with the registry on import. The agent imports them all, and the registry serializes them into the format Ollama expects for tool-calling.

On first run, `context.js` gathers a snapshot of the project (file tree, git state, config files, README) and appends it to the system prompt. This gives the model grounding in the project before any tool calls happen.

The Ink UI subscribes to `tool_call`, `tool_result`, `response`, and `error` events emitted by the agent, rendering tool activity in real time with a spinner and status text. The `ask_user` tool is wired through a promise bridge so the Ink app collects the answer inline without readline conflicts.

## License

MIT
