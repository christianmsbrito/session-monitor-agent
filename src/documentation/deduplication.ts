/**
 * DeduplicationTracker - Tracks documented events to prevent duplicates
 * Also tracks invalidated events (corrections, contradictions)
 */

import * as crypto from 'crypto';
import type { DocumentedItem, EventType } from '../types/index.js';
import type { DatabaseManager } from '../database/db-manager.js';

export interface DeduplicationConfig {
  /** Similarity threshold for fuzzy matching (0-1, default: 0.7) */
  similarityThreshold?: number;

  /** Maximum items to keep in memory (default: 1000) */
  maxItems?: number;

  /** Optional database for persistence */
  db?: DatabaseManager;

  /** Session ID (required if db is provided) */
  sessionId?: string;
}

const DEFAULT_CONFIG = {
  similarityThreshold: 0.7,
  maxItems: 1000,
};

export interface InvalidatedEvent {
  hash: string;
  originalTitle: string;
  originalType: EventType;
  invalidatedAt: Date;
  reason: string;
  correctedBy?: string;  // Hash of the correcting event
}

export class DeduplicationTracker {
  private documented: Map<string, DocumentedItem> = new Map();
  private invalidated: Map<string, InvalidatedEvent> = new Map();
  private titleIndex: Map<string, string[]> = new Map(); // normalized title -> hashes
  private config: typeof DEFAULT_CONFIG;
  private db?: DatabaseManager;
  private sessionId?: string;

  constructor(config: DeduplicationConfig = {}) {
    this.config = {
      similarityThreshold: config.similarityThreshold ?? DEFAULT_CONFIG.similarityThreshold,
      maxItems: config.maxItems ?? DEFAULT_CONFIG.maxItems,
    };
    this.db = config.db;
    this.sessionId = config.sessionId;

    // Load existing hashes from DB if available
    if (this.db && this.sessionId) {
      this.loadFromDatabase();
    }
  }

  /**
   * Load existing hashes from database into memory for fast lookups
   */
  private loadFromDatabase(): void {
    if (!this.db || !this.sessionId) return;

    const hashes = this.db.getSessionDedupHashes(this.sessionId);
    for (const { hash } of hashes) {
      // We only need to track that the hash exists for duplicate detection
      // The full event details are in the events table
      this.documented.set(hash, {
        hash,
        title: '', // Not needed for duplicate check
        eventType: 'user_request' as EventType, // Placeholder
        timestamp: new Date(),
      });
    }
  }

  /**
   * Generate a hash for an event based on key content
   * IMPORTANT: Evidence field is the PRIMARY deduplication key when available,
   * as it contains the actual user quote which doesn't vary like AI-generated content.
   */
  hash(event: {
    eventType: string;
    title: string;
    description: string;
    evidence?: string;
  }): string {
    // If evidence exists, use it as the PRIMARY key (with eventType)
    // This prevents duplicates when Claude generates different titles for the same user quote
    if (event.evidence && event.evidence.trim().length > 0) {
      const normalized = [
        event.eventType,
        this.normalizeText(event.evidence.slice(0, 300)),
      ].join(':');
      return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    }

    // Fallback to title + description when no evidence available
    const normalized = [
      event.eventType,
      this.normalizeText(event.title),
      this.normalizeText(event.description.slice(0, 200)),
    ].join(':');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /**
   * Check if an exact duplicate exists
   */
  isDuplicate(hash: string): boolean {
    return this.documented.has(hash);
  }

  /**
   * Check if a similar event has been documented
   * Now properly compares evidence fields when available for more accurate matching
   */
  isSimilar(event: { title: string; description: string; evidence?: string }): boolean {
    const normalizedTitle = this.normalizeText(event.title);
    const words = normalizedTitle.split(/\s+/);

    // Check title index for potential matches
    for (const word of words) {
      const hashes = this.titleIndex.get(word) || [];
      for (const existingHash of hashes) {
        const existing = this.documented.get(existingHash);
        if (existing) {
          // If both have evidence, compare evidence directly (most reliable)
          if (event.evidence && existing.evidence) {
            const evidenceSimilarity = this.calculateSimilarity(
              event.evidence,
              existing.evidence
            );
            if (evidenceSimilarity > this.config.similarityThreshold) {
              return true;
            }
          }

          // Also check title similarity (symmetric comparison)
          const titleSimilarity = this.calculateSimilarity(
            event.title,
            existing.title
          );
          if (titleSimilarity > this.config.similarityThreshold) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Mark an event as documented
   * @param eventId - Optional database event ID for linking dedup hash to event
   */
  markDocumented(
    hash: string,
    event: { title: string; eventType: string; evidence?: string },
    eventId?: number
  ): void {
    // Evict oldest if at capacity
    if (this.documented.size >= this.config.maxItems) {
      const oldestHash = this.documented.keys().next().value;
      if (oldestHash) {
        this.removeFromIndex(oldestHash);
        this.documented.delete(oldestHash);
      }
    }

    const item: DocumentedItem = {
      hash,
      title: event.title,
      eventType: event.eventType as EventType,
      timestamp: new Date(),
      evidence: event.evidence,
    };

    this.documented.set(hash, item);
    this.addToIndex(hash, event.title);

    // Write to DB if available
    if (this.db && this.sessionId) {
      this.db.insertDedupHash(hash, this.sessionId, eventId);
    }
  }

  /**
   * Get list of documented events, optionally filtered by query
   */
  getDocumented(query?: string): DocumentedItem[] {
    const events = Array.from(this.documented.values());

    if (!query) {
      return events;
    }

    const lowerQuery = query.toLowerCase();
    return events.filter(
      (e) =>
        e.title.toLowerCase().includes(lowerQuery) ||
        e.eventType.includes(lowerQuery)
    );
  }

  /**
   * Get count of documented items
   */
  getCount(): number {
    return this.documented.size;
  }

  /**
   * Clear all tracked items
   */
  clear(): void {
    this.documented.clear();
    this.invalidated.clear();
    this.titleIndex.clear();
  }

  /**
   * Invalidate an event (mark as incorrect/outdated)
   * Returns true if the event was found and invalidated
   */
  invalidateEvent(
    hash: string,
    reason: string,
    correctedByHash?: string
  ): boolean {
    const item = this.documented.get(hash);
    if (!item) {
      return false;
    }

    // Move to invalidated
    const invalidatedItem: InvalidatedEvent = {
      hash,
      originalTitle: item.title,
      originalType: item.eventType,
      invalidatedAt: new Date(),
      reason,
      correctedBy: correctedByHash,
    };

    this.invalidated.set(hash, invalidatedItem);
    this.removeFromIndex(hash);
    this.documented.delete(hash);

    return true;
  }

  /**
   * Invalidate events matching a query (title or description contains)
   * Returns the invalidated events
   */
  invalidateMatching(
    query: string,
    reason: string
  ): InvalidatedEvent[] {
    const results: InvalidatedEvent[] = [];
    const lowerQuery = query.toLowerCase();

    for (const [hash, item] of this.documented) {
      if (item.title.toLowerCase().includes(lowerQuery)) {
        const invalidatedItem: InvalidatedEvent = {
          hash,
          originalTitle: item.title,
          originalType: item.eventType,
          invalidatedAt: new Date(),
          reason,
        };

        this.invalidated.set(hash, invalidatedItem);
        this.removeFromIndex(hash);
        this.documented.delete(hash);
        results.push(invalidatedItem);
      }
    }

    return results;
  }

  /**
   * Check if an event has been invalidated
   */
  isInvalidated(hash: string): boolean {
    return this.invalidated.has(hash);
  }

  /**
   * Get all invalidated events
   */
  getInvalidated(): InvalidatedEvent[] {
    return Array.from(this.invalidated.values());
  }

  /**
   * Find documented events that might contradict new information
   * Returns events that should potentially be invalidated
   */
  findContradictions(newInfo: {
    title: string;
    description: string;
    eventType: string;
  }): DocumentedItem[] {
    const candidates: DocumentedItem[] = [];
    const normalizedNew = this.normalizeText(newInfo.title + ' ' + newInfo.description);
    const newWords = new Set(normalizedNew.split(/\s+/));

    // Look for events with similar topics but potentially different conclusions
    for (const [, item] of this.documented) {
      const normalizedExisting = this.normalizeText(item.title);
      const existingWords = new Set(normalizedExisting.split(/\s+/));

      // Check for topic overlap
      const intersection = new Set([...newWords].filter((x) => existingWords.has(x)));
      const overlap = intersection.size / Math.min(newWords.size, existingWords.size);

      // If there's significant topic overlap, it might be a contradiction
      if (overlap > 0.3) {
        candidates.push(item);
      }
    }

    return candidates;
  }

  /**
   * Normalize text for comparison
   */
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // Remove punctuation
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Add an item to the title index
   */
  private addToIndex(hash: string, title: string): void {
    const words = this.normalizeText(title).split(/\s+/);
    for (const word of words) {
      if (word.length < 3) continue; // Skip short words
      const existing = this.titleIndex.get(word) || [];
      existing.push(hash);
      this.titleIndex.set(word, existing);
    }
  }

  /**
   * Remove an item from the title index
   */
  private removeFromIndex(hash: string): void {
    const item = this.documented.get(hash);
    if (!item) return;

    const words = this.normalizeText(item.title).split(/\s+/);
    for (const word of words) {
      const existing = this.titleIndex.get(word) || [];
      const filtered = existing.filter((h) => h !== hash);
      if (filtered.length === 0) {
        this.titleIndex.delete(word);
      } else {
        this.titleIndex.set(word, filtered);
      }
    }
  }

  /**
   * Calculate Jaccard similarity between two strings
   */
  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(this.normalizeText(a).split(/\s+/));
    const wordsB = new Set(this.normalizeText(b).split(/\s+/));

    const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  /**
   * Export documented items for persistence
   */
  export(): DocumentedItem[] {
    return Array.from(this.documented.values());
  }

  /**
   * Import documented items (e.g., from disk)
   */
  import(items: DocumentedItem[]): void {
    for (const item of items) {
      this.documented.set(item.hash, item);
      this.addToIndex(item.hash, item.title);
    }
  }
}
