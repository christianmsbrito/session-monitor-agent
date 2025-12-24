# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Build the project (TypeScript to JavaScript)
npm run build

# Watch mode for development
npm run dev

# Run the session monitor
npm start

# Lint the codebase
npm run lint

# Run tests
npm test

# Run tests once (no watch)
npm run test:run
```

## Architecture Overview

This is a background documentation agent that watches Claude Code sessions via hooks and automatically documents significant events (bug fixes, decisions, discoveries).

### Data Flow Pipeline

```
Claude Code Session
        ↓
   Claude Hooks (PostToolUse, Stop, SessionStart, SessionEnd)
        ↓
   Hook Script (src/hooks/hook-script.ts) → sends JSON to Unix socket
        ↓
   SocketServer (src/server/socket-server.ts) → receives hook events
        ↓
   SessionWatcher (src/watcher/session-watcher.ts) → reads transcript file
        ↓
   TranscriptReader (src/server/transcript-reader.ts) → parses JSONL entries
        ↓
   MessageRouter (src/interceptor/message-router.ts) → batches messages with backpressure
        ↓
   DocumentationAgent (src/documentation/doc-agent.ts) → Claude Haiku analyzes for significance
        ↓
   FileManager (src/output/file-manager.ts) → writes markdown documentation
```

### Key Components

- **SessionWatcher**: Main orchestrator - listens on Unix socket for hook notifications, coordinates the documentation pipeline. Creates one DocumentationAgent per Claude Code session.

- **DocumentationAgent**: Uses Claude Haiku to analyze conversation batches, detect significant events (user requests, bug fixes, decisions), and generate documentation. Tracks confirmed vs unconfirmed findings.

- **HierarchicalContextManager**: Three-tier context management (recent/hourly/session) to handle long sessions without exceeding context limits. Preserves full user prompts and summarizes older content.

- **MessageRouter**: Queue with backpressure control. Batches messages before sending to the doc agent, filters out internal thinking content.

- **FileManager**: Manages the `.session-docs/` output structure organized by date and session subject.

### CLI Commands

**Core Commands:**
- `session-monitor install` - Installs hooks into `~/.claude/settings.json`
- `session-monitor uninstall` - Removes hooks
- `session-monitor status` - Checks if hooks are installed
- `session-monitor start` - Starts the monitor daemon (requires `ANTHROPIC_API_KEY`)

**Sentinel Commands (macOS):**
- `session-monitor sentinel` - Runs the sentinel daemon that alerts when monitor isn't running
- `session-monitor install-startup` - Installs macOS LaunchAgent for auto-start on login
- `session-monitor uninstall-startup` - Removes the LaunchAgent

### Sentinel Feature

The sentinel is a lightweight daemon that ensures you never miss documenting a Claude Code session. It runs at system startup and monitors for session starts.

**Architecture:**
```
User Login
    ↓
LaunchAgent starts sentinel daemon
    ↓
Sentinel listens on /tmp/session-monitor-sentinel.sock
    ↓
Claude Code Session Starts
    ↓
Hook script sends SessionStart to BOTH:
  - Main monitor socket (/tmp/session-monitor.sock)
  - Sentinel socket (/tmp/session-monitor-sentinel.sock)
    ↓
Sentinel checks if main monitor is running
    ↓
If NOT running → Shows dialog with configuration options
```

**Sentinel Options:**
- `--auto-start` / `-a`: Automatically start the monitor instead of showing a dialog
- `--verbose` / `-v`: Enable verbose logging

**Configuration Dialog (when monitor not running):**
1. Main prompt with options: "Ignore", "Configure...", "Start (Default)"
2. If "Configure..." selected:
   - API key input (if `ANTHROPIC_API_KEY` not in environment, with hidden input)
   - Output directory (text field with "Browse..." option, default: `.session-docs`)
   - Verbose mode toggle (Yes/No buttons, default: No)

**Setup:**
```bash
# Install hooks first
session-monitor install

# Option 1: Notification mode (shows dialog when monitor not running)
session-monitor install-startup

# Option 2: Auto-start mode (automatically starts monitor)
session-monitor install-startup --auto-start

# To uninstall
session-monitor uninstall-startup
```

**Key Files:**
- `src/sentinel/sentinel.ts` - Main sentinel daemon
- `src/sentinel/launchagent.ts` - macOS LaunchAgent installer
- LaunchAgent plist: `~/Library/LaunchAgents/com.session-monitor.sentinel.plist`

### Output Structure

```
.session-docs/
├── index.md
└── sessions/
    └── YYYY-MM-DD/
        └── {sessionId}-{subject-slug}/
            ├── session.md
            ├── events/
            │   └── 001-user_request.md
            └── summaries/
                └── running-summary.md
```

### Event Types

Documentation events are categorized as:
- **Confirmed** (user verified): `user_request`, `user_confirmed`, `user_provided`, `solution_verified`, `requirement_clarified`
- **Unconfirmed** (agent analysis): `agent_analysis`, `agent_suggestion`, `bug_identified`, `decision_made`
- **Special**: `correction` (invalidates previous documentation)

## Environment Requirements

- Node.js >= 20.0.0
- `ANTHROPIC_API_KEY` environment variable for the documentation agent
