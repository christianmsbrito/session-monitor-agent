/**
 * Tests for FileManager
 *
 * These tests verify the session directory management, particularly:
 * - Finding and reusing existing session directories (prevents fragmentation)
 * - Subject locking when reusing directories
 * - Handling rename failures gracefully
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileManager } from './file-manager.js';

// Mock fs/promises
vi.mock('fs/promises');

const mockedFs = vi.mocked(fs);

describe('FileManager', () => {
  const outputDir = '/tmp/test-session-docs';
  const sessionId = 'abc12345-1234-5678-9abc-def012345678';
  const shortSessionId = 'abc12345';

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset date to a fixed value for consistent testing
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-30T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('findExistingSessionDir', () => {
    it('should find and reuse existing session directory', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      // Mock readdir to return an existing directory for this session
      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-debugging-auth',
        'other-session-dir',
      ] as unknown as fs.Dirent[]);

      // Mock readdir for events directory (to count existing events)
      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
      ] as unknown as fs.Dirent[]);

      const found = await fileManager.findExistingSessionDir();

      expect(found).toBe(true);
      expect(fileManager.getSessionDir()).toBe(
        path.join(outputDir, 'sessions', '2025-12-30', 'abc12345-debugging-auth')
      );
      expect(fileManager.getSessionSubject()).toBe('debugging-auth');
      expect(fileManager.isSubjectLocked()).toBe(true);
    });

    it('should return false when no existing directory found', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      // Mock readdir to return directories that don't match
      mockedFs.readdir.mockResolvedValueOnce([
        'different-session-dir',
        'another-session',
      ] as unknown as fs.Dirent[]);

      const found = await fileManager.findExistingSessionDir();

      expect(found).toBe(false);
      expect(fileManager.isSubjectLocked()).toBe(false);
    });

    it('should return false when date directory does not exist', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      // Mock readdir to throw (directory doesn't exist)
      mockedFs.readdir.mockRejectedValueOnce(new Error('ENOENT'));

      const found = await fileManager.findExistingSessionDir();

      expect(found).toBe(false);
      expect(fileManager.isSubjectLocked()).toBe(false);
    });

    it('should count existing events to continue numbering correctly', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      // Mock readdir for date directory
      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-my-session',
      ] as unknown as fs.Dirent[]);

      // Mock readdir for events directory with 5 existing events
      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
        '003-agent_analysis.md',
        '004-decision_made.md',
        '005-user_confirmed.md',
      ] as unknown as fs.Dirent[]);

      await fileManager.findExistingSessionDir();

      expect(fileManager.getEventCount()).toBe(5);
    });
  });

  describe('setSessionSubject with locking', () => {
    it('should not change subject when locked', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      // Set up existing directory
      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-original-subject',
      ] as unknown as fs.Dirent[]);
      mockedFs.readdir.mockResolvedValueOnce([] as unknown as fs.Dirent[]);

      await fileManager.findExistingSessionDir();

      expect(fileManager.getSessionSubject()).toBe('original-subject');
      expect(fileManager.isSubjectLocked()).toBe(true);

      // Try to change the subject
      await fileManager.setSessionSubject('New Different Subject');

      // Subject should NOT have changed
      expect(fileManager.getSessionSubject()).toBe('original-subject');
      expect(fileManager.getSessionDir()).toContain('original-subject');
    });

    it('should allow subject change when not locked', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      // No existing directory found
      mockedFs.readdir.mockRejectedValueOnce(new Error('ENOENT'));

      await fileManager.findExistingSessionDir();

      expect(fileManager.isSubjectLocked()).toBe(false);

      // Set subject should work
      await fileManager.setSessionSubject('My New Subject');

      expect(fileManager.getSessionSubject()).toBe('My New Subject');
      expect(fileManager.getSessionDir()).toContain('my-new-subject');
    });

    it('should not update paths when rename fails', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      // Initialize first
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.writeFile.mockResolvedValue(undefined);

      await fileManager.initialize();

      // Set initial subject
      await fileManager.setSessionSubject('First Subject');
      const originalDir = fileManager.getSessionDir();

      // Now try to change subject but rename fails
      mockedFs.rename.mockRejectedValueOnce(new Error('EBUSY: resource busy'));

      await fileManager.setSessionSubject('Second Subject');

      // Directory should NOT have changed because rename failed
      expect(fileManager.getSessionDir()).toBe(originalDir);
      expect(fileManager.getSessionSubject()).toBe('First Subject');
    });
  });

  describe('slugify behavior', () => {
    it('should create proper slugs from session subjects', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockRejectedValueOnce(new Error('ENOENT'));
      await fileManager.findExistingSessionDir();

      await fileManager.setSessionSubject('Debug Auth System');

      expect(fileManager.getSessionDir()).toContain('debug-auth-system');
    });

    it('should handle special characters in subjects', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockRejectedValueOnce(new Error('ENOENT'));
      await fileManager.findExistingSessionDir();

      await fileManager.setSessionSubject('Fix: User\'s Profile (v2)');

      expect(fileManager.getSessionDir()).toContain('fix-users-profile-v2');
    });

    it('should truncate long subjects', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockRejectedValueOnce(new Error('ENOENT'));
      await fileManager.findExistingSessionDir();

      const longSubject = 'This is a very long subject that should be truncated to fifty characters maximum';
      await fileManager.setSessionSubject(longSubject);

      const dirName = path.basename(fileManager.getSessionDir());
      // shortSessionId (8) + '-' (1) + slug (max 50) = max 59 chars
      expect(dirName.length).toBeLessThanOrEqual(59);
    });
  });
});
