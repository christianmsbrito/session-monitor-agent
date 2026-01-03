import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DeduplicationTracker } from './deduplication.js';
import { DatabaseManager } from '../database/db-manager.js';

describe('DeduplicationTracker', () => {
  let tracker: DeduplicationTracker;

  beforeEach(() => {
    tracker = new DeduplicationTracker();
  });

  describe('hash', () => {
    it('should generate same hash for identical events', () => {
      const event = {
        eventType: 'user_request',
        title: 'Update documentation',
        description: 'User wants to update docs',
        evidence: 'User said: "let\'s update our docs"',
      };

      const hash1 = tracker.hash(event);
      const hash2 = tracker.hash(event);

      expect(hash1).toBe(hash2);
    });

    it('should generate different hash for different evidence', () => {
      const event1 = {
        eventType: 'user_request',
        title: 'Update documentation',
        description: 'User wants to update docs',
        evidence: 'User said: "let\'s update our docs"',
      };
      const event2 = {
        eventType: 'user_request',
        title: 'Update documentation',
        description: 'User wants to update docs',
        evidence: 'User said: "fix the bug please"',
      };

      const hash1 = tracker.hash(event1);
      const hash2 = tracker.hash(event2);

      expect(hash1).not.toBe(hash2);
    });

    it('should generate same hash for same evidence with different titles (regression test for duplicate events bug)', () => {
      // This is the key regression test - the bug was that the same user request
      // was being documented 10+ times because Claude generated different titles
      // but the evidence (actual user quote) was the same
      const sameEvidence = 'User said: "let\'s update our docs based on the current state of our app"';

      const event1 = {
        eventType: 'user_request',
        title: 'Update documentation to reflect current app state',
        description: 'User wants documentation updated',
        evidence: sameEvidence,
      };
      const event2 = {
        eventType: 'user_request',
        title: 'Update documentation for app',
        description: 'Documentation update requested',
        evidence: sameEvidence,
      };
      const event3 = {
        eventType: 'user_request',
        title: 'Update documentation',
        description: 'Docs need update',
        evidence: sameEvidence,
      };

      const hash1 = tracker.hash(event1);
      const hash2 = tracker.hash(event2);
      const hash3 = tracker.hash(event3);

      // All should have the same hash because evidence is the same
      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });
  });

  describe('isDuplicate', () => {
    it('should return false for undocumented hash', () => {
      expect(tracker.isDuplicate('somehash')).toBe(false);
    });

    it('should return true for documented hash', () => {
      const event = {
        eventType: 'user_request',
        title: 'Test event',
        description: 'Test description',
        evidence: 'User said: "test"',
      };
      const hash = tracker.hash(event);
      tracker.markDocumented(hash, { title: event.title, eventType: event.eventType, evidence: event.evidence });

      expect(tracker.isDuplicate(hash)).toBe(true);
    });
  });

  describe('isSimilar', () => {
    it('should detect similar events by evidence', () => {
      const event1 = {
        eventType: 'user_request',
        title: 'First title',
        description: 'First description',
        evidence: 'User said: "let\'s update our documentation files"',
      };
      const hash = tracker.hash(event1);
      tracker.markDocumented(hash, { title: event1.title, eventType: event1.eventType, evidence: event1.evidence });

      // Different title/description but very similar evidence
      const event2 = {
        title: 'Second different title',
        description: 'Different description',
        evidence: 'User said: "let\'s update our documentation files please"',
      };

      expect(tracker.isSimilar(event2)).toBe(true);
    });

    it('should detect similar events by title when no evidence', () => {
      const event1 = {
        eventType: 'user_request',
        title: 'Update documentation files',
        description: 'User wants docs updated',
      };
      const hash = tracker.hash(event1);
      tracker.markDocumented(hash, { title: event1.title, eventType: event1.eventType });

      const event2 = {
        title: 'Update documentation files now',
        description: 'Different description',
      };

      expect(tracker.isSimilar(event2)).toBe(true);
    });

    it('should not flag different events as similar', () => {
      const event1 = {
        eventType: 'user_request',
        title: 'Update documentation',
        description: 'Docs update',
        evidence: 'User said: "update the docs"',
      };
      const hash = tracker.hash(event1);
      tracker.markDocumented(hash, { title: event1.title, eventType: event1.eventType, evidence: event1.evidence });

      const event2 = {
        title: 'Fix the authentication bug',
        description: 'Auth system has issues',
        evidence: 'User said: "there is a bug in auth"',
      };

      expect(tracker.isSimilar(event2)).toBe(false);
    });
  });

  describe('markDocumented', () => {
    it('should store evidence for later similarity comparison', () => {
      const event = {
        eventType: 'user_request',
        title: 'Test event',
        description: 'Test description',
        evidence: 'User said: "test this feature"',
      };
      const hash = tracker.hash(event);
      tracker.markDocumented(hash, { title: event.title, eventType: event.eventType, evidence: event.evidence });

      const documented = tracker.getDocumented();
      expect(documented).toHaveLength(1);
      expect(documented[0].evidence).toBe(event.evidence);
    });
  });
});

describe('DeduplicationTracker with DB', () => {
  let db: DatabaseManager;
  let tracker: DeduplicationTracker;

  beforeEach(() => {
    db = new DatabaseManager(':memory:');
    db.createSession({ id: 'test-session', shortId: 'test-s' });
    tracker = new DeduplicationTracker({ db, sessionId: 'test-session' });
  });

  afterEach(() => {
    db.close();
  });

  it('persists documented items to database', () => {
    const hash = tracker.hash({
      eventType: 'user_request',
      title: 'Add feature',
      description: 'Description',
    });

    tracker.markDocumented(hash, {
      title: 'Add feature',
      eventType: 'user_request',
    });

    // Check database directly
    expect(db.hashExists(hash)).toBe(true);
  });

  it('loads existing hashes from database on init', () => {
    // Pre-populate database
    db.insertDedupHash('existing-hash', 'test-session');

    // Create new tracker (simulates restart)
    const newTracker = new DeduplicationTracker({ db, sessionId: 'test-session' });

    expect(newTracker.isDuplicate('existing-hash')).toBe(true);
  });

  it('still works in-memory without DB', () => {
    const memTracker = new DeduplicationTracker(); // No DB
    const hash = memTracker.hash({
      eventType: 'user_request',
      title: 'Test',
      description: 'Desc',
    });

    memTracker.markDocumented(hash, { title: 'Test', eventType: 'user_request' });

    expect(memTracker.isDuplicate(hash)).toBe(true);
  });

  it('links dedup hash to event ID when provided', () => {
    const event = db.insertEvent({
      sessionId: 'test-session',
      eventType: 'user_request',
      title: 'Test event',
      confidence: 'confirmed',
    });

    const hash = tracker.hash({
      eventType: 'user_request',
      title: 'Test event',
      description: 'Desc',
    });

    tracker.markDocumented(hash, { title: 'Test event', eventType: 'user_request' }, event.id);

    const hashes = db.getSessionDedupHashes('test-session');
    expect(hashes).toHaveLength(1);
    expect(hashes[0].eventId).toBe(event.id);
  });
});
