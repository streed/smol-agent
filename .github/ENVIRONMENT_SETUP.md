# GitHub Environment Setup

This repository uses GitHub Environments to manage secrets for model testing.

## Create "Model Test" Environment

1. Go to **Settings** → **Environments**
2. Click **New environment**
3. Name: `Model Test`
4. Click **Configure environment**

## Add Required Secrets

### OLLAMA_API_KEY

1. In the "Model Test" environment, scroll to **Environment secrets**
2. Click **Add secret**
3. Name: `OLLAMA_API_KEY`
4. Value: Your Ollama API key from https://ollama.com/pricing
5. Click **Add secret**

## Optional: Protection Rules

You can optionally add protection rules to the environment:

### Required Reviewers
- Require manual approval before running model tests
- Useful for controlling API costs

### Wait Timer
- Add a delay before deployment
- Useful for rate limiting

### Deployment Branches
- Limit which branches can use this environment
- Example: Only `main` and `develop`

## Verify Setup

Once configured, the workflow will:
- Show "Model Test" environment badge in the workflow run
- Use the scoped `OLLAMA_API_KEY` secret
- Display environment protection status

## Cost Management

To manage API costs:

1. **Set usage limits** in Ollama dashboard
2. **Add required reviewers** to prevent automatic runs
3. **Disable workflow** when not needed:
   ```yaml
   # In .github/workflows/model-benchmark.yml
   on:
     # Comment out 'push' and 'pull_request' to disable automatic runs
     # push:
     #   branches: [main]
     workflow_dispatch:  # Keep manual trigger
   ```

## Troubleshooting

### "OLLAMA_API_KEY not found"
- Ensure secret is added to "Model Test" environment, not repository secrets
- Check environment name matches exactly: `Model Test`

### "Environment protection rule"
- Review environment protection rules
- Approve pending deployment if required reviewers are configured

### "API quota exceeded"
- Check Ollama dashboard for usage limits
- Consider reducing test frequency or model count
