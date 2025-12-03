# Session Monitor Agent

A background documentation agent that watches Claude Code sessions via hooks and automatically documents significant events like bug fixes, decisions, and discoveries.

## How It Works

Session Monitor runs as a background daemon that integrates with Claude Code through its hooks system. When you use Claude Code normally, the monitor:

1. **Captures session events** via hooks (tool usage, conversation stops, session lifecycle)
2. **Reads the conversation transcript** to understand context
3. **Analyzes with Claude Haiku** to identify significant moments worth documenting
4. **Writes structured markdown** organizing findings by session and event type

The result is automatic, comprehensive documentation of your coding sessions without any manual effort.

## Installation

```bash
# Clone and install
git clone https://github.com/your-username/session-monitor-agent.git
cd session-monitor-agent
npm install
npm run build

# Install hooks into Claude Code
npm start -- install
```

## Quick Start

```bash
# 1. Set your Anthropic API key
export ANTHROPIC_API_KEY="your-key-here"

# 2. Start the monitor daemon (in a dedicated terminal)
npm start -- start

# 3. Use Claude Code normally in another terminal
# Documentation will appear in .session-docs/
```

## Commands

### `session-monitor install`

Installs monitoring hooks into Claude Code's settings (`~/.claude/settings.json`).

```bash
npm start -- install           # Install hooks
npm start -- install --force   # Overwrite existing hooks
npm start -- install --debug   # Enable debug logging in hooks
```

### `session-monitor uninstall`

Removes session-monitor hooks from Claude Code.

```bash
npm start -- uninstall
```

### `session-monitor status`

Checks if hooks are properly installed.

```bash
npm start -- status
```

### `session-monitor start`

Starts the monitoring daemon. This should run in a dedicated terminal while you use Claude Code.

```bash
npm start -- start                        # Basic start
npm start -- start --verbose              # Verbose logging
npm start -- start --output ./my-docs     # Custom output directory
npm start -- start --model claude-3-5-haiku-latest  # Different model
```

**Options:**
- `-o, --output <dir>` - Output directory (default: `.session-docs`)
- `-k, --api-key <key>` - Anthropic API key (or use `ANTHROPIC_API_KEY` env var)
- `-m, --model <model>` - Model for documentation agent (default: `claude-3-haiku-20240307`)
- `-v, --verbose` - Enable verbose logging
- `--socket <path>` - Unix socket path (default: `/tmp/session-monitor.sock`)
- `--max-queue <n>` - Maximum message queue size (default: 1000)
- `--batch-size <n>` - Messages per batch (default: 10)
- `--flush-interval <ms>` - Flush interval in milliseconds (default: 5000)

## Output Structure

Documentation is organized by date and session:

```
.session-docs/
├── index.md                              # Links to all sessions
└── sessions/
    └── 2025-12-03/
        └── abc123-debugging-auth/        # sessionId + subject slug
            ├── session.md                # Session overview with event links
            ├── events/
            │   ├── 001-user_request.md   # Individual documented events
            │   ├── 002-agent_analysis.md
            │   └── 003-solution_verified.md
            └── summaries/
                └── running-summary.md    # Live-updated session summary
```

## What Gets Documented

The agent distinguishes between **confirmed** and **unconfirmed** information:

### Confirmed Events (User Verified)
- **user_request** - What the user asked for
- **user_confirmed** - User explicitly confirmed agent's analysis
- **user_provided** - Information the user directly provided
- **solution_verified** - Fix confirmed working by user
- **requirement_clarified** - Requirements confirmed by user

### Unconfirmed Events (Agent Analysis)
- **agent_analysis** - Agent's understanding of code/system
- **agent_suggestion** - Agent's recommendations
- **bug_identified** - Root cause identified (until user confirms)
- **decision_made** - Decisions made (until implemented/tested)

### Special Events
- **correction** - Previous finding was wrong, invalidates earlier documentation

## Example Documentation Output

**Session: Debugging Authentication Flow**

```markdown
# Debugging Authentication Flow

**Session ID**: abc12345-6789-...
**Date**: 2025-12-03

## Events

### user_request: Fix login timeout issue
Users are experiencing timeouts when logging in...
[→ Full details](./events/001-user_request.md)

### agent_analysis: Token refresh mechanism
The authentication system uses a token refresh pattern...
[→ Full details](./events/002-agent_analysis.md)

### solution_verified: Increased timeout resolved issue
After increasing the timeout from 5s to 30s...
[→ Full details](./events/003-solution_verified.md)
```

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Lint
npm run lint

# Test
npm test
npm run test:run  # Run once without watch
```

## Architecture

```
Claude Code → Hooks → Unix Socket → Session Watcher → Doc Agent → Markdown Files
```

Key components:
- **Hook Script**: Lightweight script triggered by Claude Code hooks, sends events via Unix socket
- **Socket Server**: Receives hook events and triggers transcript processing
- **Session Watcher**: Orchestrates the pipeline, manages one DocumentationAgent per Claude Code session
- **Documentation Agent**: Uses Claude Haiku to analyze conversations and extract significant events
- **Hierarchical Context Manager**: Three-tier context (recent/hourly/session) for handling long sessions
- **File Manager**: Writes and organizes markdown documentation

## Requirements

- Node.js >= 20.0.0
- Anthropic API key with access to Claude Haiku
- Claude Code with hooks support

## Troubleshooting

### Hooks not triggering
1. Check hook status: `npm start -- status`
2. Reinstall with force: `npm start -- install --force`
3. Verify Claude Code settings: `cat ~/.claude/settings.json`

### Monitor not receiving events
1. Ensure monitor is running: Check for "Waiting for Claude Code hooks..." message
2. Check socket exists: `ls -la /tmp/session-monitor.sock`
3. Enable verbose mode: `npm start -- start --verbose`

### Debug mode
Install hooks with debug logging to troubleshoot hook execution:
```bash
npm start -- install --debug
# Logs written to: /tmp/session-monitor-hooks.log
```

## License

MIT
