/**
 * Types for Claude Code NDJSON stream messages
 * Based on --output-format stream-json output
 */

import crypto from 'crypto';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextContent | ThinkingContent | ToolUseContent | ToolResultContent;

export interface MessageContent {
  content: ContentBlock[];
}

export interface SystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools?: string[];
  mcp_servers?: string[];
  model?: string;
}

export interface SystemResultMessage {
  type: 'system';
  subtype: 'result';
  duration_ms?: number;
  cost_usd?: number;
  is_error?: boolean;
  result?: string;
  session_id: string;
}

export interface AssistantMessage {
  type: 'assistant';
  message: MessageContent;
  session_id: string;
}

export interface UserMessage {
  type: 'user';
  message: MessageContent;
  session_id: string;
}

export type StreamMessage =
  | SystemInitMessage
  | SystemResultMessage
  | AssistantMessage
  | UserMessage;

export function isSystemResult(msg: StreamMessage): msg is SystemResultMessage {
  return msg.type === 'system' && (msg as SystemResultMessage).subtype === 'result';
}

export function isAssistantMessage(msg: StreamMessage): msg is AssistantMessage {
  return msg.type === 'assistant';
}

export function isUserMessage(msg: StreamMessage): msg is UserMessage {
  return msg.type === 'user';
}

/**
 * Check if a user message contains actual human text input
 * (as opposed to tool_result content which is automated)
 *
 * In Claude API, tool results are sent as "user" role messages,
 * but they're not actual user input - they're automated responses.
 *
 * Note: By the time messages reach here, the TranscriptReader has already
 * normalized string content to ContentBlock[] arrays.
 */
export function hasActualUserText(msg: UserMessage): boolean {
  const content = msg.message.content;

  // Check for text blocks (actual user input), not just tool_result blocks
  return content.some(
    (c): c is TextContent => c.type === 'text' && c.text.trim().length > 0
  );
}

/**
 * Get text content from a message, excluding thinking blocks
 */
export function getTextContent(msg: AssistantMessage | UserMessage): string {
  return msg.message.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join(' ');
}

/**
 * Check if a message contains only thinking content (no user-facing output)
 */
export function isThinkingOnlyMessage(msg: AssistantMessage): boolean {
  const content = msg.message.content;
  // If all content is thinking blocks, this is internal reasoning
  return content.length > 0 && content.every((c) => c.type === 'thinking');
}

/**
 * Check if a message has meaningful user-facing content
 * (text output or tool usage, not just thinking)
 */
export function hasUserFacingContent(msg: AssistantMessage): boolean {
  return msg.message.content.some(
    (c) => c.type === 'text' || c.type === 'tool_use'
  );
}

export function getToolResults(msg: UserMessage): ToolResultContent[] {
  return msg.message.content.filter(
    (c): c is ToolResultContent => c.type === 'tool_result'
  );
}

export function getToolUses(msg: AssistantMessage): ToolUseContent[] {
  return msg.message.content.filter(
    (c): c is ToolUseContent => c.type === 'tool_use'
  );
}

/**
 * Generate a deterministic message ID via content hashing.
 * Used to track which messages have been analyzed to prevent re-analysis.
 */
export function generateMessageId(message: StreamMessage): string {
  let contentForHash: Record<string, unknown>;

  if (message.type === 'user' || message.type === 'assistant') {
    contentForHash = {
      type: message.type,
      content: message.message.content,
    };
  } else if (message.type === 'system') {
    contentForHash = {
      type: message.type,
      subtype: message.subtype,
      session_id: message.session_id,
    };
  } else {
    contentForHash = { type: (message as StreamMessage).type };
  }

  const jsonStr = JSON.stringify(contentForHash);
  return crypto.createHash('sha256').update(jsonStr).digest('hex').slice(0, 16);
}
