# Contributing to smol-agent

Thank you for your interest in contributing to smol-agent! We welcome contributions from the community.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [Pull Requests](#pull-requests)
- [Release Process](#release-process)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project and everyone participating in it is governed by basic principles of respect and inclusivity. By participating, you are expected to uphold this standard. Be respectful, be constructive, and be welcoming.

## Development Setup

```bash
git clone https://github.com/smol-ai/smol-agent.git
cd smol-agent
npm install
```

## Running locally

```bash
npm start
# or
node src/index.js
```

## Running in development mode with global linking

```bash
npm link
smol-agent  # now uses your local code
```

## Project Structure

- `src/index.js` - CLI entry point
- `src/agent.js` - Core agent loop
- `src/context.js` - Project context gathering
- `src/context-manager.js` - Context window management
- `src/ollama.js` - Ollama API wrapper
- `src/tools/` - Tool implementations
- `src/ui/` - Terminal UI (Ink/React)

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (if any)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## Coding Standards

- **ES Modules**: Use `import`/`export` syntax (no `require()`)
- **JavaScript**: Plain JS with JSDoc comments for documentation
- **Code style**: Follow existing patterns in the codebase
- **Tools**: Each tool in `src/tools/` should self-register with the registry
- **Async/await**: Prefer over `.then()` chains

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation changes
- `refactor:` code refactoring
- `test:` adding/updating tests
- `chore:` maintenance tasks

Example: `feat: add support for custom system prompts`

## Pull Requests

1. **Small PRs**: Keep changes focused and reviewable
2. **Description**: Explain what and why, not just how
3. **Tests**: Add tests for new functionality when possible
4. **Documentation**: Update README.md and AGENT.md as needed
5. **Self-review**: Review your own changes before submitting

## Release Process

Releases are automated via GitHub Actions. When a PR is merged to `main`:

1. **Automatic Versioning**: If the PR has the `release` label, a new version is automatically created
2. **Version Bump**: The version is determined by PR labels:
   - `major` label → Major version bump (breaking changes)
   - `minor` label → Minor version bump (new features)
   - `patch` label → Patch version bump (bug fixes)
   - No version label → Patch version by default
3. **Changelog**: The PR title and body are used for the release notes
4. **NPM Publish**: The package is automatically published to npm

### Creating a Release

1. Create a PR with your changes
2. Add the `release` label to the PR
3. (Optional) Add a version label (`major`, `minor`, or `patch`)
4. Merge the PR — the release workflow handles the rest

### Release Workflow Details

The release workflow (`.github/workflows/release.yml`):
- Triggers when a PR with the `release` label is merged to `main`
- Bumps the version in `package.json`
- Creates a git tag for the new version
- Generates release notes from the PR description
- Publishes to npm (if configured)
- Creates a GitHub Release with the notes

## Reporting Issues

When reporting bugs, please include:

- Node.js version (`node --version`)
- smol-agent version
- Ollama model being used
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs or error messages

For feature requests, describe the use case and expected behavior.

## Questions?

Open an issue at https://github.com/smol-ai/smol-agent/issues
