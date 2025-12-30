/**
 * Tests for stream-messages utilities
 *
 * Focus on hasActualUserText which distinguishes actual human input
 * from automated tool results in "user" type messages.
 */

import { describe, it, expect } from 'vitest';
import {
  type UserMessage,
  type AssistantMessage,
  type ContentBlock,
  hasActualUserText,
  isUserMessage,
  isAssistantMessage,
  getTextContent,
  getToolResults,
  hasUserFacingContent,
} from './stream-messages.js';

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

describe('hasActualUserText', () => {
  describe('returns true for actual human text input', () => {
    it('identifies simple text content as actual user input', () => {
      const msg = createUserMessage([
        { type: 'text', text: 'Help me debug this issue' },
      ]);
      expect(hasActualUserText(msg)).toBe(true);
    });

    it('identifies text with questions as actual user input', () => {
      const msg = createUserMessage([
        { type: 'text', text: 'Can you explain how this works?' },
      ]);
      expect(hasActualUserText(msg)).toBe(true);
    });

    it('identifies multi-line text as actual user input', () => {
      const msg = createUserMessage([
        { type: 'text', text: 'First line\nSecond line\nThird line' },
      ]);
      expect(hasActualUserText(msg)).toBe(true);
    });

    it('handles messages with both text and tool_result content', () => {
      // This is unusual but possible - user text mixed with tool results
      const msg = createUserMessage([
        { type: 'text', text: 'Here is my question' },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'some result' },
      ]);
      expect(hasActualUserText(msg)).toBe(true);
    });
  });

  describe('returns false for tool results (not actual user input)', () => {
    it('identifies tool_result content as NOT actual user input', () => {
      const msg = createUserMessage([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01UuJXPMGbwTbpTtDcXSCSGp',
          content: 'Found 4 files\nsrc/types/config.ts\nsrc/output/file-manager.ts',
        },
      ]);
      expect(hasActualUserText(msg)).toBe(false);
    });

    it('identifies multiple tool results as NOT actual user input', () => {
      const msg = createUserMessage([
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'File read successfully' },
        { type: 'tool_result', tool_use_id: 'tool-2', content: 'Command executed' },
      ]);
      expect(hasActualUserText(msg)).toBe(false);
    });

    it('identifies error tool results as NOT actual user input', () => {
      const msg = createUserMessage([
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'Error: File not found',
          is_error: true,
        },
      ]);
      expect(hasActualUserText(msg)).toBe(false);
    });
  });

  describe('returns false for empty or whitespace-only content', () => {
    it('returns false for empty content array', () => {
      const msg = createUserMessage([]);
      expect(hasActualUserText(msg)).toBe(false);
    });

    it('returns false for text with only whitespace', () => {
      const msg = createUserMessage([{ type: 'text', text: '   ' }]);
      expect(hasActualUserText(msg)).toBe(false);
    });

    it('returns false for text with only newlines', () => {
      const msg = createUserMessage([{ type: 'text', text: '\n\n\n' }]);
      expect(hasActualUserText(msg)).toBe(false);
    });

    it('returns false for text with only tabs and spaces', () => {
      const msg = createUserMessage([{ type: 'text', text: '\t\t  \t' }]);
      expect(hasActualUserText(msg)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns true for very short but valid text', () => {
      const msg = createUserMessage([{ type: 'text', text: 'ok' }]);
      expect(hasActualUserText(msg)).toBe(true);
    });

    it('returns true for single character text', () => {
      const msg = createUserMessage([{ type: 'text', text: 'y' }]);
      expect(hasActualUserText(msg)).toBe(true);
    });

    it('returns true for emoji-only text', () => {
      const msg = createUserMessage([{ type: 'text', text: '👍' }]);
      expect(hasActualUserText(msg)).toBe(true);
    });

    it('returns true when first content is tool_result but later has text', () => {
      const msg = createUserMessage([
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
        { type: 'text', text: 'User follow-up question' },
      ]);
      expect(hasActualUserText(msg)).toBe(true);
    });
  });
});

describe('isUserMessage', () => {
  it('returns true for user type messages', () => {
    const msg = createUserMessage([{ type: 'text', text: 'test' }]);
    expect(isUserMessage(msg)).toBe(true);
  });

  it('returns false for assistant type messages', () => {
    const msg = createAssistantMessage([{ type: 'text', text: 'response' }]);
    expect(isUserMessage(msg)).toBe(false);
  });
});

describe('isAssistantMessage', () => {
  it('returns true for assistant type messages', () => {
    const msg = createAssistantMessage([{ type: 'text', text: 'response' }]);
    expect(isAssistantMessage(msg)).toBe(true);
  });

  it('returns false for user type messages', () => {
    const msg = createUserMessage([{ type: 'text', text: 'test' }]);
    expect(isAssistantMessage(msg)).toBe(false);
  });
});

describe('getTextContent', () => {
  it('extracts text from user messages', () => {
    const msg = createUserMessage([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ]);
    expect(getTextContent(msg)).toBe('Hello World');
  });

  it('extracts text from assistant messages', () => {
    const msg = createAssistantMessage([
      { type: 'text', text: 'Here is the answer' },
    ]);
    expect(getTextContent(msg)).toBe('Here is the answer');
  });

  it('ignores thinking content', () => {
    const msg = createAssistantMessage([
      { type: 'thinking', thinking: 'Let me think...' },
      { type: 'text', text: 'The answer is 42' },
    ]);
    expect(getTextContent(msg)).toBe('The answer is 42');
  });

  it('ignores tool_use content', () => {
    const msg = createAssistantMessage([
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/test' } },
      { type: 'text', text: 'I read the file' },
    ]);
    expect(getTextContent(msg)).toBe('I read the file');
  });

  it('returns empty string when no text content', () => {
    const msg = createUserMessage([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
    ]);
    expect(getTextContent(msg)).toBe('');
  });
});

describe('getToolResults', () => {
  it('extracts tool results from user messages', () => {
    const msg = createUserMessage([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result 1' },
      { type: 'tool_result', tool_use_id: 'tool-2', content: 'result 2' },
    ]);
    const results = getToolResults(msg);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('result 1');
    expect(results[1].content).toBe('result 2');
  });

  it('returns empty array when no tool results', () => {
    const msg = createUserMessage([
      { type: 'text', text: 'Just text' },
    ]);
    expect(getToolResults(msg)).toHaveLength(0);
  });
});

describe('hasUserFacingContent', () => {
  it('returns true for messages with text', () => {
    const msg = createAssistantMessage([
      { type: 'text', text: 'Hello' },
    ]);
    expect(hasUserFacingContent(msg)).toBe(true);
  });

  it('returns true for messages with tool_use', () => {
    const msg = createAssistantMessage([
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} },
    ]);
    expect(hasUserFacingContent(msg)).toBe(true);
  });

  it('returns false for thinking-only messages', () => {
    const msg = createAssistantMessage([
      { type: 'thinking', thinking: 'Processing...' },
    ]);
    expect(hasUserFacingContent(msg)).toBe(false);
  });
});
