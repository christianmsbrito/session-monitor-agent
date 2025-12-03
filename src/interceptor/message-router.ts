/**
 * MessageRouter - Queue with backpressure control for documentation pipeline
 */

import { EventEmitter } from 'events';
import {
  type StreamMessage,
  isAssistantMessage,
  isThinkingOnlyMessage,
  hasUserFacingContent,
} from '../types/index.js';

export interface MessageRouterConfig {
  /** Maximum queue size before dropping oldest (default: 1000) */
  maxQueueSize: number;

  /** Number of messages per batch (default: 10) */
  batchSize: number;

  /** Flush interval in milliseconds (default: 5000) */
  flushIntervalMs: number;
}

export const DEFAULT_ROUTER_CONFIG: MessageRouterConfig = {
  maxQueueSize: 1000,
  batchSize: 10,
  flushIntervalMs: 5000,
};

export class MessageRouter extends EventEmitter {
  private queue: StreamMessage[] = [];
  private processing: boolean = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private droppedCount: number = 0;
  private processedCount: number = 0;
  private filteredCount: number = 0; // Thinking-only messages filtered out

  constructor(private config: MessageRouterConfig = DEFAULT_ROUTER_CONFIG) {
    super();
    this.startFlushTimer();
  }

  /**
   * Add a message to the queue
   * Filters out thinking-only messages (internal reasoning)
   */
  enqueue(message: StreamMessage): void {
    // Filter out thinking-only assistant messages
    // We only want to document user-facing content
    if (isAssistantMessage(message)) {
      if (isThinkingOnlyMessage(message) || !hasUserFacingContent(message)) {
        this.filteredCount++;
        return; // Skip internal reasoning
      }
    }

    // Drop oldest messages if queue is full (graceful degradation)
    if (this.queue.length >= this.config.maxQueueSize) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.droppedCount++;
        this.emit('dropped', dropped);
      }
    }

    this.queue.push(message);

    // Batch threshold reached - flush immediately
    if (this.queue.length >= this.config.batchSize && !this.processing) {
      this.flush();
    }
  }

  /**
   * Force flush all queued messages
   */
  async flush(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    try {
      const batch = this.queue.splice(0, this.config.batchSize);
      this.processedCount += batch.length;
      this.emit('batch', batch);
      this.emit('flushed', batch.length);
    } finally {
      this.processing = false;

      // If there are more messages, schedule another flush
      if (this.queue.length >= this.config.batchSize) {
        setImmediate(() => this.flush());
      }
    }
  }

  /**
   * Flush all remaining messages (for shutdown)
   */
  async flushAll(): Promise<void> {
    while (this.queue.length > 0) {
      await this.flush();
      // Small delay to allow processing
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.queue.length > 0 && !this.processing) {
        this.flush();
      }
    }, this.config.flushIntervalMs);

    // Don't keep process alive just for this timer
    this.flushTimer.unref();
  }

  /**
   * Stop the router and clean up
   */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Get current queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Get statistics
   */
  getStats(): {
    queueLength: number;
    droppedCount: number;
    processedCount: number;
    filteredCount: number;
  } {
    return {
      queueLength: this.queue.length,
      droppedCount: this.droppedCount,
      processedCount: this.processedCount,
      filteredCount: this.filteredCount,
    };
  }

  /**
   * Type-safe batch listener
   */
  onBatch(handler: (messages: StreamMessage[]) => void | Promise<void>): void {
    this.on('batch', handler);
  }

  /**
   * Type-safe dropped listener
   */
  onDropped(handler: (message: StreamMessage) => void): void {
    this.on('dropped', handler);
  }
}
