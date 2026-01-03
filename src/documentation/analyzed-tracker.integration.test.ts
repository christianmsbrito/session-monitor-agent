/**
 * Integration test for analyzed-message tracking
 * Verifies the complete flow: doc-agent → tracker → context → filtering
 */

import { describe, it, expect } from 'vitest';
import { AnalyzedMessageTracker } from './analyzed-tracker.js';
import { HierarchicalContextManager } from '../context/hierarchical-context.js';
import { generateMessageId } from '../types/index.js';
import type { UserMessage, AssistantMessage } from '../types/index.js';

describe('Analyzed Message Tracking - Integration', () => {
  it('should filter analyzed messages from context correctly', () => {
    // Setup
    const tracker = new AnalyzedMessageTracker();
    const contextMgr = new HierarchicalContextManager();

    // Batch 1: Initial messages
    const userMsg1: UserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        content: [{ type: 'text', text: 'Can you help me debug this issue?' }],
      },
    };

    const assistantMsg1: AssistantMessage = {
      type: 'assistant',
      session_id: 'test-session',
      message: {
        content: [{ type: 'text', text: 'Sure, let me investigate the problem.' }],
      },
    };

    // Add to context manager
    contextMgr.addMessage(userMsg1);
    contextMgr.addMessage(assistantMsg1);

    // Simulate first batch analysis
    const msg1Id = generateMessageId(userMsg1);
    const msg2Id = generateMessageId(assistantMsg1);
    const msg1Summary = AnalyzedMessageTracker.generateBriefSummary(userMsg1);
    const msg2Summary = AnalyzedMessageTracker.generateBriefSummary(assistantMsg1);

    tracker.markAnalyzed(msg1Id, msg1Summary);
    tracker.markAnalyzed(msg2Id, msg2Summary);

    // Batch 2: New message
    const userMsg2: UserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        content: [{ type: 'text', text: 'Yes, that looks like the root cause!' }],
      },
    };

    contextMgr.addMessage(userMsg2);

    // Get context WITH filtering
    const contextWithFiltering = contextMgr.getContext({
      analyzedMessageIds: tracker.getAnalyzedIds(),
      analyzedSummaries: tracker.getAnalyzedSummaries(),
    });

    // Verify: Should have "Previously Analyzed" section with summaries
    expect(contextWithFiltering).toContain('Previously Analyzed');
    expect(contextWithFiltering).toContain('Can you help me debug this issue');
    // Note: Summary generation truncates at first clause, so "Sure, let me investigate." becomes "Sure"
    expect(contextWithFiltering).toContain('Sure');

    // Verify: Should have "New Messages" section with ONLY userMsg2
    expect(contextWithFiltering).toContain('New Messages to Analyze');
    expect(contextWithFiltering).toContain('Yes, that looks like the root cause!');

    // Verify: The "Previously Analyzed" section should NOT have full original text
    // (it should only have the brief summaries)
    const lines = contextWithFiltering.split('\n');
    const previouslyAnalyzedSection = lines
      .slice(
        lines.findIndex((l) => l.includes('Previously Analyzed')),
        lines.findIndex((l) => l.includes('New Messages'))
      )
      .join('\n');

    // The summaries should be brief (< 150 chars each)
    const summaryLines = previouslyAnalyzedSection
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(summaryLines.length).toBe(2);
    summaryLines.forEach((line) => {
      expect(line.length).toBeLessThan(150);
    });
  });

  it('should handle all messages already analyzed', () => {
    const tracker = new AnalyzedMessageTracker();
    const contextMgr = new HierarchicalContextManager();

    // Add messages
    const userMsg: UserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        content: [{ type: 'text', text: 'Test message' }],
      },
    };

    contextMgr.addMessage(userMsg);

    // Mark as analyzed
    const msgId = generateMessageId(userMsg);
    const summary = AnalyzedMessageTracker.generateBriefSummary(userMsg);
    tracker.markAnalyzed(msgId, summary);

    // Get context - all messages analyzed
    const context = contextMgr.getContext({
      analyzedMessageIds: tracker.getAnalyzedIds(),
      analyzedSummaries: tracker.getAnalyzedSummaries(),
    });

    // Should have "Previously Analyzed" but NOT "New Messages"
    expect(context).toContain('Previously Analyzed');
    expect(context).not.toContain('New Messages to Analyze');
  });

  it('should work without filtering (backward compatibility)', () => {
    const contextMgr = new HierarchicalContextManager();

    const userMsg: UserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        content: [{ type: 'text', text: 'Test message' }],
      },
    };

    contextMgr.addMessage(userMsg);

    // Get context WITHOUT filtering (legacy mode)
    const context = contextMgr.getContext();

    // Should have "Recent Exchanges" (not "New Messages")
    expect(context).toContain('Recent Exchanges');
    expect(context).not.toContain('Previously Analyzed');
    expect(context).not.toContain('New Messages to Analyze');
    expect(context).toContain('Test message');
  });

  it('should handle empty summaries correctly', () => {
    const tracker = new AnalyzedMessageTracker();
    const contextMgr = new HierarchicalContextManager();

    // Tool result message (generates empty summary)
    const userMsg: UserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }],
      },
    };

    contextMgr.addMessage(userMsg);

    const msgId = generateMessageId(userMsg);
    const summary = AnalyzedMessageTracker.generateBriefSummary(userMsg);
    expect(summary).toBe(''); // Empty summary

    tracker.markAnalyzed(msgId, summary);

    // Get summaries - should not include the empty one
    const summariesStr = tracker.getAnalyzedSummaries();
    expect(summariesStr).toBe(''); // No non-empty summaries
  });

  it('should correctly track multiple batches over time', () => {
    const tracker = new AnalyzedMessageTracker();
    const contextMgr = new HierarchicalContextManager();

    // Batch 1
    const batch1Msgs = [
      {
        type: 'user' as const,
        session_id: 'test',
        message: { content: [{ type: 'text' as const, text: 'Question 1' }] },
      },
      {
        type: 'assistant' as const,
        session_id: 'test',
        message: { content: [{ type: 'text' as const, text: 'Answer 1' }] },
      },
    ];

    batch1Msgs.forEach((m) => {
      contextMgr.addMessage(m);
      const id = generateMessageId(m);
      const summary = AnalyzedMessageTracker.generateBriefSummary(m);
      tracker.markAnalyzed(id, summary);
    });

    expect(tracker.getCount()).toBe(2);

    // Batch 2
    const batch2Msgs = [
      {
        type: 'user' as const,
        session_id: 'test',
        message: { content: [{ type: 'text' as const, text: 'Question 2' }] },
      },
    ];

    batch2Msgs.forEach((m) => contextMgr.addMessage(m));

    const context = contextMgr.getContext({
      analyzedMessageIds: tracker.getAnalyzedIds(),
      analyzedSummaries: tracker.getAnalyzedSummaries(),
    });

    // Should have both sections
    expect(context).toContain('Previously Analyzed');
    expect(context).toContain('New Messages to Analyze');

    // New message should be in full
    expect(context).toContain('Question 2');

    // Old messages should be in summary form
    expect(context).toContain('Question 1');
    expect(context).toContain('Answer 1');

    // Mark batch 2 as analyzed
    batch2Msgs.forEach((m) => {
      const id = generateMessageId(m);
      const summary = AnalyzedMessageTracker.generateBriefSummary(m);
      tracker.markAnalyzed(id, summary);
    });

    expect(tracker.getCount()).toBe(3);

    // Batch 3: No new messages
    const contextBatch3 = contextMgr.getContext({
      analyzedMessageIds: tracker.getAnalyzedIds(),
      analyzedSummaries: tracker.getAnalyzedSummaries(),
    });

    // All messages analyzed
    expect(contextBatch3).toContain('Previously Analyzed');
    expect(contextBatch3).not.toContain('New Messages to Analyze');
  });

  it('should generate deterministic IDs across calls', () => {
    const msg: UserMessage = {
      type: 'user',
      session_id: 'test',
      message: {
        content: [{ type: 'text', text: 'Deterministic test' }],
      },
    };

    const id1 = generateMessageId(msg);
    const id2 = generateMessageId(msg);
    const id3 = generateMessageId(msg);

    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it('should export and import state correctly', () => {
    const tracker1 = new AnalyzedMessageTracker();

    // Mark some messages
    tracker1.markAnalyzed('id-1', 'User: "Question 1"');
    tracker1.markAnalyzed('id-2', 'Assistant: "Answer 1"');
    tracker1.markAnalyzed('id-3', 'User: "Question 2"');

    // Export
    const exported = tracker1.export();
    expect(exported).toHaveLength(3);

    // Import into new tracker
    const tracker2 = new AnalyzedMessageTracker();
    tracker2.import(exported);

    // Verify state
    expect(tracker2.getCount()).toBe(3);
    expect(tracker2.isAnalyzed('id-1')).toBe(true);
    expect(tracker2.isAnalyzed('id-2')).toBe(true);
    expect(tracker2.isAnalyzed('id-3')).toBe(true);

    const summaries = tracker2.getAnalyzedSummaries();
    expect(summaries).toContain('Question 1');
    expect(summaries).toContain('Answer 1');
    expect(summaries).toContain('Question 2');
  });
});
