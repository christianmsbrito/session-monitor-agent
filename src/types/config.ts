/**
 * Configuration types
 */

export interface Config {
  /** Output directory for documentation (default: .session-docs) */
  outputDir: string;

  /** Maximum queue size before dropping oldest (default: 1000) */
  maxQueueSize: number;

  /** Number of messages per batch (default: 10) */
  batchSize: number;

  /** Flush interval in milliseconds (default: 5000) */
  flushIntervalMs: number;

  /** Number of recent messages to keep in full detail (default: 50) */
  maxRecentMessages: number;

  /** Trigger summarization after this many messages (default: 100) */
  summarizeAfter: number;

  /** Anthropic API key for documentation agent */
  apiKey: string;

  /** Model to use for documentation agent (default: claude-3-haiku-20240307) */
  docModel: string;

  /** Enable verbose logging */
  verbose: boolean;
}

export const DEFAULT_CONFIG: Omit<Config, 'apiKey'> = {
  outputDir: '.session-docs',
  maxQueueSize: 1000,
  batchSize: 10,
  flushIntervalMs: 5000,
  maxRecentMessages: 50,
  summarizeAfter: 100,
  docModel: 'claude-3-haiku-20240307',
  verbose: false,
};
