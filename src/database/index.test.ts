import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDatabase, closeDatabase, initializeDatabase } from './index';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Database Singleton', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('initializes database at specified path', () => {
    const dbPath = path.join(testDir, 'sessions.db');
    initializeDatabase(dbPath);

    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('creates directory if it does not exist', () => {
    const dbPath = path.join(testDir, 'nested', 'dir', 'sessions.db');
    initializeDatabase(dbPath);

    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('returns same instance on multiple calls', () => {
    const dbPath = path.join(testDir, 'sessions.db');
    initializeDatabase(dbPath);

    const db1 = getDatabase();
    const db2 = getDatabase();

    expect(db1).toBe(db2);
  });

  it('throws if getDatabase called before init', () => {
    expect(() => getDatabase()).toThrow('Database not initialized');
  });

  it('allows reinitialize after close', () => {
    const dbPath1 = path.join(testDir, 'sessions1.db');
    const dbPath2 = path.join(testDir, 'sessions2.db');

    initializeDatabase(dbPath1);
    closeDatabase();

    initializeDatabase(dbPath2);
    const db = getDatabase();

    expect(db).toBeDefined();
    expect(fs.existsSync(dbPath2)).toBe(true);
  });
});
