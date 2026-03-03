# Test Suite

This directory contains unit tests and end-to-end (E2E) tests for smol-agent.

## Quick Start

```bash
# Run unit tests
npm test

# Run E2E tests with default model
npm run test:e2e

# Run E2E tests with specific model
SMOL_TEST_MODEL=qwen2.5:7b npm run test:e2e

# Run all tests
npm run test:all
```

## E2E Test Scenarios

The E2E test suite contains 32 scenarios covering various agent capabilities:

### File Operations (1-3)
- **01-file-create**: Create new file from scratch
- **02-file-read**: Read and understand file contents
- **03-file-edit**: Edit existing file with replace_in_file

### Multi-Step & Complex Tasks (4, 14, 18-19)
- **04-multi-step**: Handle tasks requiring multiple operations
- **14-multi-file-create**: Create multiple related files
- **18-multi-turn**: Maintain context across conversation turns
- **19-nested-directory**: Work with nested directory structures

### Error Handling & Recovery (5, 11, 17)
- **05-error-recovery**: Handle and recover from tool errors
- **11-self-correction**: Auto-correct after failed operations
- **17-circuit-breaker**: Prevent infinite retry loops

### Search & Analysis (6, 9, 22)
- **06-grep-search**: Search code using grep tool
- **09-context-init**: Gather context before making changes
- **22-ambiguous-task**: Explore before acting on vague requests

### Execution & Commands (7)
- **07-run-command**: Execute shell commands safely

### Modes & Constraints (8, 10)
- **08-read-only**: Respect read-only mode constraints
- **10-cancellation**: Handle operation cancellation gracefully

### Sub-Agent Delegation (12)
- **12-sub-agent**: Delegate research to sub-agent

### Edge Cases (13, 20, 21)
- **13-whitespace-replace**: Handle whitespace in replacements
- **20-large-output**: Manage large command outputs
- **21-refactor-rename**: Rename variables across codebase

### Parallel Operations (16)
- **16-parallel-tools**: Execute independent tools in parallel

### Code Transformations (23-28)
- **23-json-manipulation**: Parse and modify JSON files
- **24-extract-function**: Refactor code by extracting functions
- **25-api-endpoint**: Add HTTP endpoints to servers
- **26-import-path-update**: Update import paths after file moves
- **27-env-config**: Migrate hardcoded values to environment variables
- **28-code-documentation**: Add JSDoc comments to code

### Bug Fixes (15)
- **15-bug-fix**: Identify and fix bugs in code

### Advanced Refactoring (29, 31)
- **29-async-refactor**: Convert sync code to async/await
- **31-class-conversion**: Convert constructor functions to ES6 classes

### Code Quality (30, 32)
- **30-test-generation**: Generate test files for existing code
- **32-dependency-analysis**: Analyze and identify unused dependencies

## E2E Test Configuration

Configure tests via environment variables:

```bash
# Model to test (must support tools)
SMOL_TEST_MODEL=qwen2.5-coder:7b

# Ollama host
OLLAMA_HOST=http://localhost:11434

# Number of retry attempts per scenario (best score wins)
SMOL_TEST_RETRIES=2

# Max agent iterations per run
SMOL_TEST_MAX_ITER=30

# Context window size for test agents
SMOL_TEST_CTX=32768

# Timeout overrides (in milliseconds)
SMOL_TEST_TIMEOUT_SIMPLE=300000   # Default: 5 minutes
SMOL_TEST_TIMEOUT_MEDIUM=600000   # Default: 10 minutes
SMOL_TEST_TIMEOUT_COMPLEX=900000  # Default: 15 minutes
```

### Default Timeouts

| Complexity | Default Timeout | CI/CD Timeout | Notes |
|------------|-----------------|---------------|-------|
| Simple     | 5 minutes       | 10 minutes    | Basic operations |
| Medium     | 10 minutes      | 15 minutes    | Multi-step tasks |
| Complex    | 15 minutes      | 20 minutes    | Advanced scenarios |

**Note**: Smaller models (1.5B-3B) are significantly slower than larger models and need generous timeouts. CI/CD uses even higher timeouts due to slower runners.

## Running Specific Scenarios

```bash
# Run only scenarios matching "file"
node test/e2e/runner.js --filter file

# Run without retries (single attempt)
node test/e2e/runner.js --no-retry

# Get JSON output for CI/CD
node test/e2e/runner.js --json > results.json
```

## Model Benchmark (GitHub Actions)

The `.github/workflows/model-benchmark.yml` workflow tests the agent against **Ollama cloud models** - fast, reliable, and optimized for coding:

| Model | Size | Strengths |
|-------|------|-----------|
| **qwen3-coder-next:cloud** | Large | Optimized for agentic coding workflows, local dev |
| **devstral-small-2:cloud** | 24B | Excels at tools, multi-file edits, codebase exploration |
| **rnj-1:cloud** | 8B | Optimized for code and STEM, SOTA performance |
| **ministral-3:cloud** | 3-14B | Edge deployment, vision and tool support |

**Benefits of Cloud Models**:
- ⚡ Much faster than local models (datacenter GPUs)
- 🎯 Optimized for coding and tool use
- 🔧 Larger models available (up to 123B+)
- ✅ Reliable performance for CI/CD

**GitHub Actions Setup**:
1. Create "Model Test" environment in repository settings
2. Add `OLLAMA_API_KEY` secret to the environment
3. See [Environment Setup Guide](../.github/ENVIRONMENT_SETUP.md) for details

**Local Setup**:
```bash
export OLLAMA_API_KEY="your-key"  # Get from https://ollama.com/pricing
export OLLAMA_HOST="https://ollama.com"
```

Sources:
- [Cloud Models - Ollama](https://ollama.com/search?c=cloud)
- [Ollama Cloud Documentation](https://docs.ollama.com/cloud)

### Running Benchmarks

```bash
# Trigger manually via GitHub UI
# Or push to main/create PR to run automatically

# Setup for cloud models
export OLLAMA_API_KEY="your-api-key-here"  # Get from https://ollama.com
export OLLAMA_HOST="https://ollama.com"

# Test a single cloud model
SMOL_TEST_MODEL=qwen3-coder-next:cloud npm run test:e2e

# Run full benchmark with all 4 cloud models
./test/e2e/benchmark.sh

# Or run with specific models
./test/e2e/benchmark.sh qwen3-coder-next:cloud devstral-small-2:cloud

# Quick benchmark (1 retry instead of 2)
./test/e2e/benchmark.sh --quick

# Test with local model (no API key needed)
SMOL_TEST_MODEL=qwen2.5-coder:7b npm run test:e2e
```

### Benchmark Results

Each benchmark run produces:
- Individual model result files (JSON)
- Aggregate comparison table
- PR comments with test summaries
- Artifacts stored for 30 days

### Comparing Benchmark Results

Use the comparison script to analyze results from multiple model runs:

```bash
# Compare specific result files
node test/e2e/compare-results.js results-qwen2.5.json results-llama3.2.json

# Compare all results in current directory
node test/e2e/compare-results.js results-*.json

# Compare results from a specific directory
node test/e2e/compare-results.js --dir ./benchmark-results/
```

The script outputs:
- Overall performance comparison table
- Scenarios that failed across models
- Best performing scenarios
- Summary statistics

## Writing New Scenarios

Create a new file in `test/e2e/scenarios/` following this template:

```javascript
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = {
  name: "scenario-name",
  timeout: config.timeouts.medium, // simple | medium | complex
};

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  // Optional: seed files
  await seedFile(tmpDir, "test.js", "console.log('hello')");

  try {
    const response = await runWithTimeout(
      agent,
      "Your task prompt here",
      meta.timeout,
    );

    const content = await readResult(tmpDir, "test.js");

    // Collect evidence
    const didRead = events.anyToolCalled(["read_file"]);
    const didWrite = events.anyToolCalled(["write_file"]);

    // Score based on checks
    return scoreResult(meta.name, [
      check("read file", didRead, 1),
      check("wrote file", didWrite, 2),
      check("correct output", content.includes("expected"), 3),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
```

### Scoring Guidelines

- Each `check()` has a weight (1-3 points)
- Total points should be 10-12 for balanced scenarios
- Higher weights for critical functionality
- Include actual values in checks for debugging
- Test passes if all checks pass (score = 1.0)

## Unit Tests

Unit tests use Node's built-in test runner:

```bash
# Run all unit tests
node --test test/unit/*.test.js

# Run specific test file
node --test test/unit/path-utils.test.js
```

Current unit tests:
- `path-utils.test.js` - Path validation and jailing
- `registry.test.js` - Tool registration system
- `errors.test.js` - Error handling utilities
