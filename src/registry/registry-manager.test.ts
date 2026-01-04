import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RegistryManager, REGISTRY_PATH, type MonitorEntry } from './registry-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('RegistryManager', () => {
  const testRegistryPath = path.join(os.tmpdir(), 'test-session-monitor-registry.json');
  const testLockPath = testRegistryPath + '.lock';

  beforeEach(() => {
    // Clean up any existing test files
    try { fs.unlinkSync(testRegistryPath); } catch { /* ignore */ }
    try { fs.unlinkSync(testLockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(testRegistryPath + '.tmp'); } catch { /* ignore */ }
    // Also clean up the actual registry path used by RegistryManager
    try { fs.unlinkSync(REGISTRY_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(REGISTRY_PATH + '.lock'); } catch { /* ignore */ }
    try { fs.unlinkSync(REGISTRY_PATH + '.tmp'); } catch { /* ignore */ }
  });

  afterEach(() => {
    // Clean up test files
    try { fs.unlinkSync(testRegistryPath); } catch { /* ignore */ }
    try { fs.unlinkSync(testLockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(testRegistryPath + '.tmp'); } catch { /* ignore */ }
    // Also clean up the actual registry path used by RegistryManager
    try { fs.unlinkSync(REGISTRY_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(REGISTRY_PATH + '.lock'); } catch { /* ignore */ }
    try { fs.unlinkSync(REGISTRY_PATH + '.tmp'); } catch { /* ignore */ }
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
