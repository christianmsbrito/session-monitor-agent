import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RegistryManager, type MonitorEntry } from './registry-manager.js';
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
    try { fs.unlinkSync(registryPath); } catch { /* ignore */ }
    try { fs.unlinkSync(registryPath + '.lock'); } catch { /* ignore */ }
  });

  afterEach(async () => {
    // Clean up after tests
    const registryPath = path.join(os.tmpdir(), 'session-monitor-registry.json');
    try { fs.unlinkSync(registryPath); } catch { /* ignore */ }
    try { fs.unlinkSync(registryPath + '.lock'); } catch { /* ignore */ }
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
