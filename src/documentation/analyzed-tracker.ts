/**
 * AnalyzedMessageTracker - Tracks which messages have been sent to Claude for analysis
 *
 * Prevents duplicate documentation by ensuring Claude only sees each message's
 * full content once. Subsequent batches show brief summaries of analyzed messages
 * to maintain cross-batch pattern detection without re-analysis.
 */

import {
  type StreamMessage,
  isUserMessage,
  isAssistantMessage,
  getTextContent,
  getToolUses,
  hasActualUserText,
} from '../types/index.js';
import type { DatabaseManager } from '../database/db-manager.js';

export interface AnalyzedMessage {
  messageId: string;
  analyzedAt: Date;
  briefSummary: string;
}

export interface AnalyzedMessageExport {
  messageId: string;
  analyzedAt: string; // ISO date string for JSON serialization
  briefSummary: string;
}

export interface AnalyzedTrackerConfig {
  /** Optional database for persistence */
  db?: DatabaseManager;

  /** Session ID (required if db is provided) */
  sessionId?: string;
}

export class AnalyzedMessageTracker {
  private analyzed: Map<string, AnalyzedMessage> = new Map();
  private db?: DatabaseManager;
  private sessionId?: string;

  constructor(config: AnalyzedTrackerConfig = {}) {
    this.db = config.db;
    this.sessionId = config.sessionId;

    // Load existing analyzed messages from DB if available
    if (this.db && this.sessionId) {
      this.loadFromDatabase();
    }
  }

  /**
   * Load existing analyzed messages from database into memory
   */
  private loadFromDatabase(): void {
    if (!this.db || !this.sessionId) return;

    const messages = this.db.getSessionAnalyzedMessages(this.sessionId);
    for (const msg of messages) {
      this.analyzed.set(msg.id, {
        messageId: msg.id,
        analyzedAt: msg.analyzedAt,
        briefSummary: msg.briefSummary ?? '',
      });
    }
  }

  /**
   * Check if a message has already been analyzed
   */
  isAnalyzed(messageId: string): boolean {
    return this.analyzed.has(messageId);
  }

  /**
   * Mark a message as analyzed
   */
  markAnalyzed(messageId: string, summary: string): void {
    if (!this.analyzed.has(messageId)) {
      this.analyzed.set(messageId, {
        messageId,
        analyzedAt: new Date(),
        briefSummary: summary,
      });

      // Write to DB if available
      if (this.db && this.sessionId) {
        this.db.markMessageAnalyzed(messageId, this.sessionId, summary);
      }
    }
  }

  /**
   * Get the set of all analyzed message IDs
   */
  getAnalyzedIds(): Set<string> {
    return new Set(this.analyzed.keys());
  }

  /**
   * Get formatted summaries of analyzed messages for context
   * Returns a string suitable for including in the context sent to Claude
   */
  getAnalyzedSummaries(): string {
    if (this.analyzed.size === 0) {
      return '';
    }

    const summaries = Array.from(this.analyzed.values())
      .filter((m) => m.briefSummary.trim().length > 0)
      .map((m) => `- ${m.briefSummary}`);

    if (summaries.length === 0) {
      return '';
    }

    return summaries.join('\n');
  }

  /**
   * Get the count of analyzed messages
   */
  getCount(): number {
    return this.analyzed.size;
  }

  /**
   * Export analyzed state for persistence
   */
  export(): AnalyzedMessageExport[] {
    return Array.from(this.analyzed.values()).map((m) => ({
      messageId: m.messageId,
      analyzedAt: m.analyzedAt.toISOString(),
      briefSummary: m.briefSummary,
    }));
  }

  /**
   * Import analyzed state from persistence
   */
  import(items: AnalyzedMessageExport[]): void {
    for (const item of items) {
      this.analyzed.set(item.messageId, {
        messageId: item.messageId,
        analyzedAt: new Date(item.analyzedAt),
        briefSummary: item.briefSummary,
      });
    }
  }

  /**
   * Clear all tracked messages (mainly for testing)
   */
  clear(): void {
    this.analyzed.clear();
  }

  /**
   * Generate a brief, rule-based summary for a message.
   * Used to provide context for cross-batch pattern detection
   * without including full message content.
   */
  static generateBriefSummary(message: StreamMessage): string {
    if (isUserMessage(message)) {
      // For user messages with actual text input
      if (hasActualUserText(message)) {
        const text = getTextContent(message);
        const firstSentence = text.split(/[.!?\n]/)[0]?.trim() || '';

        if (firstSentence.length > 0) {
          // Truncate if too long
          const truncated =
            firstSentence.length > 100
              ? firstSentence.slice(0, 100) + '...'
              : firstSentence;
          return `User: "${truncated}"`;
        }
        return 'User provided input';
      }

      // Tool results (automated, not user text)
      return ''; // Skip tool results as they're not informative alone
    }

    if (isAssistantMessage(message)) {
      const toolUses = getToolUses(message);
      const text = getTextContent(message);

      // If assistant used tools
      if (toolUses.length > 0) {
        const toolNames = toolUses.map((t) => t.name).join(', ');
        return `Assistant used tools: ${toolNames}`;
      }

      // If assistant provided text
      if (text.trim().length > 0) {
        const firstClause = text.split(/[.!?\n,;]/)[0]?.trim() || '';

        if (firstClause.length > 0) {
          const truncated =
            firstClause.length > 80
              ? firstClause.slice(0, 80) + '...'
              : firstClause;
          return `Assistant: "${truncated}"`;
        }
        return 'Assistant responded';
      }

      return ''; // Thinking-only messages
    }

    // System messages
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        return 'Session initialized';
      }
      if (message.subtype === 'result') {
        return 'Session result received';
      }
    }

    return '';
  }
}
