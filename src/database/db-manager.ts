import Database from 'better-sqlite3';

// Raw database row types (snake_case columns from SQLite)
interface RawSessionRow {
  id: string;
  short_id: string;
  subject: string | null;
  started_at: string;
  ended_at: string | null;
  transcript_path: string | null;
  transcript_position: number;
  status: string;
}

interface RawEventRow {
  id: number;
  session_id: string;
  event_type: string;
  title: string;
  description: string | null;
  confidence: string;
  evidence: string | null;
  context: string | null;
  reasoning: string | null;
  related_files: string | null;
  tags: string | null;
  created_at: string;
  invalidated_at: string | null;
  invalidation_reason: string | null;
}

interface RawDedupHashRow {
  hash: string;
  session_id: string;
  event_id: number | null;
  created_at: string;
}

interface RawAnalyzedMessageRow {
  id: string;
  session_id: string;
  brief_summary: string | null;
  analyzed_at: string;
}

export interface SessionRow {
  id: string;
  shortId: string;
  subject: string | null;
  startedAt: Date;
  endedAt: Date | null;
  transcriptPath: string | null;
  transcriptPosition: number;
  status: string;
}

export interface CreateSessionInput {
  id: string;
  shortId: string;
  subject?: string;
  transcriptPath?: string;
}

export interface EventRow {
  id: number;
  sessionId: string;
  eventType: string;
  title: string;
  description: string | null;
  confidence: string;
  evidence: string | null;
  context: string | null;
  reasoning: string | null;
  relatedFiles: string[] | null;
  tags: string[] | null;
  createdAt: Date;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
}

export interface InsertEventInput {
  sessionId: string;
  eventType: string;
  title: string;
  description?: string;
  confidence: string;
  evidence?: string;
  context?: string;
  reasoning?: string;
  relatedFiles?: string[];
  tags?: string[];
}

export interface DedupHashRow {
  hash: string;
  sessionId: string;
  eventId: number | null;
  createdAt: Date;
}

export interface AnalyzedMessageRow {
  id: string;
  sessionId: string;
  briefSummary: string | null;
  analyzedAt: Date;
}

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

  // Session CRUD methods

  createSession(input: CreateSessionInput): SessionRow {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sessions (id, short_id, subject, started_at, transcript_path, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(input.id, input.shortId, input.subject ?? null, now, input.transcriptPath ?? null);

    return this.getSession(input.id)!;
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as RawSessionRow | undefined;
    return row ? this.mapSessionRow(row) : null;
  }

  updateSessionSubject(sessionId: string, subject: string): void {
    this.db.prepare('UPDATE sessions SET subject = ? WHERE id = ?').run(subject, sessionId);
  }

  updateTranscriptPosition(sessionId: string, position: number): void {
    this.db.prepare('UPDATE sessions SET transcript_position = ? WHERE id = ?').run(position, sessionId);
  }

  finalizeSession(sessionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?')
      .run('finalized', now, sessionId);
  }

  findSessionByShortId(shortId: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE short_id = ? AND status = ?')
      .get(shortId, 'active') as RawSessionRow | undefined;
    return row ? this.mapSessionRow(row) : null;
  }

  private mapSessionRow(row: RawSessionRow): SessionRow {
    return {
      id: row.id,
      shortId: row.short_id,
      subject: row.subject,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : null,
      transcriptPath: row.transcript_path,
      transcriptPosition: row.transcript_position,
      status: row.status,
    };
  }

  // Event CRUD methods

  insertEvent(input: InsertEventInput): EventRow {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO events (session_id, event_type, title, description, confidence, evidence, context, reasoning, related_files, tags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.eventType,
      input.title,
      input.description ?? null,
      input.confidence,
      input.evidence ?? null,
      input.context ?? null,
      input.reasoning ?? null,
      input.relatedFiles ? JSON.stringify(input.relatedFiles) : null,
      input.tags ? JSON.stringify(input.tags) : null,
      now
    );

    return this.getEvent(result.lastInsertRowid as number)!;
  }

  getEvent(id: number): EventRow | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow | undefined;
    return row ? this.mapEventRow(row) : null;
  }

  getSessionEvents(sessionId: string, options?: { includeInvalidated?: boolean }): EventRow[] {
    let query = 'SELECT * FROM events WHERE session_id = ?';
    if (!options?.includeInvalidated) {
      query += ' AND invalidated_at IS NULL';
    }
    query += ' ORDER BY created_at ASC';

    const rows = this.db.prepare(query).all(sessionId) as RawEventRow[];
    return rows.map(row => this.mapEventRow(row));
  }

  getEventCount(sessionId: string): number {
    const result = this.db.prepare(
      'SELECT COUNT(*) as count FROM events WHERE session_id = ? AND invalidated_at IS NULL'
    ).get(sessionId) as { count: number };
    return result.count;
  }

  invalidateEvent(eventId: number, reason: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE events SET invalidated_at = ?, invalidation_reason = ? WHERE id = ?')
      .run(now, reason, eventId);
  }

  private mapEventRow(row: RawEventRow): EventRow {
    return {
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      title: row.title,
      description: row.description,
      confidence: row.confidence,
      evidence: row.evidence,
      context: row.context,
      reasoning: row.reasoning,
      relatedFiles: row.related_files ? JSON.parse(row.related_files) : null,
      tags: row.tags ? JSON.parse(row.tags) : null,
      createdAt: new Date(row.created_at),
      invalidatedAt: row.invalidated_at ? new Date(row.invalidated_at) : null,
      invalidationReason: row.invalidation_reason,
    };
  }

  // Dedup hash methods

  insertDedupHash(hash: string, sessionId: string, eventId?: number): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO dedup_hashes (hash, session_id, event_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(hash, sessionId, eventId ?? null, now);
  }

  hashExists(hash: string): boolean {
    const result = this.db.prepare('SELECT 1 FROM dedup_hashes WHERE hash = ?').get(hash);
    return result !== undefined;
  }

  getSessionDedupHashes(sessionId: string): DedupHashRow[] {
    const rows = this.db.prepare('SELECT * FROM dedup_hashes WHERE session_id = ?').all(sessionId) as RawDedupHashRow[];
    return rows.map(row => ({
      hash: row.hash,
      sessionId: row.session_id,
      eventId: row.event_id,
      createdAt: new Date(row.created_at),
    }));
  }

  // Analyzed messages methods

  markMessageAnalyzed(messageId: string, sessionId: string, briefSummary?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO analyzed_messages (id, session_id, brief_summary, analyzed_at)
      VALUES (?, ?, ?, ?)
    `).run(messageId, sessionId, briefSummary ?? null, now);
  }

  isMessageAnalyzed(messageId: string): boolean {
    const result = this.db.prepare('SELECT 1 FROM analyzed_messages WHERE id = ?').get(messageId);
    return result !== undefined;
  }

  getSessionAnalyzedMessages(sessionId: string): AnalyzedMessageRow[] {
    const rows = this.db.prepare('SELECT * FROM analyzed_messages WHERE session_id = ?').all(sessionId) as RawAnalyzedMessageRow[];
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      briefSummary: row.brief_summary,
      analyzedAt: new Date(row.analyzed_at),
    }));
  }

  getAnalyzedMessageIds(sessionId: string): Set<string> {
    const rows = this.db.prepare('SELECT id FROM analyzed_messages WHERE session_id = ?').all(sessionId) as { id: string }[];
    return new Set(rows.map(r => r.id));
  }

  // Transaction methods

  insertEventWithHash(input: InsertEventInput, hash: string): EventRow {
    const insertTransaction = this.db.transaction(() => {
      const event = this.insertEvent(input);
      this.insertDedupHash(hash, input.sessionId, event.id);
      return event;
    });

    return insertTransaction();
  }

  close(): void {
    this.db.close();
  }
}
