# Open Source Agent Feature Analysis

Analysis of features from **Aider**, **Kilocode**, and **OpenCode** that could improve smol-agent.

## Current smol-agent Strengths
- Solid tool-call loop with streaming, retries, error recovery
- Shift-left linting (Stripe Minions pattern)
- Context management with summarization and pruning
- Pre-hydration of referenced files
- Sub-agent delegation for research tasks
- Persistent memory across sessions
- Skills system (SKILL.md format)
- Loop detection and self-correction
- Shared coding rules (.cursorrules, CLAUDE.md, etc.)

---

## Feature Opportunities (Ranked by Impact)

### 1. Repository Map via Tree-Sitter (from Aider)
**Impact: HIGH** | **Effort: MEDIUM**

Aider's killer feature. Uses tree-sitter to parse all source files into ASTs, extract function/class/type definitions, and build a condensed "repo map" that fits in the context window. Uses PageRank to rank symbol importance by reference count.

**What smol-agent has today:** A shallow 2-level file tree in the system prompt.

**What to add:**
- Parse source files with tree-sitter to extract top-level symbols (functions, classes, exports)
- Build a compact repo map showing key definitions with file locations
- Fit within a token budget (e.g., 1000-2000 tokens)
- Include in system prompt so the agent knows where things are without grepping

**Why it matters:** The agent currently wastes multiple tool calls (list_files → grep → read_file) just to find where something is defined. A repo map gives it a "table of contents" for the codebase.

---

### 2. LSP Integration for Diagnostics (from OpenCode)
**Impact: HIGH** | **Effort: HIGH**

OpenCode integrates with Language Server Protocol to get real-time diagnostics after edits. Instead of running a lint command (which may not catch type errors), LSP gives structured, file-specific errors including type checking.

**What smol-agent has today:** Shift-left linting via shell commands (npm run lint, ruff, etc.)

**What to add:**
- Spawn an LSP server for the detected project language
- After file edits, request diagnostics from the LSP
- Feed structured error info (file, line, message, severity) back to the agent
- This replaces/augments the shift-left shell-based approach

**Why it matters:** LSP diagnostics are faster, more precise, and catch type errors that linters miss. They also provide go-to-definition context that helps the agent navigate.

---

### 3. Architect/Editor Dual Mode (from Aider + Kilocode)
**Impact: MEDIUM-HIGH** | **Effort: LOW**

Both Aider and Kilocode separate planning from execution. An "architect" pass thinks through the approach, then an "editor" pass makes the changes. This prevents the agent from jumping straight into code changes without understanding the problem.

**What smol-agent has today:** Single mode with `<thinking>` tags for reasoning. Plan tools exist but are optional/manual.

**What to add:**
- A `/architect` command that uses a two-pass approach:
  1. First pass: analyze the codebase and produce a plan (read-only tools only)
  2. Second pass: execute the plan with edit tools
- Could reuse the existing `delegate` sub-agent for the architect pass
- System prompt adjustment per mode

**Why it matters:** Reduces wasted edits. The agent reads more before writing, leading to better first-attempt success rates.

---

### 4. Smarter Diff/Edit Formats (from Aider)
**Impact: MEDIUM** | **Effort: MEDIUM**

Aider offers multiple edit formats: whole-file, diff, unified-diff, search/replace. Different models work better with different formats. The key insight: smaller models struggle with precise diffs but can output whole files; larger models can handle surgical diffs.

**What smol-agent has today:** `replace_in_file` (search/replace) and `write_file` (whole file).

**What to add:**
- A unified diff edit format option (`apply_diff`) for models that produce standard unified diffs
- Model-aware format selection: use whole-file for smaller models, search/replace for larger ones
- Better error recovery when diffs fail (show the agent what the file actually looks like around the match location)

---

### 5. Git Snapshot/Checkpoint System (from Kilocode + OpenCode)
**Impact: MEDIUM** | **Effort: LOW-MEDIUM**

Both Kilocode and OpenCode create automatic checkpoints before making changes, allowing easy rollback. OpenCode uses `git write-tree`/`read-tree` for lightweight snapshots without polluting git history.

**What smol-agent has today:** Basic git info display. No automatic checkpointing.

**What to add:**
- Auto-create a git stash or lightweight snapshot before each agent run
- A `/undo` command to revert all changes from the last run
- Track which files were modified and offer selective rollback

**Why it matters:** Users are more willing to let the agent make changes when they know they can easily undo them.

---

### 6. Codebase Semantic Indexing (from Kilocode)
**Impact: MEDIUM** | **Effort: HIGH**

Kilocode builds a semantic index of the codebase for fast, meaning-aware search. This goes beyond grep to understand code relationships.

**What smol-agent has today:** `grep` (regex text search) and `save_context` (manual summaries).

**What to add:**
- Build an index of symbols, imports, and dependencies
- Use tree-sitter (same as repo map) to extract relationships
- Offer a `find_symbol` tool that resolves "where is X defined?" instantly

---

### 7. Enhanced Context Compaction (from OpenCode)
**Impact: MEDIUM** | **Effort: LOW**

OpenCode adapts compaction strategy based on context window size. Small windows get aggressive compaction; large windows use minimal compaction. It also triggers compaction at 90% rather than smol-agent's multi-threshold approach.

**What smol-agent has today:** 55%/70%/85% thresholds with multiple strategies.

**What to add:**
- Make thresholds configurable based on model's actual context size
- For large-context models (128K+), delay compaction to preserve more history
- Better compaction that preserves file edit history (which files were changed and why)

---

### 8. Auto-Accept for Safe Operations (from Aider + Kilocode)
**Impact: LOW-MEDIUM** | **Effort: LOW**

Both tools have granular auto-approval. Aider auto-accepts architect suggestions. Kilocode allows auto-approving specific operation types (reads, lint fixes) while prompting for others.

**What smol-agent has today:** All-or-nothing `--auto-approve` flag.

**What to add:**
- Category-based auto-approval: auto-approve reads, prompt for writes, always prompt for commands
- `--auto-approve-reads` and `--auto-approve-lint-fixes` flags
- Per-tool approval memory ("always allow grep")

---

## Implementation Priority

| # | Feature | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| 1 | Repo Map (tree-sitter) | HIGH | MEDIUM | **P0** |
| 3 | Architect Mode | MED-HIGH | LOW | **P0** |
| 5 | Git Checkpoints | MEDIUM | LOW | **P1** |
| 8 | Granular Auto-Approve | LOW-MED | LOW | **P1** |
| 4 | Smarter Edit Formats | MEDIUM | MEDIUM | **P2** |
| 7 | Enhanced Compaction | MEDIUM | LOW | **P2** |
| 2 | LSP Integration | HIGH | HIGH | **P3** |
| 6 | Semantic Indexing | MEDIUM | HIGH | **P3** |

## Recommended First Implementation

**Repo Map + Architect Mode** — These two features work together beautifully:
1. The repo map gives the agent a structural understanding of the codebase
2. Architect mode uses that understanding to plan before editing
3. Both are relatively straightforward to implement with existing infrastructure

Sources:
- [Aider - Repository Map](https://aider.chat/docs/repomap.html)
- [Aider - Tree-sitter Blog Post](https://aider.chat/2023/10/22/repomap.html)
- [Kilocode GitHub](https://github.com/Kilo-Org/kilocode)
- [Kilocode DeepWiki](https://deepwiki.com/Kilo-Org/kilocode/1-overview)
- [OpenCode](https://opencode.ai/)
- [AI Coding Agents 2026 Comparison](https://www.tembo.io/blog/coding-cli-tools-comparison)
