/**
 * Tests for SignificanceDetector
 *
 * Verifies that the detector correctly identifies significant messages
 * and properly distinguishes actual user input from tool results.
 */

import { describe, it, expect } from 'vitest';
import { SignificanceDetector } from './significance-detector.js';
import type {
  UserMessage,
  AssistantMessage,
  SystemResultMessage,
  ContentBlock,
} from '../types/index.js';

// Helper to create a UserMessage with content blocks
function createUserMessage(content: ContentBlock[]): UserMessage {
  return {
    type: 'user',
    message: { content },
    session_id: 'test-session',
  };
}

// Helper to create an AssistantMessage
function createAssistantMessage(content: ContentBlock[]): AssistantMessage {
  return {
    type: 'assistant',
    message: { content },
    session_id: 'test-session',
  };
}

// Helper to create a SystemResultMessage
function createSystemResult(): SystemResultMessage {
  return {
    type: 'system',
    subtype: 'result',
    session_id: 'test-session',
  };
}

describe('SignificanceDetector', () => {
  const detector = new SignificanceDetector();

  describe('quickCheck', () => {
    describe('actual user text input', () => {
      it('marks actual user text as significant', () => {
        const msg = createUserMessage([
          { type: 'text', text: 'Help me debug this issue' },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks user questions as significant', () => {
        const msg = createUserMessage([
          { type: 'text', text: 'Can you explain how this works?' },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks short confirmations as significant', () => {
        const msg = createUserMessage([
          { type: 'text', text: 'yes' },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks user requests with commands as significant', () => {
        const msg = createUserMessage([
          { type: 'text', text: 'please fix the bug in auth.ts' },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });
    });

    describe('tool results (not actual user input)', () => {
      it('does NOT mark basic tool results as significant', () => {
        const msg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'Found 4 files\nsrc/types/config.ts',
          },
        ]);
        // Tool results without significant patterns are not significant
        expect(detector.quickCheck(msg)).toBe(false);
      });

      it('does NOT mark file read results as significant', () => {
        const msg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: '     1→export function foo() {\n     2→  return "bar";\n     3→}',
          },
        ]);
        expect(detector.quickCheck(msg)).toBe(false);
      });

      it('marks tool results with test PASS as significant', () => {
        const msg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'Tests: 10 passed\nPASS src/foo.test.ts',
          },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks tool results with test FAIL as significant', () => {
        const msg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'Tests: 3 failed\nFAIL src/bar.test.ts',
          },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks tool results with git commits as significant', () => {
        const msg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: '[main abc1234] Fix authentication bug',
          },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks tool results with errors as significant', () => {
        const msg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'Error: Cannot read property x of undefined',
            is_error: true,
          },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks tool results with build status as significant', () => {
        const msg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'build succeeded\nCompiled 42 modules',
          },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });
    });

    describe('empty content', () => {
      it('does NOT mark empty user messages as significant', () => {
        const msg = createUserMessage([]);
        expect(detector.quickCheck(msg)).toBe(false);
      });

      it('does NOT mark whitespace-only messages as significant', () => {
        const msg = createUserMessage([
          { type: 'text', text: '   \n\t  ' },
        ]);
        expect(detector.quickCheck(msg)).toBe(false);
      });
    });

    describe('assistant messages', () => {
      it('marks substantial assistant responses as significant', () => {
        const msg = createAssistantMessage([
          {
            type: 'text',
            text: 'I found the issue. The bug is in the authentication module where the token validation fails due to an expired timestamp check.',
          },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks short assistant responses without patterns as NOT significant', () => {
        const msg = createAssistantMessage([
          { type: 'text', text: 'Got it.' },  // Short, doesn't match any significance patterns
        ]);
        // Short responses without significance patterns are not significant
        expect(detector.quickCheck(msg)).toBe(false);
      });

      it('marks thinking-only messages as NOT significant', () => {
        const msg = createAssistantMessage([
          { type: 'thinking', thinking: 'Let me analyze this code...' },
        ]);
        expect(detector.quickCheck(msg)).toBe(false);
      });

      it('marks assistant messages with conclusions as significant', () => {
        const msg = createAssistantMessage([
          { type: 'text', text: 'In summary, the fix requires updating the validation logic.' },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks assistant messages with bug findings as significant', () => {
        const msg = createAssistantMessage([
          { type: 'text', text: 'Found the bug in the error handling code.' },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });

      it('marks assistant messages with decisions as significant', () => {
        const msg = createAssistantMessage([
          { type: 'text', text: 'I decided to use the async/await pattern for better readability.' },
        ]);
        expect(detector.quickCheck(msg)).toBe(true);
      });
    });

    describe('system messages', () => {
      it('marks session end as significant', () => {
        const msg = createSystemResult();
        expect(detector.quickCheck(msg)).toBe(true);
      });
    });
  });

  describe('analyze', () => {
    describe('actual user input', () => {
      it('identifies user requests with high confidence', () => {
        const msg = createUserMessage([
          { type: 'text', text: 'Can you help me fix the authentication bug?' },
        ]);
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(true);
        expect(result.categories).toContain('userRequest');
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      });

      it('identifies user confirmations', () => {
        const msg = createUserMessage([
          { type: 'text', text: 'Yes, that looks correct' },
        ]);
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(true);
        expect(result.categories).toContain('userConfirmation');
      });

      it('identifies action requests', () => {
        const msg = createUserMessage([
          { type: 'text', text: 'Please implement the new feature' },
        ]);
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(true);
        expect(result.matchedPatterns.length).toBeGreaterThan(0);
      });
    });

    describe('tool results', () => {
      it('marks tool results without patterns as not significant', () => {
        const msg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'src/foo.ts\nsrc/bar.ts',
          },
        ]);
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(false);
        expect(result.confidence).toBe(0);
      });

      it('marks tool results with test outcomes as significant', () => {
        const msg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'All tests passed ✓',
          },
        ]);
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(true);
      });
    });

    describe('assistant messages', () => {
      it('detects bug-related patterns', () => {
        const msg = createAssistantMessage([
          {
            type: 'text',
            text: 'I found the bug in the authentication module. The root cause was a missing null check.',
          },
        ]);
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(true);
        expect(result.categories).toContain('bugRelated');
      });

      it('detects discovery patterns', () => {
        const msg = createAssistantMessage([
          {
            type: 'text',
            text: 'I discovered that the key file is located in src/auth/validator.ts',
          },
        ]);
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(true);
        expect(result.categories).toContain('discoveries');
      });

      it('detects decision patterns', () => {
        const msg = createAssistantMessage([
          {
            type: 'text',
            text: 'I recommend using the async approach because it handles errors better.',
          },
        ]);
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(true);
        expect(result.categories).toContain('decisions');
      });

      it('detects confirmation patterns', () => {
        const msg = createAssistantMessage([
          {
            type: 'text',
            text: 'All tests passed successfully. The build succeeded.',
          },
        ]);
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(true);
        expect(result.categories).toContain('confirmations');
      });
    });

    describe('system messages', () => {
      it('marks session end with full confidence', () => {
        const msg = createSystemResult();
        const result = detector.analyze(msg);
        expect(result.isSignificant).toBe(true);
        expect(result.confidence).toBe(1.0);
        expect(result.matchedPatterns).toContain('session_end');
      });
    });
  });

  describe('getCategories', () => {
    it('returns all significance categories', () => {
      const categories = detector.getCategories();
      expect(categories).toContain('userRequest');
      expect(categories).toContain('userConfirmation');
      expect(categories).toContain('modelConclusion');
      expect(categories).toContain('bugRelated');
      expect(categories).toContain('decisions');
      expect(categories).toContain('discoveries');
      expect(categories).toContain('confirmations');
      expect(categories).toContain('requirements');
    });
  });
});

describe('Real-world scenarios', () => {
  const detector = new SignificanceDetector();

  it('correctly handles a typical Claude Code interaction pattern', () => {
    // 1. User asks a question (should be significant)
    const userQuestion = createUserMessage([
      { type: 'text', text: 'Can you help me understand how the auth module works?' },
    ]);
    expect(detector.quickCheck(userQuestion)).toBe(true);
    expect(detector.analyze(userQuestion).categories).toContain('userRequest');

    // 2. Tool results from agent reading files (should NOT be significant as user input)
    const toolResult = createUserMessage([
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'export function authenticate(user: User) {\n  return validateToken(user.token);\n}',
      },
    ]);
    expect(detector.analyze(toolResult).isSignificant).toBe(false);

    // 3. Agent explains the code (significant if substantial)
    const agentExplanation = createAssistantMessage([
      {
        type: 'text',
        text: 'Based on my analysis, the authentication module works as follows:\n\n1. The authenticate function takes a User object\n2. It validates the token using validateToken\n3. This is where the bug might be occurring',
      },
    ]);
    expect(detector.quickCheck(agentExplanation)).toBe(true);

    // 4. User confirms understanding (significant)
    const userConfirmation = createUserMessage([
      { type: 'text', text: 'Yes, that makes sense. Please fix it.' },
    ]);
    expect(detector.quickCheck(userConfirmation)).toBe(true);
    expect(detector.analyze(userConfirmation).categories).toContain('userConfirmation');
  });

  it('distinguishes user interrupts from tool results', () => {
    // User interrupt message (actual user input)
    const interrupt = createUserMessage([
      { type: 'text', text: '[Request interrupted by user]' },
    ]);
    expect(detector.quickCheck(interrupt)).toBe(true);

    // Tool result with similar bracketed content
    const toolResult = createUserMessage([
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: '[main abc123] Commit message',
      },
    ]);
    // This is significant because of git commit pattern, but not as user input
    const result = detector.analyze(toolResult);
    expect(result.isSignificant).toBe(true);
  });
});
