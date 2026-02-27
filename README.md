# smol-agent

A small coding agent that runs in your terminal, powered by [Ollama](https://ollama.com) for local LLM hosting.

smol-agent gives a local language model the tools it needs to read, write, and edit code, run shell commands, search across a codebase, and ask you for clarification when it gets stuck — all wrapped in a colorful [Ink](https://github.com/vadimdemedes/ink)-based terminal UI.

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

### Pre-Plan Mode

smol-agent now supports a dedicated **pre-plan phase** for complex tasks:

1. **Task received** → Agent enters pre-plan mode automatically for complex tasks
2. **Requirements gathering** → Agent asks clarifying questions using `ask_requirements`
3. **Analysis** → Agent analyzes the codebase and breaks the task into sub-tasks
4. **Plan creation** → Agent creates a detailed plan saved to `PLAN-*.md` files
5. **Review** → You review the plan
6. **Implementation** → Agent switches to coding mode and executes the plan step-by-step

This approach helps avoid "plan drift" and ensures you're happy with the approach before coding begins.

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
| `/plan` | Switch to planning mode (read-only tools) |
| `/code` | Switch to coding mode (full access) |
| `/mode` | Show current mode |
| `/reset` | Clear conversation history |
| `exit` / `quit` | Exit the agent |
| `Ctrl-C` | Cancel current operation / Exit on double tap |
| `Shift-Tab` | Cycle through modes (coding → planning → coding) |

## Multi-Agent System

smol-agent supports a parent-child multi-agent architecture for distributed problem-solving:

### Architecture
- **Single-level hierarchy**: Parent agents can spawn child agents, but child agents cannot spawn further sub-agents
- **State synchronization**: All agents share state via file-based coordination in `.smol-agent/state/`
- **Concurrent execution**: Child agents work independently while reporting progress back to parent

### How It Works

1. **Parent Agent**: Has full tool access including `spawn_agent` and `agent_coordinator`
2. **Child Agent**: Limited tool access - cannot spawn further sub-agents, but can coordinate with parent
3. **Agent ID**: Each agent gets a unique ID via `AGENT_INSTANCE_ID` environment variable

### Spawning Child Agents

```json
{
  "name": "spawn_agent",
  "arguments": {
    "prompt": "Solve this sub-problem...",
    "child_agent_id": "child-1",
    "context": "Optional context from parent"
  }
}
```

### Child Agent Capabilities

Child agents have access to read-only tools plus:
- `agent_coordinator` (for reporting progress to parent)
- `agent_status` (check own status)
- `agent_monitor` (monitor other agents - limited to their own children if any)

Child agents **cannot** use:
- `spawn_agent` (no sub-agent spawning)
- `agent_coordinator` (cannot spawn children)

### Monitoring Agents

```json
{
  "name": "agent_coordinator",
  "arguments": {
    "action": "monitor",
    "agent_ids": ["child-1", "child-2"]
  }
}
```

### Monitoring Command

```bash
# Monitor specific agents
agent_coordinator({
  "action": "monitor",
  "agent_ids": ["child-1", "child-2"]
})
```

### Agent State

Each agent's state is stored in `.smol-agent/state/<agent_id>.json`:
```json
{
  "agent_id": "child-1",
  "status": "completed",
  "progress": 100,
  "parent_id": "parent-agent-1",
  "start_time": 1712345678901,
  "end_time": 1712345689012,
  "exitCode": 0,
  "result": "Task completed successfully"
}
```

### Usage in Interactive Mode

```
smol-agent
> /code  # Switch to coding mode
> Use spawn_agent to work on sub-tasks
```

### Example Workflow

1. Parent agent receives complex task
2. Parent breaks task into sub-tasks using `spawn_agent`
3. Child agents work concurrently on their sub-tasks
4. Child agents report progress via `agent_coordinator`
5. Parent monitors progress and collects results
6. Parent synthesizes final answer from child results

### Benefits

- **Parallel processing**: Multiple agents work on different parts simultaneously
- **Specialization**: Each agent can focus on a specific sub-task
- **State tracking**: Parent sees full progress of all child agents
- **Error isolation**: Child failures don't necessarily crash parent

## Planning mode

Planning mode restricts the agent to read-only tools — it can explore the codebase but cannot modify files or run shell commands. This is useful when you want the agent to:

- Analyze a problem and propose a solution
- Review code and suggest improvements
- Create a detailed implementation plan before making changes

Switch to planning mode with `/plan`. The agent will produce a plan with specific files, changes, and code snippets. After reviewing, switch to coding mode with `/code` to let the agent implement the plan.

## Smart Context Management (NEW!)

smol-agent now includes intelligent context management to reduce token usage while maintaining awareness of project state:

- **File-touched tracking** - Track which files the agent has already seen/modified and only update context for changed files
- **Conversation summarization** - Automatically summarize old conversation messages when context approaches 95% capacity
- **Repo map** - Create a map of files to their top-level functions/classes for faster codebase understanding

These changes significantly reduce token usage while maintaining the agent's awareness of the project state.

See AGENT.md for more details on the implementation.

## Pre-plan mode (NEW!)

Pre-plan mode is an **automatic** planning phase that the agent enters for complex tasks. You don't manually switch to preplan mode - the agent decides when it needs to gather requirements and create a detailed plan before coding.

### When pre-plan mode is triggered:

The agent automatically enters preplan mode when:
- The task is complex or multi-step
- The task contains keywords like "create", "build", "implement", "feature", "design", etc.
- The task description is long (>50 characters)

### How pre-plan mode works:

1. **Automatic trigger** — Agent detects a complex task and switches to preplan mode automatically
2. **Requirements gathering** — Agent uses `ask_requirements` to ask clarifying questions
3. **Task analysis** — Agent uses `analyze_task` to break the task into sub-tasks
4. **Plan creation** — Agent creates a detailed plan and saves it to `PLAN-*.md` files
5. **Review** — You review the plan file in your current directory
6. **Implementation** — When ready, run `/code` to let the agent execute the plan

### Special pre-plan tools (agent-only):

| Tool | Purpose |
|------|---------|
| `ask_requirements(questions, context)` | Ask clarifying questions before planning |
| `analyze_task(task, constraints)` | Break a task into smaller sub-tasks |
| `save_plan(description, planContent)` | Save a detailed plan to a markdown file |
| `review_plan(plan, checklist)` | Review and refine a plan before execution |
| `load_plan_progress()` | Load current plan progress and state |
| `get_current_plan()` | Get the content of the currently active plan |
| `complete_plan_step(stepNumber, stepDescription)` | Mark a step as completed |
| `update_plan_status(status, message)` | Update the plan status |

### Plan lifecycle:

```
Task received → PREPLAN mode (auto) → Questions → Analysis → Plan saved to PLAN-*.md
    ↓
User reviews plan
    ↓
User runs /code → CODING mode → Execute plan with progress tracking
    ↓
Complete each step, track progress
```

### Manual mode switching:

You can still manually switch between coding and planning modes using:
- `/plan` — Enter read-only planning mode
- `/code` — Enter coding mode
- `/mode` — Show current mode

But you **cannot** manually enter preplan mode — it's automatically managed by the agent.

## Tools

The agent has access to the following tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with optional line offset/limit |
| `list_files` | Glob-based file and directory listing |
| `run_command` | Execute shell commands (builds, tests, git, etc.) |
| `grep` | Regex search across files with line numbers |
| `find_in_file` | Search for specific text within a file and return line numbers and content |
| `web_search` | Search the web via [Ollama's web search API](https://docs.ollama.com/capabilities/web-search) |
| `web_fetch` | Fetch a URL and return its content via [Ollama's web fetch API](https://docs.ollama.com/capabilities/web-search) |
| `ask_user` | Ask the user a clarifying question and wait for a response |
| `spawn_agent` | Spawn a child agent to work on a sub-problem (parent only) |
| `agent_coordinator` | Coordinate multiple agents and report progress |
| `agent_status` | Check the status of any agent instance |
| `agent_monitor` | Monitor progress of child agents |
| `save_plan` | Save a plan to a markdown file (pre-plan mode) |
| `load_plan_progress` | Load current plan progress (pre-plan mode) |
| `get_current_plan` | Get the current plan content (pre-plan mode) |
| `complete_plan_step` | Mark a plan step as completed (pre-plan mode) |
| `update_plan_status` | Update plan status (pre-plan mode) |
| `ask_requirements` | Ask clarifying questions (pre-plan mode) |
| `analyze_task` | Break task into sub-tasks (pre-plan mode) |
| `review_plan` | Review plan before execution (pre-plan mode) |

The model decides which tools to call and when. It will loop — calling tools and feeding results back in — until it produces a final text response.

## Context injection

When the agent starts (or after `/reset`), it automatically gathers context about the current project and injects it into the system prompt. This gives the model immediate awareness of:

- **Working directory** and **file tree** (top 2 levels, ignoring node_modules/.git/etc.)
- **Git status** — current branch, uncommitted changes, and recent commit history
- **Config files** — package.json, tsconfig.json, pyproject.toml, Cargo.toml, go.mod, Makefile, .env.example (whichever exist)
- **README excerpt** — first 80 lines of any README file
- **Active plan summary** — when in coding mode with an active plan

This means the model already knows your project layout, language, dependencies, and available scripts before you even ask your first question — so it can give better answers with fewer tool calls.

## Architecture

```
src/
├── index.js              CLI entry point, arg parsing, Ink render
├── agent.js              Agent loop (EventEmitter): prompt → LLM → tool calls → repeat
├── context.js            Project context gathering (file tree, git, configs, README)
├── ollama.js             Thin wrapper around the ollama npm package
├── plan-tracker.js       Plan state management and persistence
├── ui/
│   └── App.js            Ink (React) terminal UI — message log, spinner, input
└── tools/
    ├── registry.js       Tool registration and dispatch
    ├── read_file.js      Read file contents
    ├── list_files.js     Glob-based file listing
    ├── run_command.js          Shell command execution
    ├── grep.js           Regex search across files
    ├── web_search.js     Web search via Ollama API
    ├── web_fetch.js      URL fetch via Ollama API
    ├── ask_user.js       Ask the user for clarification
    ├── spawn_agent.js    Spawn child agent
    ├── agent_coordinator.js  Multi-agent coordination
    ├── agent_monitor.js  Monitor child agents
    ├── agent_status.js   Check agent status
    ├── plan_tools.js     Plan-related tools (save, load, progress tracking)
    └── requirements_tools.js  Requirements gathering tools
```

Each tool file self-registers with the registry on import. The agent imports them all, and the registry serializes them into the format Ollama expects for tool-calling.

On first run, `context.js` gathers a snapshot of the project (file tree, git state, config files, README) and appends it to the system prompt. This gives the model grounding in the project before any tool calls happen.

The Ink UI subscribes to `tool_call`, `tool_result`, `response`, and `error` events emitted by the agent, rendering tool activity in real time with a spinner and status text. The `ask_user` tool is wired through a promise bridge so the Ink app collects the answer inline without readline conflicts.

## License

MIT
