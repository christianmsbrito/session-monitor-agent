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
