# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **LLM-based Context Summarization**: When context reaches 55% capacity, the agent now uses 
  the LLM to intelligently summarize old messages, preserving critical context like file names, 
  function names, and decisions made. Falls back to simple extraction if LLM is unavailable.
  - Uses smaller model variant (e.g., 7b instead of 32b) for summarization when possible
  - Inspired by Aider's approach to conversation summarization

- **Importance-based Message Pruning**: Messages are now scored by importance before pruning:
  - System messages: highest priority (1000)
  - User messages: high priority (80+), recent ones higher
  - Assistant messages with tool calls: medium-high priority
  - Tool results with errors: higher priority than successful ones
  - Very large tool results: deprioritized
  - Summarized messages: lowest priority (10)
  - Recency bonus: exponential decay favoring recent messages

- **Improved Tool Result Truncation**: Tool results are now truncated more intelligently:
  - Preserves error messages in full when possible
  - For file content, keeps first 50 and last 50 lines (with line count indicator)
  - Standard truncation for other large outputs

- **Progressive Context Management**: Earlier intervention thresholds:
  - 55%: Start summarizing old messages
  - 70%: Prune messages using importance scoring
  - 85%: Aggressive pruning
  - Overflow: Emergency reduction keeping only essential messages

### Changed
- Context summarization now runs before pruning, giving the agent a chance to preserve context
- Pruning uses importance scoring instead of simple recency-based selection
- Better logging for context management decisions

## [1.0.0] - Initial Release

### Added
- Terminal-based coding agent powered by local LLMs via Ollama
- Tools: read_file, write_file, replace_in_file, list_files, grep, run_command, ask_user
- Tools: web_search, web_fetch, plan management, reflection
- Context management with token tracking and proactive pruning
- Ink-based React terminal UI with markdown rendering
- Conversation history management
- Rate limiting and retry logic for Ollama API
- Support for multiple models with auto-detection of tool exposure
- Jail directory support for safe file operations