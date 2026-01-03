import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from './db-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('DatabaseManager', () => {
  let db: DatabaseManager;

  beforeEach(() => {
    db = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('initialization', () => {
    it('creates all required tables', () => {
      const tables = db.getTableNames();
      expect(tables).toContain('sessions');
      expect(tables).toContain('events');
      expect(tables).toContain('dedup_hashes');
      expect(tables).toContain('analyzed_messages');
    });

    it('enables WAL mode for file-based databases', () => {
      // Close the in-memory db first
      db.close();

      // Create a temp file-based database
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
      const dbPath = path.join(testDir, 'test.db');

      try {
        const fileDb = new DatabaseManager(dbPath);
        const mode = fileDb.getJournalMode();
        expect(mode).toBe('wal');
        fileDb.close();
      } finally {
        // Cleanup
        fs.rmSync(testDir, { recursive: true, force: true });
      }

      // Recreate in-memory db for afterEach
      db = new DatabaseManager(':memory:');
    });

    it('uses memory journal mode for in-memory databases', () => {
      const mode = db.getJournalMode();
      expect(mode).toBe('memory');
    });
  });

  describe('sessions', () => {
    it('creates a new session', () => {
      const session = db.createSession({
        id: 'session-123-abc',
        shortId: 'session-1',
        transcriptPath: '/path/to/transcript.jsonl',
      });

      expect(session.id).toBe('session-123-abc');
      expect(session.shortId).toBe('session-1');
      expect(session.status).toBe('active');
      expect(session.startedAt).toBeInstanceOf(Date);
    });

    it('gets session by id', () => {
      db.createSession({ id: 'test-session', shortId: 'test-s' });

      const session = db.getSession('test-session');
      expect(session?.id).toBe('test-session');
    });

    it('returns null for non-existent session', () => {
      const session = db.getSession('non-existent');
      expect(session).toBeNull();
    });

    it('updates session subject', () => {
      db.createSession({ id: 'test-session', shortId: 'test-s' });

      db.updateSessionSubject('test-session', 'Debugging auth flow');

      const session = db.getSession('test-session');
      expect(session?.subject).toBe('Debugging auth flow');
    });

    it('updates transcript position', () => {
      db.createSession({ id: 'test-session', shortId: 'test-s' });

      db.updateTranscriptPosition('test-session', 12500);

      const session = db.getSession('test-session');
      expect(session?.transcriptPosition).toBe(12500);
    });

    it('finalizes session', () => {
      db.createSession({ id: 'test-session', shortId: 'test-s' });

      db.finalizeSession('test-session');

      const session = db.getSession('test-session');
      expect(session?.status).toBe('finalized');
      expect(session?.endedAt).toBeInstanceOf(Date);
    });

    it('finds existing session by short id prefix', () => {
      db.createSession({ id: 'abc12345-full-id', shortId: 'abc12345' });

      const found = db.findSessionByShortId('abc12345');
      expect(found?.id).toBe('abc12345-full-id');
    });

    it('only finds active sessions by short id', () => {
      db.createSession({ id: 'abc12345-full-id', shortId: 'abc12345' });
      db.finalizeSession('abc12345-full-id');

      const found = db.findSessionByShortId('abc12345');
      expect(found).toBeNull();
    });
  });

  describe('events', () => {
    beforeEach(() => {
      db.createSession({ id: 'test-session', shortId: 'test-s' });
    });

    it('inserts an event', () => {
      const event = db.insertEvent({
        sessionId: 'test-session',
        eventType: 'user_request',
        title: 'Add dark mode',
        description: 'User wants dark mode toggle',
        confidence: 'confirmed',
        evidence: 'User said: "Add dark mode please"',
      });

      expect(event.id).toBeGreaterThan(0);
      expect(event.eventType).toBe('user_request');
      expect(event.createdAt).toBeInstanceOf(Date);
    });

    it('gets events for session', () => {
      db.insertEvent({ sessionId: 'test-session', eventType: 'user_request', title: 'First', confidence: 'confirmed' });
      db.insertEvent({ sessionId: 'test-session', eventType: 'bug_identified', title: 'Second', confidence: 'unconfirmed' });

      const events = db.getSessionEvents('test-session');
      expect(events).toHaveLength(2);
      expect(events[0].title).toBe('First');
      expect(events[1].title).toBe('Second');
    });

    it('excludes invalidated events by default', () => {
      const event = db.insertEvent({ sessionId: 'test-session', eventType: 'bug_identified', title: 'Wrong', confidence: 'unconfirmed' });
      db.invalidateEvent(event.id, 'Was incorrect');

      const events = db.getSessionEvents('test-session');
      expect(events).toHaveLength(0);
    });

    it('can include invalidated events', () => {
      const event = db.insertEvent({ sessionId: 'test-session', eventType: 'bug_identified', title: 'Wrong', confidence: 'unconfirmed' });
      db.invalidateEvent(event.id, 'Was incorrect');

      const events = db.getSessionEvents('test-session', { includeInvalidated: true });
      expect(events).toHaveLength(1);
      expect(events[0].invalidatedAt).toBeInstanceOf(Date);
    });

    it('gets event count for session', () => {
      db.insertEvent({ sessionId: 'test-session', eventType: 'user_request', title: 'First', confidence: 'confirmed' });
      db.insertEvent({ sessionId: 'test-session', eventType: 'bug_identified', title: 'Second', confidence: 'unconfirmed' });

      expect(db.getEventCount('test-session')).toBe(2);
    });

    it('stores and retrieves related files', () => {
      const event = db.insertEvent({
        sessionId: 'test-session',
        eventType: 'user_request',
        title: 'Update auth',
        confidence: 'confirmed',
        relatedFiles: ['src/auth.ts', 'src/login.ts'],
      });

      const retrieved = db.getEvent(event.id);
      expect(retrieved?.relatedFiles).toEqual(['src/auth.ts', 'src/login.ts']);
    });

    it('stores and retrieves tags', () => {
      const event = db.insertEvent({
        sessionId: 'test-session',
        eventType: 'bug_identified',
        title: 'Memory leak',
        confidence: 'unconfirmed',
        tags: ['performance', 'critical'],
      });

      const retrieved = db.getEvent(event.id);
      expect(retrieved?.tags).toEqual(['performance', 'critical']);
    });
  });

  describe('dedup_hashes', () => {
    beforeEach(() => {
      db.createSession({ id: 'test-session', shortId: 'test-s' });
    });

    it('inserts a dedup hash', () => {
      const event = db.insertEvent({ sessionId: 'test-session', eventType: 'user_request', title: 'Test', confidence: 'confirmed' });

      db.insertDedupHash('abc123def456', 'test-session', event.id);

      expect(db.hashExists('abc123def456')).toBe(true);
    });

    it('checks hash existence', () => {
      expect(db.hashExists('nonexistent')).toBe(false);
    });

    it('gets all hashes for session', () => {
      const event1 = db.insertEvent({ sessionId: 'test-session', eventType: 'user_request', title: 'Test1', confidence: 'confirmed' });
      const event2 = db.insertEvent({ sessionId: 'test-session', eventType: 'bug_identified', title: 'Test2', confidence: 'unconfirmed' });

      db.insertDedupHash('hash1', 'test-session', event1.id);
      db.insertDedupHash('hash2', 'test-session', event2.id);

      const hashes = db.getSessionDedupHashes('test-session');
      expect(hashes).toHaveLength(2);
      expect(hashes.map(h => h.hash)).toContain('hash1');
      expect(hashes.map(h => h.hash)).toContain('hash2');
    });

    it('ignores duplicate hash insertions', () => {
      db.insertDedupHash('same-hash', 'test-session');
      db.insertDedupHash('same-hash', 'test-session'); // Should not throw

      const hashes = db.getSessionDedupHashes('test-session');
      expect(hashes).toHaveLength(1);
    });
  });

  describe('analyzed_messages', () => {
    beforeEach(() => {
      db.createSession({ id: 'test-session', shortId: 'test-s' });
    });

    it('marks message as analyzed', () => {
      db.markMessageAnalyzed('msg-123', 'test-session', 'User asked about auth');

      expect(db.isMessageAnalyzed('msg-123')).toBe(true);
    });

    it('checks if message is analyzed', () => {
      expect(db.isMessageAnalyzed('nonexistent')).toBe(false);
    });

    it('gets analyzed messages for session', () => {
      db.markMessageAnalyzed('msg-1', 'test-session', 'Summary 1');
      db.markMessageAnalyzed('msg-2', 'test-session', 'Summary 2');

      const messages = db.getSessionAnalyzedMessages('test-session');
      expect(messages).toHaveLength(2);
    });

    it('gets analyzed message IDs as Set', () => {
      db.markMessageAnalyzed('msg-1', 'test-session', 'Summary 1');
      db.markMessageAnalyzed('msg-2', 'test-session', 'Summary 2');

      const ids = db.getAnalyzedMessageIds('test-session');
      expect(ids).toBeInstanceOf(Set);
      expect(ids.has('msg-1')).toBe(true);
      expect(ids.has('msg-2')).toBe(true);
    });

    it('ignores duplicate message insertions', () => {
      db.markMessageAnalyzed('msg-1', 'test-session', 'Summary 1');
      db.markMessageAnalyzed('msg-1', 'test-session', 'Summary 2'); // Should not throw

      const messages = db.getSessionAnalyzedMessages('test-session');
      expect(messages).toHaveLength(1);
      expect(messages[0].briefSummary).toBe('Summary 1'); // First wins
    });
  });

  describe('transactions', () => {
    beforeEach(() => {
      db.createSession({ id: 'test-session', shortId: 'test-s' });
    });

    it('inserts event and dedup hash atomically', () => {
      const hash = 'abc123def456';

      const event = db.insertEventWithHash({
        sessionId: 'test-session',
        eventType: 'user_request',
        title: 'Add feature',
        confidence: 'confirmed',
      }, hash);

      expect(event.id).toBeGreaterThan(0);
      expect(db.hashExists(hash)).toBe(true);
    });

    it('handles existing hash gracefully', () => {
      const hash = 'existing-hash';
      db.insertDedupHash(hash, 'test-session');

      // Should still insert event, hash is ignored (OR IGNORE)
      const event = db.insertEventWithHash({
        sessionId: 'test-session',
        eventType: 'user_request',
        title: 'Add feature',
        confidence: 'confirmed',
      }, hash);

      expect(event.id).toBeGreaterThan(0);
    });
  });
});
