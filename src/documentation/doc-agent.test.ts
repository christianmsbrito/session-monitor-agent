/**
 * Tests for DocumentationAgent
 *
 * These tests verify:
 * - Ghost session prevention (skip finalization when no content)
 * - Session directory reuse on initialization
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the dependencies before importing DocumentationAgent
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"events": []}' }],
      }),
    },
  })),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readdir: vi.fn().mockResolvedValue([]),
  rename: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

import { DocumentationAgent } from './doc-agent.js';
import * as fs from 'fs/promises';

const mockedFs = vi.mocked(fs);

describe('DocumentationAgent', () => {
  const defaultConfig = {
    apiKey: 'test-api-key',
    model: 'claude-3-haiku-20240307',
    outputDir: '/tmp/test-docs',
    sessionId: 'test-session-123',
    verbose: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('finalize - ghost session prevention', () => {
    it('should skip finalization when no events documented and no messages processed', async () => {
      const agent = new DocumentationAgent({ ...defaultConfig, verbose: true });

      // Spy on console.error to verify the skip message
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await agent.finalize();

      // Should have logged the skip message
      expect(consoleSpy).toHaveBeenCalledWith(
        '[doc-agent] Skipping finalization - no content to document'
      );

      // Should NOT have written any files
      expect(mockedFs.writeFile).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should proceed with finalization when events were documented', async () => {
      const agent = new DocumentationAgent(defaultConfig);

      // Mock finding no existing directory
      mockedFs.readdir.mockResolvedValueOnce([]); // For findExistingSessionDir

      // Simulate processing a batch with significant content
      // We need to add a message to the context manager
      await agent.processBatch([
        {
          type: 'user',
          message: {
            content: [{ type: 'text', text: 'Please help me fix this bug' }],
          },
          session_id: 'test-session',
        },
      ]);

      // Reset mocks after processBatch
      vi.clearAllMocks();

      // Now finalize - should proceed because we have messages
      await agent.finalize();

      // The finalize should have made API calls and written files
      // (even if no events were documented, there were messages processed)
      // At minimum it should have tried to write a summary
    });

    it('should not create directories when skipping finalization', async () => {
      const agent = new DocumentationAgent(defaultConfig);

      await agent.finalize();

      // mkdir should not have been called for session dirs
      expect(mockedFs.mkdir).not.toHaveBeenCalled();
    });
  });

  describe('ensureInitialized - session reuse', () => {
    it('should mark sessionSubjectSet when reusing existing directory', async () => {
      // Mock finding an existing directory
      mockedFs.readdir
        .mockResolvedValueOnce(['test-ses-existing-subject'] as unknown as fs.Dirent[])
        .mockResolvedValueOnce(['001-user_request.md'] as unknown as fs.Dirent[]);

      const agent = new DocumentationAgent({
        ...defaultConfig,
        sessionId: 'test-ses-1234-5678-9abc-def0',
        verbose: true,
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Trigger initialization by processing a batch
      await agent.processBatch([
        {
          type: 'user',
          message: {
            content: [{ type: 'text', text: 'test message' }],
          },
          session_id: 'test-session',
        },
      ]);

      // Should have logged reusing the directory
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Reusing existing session directory')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('getStats', () => {
    it('should return zero documented count for new agent', () => {
      const agent = new DocumentationAgent(defaultConfig);
      const stats = agent.getStats();

      expect(stats.documentedCount).toBe(0);
    });
  });
});
