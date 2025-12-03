/**
 * MarkdownFormatter - Formats documentation events as markdown
 */

import {
  type DocumentationEvent,
  type SessionSummary,
  type SessionMetadata,
  EVENT_TYPE_LABELS,
} from '../types/index.js';

export class MarkdownFormatter {
  /**
   * Format a documentation event as markdown
   * Comprehensive format that preserves all details
   */
  formatEvent(event: DocumentationEvent): string {
    const lines: string[] = [];

    // Confidence indicator
    const confidenceIcon = event.confidence === 'confirmed' ? '✓' : '~';
    const confidenceLabel = event.confidence === 'confirmed' ? 'Confirmed' : 'Unconfirmed';

    // Header with confidence indicator
    lines.push(`# ${confidenceIcon} ${EVENT_TYPE_LABELS[event.eventType]}: ${event.title}`);
    lines.push('');

    // Confidence banner for unconfirmed events
    if (event.confidence === 'unconfirmed') {
      lines.push('> ⚠️ **UNCONFIRMED** - This is agent analysis that has not been verified by the user.');
      lines.push('');
    }

    // Metadata section
    lines.push('## Metadata');
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Confidence** | ${confidenceIcon} ${confidenceLabel} |`);
    lines.push(`| **Time** | ${event.timestamp.toISOString()} |`);
    lines.push(`| **Type** | \`${event.eventType}\` |`);
    lines.push(`| **Session** | ${event.sessionId} |`);

    if (event.relatedFiles && event.relatedFiles.length > 0) {
      lines.push(`| **Files** | ${event.relatedFiles.map((f) => `\`${f}\``).join(', ')} |`);
    }

    if (event.tags && event.tags.length > 0) {
      lines.push(`| **Tags** | ${event.tags.map((t) => `#${t}`).join(', ')} |`);
    }

    lines.push('');

    // Context (if provided) - conversation leading to this event
    if (event.context) {
      lines.push('## Context');
      lines.push('');
      lines.push('> What led to this event:');
      lines.push('');
      lines.push(event.context);
      lines.push('');
    }

    // Description - the main content
    lines.push('## Description');
    lines.push('');
    lines.push(event.description);
    lines.push('');

    // Reasoning (if provided) - why this decision/conclusion
    if (event.reasoning) {
      lines.push('## Reasoning');
      lines.push('');
      lines.push(event.reasoning);
      lines.push('');
    }

    // Evidence (if provided) - quotes, code, output
    if (event.evidence) {
      lines.push('## Evidence');
      lines.push('');
      // Check if evidence looks like code
      if (event.evidence.includes('\n') || event.evidence.includes('  ') ||
          event.evidence.includes('function') || event.evidence.includes('const ') ||
          event.evidence.includes('import ') || event.evidence.includes('export ')) {
        lines.push('```');
        lines.push(event.evidence);
        lines.push('```');
      } else {
        // Treat as quoted text
        lines.push(`> ${event.evidence.split('\n').join('\n> ')}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Format a brief event entry for the session document
   * Still includes meaningful detail, not just a one-liner
   */
  formatEventBrief(event: DocumentationEvent, eventPath: string): string {
    const lines: string[] = [];

    // Confidence indicator
    const confidenceIcon = event.confidence === 'confirmed' ? '✓' : '~';

    lines.push(`### ${confidenceIcon} ${EVENT_TYPE_LABELS[event.eventType]}: ${event.title}`);
    lines.push('');

    // Show unconfirmed warning inline
    if (event.confidence === 'unconfirmed') {
      lines.push(`> ⚠️ *Unconfirmed - agent analysis*`);
      lines.push('');
    }

    lines.push(`**Time**: ${event.timestamp.toTimeString().slice(0, 8)} | **Type**: \`${event.eventType}\` | **Confidence**: ${confidenceIcon}`);

    if (event.relatedFiles && event.relatedFiles.length > 0) {
      lines.push(`**Files**: ${event.relatedFiles.join(', ')}`);
    }

    lines.push('');

    // Include more of the description (up to 500 chars)
    const descLimit = 500;
    const desc = event.description.slice(0, descLimit);
    lines.push(desc + (event.description.length > descLimit ? '...' : ''));

    // Include a brief reasoning snippet if available
    if (event.reasoning) {
      const reasonLimit = 200;
      const reason = event.reasoning.slice(0, reasonLimit);
      lines.push('');
      lines.push(`> **Reasoning**: ${reason}${event.reasoning.length > reasonLimit ? '...' : ''}`);
    }

    lines.push('');
    lines.push(`[View full details](${eventPath})`);
    lines.push('');
    lines.push('---');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Format a summary as markdown
   */
  formatSummary(summary: SessionSummary): string {
    const lines: string[] = [];

    // Header
    const headerText =
      summary.summaryType === 'hourly' ? 'Hourly Summary' : 'Session Summary';
    lines.push(`# ${headerText}`);
    lines.push('');
    lines.push(`**Generated**: ${summary.timestamp.toISOString()}`);
    lines.push(`**Session**: ${summary.sessionId}`);
    lines.push('');

    // Content
    lines.push('## Overview');
    lines.push('');
    lines.push(summary.content);
    lines.push('');

    // Key decisions
    if (summary.keyDecisions && summary.keyDecisions.length > 0) {
      lines.push('## Key Decisions');
      lines.push('');
      for (const decision of summary.keyDecisions) {
        lines.push(`- ${decision}`);
      }
      lines.push('');
    }

    // Unresolved issues
    if (summary.unresolvedIssues && summary.unresolvedIssues.length > 0) {
      lines.push('## Unresolved Issues');
      lines.push('');
      for (const issue of summary.unresolvedIssues) {
        lines.push(`- [ ] ${issue}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format session header
   */
  formatSessionHeader(metadata: SessionMetadata): string {
    const lines: string[] = [];

    lines.push(`# Session: ${metadata.sessionId}`);
    lines.push('');
    lines.push(`**Started**: ${metadata.startTime.toISOString()}`);

    if (metadata.endTime) {
      const duration = metadata.endTime.getTime() - metadata.startTime.getTime();
      const minutes = Math.floor(duration / 60000);
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;

      lines.push(`**Duration**: ${hours}h ${remainingMinutes}m`);
    }

    lines.push(`**Status**: ${metadata.status}`);

    if (metadata.model) {
      lines.push(`**Model**: ${metadata.model}`);
    }

    lines.push('');
    lines.push('## Events');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Format session footer with summary links
   */
  formatSessionFooter(summaryPaths: string[]): string {
    const lines: string[] = [];

    lines.push('## Summaries');
    lines.push('');

    for (const summaryPath of summaryPaths) {
      const name = summaryPath.split('/').pop() || summaryPath;
      lines.push(`- [${name.replace('.md', '')}](${summaryPath})`);
    }

    lines.push('');

    return lines.join('\n');
  }
}
