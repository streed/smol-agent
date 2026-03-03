# E2E Test Performance Notes

## Model Performance Expectations

Different model sizes will have different success rates:

### Large Models (7B+)
- **Expected pass rate**: 80-95%
- **Speed**: Moderate to fast
- **Strengths**: Complex refactoring, multi-step tasks, edge cases

### Medium Models (3B-7B)
- **Expected pass rate**: 60-80%
- **Speed**: Moderate
- **Strengths**: Basic file operations, simple refactoring
- **Challenges**: Complex multi-step tasks, large context

### Small Models (1.5B-3B)
- **Expected pass rate**: 40-60%
- **Speed**: Slow (high timeout needed)
- **Strengths**: Simple CRUD operations
- **Challenges**: Complex reasoning, multi-step coordination, error recovery

## Known Challenges for Small Models

1. **Timeout Issues**: Small models generate tokens more slowly and may need 5-10 minutes per scenario
2. **Tool Formatting**: May struggle with correct tool call syntax
3. **Multi-step Planning**: Difficulty coordinating multiple operations
4. **Error Recovery**: Less reliable at self-correction

## Optimizing for Specific Models

### For Very Small Models (1.5B)
Consider running a subset of tests:
```bash
# Run only simple scenarios
node test/e2e/runner.js --filter "file-create|file-read|file-edit"
```

### For Medium Models (3B)
Standard configuration should work:
```bash
SMOL_TEST_MODEL=qwen2.5-coder:3b npm run test:e2e
```

### For Large Models (7B)
Can reduce timeouts for faster feedback:
```bash
SMOL_TEST_TIMEOUT_SIMPLE=180000 \
SMOL_TEST_TIMEOUT_MEDIUM=300000 \
SMOL_TEST_TIMEOUT_COMPLEX=600000 \
SMOL_TEST_MODEL=qwen2.5-coder:7b npm run test:e2e
```

## CI/CD Considerations

The GitHub Actions workflow:
- Uses generous timeouts (10-20 minutes per scenario)
- Limits to 10 iterations to prevent runaway loops
- Runs all 32 scenarios regardless of model size
- **Expected total runtime**: 2-6 hours depending on model

This is intentional to give a comprehensive benchmark, but may not be suitable for every PR.

## Interpreting Results

A "good" result depends on model size:
- **7B model**: Should pass most tests (25+/32)
- **3B model**: Should pass basic tests (15-20/32)
- **1.5B model**: May only pass simple tests (10-15/32)

The goal is to track improvements and regressions, not achieve 100% pass rate with small models.
