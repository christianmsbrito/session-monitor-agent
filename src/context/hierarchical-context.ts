/**
 * HierarchicalContextManager - Multi-tier context management for long sessions
 *
 * Three tiers:
 * - Recent: Last N messages in full detail
 * - Hourly: Summarized content from earlier in session
 * - Session: High-level session summary
 */

import {
  type StreamMessage,
  isAssistantMessage,
  isUserMessage,
  getTextContent,
  getToolUses,
  getToolResults,
  hasUserFacingContent,
  hasActualUserText,
} from '../types/index.js';

export interface ContextConfig {
  /** Maximum messages to keep in full detail (default: 100) */
  maxRecentMessages: number;

  /** Trigger summarization after this many messages (default: 200) */
  summarizeAfter: number;

  /** Estimated max tokens for context window (default: 16000) */
  maxContextTokens: number;
}

const DEFAULT_CONFIG: ContextConfig = {
  maxRecentMessages: 100,  // Keep more messages in full detail
  summarizeAfter: 200,     // Summarize less frequently
  maxContextTokens: 16000, // Allow larger context
};

interface ContextTier {
  level: 'recent' | 'hourly' | 'session';
  messages: StreamMessage[];
  summary: string;
  tokenEstimate: number;
}

export class HierarchicalContextManager {
  private tiers: Map<string, ContextTier> = new Map();
  private messageCount: number = 0;
  private lastSummarization: number = 0;
  private config: ContextConfig;

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeTiers();
  }

  private initializeTiers(): void {
    this.tiers.set('recent', {
      level: 'recent',
      messages: [],
      summary: '',
      tokenEstimate: 0,
    });
    this.tiers.set('hourly', {
      level: 'hourly',
      messages: [],
      summary: '',
      tokenEstimate: 0,
    });
    this.tiers.set('session', {
      level: 'session',
      messages: [],
      summary: '',
      tokenEstimate: 0,
    });
  }

  /**
   * Add a new message to the context
   */
  addMessage(message: StreamMessage): void {
    const recent = this.tiers.get('recent')!;
    recent.messages.push(message);
    recent.tokenEstimate += this.estimateTokens(message);
    this.messageCount++;

    // Roll up to hourly if recent is full
    if (recent.messages.length > this.config.maxRecentMessages) {
      this.rollUpToHourly();
    }

    // Summarize hourly to session periodically
    if (this.messageCount - this.lastSummarization > this.config.summarizeAfter) {
      this.summarizeHourly();
    }
  }

  /**
   * Move oldest messages from recent to hourly tier
   */
  private rollUpToHourly(): void {
    const recent = this.tiers.get('recent')!;
    const hourly = this.tiers.get('hourly')!;

    // Move oldest half of recent to hourly
    const toMove = recent.messages.splice(
      0,
      Math.floor(recent.messages.length / 2)
    );
    hourly.messages.push(...toMove);

    // Recalculate token estimates
    recent.tokenEstimate = this.estimateTokensForMessages(recent.messages);
    hourly.tokenEstimate = this.estimateTokensForMessages(hourly.messages);
  }

  /**
   * Summarize hourly tier and roll up to session
   */
  private summarizeHourly(): void {
    const hourly = this.tiers.get('hourly')!;
    const session = this.tiers.get('session')!;

    if (hourly.messages.length === 0) return;

    // Generate summary of hourly messages
    const summaryContent = this.generateSummary(hourly.messages);

    // Append to session-level summary
    session.summary =
      (session.summary ? session.summary + '\n\n---\n\n' : '') + summaryContent;

    // Update hourly with summary, clear messages
    hourly.summary = summaryContent;
    hourly.messages = [];
    hourly.tokenEstimate = this.estimateTokens({ content: summaryContent });

    this.lastSummarization = this.messageCount;
  }

  /**
   * Get formatted context for the documentation agent
   */
  getContext(): string {
    const session = this.tiers.get('session')!;
    const hourly = this.tiers.get('hourly')!;
    const recent = this.tiers.get('recent')!;

    const parts: string[] = [];

    // Session-level summary (oldest, most compressed)
    if (session.summary) {
      parts.push(`## Session Context (Summary)\n\n${session.summary}`);
    }

    // Hourly summary (medium compression)
    if (hourly.summary) {
      parts.push(`## Recent Period Summary\n\n${hourly.summary}`);
    }

    // Recent messages (full detail)
    if (recent.messages.length > 0) {
      parts.push(
        `## Recent Exchanges\n\n${this.formatMessages(recent.messages)}`
      );
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * Get context for final session summary
   */
  getFinalSummary(): string {
    // Force summarize any remaining hourly messages
    this.summarizeHourly();

    return this.getContext() + '\n\n[SESSION ENDING - Generate final summary]';
  }

  /**
   * Generate a summary from a list of messages
   */
  private generateSummary(messages: StreamMessage[]): string {
    const keyContent: string[] = [];
    const toolsUsed = new Set<string>();
    const filesDiscussed = new Set<string>();

    for (const msg of messages) {
      if (isAssistantMessage(msg)) {
        const text = getTextContent(msg);

        // Extract key sentences (those with significant patterns)
        const sentences = text.split(/[.!?]+/);
        for (const sentence of sentences) {
          const trimmed = sentence.trim();
          if (this.isSignificantSentence(trimmed)) {
            keyContent.push(`- ${trimmed}`);
          }
        }

        // Track tools used
        const tools = getToolUses(msg);
        for (const tool of tools) {
          toolsUsed.add(tool.name);
        }
      }

      if (isUserMessage(msg)) {
        const results = getToolResults(msg);
        for (const result of results) {
          // Extract file paths from tool results
          // Handle both string content and array content (API format varies)
          // Type says string but runtime can be array - cast to handle both
          const rawContent = result.content as unknown;
          const contentStr = typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent.map((c: unknown) => {
                  if (typeof c === 'string') return c;
                  if (c && typeof c === 'object' && 'text' in c) return (c as { text: string }).text;
                  return '';
                }).join(' ')
              : String(rawContent);

          const fileMatches = contentStr.match(
            /(?:^|\s)([\w./\\-]+\.[a-z]+)/gi
          );
          if (fileMatches) {
            for (const match of fileMatches) {
              filesDiscussed.add(match.trim());
            }
          }
        }
      }
    }

    const summaryParts: string[] = [];

    if (keyContent.length > 0) {
      summaryParts.push('### Key Points\n' + keyContent.slice(0, 10).join('\n'));
    }

    if (toolsUsed.size > 0) {
      summaryParts.push(
        '### Tools Used\n' + Array.from(toolsUsed).join(', ')
      );
    }

    if (filesDiscussed.size > 0) {
      summaryParts.push(
        '### Files Discussed\n' +
          Array.from(filesDiscussed)
            .slice(0, 10)
            .map((f) => `- ${f}`)
            .join('\n')
      );
    }

    return summaryParts.join('\n\n') || 'No significant content in this period.';
  }

  /**
   * Check if a sentence is significant enough to include in summary
   */
  private isSignificantSentence(sentence: string): boolean {
    if (sentence.length < 20) return false;

    const significantPatterns = [
      /found/i,
      /fixed/i,
      /decided/i,
      /implemented/i,
      /discovered/i,
      /confirmed/i,
      /the (problem|issue|bug|solution)/i,
      /because/i,
      /therefore/i,
      /this means/i,
    ];

    return significantPatterns.some((p) => p.test(sentence));
  }

  /**
   * Format messages for inclusion in context
   * Only includes user-facing content (text and tool usage), not internal thinking
   *
   * COMPREHENSIVE - preserve ALL content without truncation
   * The doc agent will handle summarization if context gets too large
   */
  private formatMessages(messages: StreamMessage[]): string {
    return messages
      .map((m) => {
        if (isAssistantMessage(m)) {
          // Skip messages that are only internal thinking
          if (!hasUserFacingContent(m)) {
            return '';
          }
          const text = getTextContent(m);
          if (!text.trim()) {
            // Only has tool usage, no text output
            const tools = getToolUses(m);
            if (tools.length > 0) {
              return `**Assistant**: [Using tools: ${tools.map((t) => t.name).join(', ')}]`;
            }
            return '';
          }
          // Preserve assistant's text responses in full
          return `**Assistant**: ${text}`;
        }
        if (isUserMessage(m)) {
          // Check for actual user text input (not tool results)
          if (hasActualUserText(m)) {
            const text = getTextContent(m);
            // User prompts are highest priority - preserve fully
            return `**User**: ${text}`;
          }
          // Tool results (not actual user input) - preserve full content
          const results = getToolResults(m);
          if (results.length > 0) {
            const formattedResults = results
              .map((r) => {
                const status = r.is_error ? 'Error' : 'Result';
                return `[${status}: ${r.content}]`;
              })
              .join('\n');
            return `**Tool Results**:\n${formattedResults}`;
          }
          return '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Estimate token count for a message
   */
  private estimateTokens(item: unknown): number {
    const str = JSON.stringify(item);
    // Rough estimate: ~4 characters per token
    return Math.ceil(str.length / 4);
  }

  /**
   * Estimate total tokens for a list of messages
   */
  private estimateTokensForMessages(messages: StreamMessage[]): number {
    return messages.reduce((sum, m) => sum + this.estimateTokens(m), 0);
  }

  /**
   * Get current token estimate across all tiers
   */
  getTotalTokenEstimate(): number {
    let total = 0;
    for (const tier of this.tiers.values()) {
      total += tier.tokenEstimate;
      if (tier.summary) {
        total += this.estimateTokens({ content: tier.summary });
      }
    }
    return total;
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    return this.messageCount;
  }

  /**
   * Get statistics about context tiers
   */
  getStats(): {
    messageCount: number;
    recentMessages: number;
    hourlyMessages: number;
    hasSummary: boolean;
    totalTokens: number;
  } {
    return {
      messageCount: this.messageCount,
      recentMessages: this.tiers.get('recent')!.messages.length,
      hourlyMessages: this.tiers.get('hourly')!.messages.length,
      hasSummary: this.tiers.get('session')!.summary.length > 0,
      totalTokens: this.getTotalTokenEstimate(),
    };
  }

  /**
   * Reset the context manager
   */
  reset(): void {
    this.messageCount = 0;
    this.lastSummarization = 0;
    this.initializeTiers();
  }
}
