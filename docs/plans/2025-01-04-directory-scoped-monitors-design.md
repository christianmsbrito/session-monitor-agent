# Directory-Scoped Session Monitors

## Overview

Change session monitor from a single global instance to directory-scoped instances. Each monitor captures only Claude Code sessions started within its scope directory (or subdirectories). Multiple monitors can run simultaneously with non-overlapping or hierarchical scopes.

## Problem

Currently, one session monitor instance captures ALL Claude Code sessions system-wide. Users want to:
- Run monitors scoped to specific projects
- Have different output directories for different projects
- Ignore sessions outside their area of interest
- Run multiple monitors for different directory trees simultaneously

## Solution: Registry-Based Routing

### Architecture

```
Claude Code Session (cwd: /projects/frontend/src)
        ↓
   Hook fires with cwd field
        ↓
   Hook Script reads /tmp/session-monitor-registry.json
        ↓
   Finds most specific matching monitor (scope: /projects/frontend)
        ↓
   Routes event to that monitor's socket
        ↓
   Monitor processes session (unchanged from today)
```

### Registry File Structure

**Location:** `/tmp/session-monitor-registry.json`

```json
{
  "monitors": [
    {
      "id": "abc123",
      "socketPath": "/tmp/session-monitor-abc123.sock",
      "scopeDirectory": "/Users/christian/projects/frontend",
      "outputDirectory": "/Users/christian/projects/frontend/.session-docs",
      "pid": 12345,
      "startedAt": "2025-01-04T10:30:00Z"
    }
  ],
  "version": 1
}
```

**Fields:**
- `id`: Unique monitor identifier (short UUID)
- `socketPath`: Unix socket for this monitor
- `scopeDirectory`: Absolute path - monitor captures sessions here and in subdirectories
- `outputDirectory`: Where documentation is written (can differ from scope)
- `pid`: Process ID for stale entry detection
- `startedAt`: ISO timestamp

### Routing Logic

When a hook fires with session `cwd`:

1. Read registry file
2. Filter monitors whose `scopeDirectory` is a prefix of `cwd`
3. Select most specific match (longest `scopeDirectory`)
4. Send event to that monitor's socket
5. If no match, send only to sentinel

**Example:**

| Session cwd | Monitor scopes | Winner |
|-------------|----------------|--------|
| `/projects/frontend/src` | `/projects`, `/projects/frontend` | `/projects/frontend` |
| `/projects/backend` | `/projects/frontend` | None (not covered) |
| `/home/user/anything` | `/home/user` | `/home/user` |

### Monitor Lifecycle

**Startup (`session-monitor start`):**

1. Determine scope: `--scope` flag or `process.cwd()`
2. Generate unique ID
3. Create socket at `/tmp/session-monitor-{id}.sock`
4. Acquire file lock on registry
5. Add entry to registry
6. Release lock
7. Start listening

**Shutdown (SIGINT/SIGTERM):**

1. Finalize active sessions
2. Acquire file lock
3. Remove entry from registry
4. Release lock
5. Delete socket file
6. Exit

**Crash recovery:**

- Stale entries detected by checking if PID is alive
- Hook script skips dead entries
- Next monitor startup cleans stale entries

### CLI Changes

```bash
# Start with scope = current directory (default)
session-monitor start

# Explicit scope
session-monitor start --scope /path/to/directory

# Custom output (can be anywhere)
session-monitor start --scope /projects -o /var/log/session-docs

# Status shows all monitors
session-monitor status
```

**New `--scope` option:**
- Sets the directory tree this monitor covers
- Defaults to current working directory
- Must be an absolute path (resolved if relative)

### Sentinel Changes

**Current behavior:**
- Check if single monitor socket exists
- Alert if not running

**New behavior:**
- On `SessionStart`, extract `cwd` from hook data
- Read registry, check if any monitor covers this `cwd`
- If not covered → show alert

**Alert dialog:**

```
Claude Code session started in:
  /Users/christian/new-project

No session monitor is covering this directory.

[Ignore]  [Configure...]  [Start Monitor (Default)]
```

**Default action:** Start monitor scoped to session's `cwd`

**Configure options:**
- Scope directory (pre-filled with session cwd)
- Output directory (pre-filled with `{scope}/.session-docs`)
- API key (if not in environment)
- Verbose mode

**Auto-start mode (`--auto-start`):**
- Skip dialog, spawn monitor scoped to session's `cwd`

### Hook Script Changes

**Current:** Send to hardcoded `/tmp/session-monitor.sock`

**New:**

```typescript
async function main() {
  const hookData = JSON.parse(input);
  const sessionCwd = hookData.cwd || '';

  // Find matching monitor
  const registry = readRegistry();
  const monitor = findMatchingMonitor(sessionCwd, registry);

  if (monitor) {
    await sendToSocket(event, monitor.socketPath);
  }

  // Always notify sentinel on SessionStart
  if (hookType === 'SessionStart') {
    await sendToSocket(event, SENTINEL_SOCKET_PATH);
  }
}

function findMatchingMonitor(cwd: string, registry: Registry): Monitor | null {
  const alive = registry.monitors.filter(m => isProcessAlive(m.pid));
  const matching = alive.filter(m =>
    cwd === m.scopeDirectory ||
    cwd.startsWith(m.scopeDirectory + '/')
  );

  if (matching.length === 0) return null;

  // Most specific wins
  return matching.sort((a, b) =>
    b.scopeDirectory.length - a.scopeDirectory.length
  )[0];
}
```

### Registry File Management

**Concurrency:**
- Use file locking (advisory locks or `.lock` file)
- Atomic writes: write to temp file, then rename

**Permissions:**
- `0o666` for registry file (any user can read/write)
- Same for socket files

**Missing registry:**
- Hook script: treat as empty (no monitors)
- Monitor startup: create fresh file

### Status Command Enhancement

```bash
$ session-monitor status

Hooks: installed ✓

Active monitors:
  ID        Scope                              Output                         PID
  abc123    /Users/christian/projects          .session-docs                  12345
  def456    /Users/christian/work/backend      /var/log/sessions              12346

Sentinel: running (PID 9999)
```

## Files to Modify

| File | Changes |
|------|---------|
| `src/hooks/hook-script.ts` | Read registry, find matching monitor, route to correct socket |
| `src/watcher/session-watcher.ts` | Register/unregister from registry on start/shutdown |
| `src/cli/args.ts` | Add `--scope` option to `start` command |
| `src/sentinel/sentinel.ts` | Check registry for coverage instead of single socket |
| `src/index.ts` | Pass scope directory to watcher config |

## New Files

| File | Purpose |
|------|---------|
| `src/registry/registry-manager.ts` | Read/write/lock registry, stale cleanup, matching logic |

## Unchanged Components

These components work per-session and need no changes:
- `DocumentationAgent`
- `MessageRouter`
- `TranscriptReader`
- `DatabaseManager`
- `FileManager`
- `SignificanceDetector`

## Migration

Clean break - no backward compatibility with old single-socket approach:
1. User upgrades package
2. Restarts monitor with new version
3. New monitor registers in registry
4. Hook script uses registry routing

Old monitors (if still running) become unreachable as hook script no longer sends to hardcoded socket.
