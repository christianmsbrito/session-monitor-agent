/**
 * SignificanceDetector - Pre-filters messages for potential documentation significance
 *
 * Prioritizes:
 * 1. User prompts (actual questions/requests from the user)
 * 2. Model text output (conclusions, explanations, summaries)
 * 3. Key findings and decisions
 */

import {
  type StreamMessage,
  isAssistantMessage,
  isUserMessage,
  isSystemResult,
  getTextContent,
  getToolResults,
  hasUserFacingContent,
} from '../types/index.js';

/**
 * Categories of significant events with detection patterns
 */
const SIGNIFICANCE_PATTERNS = {
  // User interaction patterns - HIGH priority
  userRequest: [
    /^(help|can you|could you|please|I need|I want|I'd like)/i,
    /\?$/,  // Questions
    /(fix|implement|create|add|update|change|modify|refactor|debug)/i,
  ],
  userConfirmation: [
    /^(yes|no|correct|right|exactly|that's it|perfect|good|ok|okay|cool)/i,
    /looks good/i,
    /that works/i,
    /approved/i,
  ],
  // Model output patterns - HIGH priority
  modelConclusion: [
    /in summary/i,
    /to summarize/i,
    /the (main|key) (point|issue|problem|finding)/i,
    /here's what/i,
    /I('ve| have) (found|discovered|implemented|fixed|completed)/i,
    /this (is|was) because/i,
    /the solution/i,
    /let me explain/i,
  ],
  // Bug-related patterns
  bugRelated: [
    /found the (bug|issue|problem)/i,
    /root cause (is|was|identified)/i,
    /the (bug|error|issue) (is|was) caused by/i,
    /fixed by/i,
    /this (fixes|resolves|addresses)/i,
    /the fix (is|was)/i,
    /bug was in/i,
    /error originated from/i,
  ],
  // Decision patterns
  decisions: [
    /decided to/i,
    /going with/i,
    /the approach (is|will be)/i,
    /architecture.*decision/i,
    /chose.*because/i,
    /trade-?off/i,
    /we('ll| will) use/i,
    /the best (option|approach|solution)/i,
    /recommend(ed|ing)?/i,
  ],
  // Discovery patterns
  discoveries: [
    /found (that|it|the)/i,
    /discovered/i,
    /turns out/i,
    /the (key|important|critical) (file|location|code|function) is/i,
    /located (in|at)/i,
    /the (problem|issue|bug) is (in|at)/i,
    /this is where/i,
    /the entry point is/i,
  ],
  // Confirmation patterns
  confirmations: [
    /confirmed/i,
    /verified/i,
    /test(s)? pass(ed|ing)?/i,
    /working (now|correctly|as expected)/i,
    /that proves/i,
    /hypothesis was (correct|wrong|confirmed)/i,
    /successfully/i,
    /build succeeded/i,
    /all (tests|checks) pass/i,
  ],
  // Requirement patterns
  requirements: [
    /requirement(s)? (is|are|clarified)/i,
    /user wants/i,
    /the goal is/i,
    /should (not )?include/i,
    /must (have|support|be)/i,
    /need(s)? to/i,
    /the spec(ification)? (says|requires)/i,
  ],
} as const;

/**
 * High-priority categories that should always be captured
 */
const HIGH_PRIORITY_CATEGORIES: SignificanceCategory[] = [
  'userRequest',
  'userConfirmation',
  'modelConclusion',
];

/**
 * Tool result patterns that indicate significance
 */
const TOOL_RESULT_PATTERNS = {
  testResults: [/PASS/i, /FAIL/i, /✓/, /✗/, /passed/i, /failed/i],
  gitOperations: [/commit/i, /\[.*\]/], // Git commit hashes in brackets
  buildResults: [/build (succeeded|failed)/i, /compiled/i, /error:/i],
};

export type SignificanceCategory = keyof typeof SIGNIFICANCE_PATTERNS;

export interface SignificanceResult {
  isSignificant: boolean;
  categories: SignificanceCategory[];
  confidence: number; // 0-1
  matchedPatterns: string[];
}

export class SignificanceDetector {
  private recentToolCalls: Map<string, number> = new Map();

  /**
   * Quick check if a message might be significant
   * Returns true if the message warrants deeper analysis
   */
  quickCheck(message: StreamMessage, verbose = false): boolean {
    // Session ending is always significant
    if (isSystemResult(message)) {
      return true;
    }

    // Check assistant messages for significant language
    if (isAssistantMessage(message)) {
      // Any assistant message with text output is potentially significant
      if (hasUserFacingContent(message)) {
        const text = getTextContent(message);
        if (verbose) {
          console.error(`[detector] Assistant message text length: ${text.length}`);
        }
        // If there's substantial text (not just brief acknowledgments), mark as significant
        if (text.length > 50) {
          return true;
        }
      }
      return this.checkContentSignificance(message).isSignificant;
    }

    // Check user messages
    if (isUserMessage(message)) {
      // User text input (actual prompts) is always significant
      const text = getTextContent(message);
      if (verbose) {
        console.error(`[detector] User message text: "${text.slice(0, 50)}..." (length: ${text.length})`);
      }
      if (text.trim().length > 0) {
        return true;  // User actually wrote something
      }
      // Also check tool results
      return this.checkToolResultSignificance(message);
    }

    return false;
  }

  /**
   * Detailed analysis of message significance
   */
  analyze(message: StreamMessage): SignificanceResult {
    if (isAssistantMessage(message)) {
      return this.checkContentSignificance(message);
    }

    if (isUserMessage(message)) {
      const text = getTextContent(message);
      const hasUserText = text.trim().length > 0;
      const hasSignificantTools = this.checkToolResultSignificance(message);

      // Analyze user text for patterns
      if (hasUserText) {
        const result = this.checkUserMessageSignificance(text);
        return {
          isSignificant: true,
          categories: result.categories,
          confidence: Math.max(0.8, result.confidence),  // User messages get high confidence
          matchedPatterns: result.matchedPatterns,
        };
      }

      return {
        isSignificant: hasSignificantTools,
        categories: [],
        confidence: hasSignificantTools ? 0.6 : 0,
        matchedPatterns: [],
      };
    }

    if (isSystemResult(message)) {
      return {
        isSignificant: true,
        categories: [],
        confidence: 1.0,
        matchedPatterns: ['session_end'],
      };
    }

    return {
      isSignificant: false,
      categories: [],
      confidence: 0,
      matchedPatterns: [],
    };
  }

  /**
   * Check user message text for patterns
   */
  private checkUserMessageSignificance(text: string): SignificanceResult {
    const categories: SignificanceCategory[] = [];
    const matchedPatterns: string[] = [];

    // Check userRequest and userConfirmation patterns
    for (const pattern of SIGNIFICANCE_PATTERNS.userRequest) {
      if (pattern.test(text)) {
        if (!categories.includes('userRequest')) {
          categories.push('userRequest');
        }
        matchedPatterns.push(pattern.source);
      }
    }

    for (const pattern of SIGNIFICANCE_PATTERNS.userConfirmation) {
      if (pattern.test(text)) {
        if (!categories.includes('userConfirmation')) {
          categories.push('userConfirmation');
        }
        matchedPatterns.push(pattern.source);
      }
    }

    return {
      isSignificant: true,  // User text is always significant
      categories,
      confidence: categories.length > 0 ? 0.9 : 0.7,
      matchedPatterns,
    };
  }

  /**
   * Check text content for significant patterns
   */
  private checkContentSignificance(
    message: StreamMessage & { type: 'assistant' }
  ): SignificanceResult {
    const textContent = getTextContent(message);
    const categories: SignificanceCategory[] = [];
    const matchedPatterns: string[] = [];
    let totalMatches = 0;

    for (const [category, patterns] of Object.entries(SIGNIFICANCE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(textContent)) {
          if (!categories.includes(category as SignificanceCategory)) {
            categories.push(category as SignificanceCategory);
          }
          matchedPatterns.push(pattern.source);
          totalMatches++;
        }
      }
    }

    // Calculate confidence based on number of matches and categories
    const confidence = Math.min(
      1.0,
      categories.length * 0.3 + totalMatches * 0.1
    );

    return {
      isSignificant: categories.length > 0,
      categories,
      confidence,
      matchedPatterns,
    };
  }

  /**
   * Check tool results for significant outcomes
   */
  private checkToolResultSignificance(
    message: StreamMessage & { type: 'user' }
  ): boolean {
    const toolResults = getToolResults(message);

    for (const result of toolResults) {
      const content = result.content || '';

      // Test results are significant
      for (const pattern of TOOL_RESULT_PATTERNS.testResults) {
        if (pattern.test(content)) {
          return true;
        }
      }

      // Git operations are significant
      for (const pattern of TOOL_RESULT_PATTERNS.gitOperations) {
        if (pattern.test(content)) {
          return true;
        }
      }

      // Build results are significant
      for (const pattern of TOOL_RESULT_PATTERNS.buildResults) {
        if (pattern.test(content)) {
          return true;
        }
      }

      // Error results are often significant
      if (result.is_error) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get all pattern categories
   */
  getCategories(): SignificanceCategory[] {
    return Object.keys(SIGNIFICANCE_PATTERNS) as SignificanceCategory[];
  }
}
