import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateSessionMarkdown } from './session-markdown-generator';
import { DatabaseManager } from '../database/db-manager';

describe('generateSessionMarkdown', () => {
  let db: DatabaseManager;

  beforeEach(() => {
    db = new DatabaseManager(':memory:');
    db.createSession({
      id: 'test-session-123',
      shortId: 'test-ses',
      subject: 'Debugging auth flow',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('generates markdown with header', () => {
    const markdown = generateSessionMarkdown(db, 'test-session-123');

    expect(markdown).toContain('# Debugging auth flow');
    expect(markdown).toContain('**Session ID**: test-session-123');
  });

  it('includes events in chronological order', () => {
    db.insertEvent({
      sessionId: 'test-session-123',
      eventType: 'user_request',
      title: 'Add login feature',
      description: 'User wants login',
      confidence: 'confirmed',
    });
    db.insertEvent({
      sessionId: 'test-session-123',
      eventType: 'bug_identified',
      title: 'Found null pointer',
      description: 'NPE in auth module',
      confidence: 'unconfirmed',
    });

    const markdown = generateSessionMarkdown(db, 'test-session-123');

    const loginPos = markdown.indexOf('Add login feature');
    const bugPos = markdown.indexOf('Found null pointer');
    expect(loginPos).toBeLessThan(bugPos);
  });

  it('excludes invalidated events', () => {
    const event = db.insertEvent({
      sessionId: 'test-session-123',
      eventType: 'bug_identified',
      title: 'Wrong bug',
      description: 'This was incorrect',
      confidence: 'unconfirmed',
    });
    db.invalidateEvent(event.id, 'User corrected');

    const markdown = generateSessionMarkdown(db, 'test-session-123');

    expect(markdown).not.toContain('Wrong bug');
  });

  it('uses default title if no subject', () => {
    db.createSession({ id: 'no-subject', shortId: 'no-subj' });

    const markdown = generateSessionMarkdown(db, 'no-subject');

    expect(markdown).toContain('# Session no-subj');
  });

  it('shows empty state when no events', () => {
    const markdown = generateSessionMarkdown(db, 'test-session-123');

    expect(markdown).toContain('*No significant events documented yet.*');
  });

  it('formats event types correctly', () => {
    db.insertEvent({
      sessionId: 'test-session-123',
      eventType: 'user_request',
      title: 'Test',
      confidence: 'confirmed',
    });

    const markdown = generateSessionMarkdown(db, 'test-session-123');

    expect(markdown).toContain('User Request');
  });

  it('shows confirmed icon for confirmed events', () => {
    db.insertEvent({
      sessionId: 'test-session-123',
      eventType: 'user_request',
      title: 'Confirmed event',
      confidence: 'confirmed',
    });

    const markdown = generateSessionMarkdown(db, 'test-session-123');

    expect(markdown).toContain('✓ User Request');
  });

  it('shows unconfirmed icon for unconfirmed events', () => {
    db.insertEvent({
      sessionId: 'test-session-123',
      eventType: 'bug_identified',
      title: 'Unconfirmed event',
      confidence: 'unconfirmed',
    });

    const markdown = generateSessionMarkdown(db, 'test-session-123');

    expect(markdown).toContain('~ Bug Identified');
  });

  it('includes related files', () => {
    db.insertEvent({
      sessionId: 'test-session-123',
      eventType: 'user_request',
      title: 'Update auth',
      confidence: 'confirmed',
      relatedFiles: ['src/auth.ts', 'src/login.ts'],
    });

    const markdown = generateSessionMarkdown(db, 'test-session-123');

    expect(markdown).toContain('**Files**: src/auth.ts, src/login.ts');
  });

  it('truncates long descriptions', () => {
    const longDesc = 'x'.repeat(600);
    db.insertEvent({
      sessionId: 'test-session-123',
      eventType: 'user_request',
      title: 'Long desc',
      description: longDesc,
      confidence: 'confirmed',
    });

    const markdown = generateSessionMarkdown(db, 'test-session-123');

    expect(markdown).toContain('x'.repeat(500) + '...');
    expect(markdown).not.toContain('x'.repeat(501));
  });

  it('throws for non-existent session', () => {
    expect(() => generateSessionMarkdown(db, 'nonexistent')).toThrow(
      'Session not found'
    );
  });
});
