# Session Monitor Agent

Automatically document your Claude Code sessions. Never lose track of bug fixes, decisions, or discoveries again.

## What It Does

Session Monitor watches your Claude Code sessions in the background and automatically creates structured documentation of significant events - bug fixes, architectural decisions, user requests, and more.

## Prerequisites

- **Node.js** >= 20.0.0
- **Claude Code** with hooks support
- **Anthropic API Key** ([Get one here](https://console.anthropic.com/))

## Setup (3 Steps)

### Step 1: Install Globally

```bash
npm install -g session-monitor-agent
```

Or install from source:
```bash
git clone https://github.com/your-username/session-monitor-agent.git
cd session-monitor-agent
npm install && npm run build
npm link  # Makes 'session-monitor' available globally
```

### Step 2: Install Claude Code Hooks

```bash
session-monitor install
```

This adds monitoring hooks to `~/.claude/settings.json`.

### Step 3: Set Up Automatic Startup (macOS)

Choose one of these options:

**Option A: Interactive Mode** (Recommended for most users)
```bash
session-monitor install-startup
```
When you start Claude Code, you'll get a dialog to start the monitor with options to configure the API key, output directory, and verbose mode.

**Option B: Fully Automatic Mode**
```bash
# Set your API key in your shell profile (~/.zshrc or ~/.bashrc)
echo 'export ANTHROPIC_API_KEY="your-key-here"' >> ~/.zshrc
source ~/.zshrc

# Install with auto-start
session-monitor install-startup --auto-start
```
The monitor starts automatically whenever you use Claude Code - completely hands-free.

### Done!

Start using Claude Code normally. Documentation appears in `.session-docs/` in your working directory.

---

## Manual Usage

If you prefer not to use automatic startup, you can run the monitor manually:

```bash
# Terminal 1: Start the monitor
export ANTHROPIC_API_KEY="your-key-here"
session-monitor start

# Terminal 2: Use Claude Code normally
claude
```

---

## Configuration Options

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (required) |
| `SESSION_MONITOR_SOCKET` | Custom socket path (optional) |
| `SESSION_MONITOR_DEBUG` | Set to `1` for debug logging |

### Start Command Options

```bash
session-monitor start [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output <dir>` | Output directory | `.session-docs` |
| `-k, --api-key <key>` | Anthropic API key | `$ANTHROPIC_API_KEY` |
| `-m, --model <model>` | Model for analysis | `claude-3-haiku-20240307` |
| `-v, --verbose` | Verbose logging | `false` |
| `-d, --debug` | Debug logging in hooks (writes to `/tmp/`) | `false` |
| `--socket <path>` | Unix socket path | `/tmp/session-monitor.sock` |
| `--max-queue <n>` | Max queue size | `1000` |
| `--batch-size <n>` | Messages per batch | `10` |
| `--flush-interval <ms>` | Flush interval in ms | `5000` |

---

## Output Structure

Documentation is organized by date and session, with SQLite persistence:

```
.session-docs/
├── sessions.db                           # SQLite database (all sessions & events)
└── sessions/
    └── 2025-12-24/
        └── abc123-debugging-auth/
            ├── session.md                # Session overview (generated from DB)
            ├── events/
            │   ├── 001-user_request.md
            │   ├── 002-agent_analysis.md
            │   └── 003-solution_verified.md
            └── summaries/
                └── running-summary.md
```

The SQLite database stores all session data, enabling features like:
- Resume documentation after monitor restart
- Regenerate markdown from database
- Query sessions and events programmatically

---

## What Gets Documented

### Confirmed Events (User Verified)
- `user_request` - What you asked for
- `user_confirmed` - Explicit confirmations
- `user_provided` - Information/context the user directly provided
- `solution_verified` - Fixes confirmed working
- `requirement_clarified` - Clarified requirements

### Unconfirmed Events (Agent Analysis)
- `agent_analysis` - Code/system understanding
- `agent_suggestion` - Recommendations
- `bug_identified` - Root causes found
- `decision_made` - Architectural decisions

### Special Events
- `correction` - Invalidates previous documentation

---

## All Commands

| Command | Description |
|---------|-------------|
| `session-monitor install` | Install Claude Code hooks |
| `session-monitor uninstall` | Remove hooks |
| `session-monitor status` | Check if hooks are installed |
| `session-monitor start` | Start the monitor daemon |
| `session-monitor sentinel` | Run sentinel daemon (macOS) |
| `session-monitor install-startup` | Install auto-start (macOS) |
| `session-monitor uninstall-startup` | Remove auto-start (macOS) |

---

## Sentinel Feature (macOS)

The sentinel ensures you never miss documenting a session. It runs at login and monitors for Claude Code session starts.

### How It Works

```
Login → Sentinel starts → You open Claude Code → Sentinel checks if monitor running
                                                          ↓
                                              If not → Shows dialog / Auto-starts
```

### Configuration Dialog

When using interactive mode (`install-startup` without `--auto-start`), you'll see:

1. **Main Dialog**: "Start (Default)", "Configure...", or "Ignore"
2. **If Configure...**:
   - **API Key** (if not in environment) - hidden input field
   - **Output Directory** - with Browse button
   - **Verbose Mode** - Yes/No

### Sentinel Options

```bash
session-monitor sentinel [options]
session-monitor install-startup [options]
```

| Option | Description |
|--------|-------------|
| `-a, --auto-start` | Auto-start monitor instead of showing dialog |
| `-v, --verbose` | Enable verbose logging |

---

## Troubleshooting

### Hooks not working
```bash
session-monitor status          # Check status
session-monitor install --force # Reinstall
```

### Monitor not receiving events
```bash
ls -la /tmp/session-monitor.sock  # Check socket exists
session-monitor start --verbose   # Run with verbose
```

### Sentinel issues (macOS)
```bash
# Check if running
launchctl list | grep session-monitor

# View logs
cat /tmp/session-monitor-sentinel.log

# Reinstall
session-monitor uninstall-startup
session-monitor install-startup
```

### Debug mode
```bash
session-monitor install --debug
# Logs: /tmp/session-monitor-hooks.log
```

---

## Uninstall

```bash
# Remove auto-start (macOS)
session-monitor uninstall-startup

# Remove hooks
session-monitor uninstall

# Remove global package
npm uninstall -g session-monitor-agent
```

---

## Development

```bash
npm run build      # Build
npm run dev        # Watch mode
npm run lint       # Lint
npm test           # Test
```

## Architecture

```
Claude Code → Hooks → Unix Socket → Session Watcher → Transcript Reader → Message Router
    → Significance Detector → Doc Agent → Deduplication → Database → Markdown
```

- **Hook Script**: Triggered by Claude Code hooks (PostToolUse, Stop, SessionStart, SessionEnd), sends events via Unix socket
- **Session Watcher**: Orchestrates the documentation pipeline, manages one DocumentationAgent per session
- **Transcript Reader**: Parses Claude Code's JSONL transcript files into structured messages
- **Message Router**: Batches messages with queue management and backpressure control
- **Significance Detector**: Pre-filters messages for potential documentation significance (user requests, decisions, discoveries, bug fixes)
- **Documentation Agent**: Uses Claude Haiku to analyze significant content and generate documentation events
- **Deduplication Tracker**: Prevents duplicate events using evidence-based hashing and fuzzy similarity matching
- **Database Manager**: SQLite persistence for sessions, events, deduplication hashes, and analyzed messages
- **File Manager**: Writes organized markdown documentation to `.session-docs/`

---

## License

MIT
