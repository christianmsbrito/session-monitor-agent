# Directory-Scoped Session Monitors Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable multiple session monitors to run simultaneously, each scoped to a directory tree, with registry-based routing.

**Architecture:** Hook script reads a central registry file to route events to the correct monitor based on session `cwd`. Each monitor registers/unregisters itself on startup/shutdown. Sentinel checks registry for coverage gaps.

**Tech Stack:** Node.js, TypeScript, Unix sockets, JSON file registry with file locking

---

## Task 1: Create RegistryManager - Types and Interface

**Files:**
- Create: `src/registry/registry-manager.ts`
- Create: `src/registry/index.ts`

**Step 1: Create the registry types and class skeleton**

Create `src/registry/registry-manager.ts`:

```typescript
/**
 * RegistryManager - Manages the central registry of active session monitors
 *
 * The registry tracks all running monitors and their scope directories,
 * enabling hooks to route events to the correct monitor.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const REGISTRY_PATH = path.join(os.tmpdir(), 'session-monitor-registry.json');
const LOCK_PATH = REGISTRY_PATH + '.lock';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

export interface MonitorEntry {
  id: string;
  socketPath: string;
  scopeDirectory: string;
  outputDirectory: string;
  pid: number;
  startedAt: string;
}

export interface Registry {
  monitors: MonitorEntry[];
  version: number;
}

export class RegistryManager {
  /**
   * Generate a unique monitor ID
   */
  static generateId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  /**
   * Get socket path for a monitor ID
   */
  static getSocketPath(monitorId: string): string {
    return path.join(os.tmpdir(), `session-monitor-${monitorId}.sock`);
  }

  /**
   * Read the registry file (creates empty registry if missing)
   */
  static readRegistry(): Registry {
    try {
      const content = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      return JSON.parse(content) as Registry;
    } catch {
      return { monitors: [], version: 1 };
    }
  }

  /**
   * Write the registry file atomically
   */
  private static writeRegistry(registry: Registry): void {
    const tempPath = REGISTRY_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), { mode: 0o666 });
    fs.renameSync(tempPath, REGISTRY_PATH);
  }

  /**
   * Acquire file lock with timeout
   */
  private static async acquireLock(): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
      try {
        fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
        return;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // Lock exists, check if holder is alive
          try {
            const holderPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf-8'), 10);
            if (!RegistryManager.isProcessAlive(holderPid)) {
              // Stale lock, remove it
              fs.unlinkSync(LOCK_PATH);
              continue;
            }
          } catch {
            // Lock file gone, retry
            continue;
          }
          await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        } else {
          throw err;
        }
      }
    }

    throw new Error('Failed to acquire registry lock: timeout');
  }

  /**
   * Release file lock
   */
  private static releaseLock(): void {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // Already released
    }
  }

  /**
   * Check if a process is alive
   */
  static isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register a new monitor in the registry
   */
  static async register(entry: MonitorEntry): Promise<void> {
    await RegistryManager.acquireLock();
    try {
      const registry = RegistryManager.readRegistry();

      // Remove any stale entries for this ID or dead processes
      registry.monitors = registry.monitors.filter(m =>
        m.id !== entry.id && RegistryManager.isProcessAlive(m.pid)
      );

      registry.monitors.push(entry);
      RegistryManager.writeRegistry(registry);
    } finally {
      RegistryManager.releaseLock();
    }
  }

  /**
   * Unregister a monitor from the registry
   */
  static async unregister(monitorId: string): Promise<void> {
    await RegistryManager.acquireLock();
    try {
      const registry = RegistryManager.readRegistry();
      registry.monitors = registry.monitors.filter(m => m.id !== monitorId);
      RegistryManager.writeRegistry(registry);
    } finally {
      RegistryManager.releaseLock();
    }
  }

  /**
   * Find the monitor that should handle a session with the given cwd.
   * Returns the most specific (longest path) matching monitor.
   */
  static findMatchingMonitor(sessionCwd: string): MonitorEntry | null {
    const registry = RegistryManager.readRegistry();

    // Filter to alive monitors whose scope contains the session cwd
    const candidates = registry.monitors.filter(m => {
      if (!RegistryManager.isProcessAlive(m.pid)) return false;

      // Normalize paths for comparison
      const normalizedCwd = path.resolve(sessionCwd);
      const normalizedScope = path.resolve(m.scopeDirectory);

      return normalizedCwd === normalizedScope ||
             normalizedCwd.startsWith(normalizedScope + path.sep);
    });

    if (candidates.length === 0) return null;

    // Return most specific (longest scopeDirectory)
    return candidates.sort((a, b) =>
      b.scopeDirectory.length - a.scopeDirectory.length
    )[0];
  }

  /**
   * Check if a session cwd is covered by any monitor
   */
  static isCovered(sessionCwd: string): boolean {
    return RegistryManager.findMatchingMonitor(sessionCwd) !== null;
  }

  /**
   * Get all active (alive) monitors
   */
  static getActiveMonitors(): MonitorEntry[] {
    const registry = RegistryManager.readRegistry();
    return registry.monitors.filter(m => RegistryManager.isProcessAlive(m.pid));
  }

  /**
   * Clean up stale entries (dead processes)
   */
  static async cleanupStale(): Promise<number> {
    await RegistryManager.acquireLock();
    try {
      const registry = RegistryManager.readRegistry();
      const before = registry.monitors.length;
      registry.monitors = registry.monitors.filter(m =>
        RegistryManager.isProcessAlive(m.pid)
      );
      const removed = before - registry.monitors.length;
      if (removed > 0) {
        RegistryManager.writeRegistry(registry);
      }
      return removed;
    } finally {
      RegistryManager.releaseLock();
    }
  }
}
```

**Step 2: Create the index export**

Create `src/registry/index.ts`:

```typescript
export {
  RegistryManager,
  REGISTRY_PATH,
  type MonitorEntry,
  type Registry,
} from './registry-manager.js';
```

**Step 3: Verify it compiles**

Run: `npm run build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/registry/
git commit -m "feat(registry): add RegistryManager for multi-monitor coordination"
```

---

## Task 2: Add RegistryManager Tests

**Files:**
- Create: `src/registry/registry-manager.test.ts`

**Step 1: Write tests for RegistryManager**

Create `src/registry/registry-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RegistryManager, REGISTRY_PATH, type MonitorEntry } from './registry-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('RegistryManager', () => {
  const testRegistryPath = path.join(os.tmpdir(), 'test-session-monitor-registry.json');
  const testLockPath = testRegistryPath + '.lock';

  // Store original path and override for tests
  let originalRegistryPath: string;

  beforeEach(() => {
    // Clean up any existing test files
    try { fs.unlinkSync(testRegistryPath); } catch {}
    try { fs.unlinkSync(testLockPath); } catch {}
    try { fs.unlinkSync(testRegistryPath + '.tmp'); } catch {}
  });

  afterEach(() => {
    // Clean up test files
    try { fs.unlinkSync(testRegistryPath); } catch {}
    try { fs.unlinkSync(testLockPath); } catch {}
    try { fs.unlinkSync(testRegistryPath + '.tmp'); } catch {}
  });

  describe('generateId', () => {
    it('generates unique 8-character IDs', () => {
      const id1 = RegistryManager.generateId();
      const id2 = RegistryManager.generateId();

      expect(id1).toHaveLength(8);
      expect(id2).toHaveLength(8);
      expect(id1).not.toBe(id2);
    });
  });

  describe('getSocketPath', () => {
    it('returns correct socket path for monitor ID', () => {
      const socketPath = RegistryManager.getSocketPath('abc12345');
      expect(socketPath).toBe(path.join(os.tmpdir(), 'session-monitor-abc12345.sock'));
    });
  });

  describe('isProcessAlive', () => {
    it('returns true for current process', () => {
      expect(RegistryManager.isProcessAlive(process.pid)).toBe(true);
    });

    it('returns false for non-existent process', () => {
      // Use a very high PID that's unlikely to exist
      expect(RegistryManager.isProcessAlive(999999999)).toBe(false);
    });
  });

  describe('readRegistry', () => {
    it('returns empty registry when file does not exist', () => {
      const registry = RegistryManager.readRegistry();
      expect(registry.monitors).toEqual([]);
      expect(registry.version).toBe(1);
    });
  });

  describe('findMatchingMonitor', () => {
    it('returns null when no monitors registered', () => {
      const result = RegistryManager.findMatchingMonitor('/some/path');
      expect(result).toBeNull();
    });

    it('finds exact match', async () => {
      const entry: MonitorEntry = {
        id: 'test1',
        socketPath: '/tmp/test.sock',
        scopeDirectory: '/projects/frontend',
        outputDirectory: '/projects/frontend/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(entry);

      const result = RegistryManager.findMatchingMonitor('/projects/frontend');
      expect(result?.id).toBe('test1');
    });

    it('finds monitor for child directory', async () => {
      const entry: MonitorEntry = {
        id: 'test1',
        socketPath: '/tmp/test.sock',
        scopeDirectory: '/projects',
        outputDirectory: '/projects/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(entry);

      const result = RegistryManager.findMatchingMonitor('/projects/frontend/src');
      expect(result?.id).toBe('test1');
    });

    it('returns most specific match when multiple monitors cover path', async () => {
      const entry1: MonitorEntry = {
        id: 'broad',
        socketPath: '/tmp/broad.sock',
        scopeDirectory: '/projects',
        outputDirectory: '/projects/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      const entry2: MonitorEntry = {
        id: 'specific',
        socketPath: '/tmp/specific.sock',
        scopeDirectory: '/projects/frontend',
        outputDirectory: '/projects/frontend/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(entry1);
      await RegistryManager.register(entry2);

      const result = RegistryManager.findMatchingMonitor('/projects/frontend/src');
      expect(result?.id).toBe('specific');
    });

    it('returns null for unrelated path', async () => {
      const entry: MonitorEntry = {
        id: 'test1',
        socketPath: '/tmp/test.sock',
        scopeDirectory: '/projects/frontend',
        outputDirectory: '/projects/frontend/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(entry);

      const result = RegistryManager.findMatchingMonitor('/other/path');
      expect(result).toBeNull();
    });

    it('ignores dead monitor processes', async () => {
      const entry: MonitorEntry = {
        id: 'dead',
        socketPath: '/tmp/dead.sock',
        scopeDirectory: '/projects',
        outputDirectory: '/projects/.session-docs',
        pid: 999999999, // Non-existent PID
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(entry);

      const result = RegistryManager.findMatchingMonitor('/projects/src');
      expect(result).toBeNull();
    });
  });

  describe('register and unregister', () => {
    it('registers and retrieves monitor', async () => {
      const entry: MonitorEntry = {
        id: 'test1',
        socketPath: '/tmp/test.sock',
        scopeDirectory: '/test',
        outputDirectory: '/test/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(entry);

      const monitors = RegistryManager.getActiveMonitors();
      expect(monitors).toHaveLength(1);
      expect(monitors[0].id).toBe('test1');
    });

    it('unregisters monitor', async () => {
      const entry: MonitorEntry = {
        id: 'test1',
        socketPath: '/tmp/test.sock',
        scopeDirectory: '/test',
        outputDirectory: '/test/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(entry);
      await RegistryManager.unregister('test1');

      const monitors = RegistryManager.getActiveMonitors();
      expect(monitors).toHaveLength(0);
    });
  });

  describe('isCovered', () => {
    it('returns true when path is covered', async () => {
      const entry: MonitorEntry = {
        id: 'test1',
        socketPath: '/tmp/test.sock',
        scopeDirectory: '/projects',
        outputDirectory: '/projects/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(entry);

      expect(RegistryManager.isCovered('/projects/frontend')).toBe(true);
    });

    it('returns false when path is not covered', async () => {
      const entry: MonitorEntry = {
        id: 'test1',
        socketPath: '/tmp/test.sock',
        scopeDirectory: '/projects/frontend',
        outputDirectory: '/projects/frontend/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(entry);

      expect(RegistryManager.isCovered('/other')).toBe(false);
    });
  });

  describe('cleanupStale', () => {
    it('removes dead process entries', async () => {
      const aliveEntry: MonitorEntry = {
        id: 'alive',
        socketPath: '/tmp/alive.sock',
        scopeDirectory: '/alive',
        outputDirectory: '/alive/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      const deadEntry: MonitorEntry = {
        id: 'dead',
        socketPath: '/tmp/dead.sock',
        scopeDirectory: '/dead',
        outputDirectory: '/dead/.session-docs',
        pid: 999999999,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(aliveEntry);
      await RegistryManager.register(deadEntry);

      const removed = await RegistryManager.cleanupStale();

      expect(removed).toBe(1);
      const monitors = RegistryManager.getActiveMonitors();
      expect(monitors).toHaveLength(1);
      expect(monitors[0].id).toBe('alive');
    });
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `npm run test:run -- src/registry/registry-manager.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/registry/registry-manager.test.ts
git commit -m "test(registry): add comprehensive tests for RegistryManager"
```

---

## Task 3: Add --scope CLI Option

**Files:**
- Modify: `src/cli/args.ts`

**Step 1: Add scope option to WatchOptions interface**

In `src/cli/args.ts`, update the `WatchOptions` interface (around line 11):

```typescript
export interface WatchOptions {
  output: string;
  apiKey?: string;
  model: string;
  verbose: boolean;
  maxQueue: number;
  batchSize: number;
  flushInterval: number;
  socketPath?: string;
  scope?: string;  // Add this line
}
```

**Step 2: Add --scope option to start command**

In `src/cli/args.ts`, add the scope option to the start command (after the --socket option, around line 136):

```typescript
    .option(
      '--scope <dir>',
      'Directory scope for this monitor (default: current directory)'
    )
```

**Step 3: Include scope in parsed options**

In `src/cli/args.ts`, update the action handler for start command (around line 148):

```typescript
    .action((opts) => {
      program.setOptionValue('_parsed', {
        command: 'start',
        options: {
          output: opts.output,
          apiKey: opts.apiKey,
          model: opts.model,
          verbose: opts.verbose,
          maxQueue: parseInt(opts.maxQueue, 10),
          batchSize: parseInt(opts.batchSize, 10),
          flushInterval: parseInt(opts.flushInterval, 10),
          socketPath: opts.socket,
          scope: opts.scope,  // Add this line
        },
      });
    });
```

**Step 4: Update buildWatcherConfig to include scopeDirectory**

In `src/cli/args.ts`, update the `buildWatcherConfig` function (around line 248):

```typescript
export function buildWatcherConfig(options: WatchOptions): WatcherConfig {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error(
      'Error: ANTHROPIC_API_KEY environment variable or --api-key option required'
    );
    process.exit(1);
  }

  // Resolve output directory to absolute path
  const outputDir = path.isAbsolute(options.output)
    ? options.output
    : path.resolve(process.cwd(), options.output);

  // Resolve scope directory to absolute path (default: cwd)
  const scopeDirectory = options.scope
    ? (path.isAbsolute(options.scope)
        ? options.scope
        : path.resolve(process.cwd(), options.scope))
    : process.cwd();

  return {
    socketPath: options.socketPath,
    outputDir,
    scopeDirectory,  // Add this line
    maxQueueSize: options.maxQueue,
    batchSize: options.batchSize,
    flushIntervalMs: options.flushInterval,
    maxRecentMessages: DEFAULT_CONFIG.maxRecentMessages,
    summarizeAfter: DEFAULT_CONFIG.summarizeAfter,
    apiKey,
    docModel: options.model,
    verbose: options.verbose,
  };
}
```

**Step 5: Update printUsage to document --scope**

In `src/cli/args.ts`, update the usage text (around line 317):

```typescript
OPTIONS (for 'start' command):
  -o, --output <dir>       Output directory for docs (default: .session-docs)
  --scope <dir>            Directory scope for this monitor (default: cwd)
  -k, --api-key <key>      Anthropic API key (or set ANTHROPIC_API_KEY)
```

**Step 6: Verify it compiles**

Run: `npm run build`
Expected: No errors (will show error about scopeDirectory not in WatcherConfig yet - we'll fix that next)

**Step 7: Commit**

```bash
git add src/cli/args.ts
git commit -m "feat(cli): add --scope option for directory-scoped monitoring"
```

---

## Task 4: Update WatcherConfig Type

**Files:**
- Modify: `src/watcher/session-watcher.ts`
- Modify: `src/watcher/index.ts`

**Step 1: Add scopeDirectory to WatcherConfig**

In `src/watcher/session-watcher.ts`, update the `WatcherConfig` interface (around line 16):

```typescript
export interface WatcherConfig extends Config {
  /** Custom socket path (optional) */
  socketPath?: string;
  /** Directory scope for this monitor */
  scopeDirectory?: string;
}
```

**Step 2: Export scopeDirectory in index if needed**

Check `src/watcher/index.ts` - it should already export `WatcherConfig`.

**Step 3: Verify it compiles**

Run: `npm run build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/watcher/
git commit -m "feat(watcher): add scopeDirectory to WatcherConfig"
```

---

## Task 5: Update SessionWatcher to Register/Unregister

**Files:**
- Modify: `src/watcher/session-watcher.ts`

**Step 1: Add imports for RegistryManager**

At the top of `src/watcher/session-watcher.ts`, add:

```typescript
import { RegistryManager, type MonitorEntry } from '../registry/index.js';
```

**Step 2: Add monitorId and scopeDirectory properties**

In the `SessionWatcher` class, add new properties (around line 52):

```typescript
export class SessionWatcher {
  private socketServer: SocketServer;
  private transcriptReader: TranscriptReader;
  private sessions: Map<string, SessionState> = new Map();
  private monitorSessionId: string;
  private monitorId: string;  // Add this
  private scopeDirectory: string;  // Add this
  private verbose: boolean;
  private messageCount: number = 0;
  private hookCount: number = 0;
  private db?: DatabaseManager;
```

**Step 3: Initialize monitorId and scopeDirectory in constructor**

Update the constructor (around line 58):

```typescript
  constructor(private config: WatcherConfig) {
    this.monitorSessionId = this.generateSessionId();
    this.monitorId = RegistryManager.generateId();
    this.scopeDirectory = config.scopeDirectory || process.cwd();
    this.verbose = config.verbose;

    // Initialize components with unique socket path
    const socketPath = config.socketPath || RegistryManager.getSocketPath(this.monitorId);
    this.socketServer = new SocketServer({
      socketPath,
    });
```

**Step 4: Register on start**

Update the `start` method to register with the registry (around line 394, after database init):

```typescript
  async start(): Promise<void> {
    // Initialize database for persistence
    const dbPath = path.join(this.config.outputDir, 'sessions.db');
    try {
      this.db = initializeDatabase(dbPath);
      console.error(`[session-monitor] Database initialized: ${dbPath}`);
    } catch (error) {
      console.error(`[session-monitor] Warning: Could not initialize database: ${error}`);
      console.error(`[session-monitor] Falling back to file-based storage`);
    }

    // Register in the monitor registry
    const entry: MonitorEntry = {
      id: this.monitorId,
      socketPath: this.socketServer.getSocketPath(),
      scopeDirectory: this.scopeDirectory,
      outputDirectory: this.config.outputDir,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    await RegistryManager.register(entry);

    console.error(`[session-monitor] Starting hook-based session monitor`);
    console.error(`[session-monitor] Monitor ID: ${this.monitorId}`);
    console.error(`[session-monitor] Scope: ${this.scopeDirectory}`);
    console.error(`[session-monitor] Output: ${this.config.outputDir}`);
    console.error(`[session-monitor] Socket: ${this.socketServer.getSocketPath()}`);
    console.error(`[session-monitor] Waiting for Claude Code hooks...`);
    console.error(`[session-monitor] Monitoring sessions in ${this.scopeDirectory} and subdirectories`);
    console.error(`[session-monitor] Press Ctrl+C to stop\n`);

    await this.socketServer.start();

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }
```

**Step 5: Unregister on shutdown**

Update the `shutdown` method to unregister (around line 424):

```typescript
  async shutdown(): Promise<void> {
    console.error('\n[session-monitor] Shutting down...');

    // Unregister from registry first
    await RegistryManager.unregister(this.monitorId);

    // Stop accepting new connections
    await this.socketServer.stop();

    // ... rest of shutdown logic unchanged
```

**Step 6: Add getter for monitorId**

Add a getter method (around line 477):

```typescript
  /**
   * Get monitor ID
   */
  getMonitorId(): string {
    return this.monitorId;
  }

  /**
   * Get scope directory
   */
  getScopeDirectory(): string {
    return this.scopeDirectory;
  }
```

**Step 7: Verify it compiles**

Run: `npm run build`
Expected: No errors

**Step 8: Commit**

```bash
git add src/watcher/session-watcher.ts
git commit -m "feat(watcher): register/unregister with monitor registry"
```

---

## Task 6: Update Hook Script for Registry-Based Routing

**Files:**
- Modify: `src/hooks/hook-script.ts`

**Step 1: Add registry imports and types**

Replace the top of `src/hooks/hook-script.ts` (lines 1-24):

```typescript
#!/usr/bin/env node
/**
 * Hook script that sends events to the session-monitor daemon
 *
 * This script is called by Claude Code hooks and forwards events
 * to the appropriate session-monitor based on the session's working directory.
 *
 * Usage: Called automatically by Claude Code when hooks fire
 * Input: JSON via stdin with hook data
 * Output: JSON response (optional)
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REGISTRY_PATH = path.join(os.tmpdir(), 'session-monitor-registry.json');
const SENTINEL_SOCKET_PATH = path.join(os.tmpdir(), 'session-monitor-sentinel.sock');

const DEBUG = process.env.SESSION_MONITOR_DEBUG === '1';
const LOG_FILE = path.join(os.tmpdir(), 'session-monitor-hooks.log');

interface MonitorEntry {
  id: string;
  socketPath: string;
  scopeDirectory: string;
  outputDirectory: string;
  pid: number;
  startedAt: string;
}

interface Registry {
  monitors: MonitorEntry[];
  version: number;
}
```

**Step 2: Update HookInput interface to include cwd**

Update the `HookInput` interface (around line 34):

```typescript
interface HookInput {
  hook_type?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;  // Add this - working directory of the Claude session
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}
```

**Step 3: Add registry reading and matching functions**

Add these functions before the `main` function:

```typescript
function debugLog(message: string): void {
  if (DEBUG) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logLine);
  }
}

function readRegistry(): Registry {
  try {
    const content = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    return JSON.parse(content) as Registry;
  } catch {
    return { monitors: [], version: 1 };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findMatchingMonitor(sessionCwd: string): MonitorEntry | null {
  const registry = readRegistry();

  // Filter to alive monitors whose scope contains the session cwd
  const candidates = registry.monitors.filter(m => {
    if (!isProcessAlive(m.pid)) return false;

    // Normalize paths for comparison
    const normalizedCwd = path.resolve(sessionCwd);
    const normalizedScope = path.resolve(m.scopeDirectory);

    return normalizedCwd === normalizedScope ||
           normalizedCwd.startsWith(normalizedScope + path.sep);
  });

  if (candidates.length === 0) return null;

  // Return most specific (longest scopeDirectory)
  return candidates.sort((a, b) =>
    b.scopeDirectory.length - a.scopeDirectory.length
  )[0];
}
```

**Step 4: Update main function to use registry routing**

Replace the `main` function:

```typescript
async function main(): Promise<void> {
  debugLog(`Hook script started. CLAUDE_HOOK_TYPE=${process.env.CLAUDE_HOOK_TYPE}`);

  // Read stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  debugLog(`Received input: ${input.slice(0, 500)}`);

  let hookData: HookInput;
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    debugLog(`Failed to parse JSON: ${err}`);
    process.exit(0);
  }

  // Determine hook type from environment or input
  const hookType = process.env.CLAUDE_HOOK_TYPE || hookData.hook_type || 'unknown';
  const sessionCwd = hookData.cwd || process.env.CLAUDE_PROJECT_DIR || '';

  debugLog(`Hook type: ${hookType}`);
  debugLog(`Session ID: ${hookData.session_id}`);
  debugLog(`Session CWD: ${sessionCwd}`);
  debugLog(`Transcript path: ${hookData.transcript_path}`);

  // Build event payload
  const event = {
    type: hookType,
    sessionId: hookData.session_id || '',
    transcriptPath: hookData.transcript_path || '',
    cwd: sessionCwd,
    timestamp: new Date().toISOString(),
    data: hookData,
  };

  // Find the matching monitor based on session cwd
  const monitor = sessionCwd ? findMatchingMonitor(sessionCwd) : null;

  if (monitor) {
    debugLog(`Found matching monitor: ${monitor.id} (scope: ${monitor.scopeDirectory})`);
    try {
      await sendToSocket(event, monitor.socketPath);
      debugLog(`Event sent to monitor ${monitor.id} successfully`);
    } catch (err) {
      debugLog(`Failed to send to monitor socket: ${err}`);
    }
  } else {
    debugLog(`No matching monitor found for cwd: ${sessionCwd}`);
  }

  // On SessionStart, also send to sentinel socket (fire-and-forget)
  if (hookType === 'SessionStart') {
    try {
      debugLog(`Sending SessionStart to sentinel socket...`);
      await sendToSocket(event, SENTINEL_SOCKET_PATH);
      debugLog(`Event sent to sentinel successfully`);
    } catch (err) {
      debugLog(`Failed to send to sentinel socket: ${err}`);
    }
  }

  // Exit successfully to not block Claude Code
  process.exit(0);
}
```

**Step 5: Verify it compiles**

Run: `npm run build`
Expected: No errors

**Step 6: Commit**

```bash
git add src/hooks/hook-script.ts
git commit -m "feat(hooks): update hook script for registry-based routing"
```

---

## Task 7: Update Sentinel for Coverage Checking

**Files:**
- Modify: `src/sentinel/sentinel.ts`

**Step 1: Add registry import**

At the top of `src/sentinel/sentinel.ts`, add:

```typescript
import { RegistryManager } from '../registry/index.js';
```

**Step 2: Update HookEvent interface to include cwd**

Update the `HookEvent` interface (around line 24):

```typescript
export interface HookEvent {
  type: string;
  sessionId: string;
  transcriptPath: string;
  cwd?: string;  // Add this
  timestamp: string;
  data?: Record<string, unknown>;
}
```

**Step 3: Update handleEvent to check coverage**

Replace the `handleEvent` method:

```typescript
  /**
   * Handle a hook event
   */
  private async handleEvent(event: HookEvent): Promise<void> {
    // Only care about SessionStart events
    if (event.type !== 'SessionStart') {
      return;
    }

    const sessionCwd = event.cwd || '';
    this.log(`SessionStart detected for session: ${event.sessionId}`);
    this.log(`Session working directory: ${sessionCwd}`);

    // Check if the session is covered by any monitor
    const isCovered = sessionCwd ? RegistryManager.isCovered(sessionCwd) : false;

    if (isCovered) {
      const monitor = RegistryManager.findMatchingMonitor(sessionCwd);
      this.log(`Session is covered by monitor: ${monitor?.id} (scope: ${monitor?.scopeDirectory})`);
      return;
    }

    this.log(`Session is NOT covered by any monitor`);

    if (this.autoStart) {
      await this.autoStartMonitor(sessionCwd);
    } else {
      await this.showNotification(sessionCwd);
    }
  }
```

**Step 4: Update showNotification to include the uncovered directory**

Replace the `showNotification` method:

```typescript
  /**
   * Show macOS notification with action button and configuration options
   */
  private async showNotification(sessionCwd: string): Promise<void> {
    this.log('Showing notification dialog...');

    const displayCwd = sessionCwd || '(unknown)';

    // First dialog: Ask what to do
    const mainScript = `
      set dialogResult to display dialog "Claude Code session started in:
${displayCwd}

No session monitor is covering this directory." ¬
        buttons {"Ignore", "Configure...", "Start (Default)"} ¬
        default button "Start (Default)" ¬
        with title "Session Monitor" ¬
        with icon caution

      return button returned of dialogResult
    `;

    const mainResult = await this.runAppleScript(mainScript);

    if (mainResult === 'Ignore') {
      this.log('User clicked Ignore');
      return;
    }

    if (mainResult === 'Start (Default)') {
      this.log('User clicked Start (Default)');
      // Start with scope = session cwd, output = .session-docs in that directory
      const outputPath = sessionCwd ? `${sessionCwd}/.session-docs` : '.session-docs';
      this.startMonitorInTerminal(outputPath, false, undefined, sessionCwd);
      return;
    }

    // User clicked "Configure..." - show configuration dialogs
    this.log('User clicked Configure...');
    const config = await this.showConfigurationDialogs(sessionCwd);

    if (config) {
      this.startMonitorInTerminal(config.outputPath, config.verbose, config.apiKey, config.scopePath);
    }
  }
```

**Step 5: Update showConfigurationDialogs to include scope**

Replace the `showConfigurationDialogs` method:

```typescript
  /**
   * Show configuration dialogs for scope, output path, verbose mode, and API key if needed
   */
  private async showConfigurationDialogs(sessionCwd: string): Promise<{
    scopePath: string;
    outputPath: string;
    verbose: boolean;
    apiKey?: string;
  } | null> {
    const defaultScope = sessionCwd || process.cwd();
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

    // If no API key in environment, ask for it first
    let apiKey: string | undefined;
    if (!hasApiKey) {
      const apiKeyScript = `
        set dialogResult to display dialog "ANTHROPIC_API_KEY not found in environment.

Enter your Anthropic API key:" ¬
          default answer "" ¬
          buttons {"Cancel", "Next"} ¬
          default button "Next" ¬
          with title "Configure Session Monitor" ¬
          with icon note ¬
          with hidden answer

        set buttonPressed to button returned of dialogResult
        set textEntered to text returned of dialogResult

        if buttonPressed is "Cancel" then
          return "CANCEL"
        else
          return "KEY:" & textEntered
        end if
      `;

      const apiKeyResult = await this.runAppleScript(apiKeyScript);

      if (apiKeyResult === 'CANCEL') {
        this.log('User cancelled configuration');
        return null;
      }

      if (apiKeyResult.startsWith('KEY:')) {
        apiKey = apiKeyResult.substring(4);
        if (!apiKey) {
          this.log('No API key provided');
          await this.runAppleScript(`
            display dialog "API key is required to run the session monitor." ¬
              buttons {"OK"} ¬
              default button "OK" ¬
              with title "Error" ¬
              with icon stop
          `);
          return null;
        }
      }
    }

    // Dialog for scope directory
    const scopeScript = `
      set defaultScope to "${defaultScope}"
      set dialogResult to display dialog "Monitor scope directory (sessions in this directory and subdirectories will be captured):" ¬
        default answer defaultScope ¬
        buttons {"Cancel", "Browse...", "Next"} ¬
        default button "Next" ¬
        with title "Configure Session Monitor" ¬
        with icon note

      set buttonPressed to button returned of dialogResult
      set textEntered to text returned of dialogResult

      if buttonPressed is "Cancel" then
        return "CANCEL"
      else if buttonPressed is "Browse..." then
        return "BROWSE:" & textEntered
      else
        return "PATH:" & textEntered
      end if
    `;

    let scopePath = defaultScope;
    const scopeResult = await this.runAppleScript(scopeScript);

    if (scopeResult === 'CANCEL') {
      this.log('User cancelled configuration');
      return null;
    }

    if (scopeResult.startsWith('BROWSE:')) {
      const browseScript = `
        set chosenFolder to choose folder with prompt "Select scope directory:" ¬
          default location (path to home folder)
        return POSIX path of chosenFolder
      `;

      const browsedPath = await this.runAppleScript(browseScript);
      if (browsedPath && !browsedPath.includes('User canceled')) {
        scopePath = browsedPath.trim().replace(/\/$/, ''); // Remove trailing slash
      }
    } else if (scopeResult.startsWith('PATH:')) {
      scopePath = scopeResult.substring(5) || defaultScope;
    }

    // Dialog for output path
    const defaultOutput = `${scopePath}/.session-docs`;
    const pathScript = `
      set defaultPath to "${defaultOutput}"
      set dialogResult to display dialog "Output directory for documentation:" ¬
        default answer defaultPath ¬
        buttons {"Cancel", "Browse...", "Next"} ¬
        default button "Next" ¬
        with title "Configure Session Monitor" ¬
        with icon note

      set buttonPressed to button returned of dialogResult
      set textEntered to text returned of dialogResult

      if buttonPressed is "Cancel" then
        return "CANCEL"
      else if buttonPressed is "Browse..." then
        return "BROWSE:" & textEntered
      else
        return "PATH:" & textEntered
      end if
    `;

    let outputPath = defaultOutput;
    const pathResult = await this.runAppleScript(pathScript);

    if (pathResult === 'CANCEL') {
      this.log('User cancelled configuration');
      return null;
    }

    if (pathResult.startsWith('BROWSE:')) {
      const browseScript = `
        set chosenFolder to choose folder with prompt "Select output directory for documentation:" ¬
          default location (path to home folder)
        return POSIX path of chosenFolder
      `;

      const browsedPath = await this.runAppleScript(browseScript);
      if (browsedPath && !browsedPath.includes('User canceled')) {
        outputPath = browsedPath.trim().replace(/\/$/, '');
      } else {
        outputPath = pathResult.substring(7) || defaultOutput;
      }
    } else if (pathResult.startsWith('PATH:')) {
      outputPath = pathResult.substring(5) || defaultOutput;
    }

    // Dialog for verbose mode
    const verboseScript = `
      set dialogResult to display dialog "Enable verbose logging?" ¬
        buttons {"Cancel", "No", "Yes"} ¬
        default button "No" ¬
        with title "Configure Session Monitor" ¬
        with icon note

      return button returned of dialogResult
    `;

    const verboseResult = await this.runAppleScript(verboseScript);

    if (verboseResult === 'Cancel') {
      this.log('User cancelled configuration');
      return null;
    }

    const verbose = verboseResult === 'Yes';

    this.log(`Configuration: scope="${scopePath}", output="${outputPath}", verbose=${verbose}, apiKey=${apiKey ? '[provided]' : '[from env]'}`);
    return { scopePath, outputPath, verbose, apiKey };
  }
```

**Step 6: Update startMonitorInTerminal to include scope**

Replace the `startMonitorInTerminal` method:

```typescript
  /**
   * Start the monitor in a new Terminal window with options
   */
  private startMonitorInTerminal(outputPath: string, verbose: boolean, apiKey?: string, scopePath?: string): void {
    // Build the command with options
    let command = '';

    // If API key is provided, set it as an environment variable for the command
    if (apiKey) {
      const escapedKey = apiKey.replace(/'/g, "'\\''");
      command += `ANTHROPIC_API_KEY='${escapedKey}' `;
    }

    command += 'session-monitor start';

    // Add scope if provided
    if (scopePath) {
      const escapedScope = scopePath.replace(/"/g, '\\"');
      command += ` --scope "${escapedScope}"`;
    }

    // Add output path
    if (outputPath) {
      const escapedPath = outputPath.replace(/"/g, '\\"');
      command += ` -o "${escapedPath}"`;
    }

    if (verbose) {
      command += ' -v';
    }

    this.log(`Starting monitor with command: ${apiKey ? '[API_KEY] ' : ''}session-monitor start${scopePath ? ` --scope "${scopePath}"` : ''}${outputPath ? ` -o "${outputPath}"` : ''}${verbose ? ' -v' : ''}`);

    const script = `
      tell application "Terminal"
        activate
        do script "${command.replace(/"/g, '\\"')}"
      end tell
    `;

    exec(`osascript -e '${script}'`, (error) => {
      if (error) {
        this.log(`Failed to start monitor in Terminal: ${error.message}`);
      } else {
        this.log('Started monitor in new Terminal window');
      }
    });
  }
```

**Step 7: Update autoStartMonitor to include scope**

Replace the `autoStartMonitor` method:

```typescript
  /**
   * Auto-start the monitor in the background
   */
  private async autoStartMonitor(sessionCwd: string): Promise<void> {
    this.log('Auto-starting session monitor...');

    // Find the session-monitor executable
    const monitorPath = await this.findSessionMonitor();
    if (!monitorPath) {
      this.log('Could not find session-monitor executable');
      await this.showNotification(sessionCwd);
      return;
    }

    // Build args
    const args = [monitorPath, 'start'];
    if (sessionCwd) {
      args.push('--scope', sessionCwd);
      args.push('-o', `${sessionCwd}/.session-docs`);
    }

    // Spawn detached process
    const child = spawn('node', args, {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
    this.log(`Auto-started monitor (PID: ${child.pid}) with scope: ${sessionCwd || 'default'}`);
  }
```

**Step 8: Remove isMonitorRunning method (no longer needed)**

Delete the `isMonitorRunning` method entirely (it's replaced by registry-based coverage checking).

**Step 9: Remove unused MONITOR_SOCKET_PATH constant**

Remove this line from the top of the file:
```typescript
const MONITOR_SOCKET_PATH = path.join(os.tmpdir(), 'session-monitor.sock');
```

Also remove the `getMonitorSocketPath` export function at the bottom if it exists.

**Step 10: Verify it compiles**

Run: `npm run build`
Expected: No errors

**Step 11: Commit**

```bash
git add src/sentinel/sentinel.ts
git commit -m "feat(sentinel): check registry for coverage instead of single socket"
```

---

## Task 8: Update Status Command

**Files:**
- Modify: `src/index.ts`

**Step 1: Import RegistryManager**

At the top of `src/index.ts`, add:

```typescript
import { RegistryManager } from './registry/index.js';
```

**Step 2: Update handleStatus function**

Replace the `handleStatus` function:

```typescript
async function handleStatus(): Promise<void> {
  const hookResult = await checkHooksInstalled();

  console.log('Session Monitor Status\n');
  console.log('======================\n');

  // Hooks status
  console.log('Hooks:');
  if (hookResult.installed.length > 0) {
    for (const hook of hookResult.installed) {
      console.log(`  ✓ ${hook}`);
    }
  }
  if (hookResult.missing.length > 0) {
    for (const hook of hookResult.missing) {
      console.log(`  ✗ ${hook}`);
    }
  }

  // Monitor status
  console.log('\nActive Monitors:');
  const monitors = RegistryManager.getActiveMonitors();

  if (monitors.length === 0) {
    console.log('  (none)');
  } else {
    console.log('  ID        Scope                                    Output                         PID');
    console.log('  ' + '-'.repeat(90));
    for (const monitor of monitors) {
      const id = monitor.id.padEnd(10);
      const scope = monitor.scopeDirectory.slice(0, 40).padEnd(40);
      const output = monitor.outputDirectory.slice(0, 30).padEnd(30);
      console.log(`  ${id}${scope}${output}${monitor.pid}`);
    }
  }

  // Summary
  console.log('');
  if (hookResult.missing.length === 0) {
    console.log('Hooks: All installed ✓');
  } else if (hookResult.installed.length === 0) {
    console.log('Hooks: Not installed. Run: session-monitor install');
  } else {
    console.log('Hooks: Partially installed. Run: session-monitor install --force');
  }

  if (monitors.length > 0) {
    console.log(`Monitors: ${monitors.length} running`);
  } else {
    console.log('Monitors: None running. Run: session-monitor start');
  }
}
```

**Step 3: Verify it compiles**

Run: `npm run build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): enhance status command to show all active monitors"
```

---

## Task 9: Add Integration Test

**Files:**
- Create: `src/registry/registry-manager.integration.test.ts`

**Step 1: Write integration test**

Create `src/registry/registry-manager.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RegistryManager, type MonitorEntry } from './registry-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Integration tests for the registry-based routing system
 */
describe('Registry Routing Integration', () => {
  beforeEach(async () => {
    // Clean up registry before each test
    const registryPath = path.join(os.tmpdir(), 'session-monitor-registry.json');
    try { fs.unlinkSync(registryPath); } catch {}
    try { fs.unlinkSync(registryPath + '.lock'); } catch {}
  });

  afterEach(async () => {
    // Clean up after tests
    const registryPath = path.join(os.tmpdir(), 'session-monitor-registry.json');
    try { fs.unlinkSync(registryPath); } catch {}
    try { fs.unlinkSync(registryPath + '.lock'); } catch {}
  });

  describe('Multi-monitor scenarios', () => {
    it('routes to correct monitor based on directory hierarchy', async () => {
      // Set up monitors for different scopes
      const rootMonitor: MonitorEntry = {
        id: 'root',
        socketPath: '/tmp/root.sock',
        scopeDirectory: '/projects',
        outputDirectory: '/projects/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      const frontendMonitor: MonitorEntry = {
        id: 'frontend',
        socketPath: '/tmp/frontend.sock',
        scopeDirectory: '/projects/frontend',
        outputDirectory: '/projects/frontend/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      const backendMonitor: MonitorEntry = {
        id: 'backend',
        socketPath: '/tmp/backend.sock',
        scopeDirectory: '/projects/backend',
        outputDirectory: '/projects/backend/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(rootMonitor);
      await RegistryManager.register(frontendMonitor);
      await RegistryManager.register(backendMonitor);

      // Test routing
      expect(RegistryManager.findMatchingMonitor('/projects/frontend/src')?.id).toBe('frontend');
      expect(RegistryManager.findMatchingMonitor('/projects/backend/api')?.id).toBe('backend');
      expect(RegistryManager.findMatchingMonitor('/projects/shared')?.id).toBe('root');
      expect(RegistryManager.findMatchingMonitor('/other/path')).toBeNull();
    });

    it('handles overlapping scopes by selecting most specific', async () => {
      const broadMonitor: MonitorEntry = {
        id: 'broad',
        socketPath: '/tmp/broad.sock',
        scopeDirectory: '/home/user',
        outputDirectory: '/home/user/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      const specificMonitor: MonitorEntry = {
        id: 'specific',
        socketPath: '/tmp/specific.sock',
        scopeDirectory: '/home/user/work/project',
        outputDirectory: '/home/user/work/project/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(broadMonitor);
      await RegistryManager.register(specificMonitor);

      // Specific should win for its subtree
      expect(RegistryManager.findMatchingMonitor('/home/user/work/project/src')?.id).toBe('specific');
      // Broad should handle everything else under /home/user
      expect(RegistryManager.findMatchingMonitor('/home/user/other')?.id).toBe('broad');
      expect(RegistryManager.findMatchingMonitor('/home/user/work/other-project')?.id).toBe('broad');
    });

    it('coverage check works correctly', async () => {
      const monitor: MonitorEntry = {
        id: 'test',
        socketPath: '/tmp/test.sock',
        scopeDirectory: '/projects',
        outputDirectory: '/projects/.session-docs',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };

      await RegistryManager.register(monitor);

      expect(RegistryManager.isCovered('/projects')).toBe(true);
      expect(RegistryManager.isCovered('/projects/foo')).toBe(true);
      expect(RegistryManager.isCovered('/projects/foo/bar')).toBe(true);
      expect(RegistryManager.isCovered('/other')).toBe(false);
      expect(RegistryManager.isCovered('/projectsX')).toBe(false); // Not a child, different name
    });
  });

  describe('Concurrent access', () => {
    it('handles multiple registrations without corruption', async () => {
      // Simulate concurrent registrations
      const registrations = Array.from({ length: 5 }, (_, i) => ({
        id: `monitor-${i}`,
        socketPath: `/tmp/monitor-${i}.sock`,
        scopeDirectory: `/scope-${i}`,
        outputDirectory: `/scope-${i}/.session-docs`,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }));

      // Register all concurrently
      await Promise.all(registrations.map(r => RegistryManager.register(r)));

      // Verify all registered
      const monitors = RegistryManager.getActiveMonitors();
      expect(monitors.length).toBe(5);

      // Verify each one
      for (let i = 0; i < 5; i++) {
        expect(monitors.find(m => m.id === `monitor-${i}`)).toBeDefined();
      }
    });
  });
});
```

**Step 2: Run the integration tests**

Run: `npm run test:run -- src/registry/registry-manager.integration.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/registry/registry-manager.integration.test.ts
git commit -m "test(registry): add integration tests for multi-monitor routing"
```

---

## Task 10: Update Exports and Final Verification

**Files:**
- Verify: all index.ts files export correctly

**Step 1: Verify registry exports**

The `src/registry/index.ts` should already export everything needed.

**Step 2: Run all tests**

Run: `npm run test:run`
Expected: All tests pass

**Step 3: Run full build**

Run: `npm run build`
Expected: No errors

**Step 4: Run lint**

Run: `npm run lint`
Expected: No errors (or only pre-existing ones)

**Step 5: Manual verification**

Test the flow manually:
1. `node dist/index.js start --scope /tmp/test-scope`
2. Check registry file exists: `cat /tmp/session-monitor-registry.json`
3. Stop with Ctrl+C
4. Verify registry entry removed

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete directory-scoped session monitor implementation"
```

---

## Summary

After completing all tasks, you will have:

1. **RegistryManager** - Central registry management with file locking
2. **Updated hook script** - Routes events to correct monitor based on session cwd
3. **CLI --scope option** - Explicit directory scoping
4. **SessionWatcher** - Registers/unregisters on start/shutdown
5. **Sentinel** - Checks registry for coverage gaps
6. **Enhanced status command** - Shows all active monitors

The system now supports multiple concurrent monitors, each scoped to different directory trees, with automatic routing of Claude Code session events to the appropriate monitor.
