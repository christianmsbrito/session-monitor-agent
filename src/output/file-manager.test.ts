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

  describe('findHighestEventNumber', () => {
    it('should find highest event number from sequential files', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-my-session',
      ] as unknown as fs.Dirent[]);

      // Events with sequential numbers
      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
        '003-agent_suggestion.md',
      ] as unknown as fs.Dirent[]);

      await fileManager.findExistingSessionDir();

      expect(fileManager.getEventCount()).toBe(3);
    });

    it('should handle gaps in event numbers', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-my-session',
      ] as unknown as fs.Dirent[]);

      // Events with gaps (001, 003, 005 - missing 002, 004)
      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '003-agent_analysis.md',
        '005-decision_made.md',
      ] as unknown as fs.Dirent[]);

      await fileManager.findExistingSessionDir();

      // Should return highest number (5), not count (3)
      expect(fileManager.getEventCount()).toBe(5);
    });

    it('should handle duplicate event numbers (same number, different types)', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-my-session',
      ] as unknown as fs.Dirent[]);

      // Multiple files with same event number (the bug we're fixing)
      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
        '003-user_request.md',
        '003-user_confirmed.md',
        '003-agent_analysis.md',
      ] as unknown as fs.Dirent[]);

      await fileManager.findExistingSessionDir();

      // Should return highest number (3), so next event will be 4
      expect(fileManager.getEventCount()).toBe(3);
    });

    it('should handle INVALIDATED prefixed files', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-my-session',
      ] as unknown as fs.Dirent[]);

      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
        'INVALIDATED-003-agent_suggestion.md',
        '004-decision_made.md',
      ] as unknown as fs.Dirent[]);

      await fileManager.findExistingSessionDir();

      // Should recognize INVALIDATED-003 and return highest (4)
      expect(fileManager.getEventCount()).toBe(4);
    });

    it('should handle high event numbers', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-my-session',
      ] as unknown as fs.Dirent[]);

      mockedFs.readdir.mockResolvedValueOnce([
        '098-user_request.md',
        '099-agent_analysis.md',
        '100-agent_suggestion.md',
        '101-decision_made.md',
      ] as unknown as fs.Dirent[]);

      await fileManager.findExistingSessionDir();

      expect(fileManager.getEventCount()).toBe(101);
    });

    it('should return 0 for empty events directory', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-my-session',
      ] as unknown as fs.Dirent[]);

      mockedFs.readdir.mockResolvedValueOnce([] as unknown as fs.Dirent[]);

      await fileManager.findExistingSessionDir();

      expect(fileManager.getEventCount()).toBe(0);
    });

    it('should ignore non-event files', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-my-session',
      ] as unknown as fs.Dirent[]);

      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
        '.DS_Store',
        'README.md',
        'random-file.txt',
      ] as unknown as fs.Dirent[]);

      await fileManager.findExistingSessionDir();

      expect(fileManager.getEventCount()).toBe(2);
    });
  });

  describe('selectBestDirectory', () => {
    it('should select directory with most events when multiple exist', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      // Multiple directories for same session ID
      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-explore-patterns',
        'abc12345-tutor-reindexing',
        'abc12345-verify-tests',
      ] as unknown as fs.Dirent[]);

      // Events count for each directory
      // explore-patterns: 2 events
      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
      ] as unknown as fs.Dirent[]);

      // tutor-reindexing: 50 events (most)
      mockedFs.readdir.mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, i) =>
          `${String(i + 1).padStart(3, '0')}-agent_analysis.md`
        ) as unknown as fs.Dirent[]
      );

      // verify-tests: 3 events
      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
        '003-solution_verified.md',
      ] as unknown as fs.Dirent[]);

      // Final readdir for selected directory's events (for event count)
      mockedFs.readdir.mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, i) =>
          `${String(i + 1).padStart(3, '0')}-agent_analysis.md`
        ) as unknown as fs.Dirent[]
      );

      const found = await fileManager.findExistingSessionDir();

      expect(found).toBe(true);
      // Should select tutor-reindexing (has most events)
      expect(fileManager.getSessionDir()).toContain('tutor-reindexing');
      expect(fileManager.getEventCount()).toBe(50);
    });

    it('should handle directories with missing events folder', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-empty-session',
        'abc12345-active-session',
      ] as unknown as fs.Dirent[]);

      // First directory has no events folder
      mockedFs.readdir.mockRejectedValueOnce(new Error('ENOENT'));

      // Second directory has events
      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
      ] as unknown as fs.Dirent[]);

      // Final readdir for selected directory's events
      mockedFs.readdir.mockResolvedValueOnce([
        '001-user_request.md',
        '002-agent_analysis.md',
      ] as unknown as fs.Dirent[]);

      const found = await fileManager.findExistingSessionDir();

      expect(found).toBe(true);
      expect(fileManager.getSessionDir()).toContain('active-session');
    });

    it('should use first directory when all have zero events', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readdir.mockResolvedValueOnce([
        'abc12345-session-a',
        'abc12345-session-b',
      ] as unknown as fs.Dirent[]);

      // Both directories have empty events
      mockedFs.readdir.mockResolvedValueOnce([] as unknown as fs.Dirent[]);
      mockedFs.readdir.mockResolvedValueOnce([] as unknown as fs.Dirent[]);

      // Final readdir for selected directory
      mockedFs.readdir.mockResolvedValueOnce([] as unknown as fs.Dirent[]);

      const found = await fileManager.findExistingSessionDir();

      expect(found).toBe(true);
      expect(fileManager.getSessionDir()).toContain('session-a');
    });
  });

  describe('dedup state persistence', () => {
    it('should save dedup state to session directory', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.writeFile.mockResolvedValue(undefined);

      const dedupItems = [
        { hash: 'abc123', title: 'Test Event', eventType: 'user_request', timestamp: new Date('2025-12-30T12:00:00Z') },
        { hash: 'def456', title: 'Another Event', eventType: 'agent_analysis', timestamp: new Date('2025-12-30T12:05:00Z') },
      ];

      await fileManager.saveDedupState(dedupItems);

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.dedup-state.json'),
        expect.any(String),
        'utf-8'
      );

      // Verify JSON format
      const writeCall = mockedFs.writeFile.mock.calls.find(
        call => String(call[0]).includes('.dedup-state.json')
      );
      expect(writeCall).toBeDefined();
      const savedData = JSON.parse(writeCall![1] as string);
      expect(savedData).toHaveLength(2);
      expect(savedData[0].hash).toBe('abc123');
    });

    it('should load dedup state from session directory', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      const savedState = JSON.stringify([
        { hash: 'abc123', title: 'Test Event', eventType: 'user_request', timestamp: '2025-12-30T12:00:00.000Z' },
        { hash: 'def456', title: 'Another Event', eventType: 'agent_analysis', timestamp: '2025-12-30T12:05:00.000Z' },
      ]);

      mockedFs.readFile.mockResolvedValueOnce(savedState);

      const loaded = await fileManager.loadDedupState();

      expect(loaded).not.toBeNull();
      expect(loaded).toHaveLength(2);
      expect(loaded![0].hash).toBe('abc123');
      expect(loaded![1].title).toBe('Another Event');
    });

    it('should return null when no dedup state file exists', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));

      const loaded = await fileManager.loadDedupState();

      expect(loaded).toBeNull();
    });
  });

  describe('transcript position persistence', () => {
    it('should save transcript position', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.writeFile.mockResolvedValue(undefined);

      await fileManager.saveTranscriptPosition('/path/to/transcript.jsonl', 12345);

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.transcript-position.json'),
        expect.any(String),
        'utf-8'
      );

      const writeCall = mockedFs.writeFile.mock.calls.find(
        call => String(call[0]).includes('.transcript-position.json')
      );
      expect(writeCall).toBeDefined();
      const savedData = JSON.parse(writeCall![1] as string);
      expect(savedData.transcriptPath).toBe('/path/to/transcript.jsonl');
      expect(savedData.position).toBe(12345);
    });

    it('should load transcript position', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      const savedState = JSON.stringify({
        transcriptPath: '/path/to/transcript.jsonl',
        position: 54321,
      });

      mockedFs.readFile.mockResolvedValueOnce(savedState);

      const loaded = await fileManager.loadTranscriptPosition();

      expect(loaded).not.toBeNull();
      expect(loaded!.transcriptPath).toBe('/path/to/transcript.jsonl');
      expect(loaded!.position).toBe(54321);
    });

    it('should return null when no position file exists', async () => {
      const fileManager = new FileManager(outputDir, sessionId);

      mockedFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));

      const loaded = await fileManager.loadTranscriptPosition();

      expect(loaded).toBeNull();
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
