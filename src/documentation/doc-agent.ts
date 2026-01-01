/**
 * DocumentationAgent - Orchestrates documentation using Claude Haiku
 *
 * Uses direct Anthropic SDK calls for simplicity and reliability.
 * Processes conversation batches and writes documentation when significant.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { StreamMessage, DocumentationEvent, EventType, ConfidenceLevel } from '../types/index.js';
import { EVENT_CONFIDENCE } from '../types/index.js';
import { HierarchicalContextManager } from '../context/index.js';
import { SignificanceDetector } from './significance-detector.js';
import { DeduplicationTracker } from './deduplication.js';
import { FileManager } from '../output/file-manager.js';
import { MarkdownFormatter } from '../output/markdown-formatter.js';

const DOCUMENTATION_SYSTEM_PROMPT = `You are a documentation agent observing a coding session. Your role is to create COMPREHENSIVE documentation that preserves the valuable details from the conversation.

## Your Goal

Create documentation that someone could read later to fully understand:
- What was requested and why
- What was discovered or learned (and whether it's confirmed or just analysis)
- What decisions were made and the reasoning
- What solutions were implemented

## CRITICAL: Distinguishing Confirmed vs Unconfirmed Information

You MUST distinguish between:
- **CONFIRMED**: Information the user explicitly verified/confirmed
- **UNCONFIRMED**: Agent's analysis/explanation that hasn't been verified by user

### User Confirmation Patterns (use CONFIRMED types):
- User says: "yes", "correct", "that's right", "exactly", "confirmed"
- User provides direct information about their system/requirements
- User explicitly validates the agent's understanding

### Agent Analysis Patterns (use UNCONFIRMED types):
- Agent explains code/system behavior
- Agent makes inferences or deductions
- Agent suggests approaches without user confirmation
- Agent summarizes findings

## Event Types:

### CONFIRMED Events (user verified):
1. **user_request**: What the user asked for (always confirmed)
2. **user_confirmed**: User explicitly confirmed agent's analysis as correct
3. **user_provided**: Information/context the user directly provided
4. **solution_verified**: Fix confirmed working (user tested it)
5. **requirement_clarified**: Requirements confirmed by user

### UNCONFIRMED Events (agent analysis - needs verification):
6. **agent_analysis**: Agent's understanding/explanation of code/system
7. **agent_suggestion**: Agent's recommendation or proposed approach
8. **bug_identified**: Root cause identified (until user confirms)
9. **decision_made**: Decision made (until implemented/tested)

### Special Events:
10. **correction**: Previous finding was WRONG - invalidates earlier documentation

## Response Format:

{
  "events": [
    {
      "eventType": "user_request",
      "title": "Brief descriptive title",
      "description": "COMPREHENSIVE description",
      "confidence": "confirmed",
      "context": "Conversation context",
      "evidence": "Direct quotes, code snippets",
      "reasoning": "Why this is significant",
      "relatedFiles": ["path/to/file.ts"],
      "tags": ["feature", "auth"]
    },
    {
      "eventType": "agent_analysis",
      "title": "How the notification system works",
      "description": "Agent's explanation of the system",
      "confidence": "unconfirmed",
      "evidence": "Code snippets analyzed",
      "reasoning": "Based on code analysis"
    },
    {
      "eventType": "user_confirmed",
      "title": "Notification flow confirmed",
      "description": "User confirmed that agent's analysis was correct",
      "confidence": "confirmed",
      "confirms": "How the notification system works",
      "evidence": "User said: 'yes, that's exactly how it works'"
    }
  ]
}

## IMPORTANT Guidelines:

1. **ALWAYS SET confidence**:
   - "confirmed" for user_request, user_confirmed, user_provided, solution_verified, requirement_clarified
   - "unconfirmed" for agent_analysis, agent_suggestion, bug_identified, decision_made

2. **BE COMPREHENSIVE** - Include full details, direct quotes, code snippets

3. **DETECT USER CONFIRMATIONS** - When user confirms agent's analysis:
   - Create a "user_confirmed" event
   - Reference what was confirmed in "confirms" field
   - Quote the user's confirmation in evidence

4. **DETECT CORRECTIONS** - If something previously documented is now found WRONG:
   - Create a "correction" event with confidence: "confirmed"
   - Include "invalidates", "reason", "correctInfo" fields

5. **USE EVIDENCE FIELD** - Include direct quotes, code snippets, error messages

6. If nothing significant, respond with: {"events": []}
7. Do NOT document the same thing twice
8. DO create corrections for anything in "already documented" that is now known to be wrong`;

// Helper to convert array to string (model sometimes returns arrays)
const stringOrArrayToString = z.union([
  z.string(),
  z.array(z.string()).transform((arr) => arr.join('\n')),
]).optional();

// Schema for validating agent responses
const EventResponseSchema = z.object({
  events: z.array(
    z.object({
      eventType: z.enum([
        // Confirmed events (user verified)
        'user_request',
        'user_confirmed',
        'user_provided',
        'solution_verified',
        'requirement_clarified',
        // Unconfirmed events (agent analysis)
        'agent_analysis',
        'agent_suggestion',
        'bug_identified',
        'decision_made',
        // Special
        'correction',
      ]),
      title: z.string(),
      description: z.string(),
      confidence: z.enum(['confirmed', 'unconfirmed']).optional(),  // Will be set based on eventType if not provided
      context: stringOrArrayToString,      // Conversation context leading to this
      evidence: stringOrArrayToString,      // Direct quotes, code, output
      reasoning: stringOrArrayToString,     // Why this decision/conclusion
      // Confirmation-specific fields
      confirms: stringOrArrayToString,      // What earlier analysis this confirms
      // Correction-specific fields
      invalidates: z.string().optional(),   // What earlier doc is being invalidated
      reason: z.string().optional(),        // Why the earlier doc was wrong
      correctInfo: z.string().optional(),   // What is actually correct
      relatedFiles: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    })
  ),
});

export interface DocAgentConfig {
  apiKey: string;
  model: string;
  outputDir: string;
  sessionId: string;
  verbose?: boolean;
}

export class DocumentationAgent {
  private client: Anthropic;
  private contextManager: HierarchicalContextManager;
  private detector: SignificanceDetector;
  private dedup: DeduplicationTracker;
  private fileManager: FileManager;
  private formatter: MarkdownFormatter;
  private processing: boolean = false;
  private pendingBatch: StreamMessage[] = [];
  private verbose: boolean;
  private sessionSubjectSet: boolean = false;

  constructor(private config: DocAgentConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.contextManager = new HierarchicalContextManager();
    this.detector = new SignificanceDetector();
    this.dedup = new DeduplicationTracker();
    this.fileManager = new FileManager(config.outputDir, config.sessionId);
    this.formatter = new MarkdownFormatter();
    this.verbose = config.verbose ?? false;
  }

  /**
   * Process a batch of messages
   */
  async processBatch(messages: StreamMessage[]): Promise<void> {
    // Add to pending if already processing
    if (this.processing) {
      this.pendingBatch.push(...messages);
      return;
    }

    this.processing = true;

    try {
      // Add messages to context manager
      for (const msg of messages) {
        this.contextManager.addMessage(msg);
      }

      // Check if any messages are potentially significant
      const significantChecks = messages.map((m) => ({
        type: m.type,
        significant: this.detector.quickCheck(m, this.verbose),
      }));

      const hasSignificant = significantChecks.some((c) => c.significant);

      if (this.verbose) {
        const summary = significantChecks.map((c) => `${c.type}:${c.significant ? 'Y' : 'N'}`).join(', ');
        console.error(`[doc-agent] Batch significance check: ${summary}`);
      }

      if (!hasSignificant) {
        if (this.verbose) {
          console.error('[doc-agent] No significant messages in batch');
        }
        return;
      }

      // Get current context
      const context = this.contextManager.getContext();

      // Get list of already documented items
      const documented = this.dedup.getDocumented();
      const documentedList =
        documented.length > 0
          ? `\n\nAlready documented (do not repeat):\n${documented.map((d) => `- ${d.title}`).join('\n')}`
          : '';

      // Query the documentation agent
      const events = await this.queryAgent(context + documentedList);

      // Process each event
      for (const event of events) {
        // Handle correction events specially
        if (event.eventType === 'correction') {
          await this.handleCorrection(event);
        } else {
          await this.documentEvent(event);
        }
      }

      // Update running session summary after each significant batch
      if (events.length > 0) {
        await this.updateRunningSummary();
      }
    } catch (error) {
      if (this.verbose) {
        console.error('[doc-agent] Error processing batch:', error);
      }
    } finally {
      this.processing = false;

      // Process any pending batches
      if (this.pendingBatch.length > 0) {
        const batch = this.pendingBatch;
        this.pendingBatch = [];
        await this.processBatch(batch);
      }
    }
  }

  /**
   * Update the running session summary
   * Called after each significant interaction to keep summary current
   */
  private async updateRunningSummary(): Promise<void> {
    try {
      const context = this.contextManager.getContext();
      const documented = this.dedup.getDocumented();

      // Generate a comprehensive running summary
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 4096,
        system: `You are creating a RUNNING SUMMARY of a coding session. This summary should be comprehensive and detailed.

Your summary should include:

1. **Session Overview**: What is being worked on in this session
2. **User Requests**: All requests the user has made (quote them)
3. **Key Findings**: Important discoveries, explanations, or insights
4. **Decisions Made**: Any decisions with their rationale
5. **Progress**: What has been accomplished so far
6. **Current Status**: Where things stand now

Be DETAILED. Include:
- Direct quotes from the user
- Specific file paths and code references
- Technical details that were discussed
- Any error messages or issues encountered

Format as clean markdown.`,
        messages: [
          {
            role: 'user',
            content: `Generate a comprehensive running summary for this coding session.

## Already Documented Events:
${documented.map((d) => `- [${d.eventType}] ${d.title}`).join('\n') || 'None yet'}

## Current Session Context:
${context}`,
          },
        ],
      });

      const textContent = response.content.find((c) => c.type === 'text');
      if (textContent && textContent.type === 'text') {
        await this.fileManager.updateRunningSummary(textContent.text);
        if (this.verbose) {
          console.error('[doc-agent] Updated running summary');
        }
      }
    } catch (error) {
      if (this.verbose) {
        console.error('[doc-agent] Error updating running summary:', error);
      }
    }
  }

  /**
   * Estimate token count for a string (rough estimate: ~4 chars per token)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Maximum context size in tokens before summarization is needed
   * Haiku has 200k context, but we want to leave room for response
   */
  private readonly MAX_CONTEXT_TOKENS = 50000;

  /**
   * Summarize large content blocks to preserve key information
   * Uses the model to intelligently compress while keeping critical details
   */
  private async summarizeLargeContent(content: string, contentType: string): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 4096,
        system: `You are summarizing ${contentType} content from a coding session.
Your goal is to PRESERVE all critical information while reducing length.

IMPORTANT - Always preserve:
- User requests and questions (quote them directly)
- Error messages and stack traces
- File paths and code references
- Key decisions and their rationale
- Technical findings and discoveries
- Code snippets that illustrate important points

Create a detailed summary that captures the essence without losing important details.
Format as clean markdown.`,
        messages: [
          {
            role: 'user',
            content: `Summarize this ${contentType} while preserving all critical details:\n\n${content}`,
          },
        ],
      });

      const textContent = response.content.find((c) => c.type === 'text');
      if (textContent && textContent.type === 'text') {
        return textContent.text;
      }
      return content; // Fallback to original if summarization fails
    } catch (error) {
      if (this.verbose) {
        console.error(`[doc-agent] Error summarizing ${contentType}:`, error);
      }
      return content; // Fallback to original
    }
  }

  /**
   * Prepare context for the documentation agent
   * Summarizes large content blocks instead of truncating
   */
  private async prepareContext(context: string): Promise<string> {
    const estimatedTokens = this.estimateTokens(context);

    if (estimatedTokens <= this.MAX_CONTEXT_TOKENS) {
      return context;
    }

    if (this.verbose) {
      console.error(`[doc-agent] Context too large (${estimatedTokens} tokens), summarizing...`);
    }

    // Split context into sections and summarize large ones
    const sections = context.split(/\n---\n/);
    const processedSections: string[] = [];

    for (const section of sections) {
      const sectionTokens = this.estimateTokens(section);

      if (sectionTokens > 10000) {
        // Summarize large sections
        const summarized = await this.summarizeLargeContent(section, 'conversation section');
        processedSections.push(summarized);
        if (this.verbose) {
          console.error(`[doc-agent] Summarized section: ${sectionTokens} -> ${this.estimateTokens(summarized)} tokens`);
        }
      } else {
        processedSections.push(section);
      }
    }

    return processedSections.join('\n---\n');
  }

  /**
   * Raw event from agent (confidence is optional, will be derived from eventType)
   */
  private deriveConfidence(eventType: EventType, rawConfidence?: 'confirmed' | 'unconfirmed'): ConfidenceLevel {
    if (rawConfidence) return rawConfidence;
    return EVENT_CONFIDENCE[eventType] || 'unconfirmed';
  }

  /**
   * Query Claude to analyze context and extract events
   */
  private async queryAgent(
    context: string
  ): Promise<Array<Omit<DocumentationEvent, 'timestamp' | 'sessionId' | 'confidence'> & { confidence?: ConfidenceLevel }>> {
    try {
      // Prepare context (summarize if too large)
      const preparedContext = await this.prepareContext(context);

      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 4096,  // Allow longer, more detailed responses
        system: DOCUMENTATION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Analyze this coding session context and identify any significant events to document. Be COMPREHENSIVE in your documentation - include full details, direct quotes, and thorough descriptions.

IMPORTANT: You MUST respond with valid JSON only. Start your response with { and end with }. No text before or after the JSON.

Context to analyze:
${preparedContext}`,
          },
        ],
      });

      // Extract text content
      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        return [];
      }

      const responseText = textContent.text.trim();

      // Try to find JSON in the response
      // First, try to match the entire response as JSON (if it starts with {)
      let jsonStr: string | null = null;

      if (responseText.startsWith('{')) {
        // Response starts with JSON, find the matching closing brace
        jsonStr = this.extractJsonObject(responseText);
      } else {
        // Look for JSON embedded in text (e.g., after explanation)
        // Find the position of a { that precedes "events" (the start of our JSON object)
        const eventsIndex = responseText.indexOf('"events"');
        if (eventsIndex !== -1) {
          // Find the opening brace before "events"
          const beforeEvents = responseText.slice(0, eventsIndex);
          const lastBraceIndex = beforeEvents.lastIndexOf('{');
          if (lastBraceIndex !== -1) {
            // Use proper brace-matching extraction from this position
            jsonStr = this.extractJsonObject(responseText.slice(lastBraceIndex));
          }
        }
      }

      if (!jsonStr) {
        if (this.verbose) {
          console.error('[doc-agent] No JSON found in response');
          console.error('[doc-agent] Response preview:', responseText.slice(0, 200));
        }
        return [];
      }

      // Sanitize JSON string - handle control characters in string values
      jsonStr = this.sanitizeJsonString(jsonStr);

      const parsed = JSON.parse(jsonStr);
      const validated = EventResponseSchema.parse(parsed);

      return validated.events;
    } catch (error) {
      if (this.verbose) {
        console.error('[doc-agent] Error querying agent:', error);
      }
      return [];
    }
  }

  /**
   * Document a single event
   */
  private async documentEvent(
    event: Omit<DocumentationEvent, 'timestamp' | 'sessionId' | 'confidence'> & { confidence?: ConfidenceLevel }
  ): Promise<void> {
    // Check for duplicates
    const hash = this.dedup.hash({
      eventType: event.eventType,
      title: event.title,
      description: event.description,
    });

    if (this.dedup.isDuplicate(hash)) {
      if (this.verbose) {
        console.error(`[doc-agent] Skipping duplicate: ${event.title}`);
      }
      return;
    }

    // Check for similar events
    if (this.dedup.isSimilar({ title: event.title, description: event.description })) {
      if (this.verbose) {
        console.error(`[doc-agent] Skipping similar: ${event.title}`);
      }
      return;
    }

    // Extract session subject from first user_request event
    if (!this.sessionSubjectSet && event.eventType === 'user_request') {
      await this.extractAndSetSessionSubject(event);
    }

    // Determine confidence level (use provided value or derive from event type)
    const confidence: ConfidenceLevel = event.confidence || EVENT_CONFIDENCE[event.eventType] || 'unconfirmed';

    // Create full event
    const fullEvent: DocumentationEvent = {
      ...event,
      confidence,
      timestamp: new Date(),
      sessionId: this.config.sessionId,
    };

    // Format and write
    const markdown = this.formatter.formatEvent(fullEvent);
    const eventPath = await this.fileManager.writeEvent(event.eventType, markdown);

    // Add brief entry to session document
    const brief = this.formatter.formatEventBrief(
      fullEvent,
      `./events/${eventPath.split('/').pop()}`
    );
    await this.fileManager.appendToSession(brief);

    // Mark as documented
    this.dedup.markDocumented(hash, {
      title: event.title,
      eventType: event.eventType,
    });

    if (this.verbose) {
      console.error(`[doc-agent] Documented: ${event.title}`);
    }
  }

  /**
   * Extract a concise session subject from the first user request
   */
  private async extractAndSetSessionSubject(
    event: Omit<DocumentationEvent, 'timestamp' | 'sessionId' | 'confidence'> & { confidence?: ConfidenceLevel }
  ): Promise<void> {
    try {
      // Use Claude to generate a concise subject from the user request
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 100,
        system: `Generate a very concise (2-5 words) subject/title for a coding session based on the user's request.
Examples:
- "Help me debug the auth system" -> "Debug Auth System"
- "Refactor the API endpoints to use REST" -> "Refactor API Endpoints"
- "Add dark mode to the app" -> "Add Dark Mode"
- "Fix the failing tests" -> "Fix Failing Tests"

Return ONLY the subject, nothing else. No quotes, no explanation.`,
        messages: [
          {
            role: 'user',
            content: `User request: ${event.title}\n\nDescription: ${event.description.slice(0, 500)}`,
          },
        ],
      });

      const textContent = response.content.find((c) => c.type === 'text');
      if (textContent && textContent.type === 'text') {
        const subject = textContent.text.trim();
        if (subject && subject.length > 0 && subject.length < 60) {
          await this.fileManager.setSessionSubject(subject);
          this.sessionSubjectSet = true;
          if (this.verbose) {
            console.error(`[doc-agent] Session subject set: "${subject}"`);
          }
        }
      }
    } catch (error) {
      if (this.verbose) {
        console.error('[doc-agent] Error extracting session subject:', error);
      }
      // Fall back to using the event title directly
      const fallbackSubject = event.title.slice(0, 50);
      await this.fileManager.setSessionSubject(fallbackSubject);
      this.sessionSubjectSet = true;
    }
  }

  /**
   * Handle a correction event - invalidate old documentation and record the correction
   */
  private async handleCorrection(
    event: Omit<DocumentationEvent, 'timestamp' | 'sessionId' | 'confidence'> & {
      confidence?: ConfidenceLevel;
      invalidates?: string;
      reason?: string;
      correctInfo?: string;
    }
  ): Promise<void> {
    const invalidatesText = event.invalidates || event.title;
    const reason = event.reason || event.description;

    if (this.verbose) {
      console.error(`[doc-agent] Processing correction: ${event.title}`);
      console.error(`[doc-agent] Invalidating documentation matching: "${invalidatesText}"`);
    }

    // Find and invalidate matching documentation
    const invalidated = this.dedup.invalidateMatching(invalidatesText, reason);

    if (invalidated.length > 0) {
      // Mark the invalidated events in the file system
      for (const inv of invalidated) {
        await this.fileManager.markEventInvalidated(inv.originalTitle, reason);
      }

      if (this.verbose) {
        console.error(`[doc-agent] Invalidated ${invalidated.length} event(s)`);
        for (const inv of invalidated) {
          console.error(`[doc-agent]   - ${inv.originalTitle}`);
        }
      }
    }

    // Document the correction itself (with the correct information)
    const correctionEvent: DocumentationEvent = {
      eventType: 'correction' as const,
      title: event.title,
      description: event.correctInfo || event.description,
      confidence: 'confirmed' as ConfidenceLevel,  // Corrections are always confirmed
      context: event.context,
      evidence: event.evidence,
      reasoning: `**What was wrong:** ${invalidatesText}\n\n**Why it was wrong:** ${reason}\n\n**Correct information:** ${event.correctInfo || event.description}`,
      relatedFiles: event.relatedFiles,
      tags: [...(event.tags || []), 'correction'],
      timestamp: new Date(),
      sessionId: this.config.sessionId,
    };

    // Format and write the correction
    const markdown = this.formatter.formatEvent(correctionEvent);
    const eventPath = await this.fileManager.writeEvent('correction', markdown);

    // Add brief entry to session document
    const brief = this.formatter.formatEventBrief(
      correctionEvent,
      `./events/${eventPath.split('/').pop()}`
    );
    await this.fileManager.appendToSession(brief);

    // Mark the correction as documented
    const hash = this.dedup.hash({
      eventType: 'correction',
      title: event.title,
      description: event.description,
    });
    this.dedup.markDocumented(hash, {
      title: event.title,
      eventType: 'correction',
    });

    if (this.verbose) {
      console.error(`[doc-agent] Recorded correction: ${event.title}`);
    }
  }

  /**
   * Finalize the session - generate final summary
   */
  async finalize(): Promise<void> {
    try {
      // Skip finalization if no events were documented and no messages were processed
      // This prevents hallucinating ghost sessions from empty context
      const documentedCount = this.dedup.getCount();
      const messageCount = this.contextManager.getMessageCount();

      if (documentedCount === 0 && messageCount === 0) {
        if (this.verbose) {
          console.error('[doc-agent] Skipping finalization - no content to document');
        }
        return;
      }

      const finalContext = this.contextManager.getFinalSummary();

      // If no subject was set yet, try to generate one from the context
      if (!this.sessionSubjectSet) {
        await this.generateSessionSubjectFromContext(finalContext);
      }

      // Update session.md header with the subject
      await this.fileManager.updateSessionHeader();

      // Generate session summary
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 2048,
        system: `You are summarizing a coding session. Generate a concise summary including:
1. What was accomplished
2. Key decisions made
3. Any unresolved issues
4. Files that were important

Format as markdown.`,
        messages: [
          {
            role: 'user',
            content: `Summarize this coding session:\n\n${finalContext}`,
          },
        ],
      });

      const textContent = response.content.find((c) => c.type === 'text');
      if (textContent && textContent.type === 'text') {
        await this.fileManager.writeSummary('session', textContent.text);
      }

      // Update index
      await this.fileManager.updateIndex({
        sessionId: this.config.sessionId,
        startTime: new Date(), // Would be tracked properly in real implementation
        status: 'completed',
        eventCount: this.dedup.getCount(),
      });

      if (this.verbose) {
        console.error('[doc-agent] Session finalized');
        const subject = this.fileManager.getSessionSubject();
        if (subject) {
          console.error(`[doc-agent] Session subject: "${subject}"`);
        }
      }
    } catch (error) {
      if (this.verbose) {
        console.error('[doc-agent] Error finalizing:', error);
      }
    }
  }

  /**
   * Generate a session subject from the overall context (fallback)
   */
  private async generateSessionSubjectFromContext(context: string): Promise<void> {
    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 100,
        system: `Generate a very concise (2-5 words) subject/title that describes what this coding session was about.
Examples: "Debug Auth System", "Refactor API", "Add Dark Mode", "Fix Tests"
Return ONLY the subject, nothing else.`,
        messages: [
          {
            role: 'user',
            content: `Session context:\n${context.slice(0, 2000)}`,
          },
        ],
      });

      const textContent = response.content.find((c) => c.type === 'text');
      if (textContent && textContent.type === 'text') {
        const subject = textContent.text.trim();
        if (subject && subject.length > 0 && subject.length < 60) {
          await this.fileManager.setSessionSubject(subject);
          this.sessionSubjectSet = true;
        }
      }
    } catch {
      // Ignore errors, subject is optional
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    documentedCount: number;
    contextStats: ReturnType<HierarchicalContextManager['getStats']>;
  } {
    return {
      documentedCount: this.dedup.getCount(),
      contextStats: this.contextManager.getStats(),
    };
  }

  /**
   * Extract a complete JSON object from text, handling nested braces
   */
  private extractJsonObject(text: string): string | null {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          return text.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  /**
   * Sanitize JSON string by properly escaping control characters within string values
   */
  private sanitizeJsonString(jsonStr: string): string {
    // Process the string character by character, tracking whether we're inside a JSON string
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < jsonStr.length; i++) {
      const char = jsonStr[i];
      const code = char.charCodeAt(0);

      if (escaped) {
        result += char;
        escaped = false;
        continue;
      }

      if (char === '\\' && inString) {
        result += char;
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        result += char;
        continue;
      }

      // If we're inside a string and encounter a control character, escape it
      if (inString && code < 32) {
        switch (char) {
          case '\n':
            result += '\\n';
            break;
          case '\r':
            result += '\\r';
            break;
          case '\t':
            result += '\\t';
            break;
          default:
            // Use unicode escape for other control characters
            result += '\\u' + code.toString(16).padStart(4, '0');
            break;
        }
      } else {
        result += char;
      }
    }

    return result;
  }
}
