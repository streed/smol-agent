# Contributing to smol-agent

Thank you for your interest in contributing to smol-agent!

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

## Code Style

- Use ES modules (`import`/`export`)
- Use JavaScript (no TypeScript for now)
- Follow existing code patterns

## Questions?

Open an issue at https://github.com/smol-ai/smol-agent/issues
