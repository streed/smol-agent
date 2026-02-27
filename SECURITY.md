# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

**Do not open a public issue.** Instead, please:

1. Email the maintainer directly (see package.json for contact info)
2. Include a description of the vulnerability
3. Include steps to reproduce if possible
4. Include potential impact

You should expect a response within 48 hours. We will:

- Confirm receipt of your report
- Investigate and verify the vulnerability
- Develop and test a fix
- Release a patch
- Credit you in the release notes (unless you prefer to remain anonymous)

## Security Considerations

### Command Execution

smol-agent has the ability to execute shell commands via the `run_command` tool. This is a core feature but comes with inherent risks:

- Only run smol-agent in environments you trust
- Review the agent's proposed changes before confirming destructive operations
- Be cautious when processing untrusted input

### File Access

The agent can read and write files within your project directory. Path traversal protections are in place, but:

- Run smol-agent in a dedicated project directory
- Don't run as root/administrator
- Review file operations before confirming

### Network Access

If you use the `web_search` and `web_fetch` tools:

- These require an Ollama API key
- Data is sent to Ollama's servers for processing
- Review Ollama's privacy policy at https://ollama.com/privacy

## Best Practices

1. **Review before executing**: The agent will show you what it plans to do
2. **Use version control**: Commit your changes before running smol-agent
3. **Limit scope**: Run in a dedicated project directory
4. **Monitor token usage**: Be aware of context window limits
5. **Keep updated**: Use the latest version of smol-agent and Ollama