/**
 * Integration tests for SQLite persistence
 * Tests the full pipeline from DocumentationAgent to database to session.md output
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initializeDatabase, closeDatabase, getDatabase } from '../database/index.js';
import { DeduplicationTracker } from '../documentation/deduplication.js';
import { AnalyzedMessageTracker } from '../documentation/analyzed-tracker.js';
import { generateSessionMarkdown } from '../output/session-markdown-generator.js';
import { SessionMarkdownDebouncer } from '../output/session-markdown-debouncer.js';

describe('SQLite Persistence Integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
    const dbPath = path.join(testDir, 'sessions.db');
    initializeDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('DeduplicationTracker with Database', () => {
    it('persists and loads dedup hashes across instances', () => {
      const db = getDatabase();
      db.createSession({ id: 'test-session', shortId: 'test-s' });

      // First tracker instance - mark events as documented
      const tracker1 = new DeduplicationTracker({ db, sessionId: 'test-session' });
      const hash1 = tracker1.hash({
        eventType: 'user_request',
        title: 'Add feature X',
        description: 'User wants feature X',
        evidence: 'User said: "please add feature X"',
      });
      tracker1.markDocumented(hash1, {
        title: 'Add feature X',
        eventType: 'user_request',
        evidence: 'User said: "please add feature X"',
      });

      expect(tracker1.isDuplicate(hash1)).toBe(true);

      // Second tracker instance (simulates restart)
      const tracker2 = new DeduplicationTracker({ db, sessionId: 'test-session' });

      // Should load from database and detect duplicate
      expect(tracker2.isDuplicate(hash1)).toBe(true);
    });

    it('prevents duplicate documentation across tracker instances', () => {
      const db = getDatabase();
      db.createSession({ id: 'resume-test', shortId: 'resume-' });

      // First instance documents an event
      const tracker1 = new DeduplicationTracker({ db, sessionId: 'resume-test' });
      const event = {
        eventType: 'bug_identified',
        title: 'Found null pointer bug',
        description: 'NPE in auth module',
        evidence: 'Stack trace shows NPE at line 42',
      };
      const hash = tracker1.hash(event);
      tracker1.markDocumented(hash, {
        title: event.title,
        eventType: event.eventType,
        evidence: event.evidence,
      });

      // Second instance should see it as duplicate
      const tracker2 = new DeduplicationTracker({ db, sessionId: 'resume-test' });
      expect(tracker2.isDuplicate(hash)).toBe(true);
      expect(tracker2.getCount()).toBe(1);
    });
  });

  describe('AnalyzedMessageTracker with Database', () => {
    it('persists and loads analyzed messages across instances', () => {
      const db = getDatabase();
      db.createSession({ id: 'analyzed-test', shortId: 'analyz' });

      // First tracker instance
      const tracker1 = new AnalyzedMessageTracker({ db, sessionId: 'analyzed-test' });
      tracker1.markAnalyzed('msg-001', 'User: "Add dark mode"');
      tracker1.markAnalyzed('msg-002', 'Assistant used tools: Read, Edit');

      expect(tracker1.isAnalyzed('msg-001')).toBe(true);
      expect(tracker1.isAnalyzed('msg-002')).toBe(true);
      expect(tracker1.getCount()).toBe(2);

      // Second tracker instance (simulates restart)
      const tracker2 = new AnalyzedMessageTracker({ db, sessionId: 'analyzed-test' });

      // Should load from database
      expect(tracker2.isAnalyzed('msg-001')).toBe(true);
      expect(tracker2.isAnalyzed('msg-002')).toBe(true);
      expect(tracker2.getCount()).toBe(2);
    });

    it('preserves brief summaries when loading from database', () => {
      const db = getDatabase();
      db.createSession({ id: 'summary-test', shortId: 'summar' });

      // First instance
      const tracker1 = new AnalyzedMessageTracker({ db, sessionId: 'summary-test' });
      tracker1.markAnalyzed('msg-1', 'User: "Help me debug the API"');
      tracker1.markAnalyzed('msg-2', 'Assistant: "I found the issue"');

      // Second instance
      const tracker2 = new AnalyzedMessageTracker({ db, sessionId: 'summary-test' });
      const summaries = tracker2.getAnalyzedSummaries();

      expect(summaries).toContain('User: "Help me debug the API"');
      expect(summaries).toContain('Assistant: "I found the issue"');
    });
  });

  describe('Session Markdown Generation', () => {
    it('generates markdown from database events', () => {
      const db = getDatabase();
      db.createSession({
        id: 'markdown-test',
        shortId: 'markdo',
        subject: 'Debugging Auth System',
      });

      // Add some events
      db.insertEvent({
        sessionId: 'markdown-test',
        eventType: 'user_request',
        title: 'Fix login bug',
        description: 'User reports login not working',
        confidence: 'confirmed',
        evidence: 'User said: "login is broken"',
      });

      db.insertEvent({
        sessionId: 'markdown-test',
        eventType: 'bug_identified',
        title: 'Found session timeout issue',
        description: 'Session expires too quickly',
        confidence: 'unconfirmed',
        reasoning: 'Based on log analysis',
      });

      const markdown = generateSessionMarkdown(db, 'markdown-test');

      expect(markdown).toContain('# Debugging Auth System');
      expect(markdown).toContain('Fix login bug');
      expect(markdown).toContain('Found session timeout issue');
      expect(markdown).toContain('user_request');
      expect(markdown).toContain('bug_identified');
    });

    it('excludes invalidated events from markdown', () => {
      const db = getDatabase();
      db.createSession({ id: 'invalidate-test', shortId: 'invali' });

      const event = db.insertEvent({
        sessionId: 'invalidate-test',
        eventType: 'bug_identified',
        title: 'Wrong diagnosis',
        description: 'This was incorrect',
        confidence: 'unconfirmed',
      });

      // Invalidate the event
      db.invalidateEvent(event.id, 'User corrected this');

      const markdown = generateSessionMarkdown(db, 'invalidate-test');

      expect(markdown).not.toContain('Wrong diagnosis');
    });
  });

  describe('Database Event Storage', () => {
    it('stores events with all fields', () => {
      const db = getDatabase();
      db.createSession({ id: 'fields-test', shortId: 'fields' });

      const event = db.insertEvent({
        sessionId: 'fields-test',
        eventType: 'decision_made',
        title: 'Use JWT for auth',
        description: 'Decided to use JWT tokens instead of sessions',
        confidence: 'confirmed',
        evidence: 'User approved: "yes, let\'s use JWT"',
        context: 'Discussing authentication strategy',
        reasoning: 'JWT provides stateless auth which scales better',
        relatedFiles: ['src/auth/jwt.ts', 'src/middleware/auth.ts'],
        tags: ['auth', 'architecture'],
      });

      const retrieved = db.getEvent(event.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe('Use JWT for auth');
      expect(retrieved?.evidence).toBe('User approved: "yes, let\'s use JWT"');
      expect(retrieved?.relatedFiles).toContain('src/auth/jwt.ts');
      expect(retrieved?.tags).toContain('architecture');
    });

    it('links dedup hash to event', () => {
      const db = getDatabase();
      db.createSession({ id: 'link-test', shortId: 'link-t' });

      const event = db.insertEvent({
        sessionId: 'link-test',
        eventType: 'user_request',
        title: 'Test event',
        confidence: 'confirmed',
      });

      db.insertDedupHash('testhash123', 'link-test', event.id);

      const hashes = db.getSessionDedupHashes('link-test');
      expect(hashes).toHaveLength(1);
      expect(hashes[0].hash).toBe('testhash123');
      expect(hashes[0].eventId).toBe(event.id);
    });
  });

  describe('Session Lifecycle', () => {
    it('creates and finalizes session', () => {
      const db = getDatabase();

      const session = db.createSession({
        id: 'lifecycle-test',
        shortId: 'lifecy',
        subject: 'Test Session',
      });

      expect(session.status).toBe('active');
      expect(session.endedAt).toBeNull();

      db.finalizeSession('lifecycle-test');

      const finalized = db.getSession('lifecycle-test');
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.endedAt).toBeInstanceOf(Date);
    });

    it('updates session subject', () => {
      const db = getDatabase();

      db.createSession({ id: 'subject-test', shortId: 'subjec' });
      db.updateSessionSubject('subject-test', 'Debugging API Issues');

      const session = db.getSession('subject-test');
      expect(session?.subject).toBe('Debugging API Issues');
    });
  });

  describe('Atomic Operations', () => {
    it('inserts event with hash atomically', () => {
      const db = getDatabase();
      db.createSession({ id: 'atomic-test', shortId: 'atomic' });

      const event = db.insertEventWithHash({
        sessionId: 'atomic-test',
        eventType: 'user_request',
        title: 'Atomic operation test',
        confidence: 'confirmed',
      }, 'atomichash123');

      expect(event.id).toBeGreaterThan(0);
      expect(db.hashExists('atomichash123')).toBe(true);

      const hashes = db.getSessionDedupHashes('atomic-test');
      expect(hashes.find(h => h.hash === 'atomichash123')?.eventId).toBe(event.id);
    });
  });
});
