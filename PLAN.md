Perfect! Now I have clear requirements. Let me create a detailed plan for these context management improvements.

```markdown
# Plan: Smart Context Management with Repo Map and Conversation Summarization

## Overview

This plan improves context management in smol-agent with three key enhancements:

1. **File-touched tracking** - Track which files the agent has already seen/modified and only update context for changed files
2. **Conversation summarization** - Automatically summarize old conversation messages when context approaches 95% capacity
3. **Repo map** - Create a map of files to their top-level functions/classes for faster codebase understanding

These changes will significantly reduce token usage while maintaining the agent's awareness of the project state.

## Files to Modify

### New Files to Create:
- `src/repo-map.js` - Generate and maintain a map of files to functions/classes
- `src/context-tracker.js` - Track which files have been touched and manage incremental updates
- `src/conversation-summarizer.js` - Handle conversation history summarization

### Files to Modify:
- `src/context.js` - Integrate with file tracker for smart updates
- `src/agent.js` - Add conversation summarization logic and repo map integration
- `src/ollama.js` - Support context window management and summarization triggers
- `src/tools/registry.js` - Register new summarization and file-touched tools
- `src/tools/file_touched.js` - New tool for tracking file access (for future use)
- `src/plan-tracker.js` - Consider repo map when tracking plan progress

## Implementation Steps

### Step 1: Create Repo Map System (`src/repo-map.js`)

**Purpose:** Generate a lightweight map of files to their top-level functions/classes without reading full file contents

**Key functions:**
- `generateRepoMap(cwd, extensions)` - Scan project files and extract function/class names
- `updateRepoMap(cwd, changedFiles)` - Incrementally update map for changed files
- `getRepoMapSummary()` - Get a concise string representation for context injection

**Implementation approach:**
- Use regex patterns to detect function/class declarations in common languages
- Skip node_modules and other ignored directories
- Store map in `.smol-agent/state/repo-map.json` for persistence
- Format: `{ "path/to/file.js": ["functionName", "ClassName", ...], ... }`

**Example output:**
```
## Repo Map

src/agent.js:
  - Agent (class)
  - parseToolCallsFromContent (function)

src/context.js:
  - gatherContext (function)
  - fileTree (function)
  - gitInfo (function)

src/tools/read_file.js:
  - read_file (function)
```

### Step 2: Create File Touched Tracker (`src/context-tracker.js`)

**Purpose:** Track which files the agent has already accessed or modified to enable smart context updates

**Key functions:**
- `recordFileTouched(filePath)` - Mark a file as touched
- `getTouchedFiles()` - Get list of all touched files
- `hasFileChanged(filePath)` - Check if a file has changed since last touch
- `getChangedFiles()` - Get all files that have changed
- `resetFileTracking()` - Clear all tracking (for `/reset`)

**Implementation approach:**
- Use a simple JSON file to track: `{ filePath: { mtime: number, checksum: string } }`
- Compare mtime/checksum to detect changes
- Store in `.smol-agent/state/file-tracker.json`

### Step 3: Create Conversation Summarizer (`src/conversation-summarizer.js`)

**Purpose:** Summarize old conversation messages when context approaches 95% of max

**Key functions:**
- `shouldSummarize(messages, maxTokens, currentTokenCount)` - Determine if summarization needed
- `estimateTokenCount(messages)` - Estimate token usage (rough: ~4 chars per token)
- `summarizeConversation(messages, summaryLength)` - Generate summary of old messages
- `createSummarizedMessages(messages)` - Replace old messages with summary

**Implementation approach:**
- Use a simple heuristic: if tokens > 95% of max, summarize first N messages
- Call Ollama with: "Summarize the following conversation in [N] words..."
- Replace early messages with a single summary message
- Keep recent messages (last 5-10) for full context

### Step 4: Integrate Repo Map into Context System (`src/context.js`)

**Changes:**
- Import `generateRepoMap` from `./repo-map.js`
- Call `generateRepoMap(cwd)` in `gatherContext()`
- Add repo map section to context output
- Load repo map from cache if available and no changes detected

**Integration pattern:**
```javascript
// Add after git info section
const repoMap = await repoMapModule.getRepoMapSummary(cwd);
if (repoMap) {
  sections.push(`## Repo Map\n${repoMap}`);
}
```

### Step 5: Add Smart Context Updates (`src/agent.js`, `src/context.js`)

**Changes in `context.js`:**
- Import `context-tracker.js`
- Check `getChangedFiles()` before re-gathering full context
- Only include changed files' details in context
- Update tracker when context is gathered

**Changes in `agent.js`:**
- Call `contextTracker.resetFileTracking()` on `agent.reset()`
- Track files that are read via `read_file` tool calls
- Integrate with new `summarizeConversation` function

### Step 6: Add Conversation Summarization (`src/agent.js`, `src/ollama.js`)

**Changes in `ollama.js`:**
- Add function to estimate token count from messages
- Add `chatWithSummarization()` that wraps `chat()` with summarization logic

**Changes in `agent.js`:**
- Call summarization before each Ollama API call if needed
- Update `run()` method to check context size and summarize if needed
- Pass summarized messages to `ollama.chat()`

### Step 7: Add New Tools (`src/tools/registry.js`, new tool files)

**Registry updates:**
- Add `FILE_TOUCHED_TOOLS` set if needed (though these will be read-only)

**Potential new tools to consider (optional, future):**
- `summarize_conversation()` - Explicitly trigger conversation summarization
- `repo_map_status()` - Check current repo map status

### Step 8: Testing and Validation

**Test scenarios:**
1. Start fresh - repo map should be generated and saved
2. Modify a file - context should detect change
3. Run agent with long conversation - should trigger summarization
4. `/reset` command - should clear all tracking
5. Check repo map accuracy vs actual file contents

**Validation metrics:**
- Token savings from repo map (compare full files vs map tokens)
- Token savings from summarization
- Accuracy of repo map (manual verification)
- Speed improvement from incremental updates

## Risks & Considerations

### Repo Map Limitations:
- **Regex patterns may miss some declarations** - Use conservative patterns, accept some false negatives
- **Language-specific parsing needed** - Start with JS/JSX, add others later
- **May not help for small projects** - Only beneficial for larger codebases

### Context Tracking Risks:
- **File system race conditions** - Handle async file operations carefully
- **Checksum overhead** - Consider skipping checksum for simple mtime check initially
- **Stale cache issues** - Always verify critical file changes before use

### Summarization Concerns:
- **Loss of detail** - Keep recent messages for full context
- **Summarization token cost** - Summarization itself uses tokens (offset by savings)
- **Multi-turn summarization** - May need to re-summarize if new summary gets old

### Implementation Risks:
- **Breaking existing functionality** - Test thoroughly with incremental changes
- **Performance overhead** - Measure impact of tracking and summarization
- **Disk I/O for state files** - Consider in-memory only for simple cases

## Testing Plan

1. **Unit tests** for each new module (`repo-map.test.js`, `context-tracker.test.js`, etc.)
2. **Integration tests** with actual agent runs
3. **Token counting** before/after improvements
4. **Manual testing** with various project sizes
5. **Edge cases** - empty projects, large files, binary files, git errors

## Success Criteria

- [ ] Repo map generated and saved correctly for project
- [ ] Changed files detected and context updated incrementally
- [ ] Conversation summarization triggered at ~95% context
- [ ] Total token usage reduced by 20%+ compared to baseline
- [ ] Agent performance not significantly degraded
- [ ] All existing functionality preserved
</parameter>
```