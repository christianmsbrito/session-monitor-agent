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
});
