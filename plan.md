# Plan: Add Programmatic Tool Calling Support

## Overview

Integrate Anthropic's **programmatic tool calling** into smol-agent's Anthropic provider. This feature allows Claude to write Python code that calls tools programmatically within a code execution container, reducing latency and token consumption for multi-tool workflows.

## Key Concepts from the API

1. **Code execution tool**: A special tool `{ type: "code_execution_20260120", name: "code_execution" }` sent in the tools array
2. **`allowed_callers` field**: Each tool can specify `["code_execution_20260120"]` to allow programmatic calling, `["direct"]` (default), or both
3. **New response content block types**:
   - `server_tool_use` — Claude's code execution block (contains the Python code)
   - `tool_use` with `caller` field — a tool call made programmatically from within code execution
   - `code_execution_tool_result` — the final output of the code execution
4. **Container**: Reusable sandbox container with an ID and expiration time
5. **Message format**: When responding to programmatic tool calls, the response must contain **only** `tool_result` blocks

## Implementation Plan

### Step 1: Add `code_execution` tool to the Anthropic provider's tool formatting

**File**: `src/providers/anthropic.js` — `formatTools()`

- When formatting tools, inject the code execution tool as the first item: `{ type: "code_execution_20260120", name: "code_execution" }`
- Add `allowed_callers: ["code_execution_20260120"]` to each tool definition
- Only do this for compatible models (claude-opus-4-6, claude-sonnet-4-6, claude-sonnet-4-5, claude-opus-4-5)
- Add a constructor option `enableProgrammaticToolCalling` (default: true for compatible models)

### Step 2: Handle new response content block types in streaming

**File**: `src/providers/anthropic.js` — `chatStream()`

- Handle `server_tool_use` content blocks (code execution blocks from Claude)
  - Track the `id` as a code execution tool use ID
  - Store the code being executed
- Handle `tool_use` blocks with a `caller` field (programmatic tool calls)
  - Parse these the same as regular tool_use but preserve the `caller` metadata
- Handle `code_execution_tool_result` blocks (final output)
  - Extract `stdout`, `stderr`, `return_code`, and `content`
- Track the `container` field from the response for reuse

### Step 3: Update message conversion for programmatic tool call responses

**File**: `src/providers/anthropic.js` — `_convertMessages()`

- When an assistant message contains `server_tool_use` blocks, preserve them as-is in the converted message
- When a tool result is for a programmatic tool call (has a `caller` reference), format the response as only `tool_result` blocks (no text content mixed in)
- Support the `container` field in API requests

### Step 4: Update the agent loop to handle programmatic tool calls

**File**: `src/agent.js` — `run()` method

- Detect tool calls that have a `caller` field (programmatic calls from code execution)
- Execute them the same way as regular tool calls (through the registry)
- When building the response message, only include `tool_result` blocks for programmatic calls
- Track the container ID for reuse across iterations
- Add a new event `"code_execution"` for UI to show code execution progress
- Handle `code_execution_tool_result` content in the response — treat it as informational text output

### Step 5: Expose configuration

**File**: `src/agent.js` — constructor and `_init()`

- Add `enableProgrammaticToolCalling` option to Agent constructor
- Pass it through to the Anthropic provider
- Default to `true` when using a compatible Anthropic model

**File**: `src/index.js` — CLI flag

- Add `--programmatic-tools` / `--no-programmatic-tools` CLI flag

### Step 6: Update the `anthropic-version` header

**File**: `src/providers/anthropic.js` — `_headers()`

- Keep using `2023-06-01` (the feature works with this version per the docs)

## Files to Modify

1. `src/providers/anthropic.js` — Core API integration (tool formatting, streaming, message conversion)
2. `src/agent.js` — Agent loop changes for programmatic tool call handling
3. `src/index.js` — CLI flag for enabling/disabling

## Key Design Decisions

- **`allowed_callers` strategy**: Use `["code_execution_20260120"]` for all tools by default when programmatic calling is enabled. This gives Claude maximum flexibility to batch tool calls in code.
- **Container reuse**: Track the container ID from responses and pass it in subsequent requests within the same agent `run()` to maintain state.
- **Backward compatibility**: Programmatic tool calling is opt-in via a flag and only activates for compatible Anthropic models. Non-Anthropic providers are unaffected.
- **Tool approval**: Programmatic tool calls still go through the same approval system — even though they're invoked from code execution, the API surfaces them as regular `tool_use` blocks that we must fulfill.
