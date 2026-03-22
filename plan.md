# Plan: Add Programmatic Tool Calling Support

## Overview

Implement **programmatic tool calling** in smol-agent with a dual approach:

1. **Client-side code execution** (all providers): A `code_execution` tool that runs JS code in a VM sandbox with all registered tools available as async functions. Works with Ollama, OpenAI, Grok, and any other provider.

2. **Anthropic-native server-side** (Anthropic only): When using compatible Claude models with `--programmatic-tools`, uses Anthropic's server-side `code_execution_20260120` with `allowed_callers` for optimal performance.

## Implementation (Completed)

### Client-side: `src/tools/code_execution.js` (NEW)
- Registers a `code_execution` tool in the tool registry
- Executes JS code in a Node.js `vm.Context` sandbox
- All registered tools available as `await toolName(args)` functions
- Captures stdout/stderr, tracks tool calls made
- 2-minute timeout, 50KB stdout cap
- Prevents recursive calls (code_execution not available inside sandbox)
- Security: runs in VM sandbox, tools still go through registry validation + jail directory

### Anthropic-native: `src/providers/anthropic.js` (MODIFIED)
- `formatTools()` injects `code_execution_20260120` tool and adds `allowed_callers` to all tools
- `chatStream()` handles `server_tool_use`, `code_execution_tool_result`, and `caller` field on `tool_use` blocks
- `_convertMessages()` preserves `server_tool_use` blocks and `caller` metadata
- `_parseResponseContent()` extracts new block types
- Tracks container ID for reuse across turns
- Only activates for compatible models (Opus 4.6, Sonnet 4.6, Sonnet 4.5, Opus 4.5)

### Agent loop: `src/agent.js` (MODIFIED)
- Imports and registers code_execution tool
- Captures `serverToolUses` and `codeExecutionResults` from streaming events
- Preserves metadata on assistant messages for Anthropic message conversion
- System prompt updated to guide models to use code_execution for multi-tool workflows

### Registry: `src/tools/registry.js` (MODIFIED)
- `code_execution` added to CORE_TOOLS, DANGEROUS_TOOLS, and TOOL_CATEGORIES
- Category: "execute" (requires approval)

### CLI: `src/index.js` (MODIFIED)
- `--programmatic-tools` flag enables Anthropic server-side programmatic calling
- `--no-programmatic-tools` disables it
- Passed through provider factory to Anthropic provider

### Provider factory: `src/providers/index.js` (MODIFIED)
- Passes `programmaticToolCalling` option through to provider constructors

### Tests: `test/unit/code-execution.test.js` (NEW)
- 9 tests covering: basic execution, tool calling, multi-tool batching, loops, error handling, recursion prevention, stderr capture

## Design Decisions

- **Dual approach**: Client-side VM for all providers, server-side for Anthropic. Client-side code_execution is always available as a core tool regardless of `--programmatic-tools` flag.
- **JS not Python**: Client-side uses JavaScript (not Python) since smol-agent is a Node.js project and the VM module provides a natural sandbox.
- **Tool approval preserved**: code_execution is a DANGEROUS_TOOL requiring approval. Individual tool calls within the sandbox still go through the registry's validation.
- **Backward compatible**: No breaking changes. The code_execution tool is simply a new core tool available to all models.
