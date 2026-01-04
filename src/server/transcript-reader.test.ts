/**
 * Tests for TranscriptReader
 *
 * These tests verify transcript reading and position management:
 * - Reading new entries from a position
 * - Position tracking and restoration
 * - Handling of transcript file changes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import { TranscriptReader } from './transcript-reader.js';

// Mock fs
vi.mock('fs');

const mockedFs = vi.mocked(fs);

describe('TranscriptReader', () => {
  let reader: TranscriptReader;

  beforeEach(() => {
    vi.clearAllMocks();
    reader = new TranscriptReader();
  });

  describe('position management', () => {
    it('should return 0 for unknown transcript paths', () => {
      const position = reader.getPosition('/unknown/path.jsonl');
      expect(position).toBe(0);
    });

    it('should track position after reading', async () => {
      const transcriptPath = '/test/transcript.jsonl';
      const content = '{"type":"user","message":{"content":"test"}}\n';

      mockedFs.promises.stat.mockResolvedValueOnce({
        size: content.length,
      } as fs.Stats);

      mockedFs.promises.open.mockResolvedValueOnce({
        read: vi.fn().mockResolvedValueOnce({ bytesRead: content.length }),
        close: vi.fn().mockResolvedValueOnce(undefined),
      } as unknown as fs.promises.FileHandle);

      await reader.readNewEntries(transcriptPath);

      expect(reader.getPosition(transcriptPath)).toBe(content.length);
    });

    it('should allow setting position manually', () => {
      const transcriptPath = '/test/transcript.jsonl';

      reader.setPosition(transcriptPath, 12345);

      expect(reader.getPosition(transcriptPath)).toBe(12345);
    });

    it('should reset position when called', () => {
      const transcriptPath = '/test/transcript.jsonl';

      reader.setPosition(transcriptPath, 12345);
      expect(reader.getPosition(transcriptPath)).toBe(12345);

      reader.resetPosition(transcriptPath);
      expect(reader.getPosition(transcriptPath)).toBe(0);
    });

    it('should restore position correctly for session resumption', async () => {
      const transcriptPath = '/test/transcript.jsonl';
      const fullContent =
        '{"type":"user","message":{"content":"first"}}\n' +
        '{"type":"assistant","message":{"content":"response"}}\n' +
        '{"type":"user","message":{"content":"second"}}\n';

      const firstPartLength = '{"type":"user","message":{"content":"first"}}\n{"type":"assistant","message":{"content":"response"}}\n'.length;

      // Simulate resuming from a saved position
      reader.setPosition(transcriptPath, firstPartLength);

      // Mock reading only the new content
      const newContent = '{"type":"user","message":{"content":"second"}}\n';

      mockedFs.promises.stat.mockResolvedValueOnce({
        size: fullContent.length,
      } as fs.Stats);

      mockedFs.promises.open.mockResolvedValueOnce({
        read: vi.fn().mockImplementation((buffer: Buffer) => {
          buffer.write(newContent, 0);
          return Promise.resolve({ bytesRead: newContent.length });
        }),
        close: vi.fn().mockResolvedValueOnce(undefined),
      } as unknown as fs.promises.FileHandle);

      const entries = await reader.readNewEntries(transcriptPath);

      // Should only get the new entry, not the ones we already processed
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('user');
    });

    it('should handle multiple transcripts independently', () => {
      const path1 = '/test/transcript1.jsonl';
      const path2 = '/test/transcript2.jsonl';

      reader.setPosition(path1, 100);
      reader.setPosition(path2, 200);

      expect(reader.getPosition(path1)).toBe(100);
      expect(reader.getPosition(path2)).toBe(200);

      reader.resetPosition(path1);

      expect(reader.getPosition(path1)).toBe(0);
      expect(reader.getPosition(path2)).toBe(200);
    });
  });

  describe('toStreamMessages', () => {
    it('should convert user entries to stream messages', () => {
      const entries = [
        {
          type: 'user',
          message: {
            content: [{ type: 'text', text: 'Hello' }],
          },
        },
      ];

      const messages = reader.toStreamMessages(entries);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('user');
    });

    it('should convert assistant entries to stream messages', () => {
      const entries = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello back' }],
          },
        },
      ];

      const messages = reader.toStreamMessages(entries);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('assistant');
    });

    it('should skip entries without messages', () => {
      const entries = [
        { type: 'system', subtype: 'unknown' },
        {
          type: 'user',
          message: {
            content: [{ type: 'text', text: 'Hello' }],
          },
        },
      ];

      const messages = reader.toStreamMessages(entries);

      // Should only have the user message
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('user');
    });
  });
});

describe('TranscriptReader - Session Resumption Integration', () => {
  it('should correctly resume from persisted position', async () => {
    const reader = new TranscriptReader();
    const transcriptPath = '/sessions/abc123/transcript.jsonl';

    // Simulate a previous session that read 5000 bytes
    const persistedPosition = 5000;

    // Restore the position (as would happen on monitor restart)
    reader.setPosition(transcriptPath, persistedPosition);

    // Verify position is restored
    expect(reader.getPosition(transcriptPath)).toBe(persistedPosition);

    // Mock file stats showing more content available
    mockedFs.promises.stat.mockResolvedValueOnce({
      size: 7500, // 2500 bytes of new content
    } as fs.Stats);

    const newContent = '{"type":"user","message":{"content":"new message"}}\n';

    mockedFs.promises.open.mockResolvedValueOnce({
      read: vi.fn().mockImplementation((buffer: Buffer) => {
        buffer.write(newContent, 0);
        return Promise.resolve({ bytesRead: newContent.length });
      }),
      close: vi.fn().mockResolvedValueOnce(undefined),
    } as unknown as fs.promises.FileHandle);

    const entries = await reader.readNewEntries(transcriptPath);

    // Should read only new content
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('user');

    // Position should be updated to end of file
    expect(reader.getPosition(transcriptPath)).toBe(7500);
  });
});
