# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-01-XX

### Added
- Initial release
- Core agent loop with Ollama integration
- Terminal UI with Ink (React for terminals)
- Tool system with registry pattern
- Rich markdown rendering in terminal output
- Context injection (file tree, git status, configs)
- Context window management with automatic pruning
- Plan tracking tools for multi-step tasks
- Reflection tool for post-task summarization

### Tools
- `read_file` - Read file contents with line numbers
- `write_file` - Write/create files
- `replace_in_file` - Find and replace in files
- `list_files` - Glob-based file listing
- `grep` - Regex search across files
- `run_command` - Execute shell commands
- `ask_user` - Interactive clarification questions
- `web_search` - Web search via Ollama API
- `web_fetch` - Fetch URLs via Ollama API
- `save_plan` / `load_plan_progress` / `get_current_plan` / `complete_plan_step` / `update_plan_status` - Plan management
- `reflect` - Task reflection and summarization

[1.0.0]: https://github.com/smol-ai/smol-agent/releases/tag/v1.0.0