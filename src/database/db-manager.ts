import Database from 'better-sqlite3';

export class DatabaseManager {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    // Enable WAL mode for concurrent read/write (only for file-based DBs)
    if (this.dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL,
        subject TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        transcript_path TEXT,
        transcript_position INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        confidence TEXT,
        evidence TEXT,
        context TEXT,
        reasoning TEXT,
        related_files TEXT,
        tags TEXT,
        created_at TEXT NOT NULL,
        invalidated_at TEXT,
        invalidation_reason TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS dedup_hashes (
        hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_id INTEGER REFERENCES events(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analyzed_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        brief_summary TEXT,
        analyzed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(started_at);
      CREATE INDEX IF NOT EXISTS idx_dedup_session ON dedup_hashes(session_id);
      CREATE INDEX IF NOT EXISTS idx_analyzed_session ON analyzed_messages(session_id);
    `);
  }

  getTableNames(): string[] {
    const rows = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as { name: string }[];
    return rows.map(r => r.name);
  }

  getJournalMode(): string {
    const result = this.db.pragma('journal_mode') as { journal_mode: string }[];
    return result[0].journal_mode;
  }

  close(): void {
    this.db.close();
  }
}
