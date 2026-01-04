/**
 * Types for documentation events
 *
 * Confidence levels:
 * - CONFIRMED (✓): User explicitly confirmed this is correct
 * - UNCONFIRMED (~): Agent's analysis, not yet verified by user
 *
 * Priority event types (user-facing):
 * - user_request: What the user asked for
 * - user_confirmed: User explicitly confirmed information as correct
 * - user_provided: Information/context the user directly provided
 *
 * Agent conclusions (need verification):
 * - agent_analysis: Agent's understanding/explanation (unconfirmed)
 * - agent_suggestion: Agent's recommendation (unconfirmed)
 *
 * Standard event types:
 * - decision_made: Architectural/implementation decisions
 * - bug_identified: Root causes found
 * - solution_verified: Fixes confirmed working
 * - requirement_clarified: Requirements confirmed
 *
 * Special types:
 * - correction: Invalidates previous incorrect documentation
 */

export type EventType =
  // User-provided/confirmed (highest confidence)
  | 'user_request'
  | 'user_confirmed'      // User explicitly said "yes", "correct", "that's right"
  | 'user_provided'       // Information the user directly gave
  // Agent conclusions (unconfirmed - need verification)
  | 'agent_analysis'      // Agent's understanding/explanation
  | 'agent_suggestion'    // Agent's recommendation
  // Standard types
  | 'bug_identified'
  | 'decision_made'
  | 'solution_verified'
  | 'requirement_clarified'
  // Special types
  | 'correction';

/**
 * Confidence level for documented events
 */
export type ConfidenceLevel = 'confirmed' | 'unconfirmed';

/**
 * Map event types to their confidence level
 */
export const EVENT_CONFIDENCE: Record<EventType, ConfidenceLevel> = {
  // Confirmed - user verified
  user_request: 'confirmed',
  user_confirmed: 'confirmed',
  user_provided: 'confirmed',
  solution_verified: 'confirmed',
  requirement_clarified: 'confirmed',
  // Unconfirmed - agent's analysis
  agent_analysis: 'unconfirmed',
  agent_suggestion: 'unconfirmed',
  bug_identified: 'unconfirmed',  // Until user confirms
  decision_made: 'unconfirmed',   // Until implemented/tested
  correction: 'confirmed',        // Corrections are explicit
};

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  // User-provided/confirmed
  user_request: '📝 User Request',
  user_confirmed: '✓ User Confirmed',
  user_provided: '💬 User Provided',
  // Agent conclusions
  agent_analysis: '🔍 Agent Analysis',
  agent_suggestion: '💡 Agent Suggestion',
  // Standard types
  bug_identified: '🐛 Bug Identified',
  decision_made: '⚖️ Decision Made',
  solution_verified: '✅ Solution Verified',
  requirement_clarified: '📋 Requirement Clarified',
  // Special types
  correction: '⚠️ Correction',
};

export interface DocumentationEvent {
  eventType: EventType;
  title: string;
  description: string;
  confidence: ConfidenceLevel;  // Whether this is confirmed by user or agent analysis
  context?: string;       // Conversation context leading to this event
  evidence?: string;      // Direct quotes, code snippets, outputs
  reasoning?: string;     // Why this decision/conclusion was made
  relatedFiles?: string[];
  tags?: string[];
  timestamp: Date;
  sessionId: string;
}

export interface SessionSummary {
  summaryType: 'hourly' | 'session';
  content: string;
  keyDecisions?: string[];
  unresolvedIssues?: string[];
  timestamp: Date;
  sessionId: string;
}

export interface DocumentedItem {
  hash: string;
  title: string;
  eventType: EventType;
  timestamp: Date;
  evidence?: string;  // Store evidence for similarity comparison
}

export interface SessionMetadata {
  sessionId: string;
  startTime: Date;
  endTime?: Date;
  status: 'active' | 'completed' | 'error';
  eventCount: number;
  model?: string;
}
