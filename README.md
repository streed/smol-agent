# smol-agent

A small coding agent that runs in your terminal, powered by [Ollama](https://ollama.com) for local LLM hosting.

smol-agent gives a local language model the tools it needs to read, write, and edit code, run shell commands, search across a codebase, and ask you for clarification when it gets stuck — all wrapped in a colorful [Ink](https://github.com/vadimdemedes/ink)-based terminal UI.

## Prerequisites

- **Node.js** >= 18
- **Ollama** running locally (default `http://127.0.0.1:11434`)
- A model pulled in Ollama — the default is `qwen2.5-coder:7b`:
  ```
  ollama pull qwen2.5-coder:7b
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
| `exit` / `quit` | Exit the agent |
| `Ctrl-C` | Exit the agent |

## Tools

The agent has access to the following tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with optional line offset/limit |
| `write_file` | Create or overwrite files (creates parent directories) |
| `edit_file` | Find-and-replace editing within a file |
| `list_files` | Glob-based file and directory listing |
| `shell` | Execute shell commands (builds, tests, git, etc.) |
| `grep` | Regex search across files with line numbers |
| `ask_user` | Ask the user a clarifying question and wait for a response |

The model decides which tools to call and when. It will loop — calling tools and feeding results back in — until it produces a final text response.

## Architecture

```
src/
├── index.js              CLI entry point, arg parsing, Ink render
├── agent.js              Agent loop (EventEmitter): prompt → LLM → tool calls → repeat
├── ollama.js             Thin wrapper around the ollama npm package
├── ui/
│   └── App.js            Ink (React) terminal UI — message log, spinner, input
└── tools/
    ├── registry.js       Tool registration and dispatch
    ├── read_file.js      Read file contents
    ├── write_file.js     Write/create files
    ├── edit_file.js      Find-and-replace editing
    ├── list_files.js     Glob-based file listing
    ├── shell.js          Shell command execution
    ├── grep.js           Regex search across files
    └── ask_user.js       Ask the user for clarification
```

Each tool file self-registers with the registry on import. The agent imports them all, and the registry serializes them into the format Ollama expects for tool-calling.

The Ink UI subscribes to `tool_call`, `tool_result`, `response`, and `error` events emitted by the agent, rendering tool activity in real time with a spinner and status text. The `ask_user` tool is wired through a promise bridge so the Ink app collects the answer inline without readline conflicts.

## License

MIT
