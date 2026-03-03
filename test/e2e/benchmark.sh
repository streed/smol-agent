#!/usr/bin/env bash

# Local model benchmark runner
#
# Usage:
#   ./test/e2e/benchmark.sh                    # Test default models
#   ./test/e2e/benchmark.sh qwen2.5:7b phi3    # Test specific models
#   ./test/e2e/benchmark.sh --quick            # Single retry, faster

set -e

# Default Ollama cloud models (fast, reliable, coding-optimized)
DEFAULT_MODELS=(
  "qwen3-coder-next:cloud"
  "devstral-small-2:cloud"
  "rnj-1:cloud"
  "ministral-3:cloud"
)

# Parse arguments
MODELS=()
QUICK=false

for arg in "$@"; do
  if [ "$arg" = "--quick" ]; then
    QUICK=true
  else
    MODELS+=("$arg")
  fi
done

# Use default models if none specified
if [ ${#MODELS[@]} -eq 0 ]; then
  MODELS=("${DEFAULT_MODELS[@]}")
fi

# Create results directory
RESULTS_DIR="benchmark-results-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo "═══════════════════════════════════════════════════════════"
echo "  Model Benchmark Runner"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Testing ${#MODELS[@]} model(s): ${MODELS[*]}"
echo "Results directory: $RESULTS_DIR"
echo ""

# Set test options
export SMOL_TEST_CTX=16384
export SMOL_TEST_MAX_ITER=20

if [ "$QUICK" = true ]; then
  export SMOL_TEST_RETRIES=1
  echo "Quick mode: 1 retry per scenario"
else
  export SMOL_TEST_RETRIES=2
  echo "Standard mode: 2 retries per scenario"
fi

echo ""

# Run tests for each model
for model in "${MODELS[@]}"; do
  echo "─────────────────────────────────────────────────────────────"
  echo "Testing model: $model"
  echo "─────────────────────────────────────────────────────────────"

  # Check if it's a cloud model
  if [[ "$model" == *":cloud" ]]; then
    echo "☁️  Using Ollama cloud model - no pull needed"
    if [ -z "$OLLAMA_API_KEY" ]; then
      echo "⚠️  Warning: OLLAMA_API_KEY not set"
      echo "   Cloud models require an API key from https://ollama.com"
    fi
  else
    # Local model - check if available
    if ! ollama list | grep -q "^${model%%:*}"; then
      echo "⚠️  Model not found. Pulling $model..."
      ollama pull "$model" || {
        echo "❌ Failed to pull model: $model"
        echo "   Skipping..."
        echo ""
        continue
      }
    fi
  fi

  # Run tests
  export SMOL_TEST_MODEL="$model"
  RESULT_FILE="$RESULTS_DIR/results-${model//:/-}.json"

  echo ""
  echo "Running tests (output: $RESULT_FILE)..."
  echo ""

  if node test/e2e/runner.js --json > "$RESULT_FILE" 2>&1; then
    echo "✅ Tests completed successfully"
  else
    echo "⚠️  Some tests failed (check results for details)"
  fi

  # Show quick summary
  if [ -f "$RESULT_FILE" ]; then
    SCORE=$(jq -r '.aggregate.normalized' "$RESULT_FILE" 2>/dev/null || echo "N/A")
    PASSED=$(jq -r '.aggregate.passed' "$RESULT_FILE" 2>/dev/null || echo "0")
    TOTAL=$(jq -r '.aggregate.total' "$RESULT_FILE" 2>/dev/null || echo "0")
    echo "   Score: $SCORE  |  Passed: $PASSED/$TOTAL"
  fi

  echo ""
done

echo "═══════════════════════════════════════════════════════════"
echo "  Benchmark Complete!"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Generate comparison if we have multiple results
RESULT_COUNT=$(find "$RESULTS_DIR" -name "results-*.json" 2>/dev/null | wc -l)

if [ "$RESULT_COUNT" -gt 1 ]; then
  echo "Generating comparison report..."
  echo ""
  node test/e2e/compare-results.js --dir "$RESULTS_DIR"
elif [ "$RESULT_COUNT" -eq 1 ]; then
  echo "Single model tested. Results saved to:"
  echo "  $RESULTS_DIR/results-*.json"
  echo ""
else
  echo "⚠️  No successful test runs found"
  echo ""
  exit 1
fi

echo "Results saved to: $RESULTS_DIR/"
echo ""
