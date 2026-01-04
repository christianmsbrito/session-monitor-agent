/**
 * TranscriptReader - Reads and parses Claude Code transcript JSONL files
 */

import * as fs from 'fs';
import type { StreamMessage, ContentBlock } from '../types/index.js';

export interface TranscriptEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  subtype?: string;
  session_id?: string;
  // For user/assistant messages
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
  // Tool use specific fields
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  [key: string]: unknown;
}

export class TranscriptReader {
  private lastPosition: Map<string, number> = new Map();

  /**
   * Read new entries from a transcript file since last read
   */
  async readNewEntries(transcriptPath: string): Promise<TranscriptEntry[]> {
    const lastPos = this.lastPosition.get(transcriptPath) || 0;
    const entries: TranscriptEntry[] = [];

    try {
      const stats = await fs.promises.stat(transcriptPath);

      // If file was truncated, reset position
      if (stats.size < lastPos) {
        this.lastPosition.set(transcriptPath, 0);
        return this.readNewEntries(transcriptPath);
      }

      if (stats.size === lastPos) {
        return []; // No new data
      }

      const fileHandle = await fs.promises.open(transcriptPath, 'r');
      const buffer = Buffer.alloc(stats.size - lastPos);
      await fileHandle.read(buffer, 0, buffer.length, lastPos);
      await fileHandle.close();

      const content = buffer.toString('utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line) as TranscriptEntry;
            entries.push(entry);
          } catch {
            // Invalid JSON line, skip
          }
        }
      }

      this.lastPosition.set(transcriptPath, stats.size);
    } catch {
      // File might not exist yet or be inaccessible
    }

    return entries;
  }

  /**
   * Read entire transcript file
   */
  async readAll(transcriptPath: string): Promise<TranscriptEntry[]> {
    const entries: TranscriptEntry[] = [];

    try {
      const content = await fs.promises.readFile(transcriptPath, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line) as TranscriptEntry;
            entries.push(entry);
          } catch {
            // Invalid JSON line, skip
          }
        }
      }

      // Update position to end of file
      const stats = await fs.promises.stat(transcriptPath);
      this.lastPosition.set(transcriptPath, stats.size);
    } catch {
      // File doesn't exist or is inaccessible
    }

    return entries;
  }

  /**
   * Convert transcript entries to StreamMessage format for compatibility
   */
  toStreamMessages(entries: TranscriptEntry[], verbose = false): StreamMessage[] {
    const messages: StreamMessage[] = [];

    for (const entry of entries) {
      const msg = this.entryToStreamMessage(entry);
      if (msg) {
        messages.push(msg);
      } else if (verbose) {
        // Log skipped entries for debugging
        console.error(`[transcript] Skipped entry type: ${entry.type}`);
      }
    }

    return messages;
  }

  /**
   * Convert a single transcript entry to StreamMessage
   */
  private entryToStreamMessage(entry: TranscriptEntry): StreamMessage | null {
    if (entry.type === 'user' && entry.message) {
      const content = this.normalizeContent(entry.message.content);
      return {
        type: 'user',
        message: { content },
        session_id: '',
      };
    }

    if (entry.type === 'assistant' && entry.message) {
      const content = this.normalizeContent(entry.message.content);
      return {
        type: 'assistant',
        message: { content },
        session_id: '',
      };
    }

    // System messages
    if (entry.type === 'system') {
      if (entry.subtype === 'init') {
        return {
          type: 'system',
          subtype: 'init',
          session_id: (entry.session_id as string) || '',
        };
      }
      if (entry.subtype === 'result') {
        return {
          type: 'system',
          subtype: 'result',
          session_id: (entry.session_id as string) || '',
        };
      }
    }

    return null;
  }

  /**
   * Normalize content to ContentBlock array
   */
  private normalizeContent(content: ContentBlock[] | string | undefined): ContentBlock[] {
    if (!content) {
      return [];
    }

    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }

    return content;
  }

  /**
   * Reset reading position for a transcript
   */
  resetPosition(transcriptPath: string): void {
    this.lastPosition.delete(transcriptPath);
  }

  /**
   * Get current position for a transcript
   */
  getPosition(transcriptPath: string): number {
    return this.lastPosition.get(transcriptPath) || 0;
  }

  /**
   * Set position for a transcript (used when restoring from persisted state)
   */
  setPosition(transcriptPath: string, position: number): void {
    this.lastPosition.set(transcriptPath, position);
  }
}
