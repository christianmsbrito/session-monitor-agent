import { DatabaseManager, EventRow, SessionRow } from '../database/db-manager.js';

export function generateSessionMarkdown(db: DatabaseManager, sessionId: string): string {
  const session = db.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const events = db.getSessionEvents(sessionId);

  return formatSessionDocument(session, events);
}

function formatSessionDocument(session: SessionRow, events: EventRow[]): string {
  const lines: string[] = [];

  // Header
  const title = session.subject || `Session ${session.shortId}`;
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`**Session ID**: ${session.id}`);
  lines.push(`**Date**: ${formatDate(session.startedAt)}`);
  lines.push(`**Started**: ${session.startedAt.toISOString()}`);
  if (session.endedAt) {
    lines.push(`**Ended**: ${session.endedAt.toISOString()}`);
  }
  lines.push('');
  lines.push('## Events');
  lines.push('');

  // Events
  if (events.length === 0) {
    lines.push('*No significant events documented yet.*');
  } else {
    for (const event of events) {
      lines.push(formatEventBrief(event));
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatEventBrief(event: EventRow): string {
  const lines: string[] = [];

  const confidenceIcon = event.confidence === 'confirmed' ? '✓' : '~';
  const typeLabel = formatEventType(event.eventType);

  lines.push(`### ${confidenceIcon} ${typeLabel}: ${event.title}`);
  lines.push('');
  lines.push(
    `**Time**: ${formatTime(event.createdAt)} | **Type**: \`${event.eventType}\` | **Confidence**: ${confidenceIcon}`
  );

  if (event.relatedFiles && event.relatedFiles.length > 0) {
    lines.push(`**Files**: ${event.relatedFiles.join(', ')}`);
  }
  lines.push('');

  if (event.description) {
    // Truncate to first 500 chars
    const desc =
      event.description.length > 500
        ? event.description.slice(0, 500) + '...'
        : event.description;
    lines.push(desc);
    lines.push('');
  }

  if (event.reasoning) {
    const reasoning =
      event.reasoning.length > 200
        ? event.reasoning.slice(0, 200) + '...'
        : event.reasoning;
    lines.push(`> **Reasoning**: ${reasoning}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatEventType(eventType: string): string {
  return eventType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function formatTime(date: Date): string {
  return date.toISOString().split('T')[1].split('.')[0];
}
