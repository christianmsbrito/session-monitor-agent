import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnalyzedMessageTracker } from './analyzed-tracker.js';
import type { StreamMessage, UserMessage, AssistantMessage } from '../types/index.js';
import { generateMessageId } from '../types/index.js';
import { DatabaseManager } from '../database/db-manager.js';

describe('AnalyzedMessageTracker', () => {
  let tracker: AnalyzedMessageTracker;

  beforeEach(() => {
    tracker = new AnalyzedMessageTracker();
  });

  describe('basic tracking', () => {
    it('should mark messages as analyzed', () => {
      tracker.markAnalyzed('msg-1', 'User: "Hello world"');

      expect(tracker.isAnalyzed('msg-1')).toBe(true);
      expect(tracker.isAnalyzed('msg-2')).toBe(false);
    });

    it('should not duplicate entries when marking same ID twice', () => {
      tracker.markAnalyzed('msg-1', 'Summary 1');
      tracker.markAnalyzed('msg-1', 'Summary 2');

      expect(tracker.getCount()).toBe(1);
    });

    it('should return analyzed IDs as a Set', () => {
      tracker.markAnalyzed('msg-1', 'Summary 1');
      tracker.markAnalyzed('msg-2', 'Summary 2');

      const ids = tracker.getAnalyzedIds();
      expect(ids).toBeInstanceOf(Set);
      expect(ids.size).toBe(2);
      expect(ids.has('msg-1')).toBe(true);
      expect(ids.has('msg-2')).toBe(true);
    });

    it('should clear all tracked messages', () => {
      tracker.markAnalyzed('msg-1', 'Summary 1');
      tracker.markAnalyzed('msg-2', 'Summary 2');
      tracker.clear();

      expect(tracker.getCount()).toBe(0);
      expect(tracker.isAnalyzed('msg-1')).toBe(false);
    });
  });

  describe('getAnalyzedSummaries', () => {
    it('should return empty string when no messages tracked', () => {
      expect(tracker.getAnalyzedSummaries()).toBe('');
    });

    it('should return formatted summaries', () => {
      tracker.markAnalyzed('msg-1', 'User: "Hello world"');
      tracker.markAnalyzed('msg-2', 'Assistant: "Hi there"');

      const summaries = tracker.getAnalyzedSummaries();
      expect(summaries).toContain('- User: "Hello world"');
      expect(summaries).toContain('- Assistant: "Hi there"');
    });

    it('should skip empty summaries', () => {
      tracker.markAnalyzed('msg-1', 'User: "Hello"');
      tracker.markAnalyzed('msg-2', ''); // Empty summary (e.g., tool result)
      tracker.markAnalyzed('msg-3', 'Assistant: "Response"');

      const summaries = tracker.getAnalyzedSummaries();
      expect(summaries).toContain('User: "Hello"');
      expect(summaries).toContain('Assistant: "Response"');
      expect(summaries.split('\n').length).toBe(2);
    });
  });

  describe('export/import', () => {
    it('should export analyzed messages for persistence', () => {
      tracker.markAnalyzed('msg-1', 'Summary 1');
      tracker.markAnalyzed('msg-2', 'Summary 2');

      const exported = tracker.export();
      expect(exported).toHaveLength(2);
      expect(exported[0]).toHaveProperty('messageId', 'msg-1');
      expect(exported[0]).toHaveProperty('briefSummary', 'Summary 1');
      expect(exported[0]).toHaveProperty('analyzedAt');
      // analyzedAt should be ISO string
      expect(typeof exported[0].analyzedAt).toBe('string');
    });

    it('should import analyzed messages from persistence', () => {
      const items = [
        { messageId: 'msg-1', analyzedAt: '2024-01-01T00:00:00.000Z', briefSummary: 'Summary 1' },
        { messageId: 'msg-2', analyzedAt: '2024-01-01T00:01:00.000Z', briefSummary: 'Summary 2' },
      ];

      tracker.import(items);

      expect(tracker.isAnalyzed('msg-1')).toBe(true);
      expect(tracker.isAnalyzed('msg-2')).toBe(true);
      expect(tracker.getCount()).toBe(2);
    });

    it('should round-trip export/import correctly', () => {
      tracker.markAnalyzed('msg-1', 'Summary 1');
      tracker.markAnalyzed('msg-2', 'Summary 2');

      const exported = tracker.export();

      const newTracker = new AnalyzedMessageTracker();
      newTracker.import(exported);

      expect(newTracker.isAnalyzed('msg-1')).toBe(true);
      expect(newTracker.isAnalyzed('msg-2')).toBe(true);
      expect(newTracker.getCount()).toBe(2);
      expect(newTracker.getAnalyzedSummaries()).toContain('Summary 1');
      expect(newTracker.getAnalyzedSummaries()).toContain('Summary 2');
    });
  });

  describe('generateBriefSummary', () => {
    describe('user messages', () => {
      it('should generate summary for user text input', () => {
        const msg: UserMessage = {
          type: 'user',
          session_id: 'test-session',
          message: {
            content: [{ type: 'text', text: 'Can you help me fix this bug?' }],
          },
        };

        const summary = AnalyzedMessageTracker.generateBriefSummary(msg);
        expect(summary).toBe('User: "Can you help me fix this bug"');
      });

      it('should truncate long user messages', () => {
        const longText = 'This is a very long message '.repeat(10);
        const msg: UserMessage = {
          type: 'user',
          session_id: 'test-session',
          message: {
            content: [{ type: 'text', text: longText }],
          },
        };

        const summary = AnalyzedMessageTracker.generateBriefSummary(msg);
        expect(summary.length).toBeLessThan(120);
        expect(summary).toContain('...');
      });

      it('should return empty string for tool results (not user text)', () => {
        const msg: UserMessage = {
          type: 'user',
          session_id: 'test-session',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result content' }],
          },
        };

        const summary = AnalyzedMessageTracker.generateBriefSummary(msg);
        expect(summary).toBe('');
      });
    });

    describe('assistant messages', () => {
      it('should generate summary for assistant text response', () => {
        const msg: AssistantMessage = {
          type: 'assistant',
          session_id: 'test-session',
          message: {
            content: [{ type: 'text', text: 'I found the issue in your code. The problem is...' }],
          },
        };

        const summary = AnalyzedMessageTracker.generateBriefSummary(msg);
        expect(summary).toBe('Assistant: "I found the issue in your code"');
      });

      it('should generate summary for tool usage', () => {
        const msg: AssistantMessage = {
          type: 'assistant',
          session_id: 'test-session',
          message: {
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/test.ts' } },
              { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { path: '/test.ts' } },
            ],
          },
        };

        const summary = AnalyzedMessageTracker.generateBriefSummary(msg);
        expect(summary).toBe('Assistant used tools: Read, Edit');
      });

      it('should return empty string for thinking-only messages', () => {
        const msg: AssistantMessage = {
          type: 'assistant',
          session_id: 'test-session',
          message: {
            content: [{ type: 'thinking', thinking: 'Internal reasoning...' }],
          },
        };

        const summary = AnalyzedMessageTracker.generateBriefSummary(msg);
        expect(summary).toBe('');
      });
    });

    describe('system messages', () => {
      it('should generate summary for session init', () => {
        const msg: StreamMessage = {
          type: 'system',
          subtype: 'init',
          session_id: 'test-session',
        };

        const summary = AnalyzedMessageTracker.generateBriefSummary(msg);
        expect(summary).toBe('Session initialized');
      });

      it('should generate summary for session result', () => {
        const msg: StreamMessage = {
          type: 'system',
          subtype: 'result',
          session_id: 'test-session',
        };

        const summary = AnalyzedMessageTracker.generateBriefSummary(msg);
        expect(summary).toBe('Session result received');
      });
    });
  });

  describe('generateMessageId', () => {
    it('should generate deterministic IDs', () => {
      const msg: UserMessage = {
        type: 'user',
        session_id: 'test-session',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      };

      const id1 = generateMessageId(msg);
      const id2 = generateMessageId(msg);

      expect(id1).toBe(id2);
    });

    it('should generate different IDs for different content', () => {
      const msg1: UserMessage = {
        type: 'user',
        session_id: 'test-session',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      };

      const msg2: UserMessage = {
        type: 'user',
        session_id: 'test-session',
        message: {
          content: [{ type: 'text', text: 'World' }],
        },
      };

      const id1 = generateMessageId(msg1);
      const id2 = generateMessageId(msg2);

      expect(id1).not.toBe(id2);
    });

    it('should generate 16-character hex IDs', () => {
      const msg: UserMessage = {
        type: 'user',
        session_id: 'test-session',
        message: {
          content: [{ type: 'text', text: 'Test' }],
        },
      };

      const id = generateMessageId(msg);
      expect(id).toMatch(/^[a-f0-9]{16}$/);
    });
  });
});

describe('AnalyzedMessageTracker with DB', () => {
  let db: DatabaseManager;
  let tracker: AnalyzedMessageTracker;

  beforeEach(() => {
    db = new DatabaseManager(':memory:');
    db.createSession({ id: 'test-session', shortId: 'test-s' });
    tracker = new AnalyzedMessageTracker({ db, sessionId: 'test-session' });
  });

  afterEach(() => {
    db.close();
  });

  it('persists analyzed messages to database', () => {
    tracker.markAnalyzed('msg-123', 'User asked about auth');

    expect(db.isMessageAnalyzed('msg-123')).toBe(true);
  });

  it('loads existing messages from database on init', () => {
    db.markMessageAnalyzed('existing-msg', 'test-session', 'Previous summary');

    const newTracker = new AnalyzedMessageTracker({ db, sessionId: 'test-session' });

    expect(newTracker.isAnalyzed('existing-msg')).toBe(true);
  });

  it('still works in-memory without DB', () => {
    const memTracker = new AnalyzedMessageTracker(); // No DB

    memTracker.markAnalyzed('msg-1', 'Summary');

    expect(memTracker.isAnalyzed('msg-1')).toBe(true);
  });

  it('preserves brief summary when loading from DB', () => {
    db.markMessageAnalyzed('msg-1', 'test-session', 'Original summary');

    const newTracker = new AnalyzedMessageTracker({ db, sessionId: 'test-session' });
    const summaries = newTracker.getAnalyzedSummaries();

    expect(summaries).toContain('Original summary');
  });

  it('does not duplicate when marking same message twice', () => {
    tracker.markAnalyzed('msg-1', 'Summary 1');
    tracker.markAnalyzed('msg-1', 'Summary 2'); // Should be ignored

    const messages = db.getSessionAnalyzedMessages('test-session');
    expect(messages).toHaveLength(1);
  });
});
