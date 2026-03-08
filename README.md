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
- [Persistent Memory](#persistent-memory)
- [Skills](#skills)
- [Architecture](#architecture)
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

- **Node.js** >= 18
- **Ollama** running locally (default `http://127.0.0.1:11434`)
- A model pulled in Ollama — the default is `qwen2.5-coder:32b`:
  ```
  ollama pull qwen2.5-coder:32b
  ```
  > **Note**: For machines with limited RAM, `qwen2.5-coder:7b` or `qwen3-coder:14b` work well too.
- An [Ollama API key](https://ollama.com/settings/keys) (free) — required for `web_search` and `web_fetch` tools. Set it as `OLLAMA_API_KEY` in your environment:
  ```
  export OLLAMA_API_KEY=your-key-here
  ```

### Running Ollama as a systemd Service (Linux)

To run Ollama as a background service on Linux:

1. Create a systemd unit file at `/etc/systemd/system/ollama.service`:

   ```ini
   [Unit]
   Description=Ollama Service
   After=network.target

   [Service]
   Type=simple
   User=ollama
   Group=ollama
   ExecStart=/usr/local/bin/ollama serve
   Restart=always
   RestartSec=3
   Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

   [Install]
   WantedBy=multi-user.target
   ```

2. Create the ollama user (if not already created by the installer):

   ```bash
   sudo useradd -r -s /bin/false -m -d /usr/share/ollama ollama
   ```

3. Enable and start the service:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable ollama
   sudo systemctl start ollama
   ```

4. Verify it's running:

   ```bash
   sudo systemctl status ollama
   ollama list  # should list your pulled models
   ```

**Optional configuration** (add to the `[Service]` section):

- Set custom model storage: `Environment="OLLAMA_MODELS=/var/lib/ollama/models"`
- Limit GPU access: `Environment="CUDA_VISIBLE_DEVICES=0"`
- Expose to network: `Environment="OLLAMA_HOST=0.0.0.0:11434"`

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
| `-m, --model <name>` | Ollama model to use (default: `qwen2.5-coder:32b`) |
| `-H, --host <url>` | Ollama server URL (default: `http://127.0.0.1:11434`) |
| `-d, --directory <path>` | Set working directory and jail boundary (default: cwd) |
| `--all-tools` | Expose all tools (auto-detected for 30B+ models) |
| `--auto-approve` | Skip approval prompts for write/command tools (alias: `--yolo`) |
| `--approve-writes` | Auto-approve file write operations only |
| `--approve-execute` | Auto-approve command execution only |
| `--acp` | Run as ACP (Agent Client Protocol) server over stdio |
| `--self-update` | Update smol-agent to the latest version |
| `--help` | Show help |

### Commands (interactive mode)

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history |
| `/model <name>` | Switch to a different model |
| `/model list` | List available models |
| `/inspect` | Dump current context to CONTEXT.md |
| `/reload-skills` | Reload skills from global and local directories |
| `/skills` | List available skills |
| `/reflect` | Analyze recent logs for skill opportunities |
| `/architect <task>` | Run in architect mode (read-only analysis → plan → execute) |
| `/undo` | Roll back to the last git checkpoint |
| `/checkpoints` | List available checkpoints |
| `/approve <category>` | Auto-approve a tool category (read/write/execute/network/safe) |
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
| `memory_bank_read` | Read structured Memory Bank files (project context, tech context, progress, learnings) |
| `memory_bank_write` | Write to structured Memory Bank files for cross-session knowledge |
| `memory_bank_init` | Initialize Memory Bank with template files |
| `save_context` | Save a dense summary of a directory/code area for future sessions |
| `delegate` | Spawn a read-only sub-agent for focused research tasks |

The model decides which tools to call and when. It will loop — calling tools and feeding results back in — until it produces a final text response.

## Context Management

smol-agent includes intelligent context management to handle large conversations without hitting token limits:

- **Proactive summarization** — At 55% capacity, starts LLM-based summarization of old messages
- **Pruning** — At 70% capacity, removes old messages and large tool results
- **Aggressive pruning** — At 85% capacity, more aggressively prunes history
- **Tool result truncation** — Large outputs are automatically truncated to 15k characters
- **Error recovery** — If Ollama returns a context overflow error, the agent prunes and informs you to retry

The context manager keeps the system prompt and recent conversation while removing older messages as needed.

## Context Injection

When the agent starts (or after `/clear`), it automatically gathers context about the current project and injects it into the system prompt. This gives the model immediate awareness of:

- **Working directory** and **file tree** (top 2 levels, ignoring node_modules/.git/etc.)
- **Repository map** — tree-sitter AST-based symbol extraction with PageRank cross-file reference ranking (inspired by [Aider](https://aider.chat)), showing the most important files and their key symbols
- **Git status** — current branch and uncommitted changes
- **Project type** — detected from manifest files (package.json, pyproject.toml, Cargo.toml, etc.)
- **AGENT.md excerpt** — first 100 lines of AGENT.md if present
- **Memory Bank** — structured cross-session knowledge (project context, tech context, progress, learnings)
- **Shared coding rules** — automatically detects and follows rule files from other tools (`.cursorrules`, `CLAUDE.md`, `.clinerules`, etc.)

This means the model already knows your project layout, language, dependencies, key symbols, and available scripts before you even ask your first question — so it can give better answers with fewer tool calls.

## Persistent Memory

smol-agent remembers things across sessions using four mechanisms, all stored in the `.smol-agent/` directory (gitignored by default):

### Key-value memories (`.smol-agent/memory.json`)

The agent can call `remember` to store facts like test commands, coding conventions, or project quirks. These are automatically loaded into the system prompt on startup. Use `recall` to retrieve them.

### Memory Bank (`.smol-agent/memory-bank/`)

Inspired by [Kilocode](https://github.com/kilocode/kilocode), the Memory Bank stores structured cross-session knowledge in markdown files:

- **projectContext.md** — What the project does, tech stack, key goals
- **techContext.md** — Architecture decisions, patterns, conventions
- **progress.md** — Current status, recent changes, known issues
- **learnings.md** — What worked, what didn't, lessons learned

Use `memory_bank_init` to create the templates, then the agent updates them as it learns about your project. All Memory Bank content is automatically injected into the system prompt on startup.

### Context docs (`.smol-agent/docs/`)

After exploring a directory, the agent can call `save_context` to write a short, dense summary (key files, exports, patterns). On next startup, the system prompt lists available docs so the agent can `read_file` them instead of re-exploring from scratch.

### Skills

Skills are user-authored markdown files that teach the agent domain-specific workflows. They can be:

- **Global skills** (`~/.config/smol-agent/skills/`) — available across all projects
- **Local skills** (`.smol-agent/skills/`) — project-specific, can override global skills by name

Skills use the `SKILL.md` format in subdirectories:

```bash
# Example: project-specific testing skill
.smol-agent/skills/testing/SKILL.md
```

```markdown
---
name: testing
description: How to run and write tests for this project
---

## Running tests
npm test              # unit tests
npm run test:e2e      # end-to-end tests

## Conventions
- Test files go in test/unit/ with .test.js suffix
- Use Jest globals: `describe`, `test`, `expect` from `@jest/globals`
```

On startup, the agent sees the `name` and `description` from frontmatter in its system prompt (with source: "global" or "local"). When a skill is relevant, it reads the full file for detailed instructions.

**Example: Set up a global git workflow skill**

```bash
mkdir -p ~/.config/smol-agent/skills/git
cat > ~/.config/smol-agent/skills/git/SKILL.md << 'EOF'
---
name: git
description: Git workflow and commit conventions
---

## Commit message format
- Use conventional commits: feat:, fix:, docs:, refactor:, test:
- Keep first line under 50 chars
- Reference issues: #123

## Branch naming
- feature/<description>
- fix/<description>
EOF
```

## Architecture

```
src/
├── index.js              CLI entry point, arg parsing, TUI render
├── agent.js              Agent loop (EventEmitter): prompt → LLM → tool calls → repeat
│                         Includes architect mode, git checkpoints, granular auto-approve
├── architect.js          Architect mode — read-only analysis pass → plan → execution
├── checkpoint.js         Git stash-based checkpoints for rollback (undo support)
├── context.js            Project context gathering (file tree, git, repo map, memory bank)
├── context-manager.js    Token counting, context pruning, message summarization
├── logger.js             Logging with configurable levels
├── memory-bank.js        Structured cross-session knowledge (Kilocode-inspired)
├── ollama.js             Thin wrapper around the ollama npm package
├── path-utils.js         Path resolution and jail security
├── repo-map.js           Tree-sitter AST symbol extraction with PageRank ranking (Aider-inspired)
├── skills.js             Skill loading and frontmatter parsing
├── ts-lint.js            Tree-sitter based syntax checking after edits (Aider-inspired)
├── ui/
│   ├── App.js            Terminal UI — message log, status, input, slash commands
│   └── markdown.js       Rich markdown rendering for terminal output
└── tools/
    ├── registry.js       Tool registration, dispatch, and per-category approval
    ├── file_tools.js     read_file, write_file, replace_in_file (with fuzzy matching and lint)
    ├── list_files.js     Glob-based file listing
    ├── grep.js           Regex search across files
    ├── run_command.js    Shell command execution
    ├── web_search.js     Web search via Ollama API
    ├── web_fetch.js      URL fetch via Ollama API
    ├── ask_user.js       Ask the user for clarification
    ├── git.js            Git operations (with safety restrictions)
    ├── plan_tools.js     Plan management tools
    ├── save_plan.js      Plan persistence utilities
    ├── reflection.js     Work reflection and summarization
    ├── memory.js         Persistent remember/recall and Memory Bank tools
    ├── context_docs.js   save_context tool for directory summaries
    └── sub_agent.js      Delegate tool for focused sub-agent tasks
```

Each tool file self-registers with the registry on import. The agent imports them all, and the registry serializes them into the format Ollama expects for tool-calling.

On first run, `context.js` gathers a snapshot of the project (file tree, repo map, git state, AGENT.md excerpt, memory bank) and appends it to the system prompt. This gives the model grounding in the project before any tool calls happen.

The terminal UI subscribes to `tool_call`, `tool_result`, `response`, and `error` events emitted by the agent, rendering tool activity in real time. The `ask_user` tool is wired through a promise bridge so the UI collects the answer inline.

## Advanced Features

### Architect Mode (inspired by Aider/Kilocode)

Architect mode uses a two-pass approach for complex tasks:

1. **Analysis pass** — The agent reads files and analyzes the codebase in read-only mode, producing an implementation plan
2. **Execution pass** — The plan is handed to an editor pass that makes the actual changes

Use `/architect <task>` to run a task in architect mode, or `/architect` to toggle it for the next prompt.

### Git Checkpoints

The agent automatically creates git stash-based checkpoints before each operation. Use `/undo` to roll back to the previous checkpoint, or `/checkpoints` to list available restore points.

### Repository Map with PageRank (inspired by Aider)

The repo map uses tree-sitter to parse source files and extract symbols (functions, classes, types, exports) across 7 languages (JS/TS, Python, Go, Rust, Java, Ruby). Cross-file references are analyzed using a directed graph, and files are ranked by PageRank score — surfacing the most important and interconnected files in the codebase.

### Fuzzy Diff Matching (inspired by Kilocode)

When `replace_in_file` can't find an exact match, it falls back through:

1. **Whitespace-normalized matching** — ignores tab/space differences
2. **Fuzzy matching** (80% similarity threshold) — finds the best approximate match using line-level similarity scoring
3. **Hint-based error** — suggests the closest matching line if no fuzzy match is found

### Tree-sitter Syntax Lint (inspired by Aider)

After every `write_file` and `replace_in_file`, the modified file is parsed with tree-sitter to detect syntax errors. If ERROR nodes are found in the AST, a `syntaxWarning` is included in the tool result, alerting the agent to fix the issue immediately.

### Granular Auto-Approve

Instead of all-or-nothing `--auto-approve`, you can approve specific categories:

- `--approve-writes` — auto-approve file write operations
- `--approve-execute` — auto-approve command execution
- `/approve <category>` — approve a category interactively (read/write/execute/network/safe)

## Model Benchmark

smol-agent is tested against a variety of Ollama models to ensure it works well across different model sizes and capabilities. The benchmark runs end-to-end tests on each model, validating that tool calling, file operations, and command execution work correctly.

### Latest Results

<!-- BENCHMARK-RESULTS-START -->
_No benchmark results yet. Results will appear here after the next benchmark run._
<!-- BENCHMARK-RESULTS-END -->

### Running the Benchmark

The benchmark is automated via GitHub Actions. To run it locally:

```bash
# Install dependencies
npm install

# Run E2E tests with a specific model
SMOL_TEST_MODEL=qwen2.5-coder:32b node test/e2e/runner.js
```

### Benchmark Configuration

The benchmark uses the following parameters:

| Variable | Description | Default |
|----------|-------------|---------|
| `SMOL_TEST_MODEL` | Model to test | `qwen2.5-coder:32b` |
| `SMOL_TEST_RETRIES` | Number of retries on failure | 1 |
| `SMOL_TEST_MAX_ITER` | Max tool call iterations per test | 20 |
| `SMOL_TEST_CTX` | Context window size | 32768 |

Check the [GitHub Actions workflow](https://github.com/streed/smol-agent/actions) for the latest benchmark results. Each model run produces detailed test output showing which tasks passed or failed.

### Choosing a Model

- **Recommended for most users**: `qwen2.5-coder:7b` or `qwen3-coder:14b` — good balance of speed and capability
- **For larger projects**: Use 30B+ models like `qwen3-coder:32b` or `qwen3-coder-next` for better context handling
- **For resource-constrained environments**: `ministral-3:3b` or `rnj-1:8b` work well with limited memory
- **For maximum capability**: `minimax-m2.5` or `glm-5` offer the strongest reasoning at the cost of slower responses

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
- UI powered by [pi-tui](https://github.com/mariozechner/pi-tui) — a terminal UI library
- Inspired by the many AI coding assistants making development easier
