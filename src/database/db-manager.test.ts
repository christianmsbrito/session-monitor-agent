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
});
