/**
 * Tests for SessionWatcher - Multi-Session Support
 *
 * These tests verify:
 * - Session creation and management with Map<sessionId, SessionState>
 * - Concurrent sessions with independent state
 * - Event routing to correct sessions
 * - SessionEnd only finalizes specific session
 * - Shutdown finalizes all active sessions
 * - Ghost session prevention
 * - Edge cases (missing transcript, reconnection after finalization)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock dependencies before importing SessionWatcher
vi.mock('../server/socket-server.js', () => ({
  SocketServer: vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getSocketPath: vi.fn().mockReturnValue('/tmp/test-socket.sock'),
      onHook: vi.fn((handler) => emitter.on('hook', handler)),
      on: vi.fn((event, handler) => emitter.on(event, handler)),
      emit: emitter.emit.bind(emitter),
      // Expose emitter for test control
      _emitter: emitter,
    };
  }),
}));

vi.mock('../server/transcript-reader.js', () => ({
  TranscriptReader: vi.fn().mockImplementation(() => ({
    readNewEntries: vi.fn().mockResolvedValue([]),
    toStreamMessages: vi.fn().mockReturnValue([]),
    resetPosition: vi.fn(),
  })),
}));

vi.mock('../interceptor/index.js', () => ({
  MessageRouter: vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return {
      enqueue: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      flushAll: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      getStats: vi.fn().mockReturnValue({
        queueLength: 0,
        droppedCount: 0,
        processedCount: 0,
        filteredCount: 0,
      }),
      onBatch: vi.fn((handler) => emitter.on('batch', handler)),
      onDropped: vi.fn((handler) => emitter.on('dropped', handler)),
      _emitter: emitter,
    };
  }),
}));

vi.mock('../documentation/index.js', () => ({
  DocumentationAgent: vi.fn().mockImplementation(() => ({
    processBatch: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({
      documentedCount: 0,
      duplicatesSkipped: 0,
      totalBatches: 0,
    }),
  })),
}));

// Import after mocks are set up
import { SessionWatcher, type WatcherConfig } from './session-watcher.js';
import { SocketServer } from '../server/socket-server.js';
import { TranscriptReader } from '../server/transcript-reader.js';
import { MessageRouter } from '../interceptor/index.js';
import { DocumentationAgent } from '../documentation/index.js';

// Helper to create a mock HookEvent
function createHookEvent(
  type: 'SessionStart' | 'SessionEnd' | 'PostToolUse' | 'Stop' | 'SubagentStop',
  sessionId: string,
  transcriptPath: string = `/tmp/transcripts/${sessionId}.jsonl`
) {
  return {
    type,
    sessionId,
    transcriptPath,
    timestamp: new Date().toISOString(),
  };
}

// Type helpers for mocked classes - using vi.mocked for cleaner typing
const MockedSocketServer = vi.mocked(SocketServer);
const MockedMessageRouter = vi.mocked(MessageRouter);
const MockedDocumentationAgent = vi.mocked(DocumentationAgent);
const MockedTranscriptReader = vi.mocked(TranscriptReader);

describe('SessionWatcher - Multi-Session Support', () => {
  const defaultConfig: WatcherConfig = {
    apiKey: 'test-api-key',
    docModel: 'claude-3-haiku-20240307',
    outputDir: '/tmp/test-docs',
    verbose: false,
    maxQueueSize: 1000,
    batchSize: 10,
    flushIntervalMs: 5000,
    maxRecentMessages: 50,
    summarizeAfter: 100,
  };

  let watcher: SessionWatcher;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSocketServer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    watcher = new SessionWatcher(defaultConfig);
    // Get reference to the mock socket server's emitter for triggering events
    mockSocketServer = MockedSocketServer.mock.results[0]?.value;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Session Creation', () => {
    it('should create a new session on SessionStart event', async () => {
      const event = createHookEvent('SessionStart', 'session-1');

      // Trigger the hook event
      mockSocketServer._emitter.emit('hook', event);

      // Wait for async processing
      await vi.waitFor(() => {
        const stats = watcher.getStats();
        expect(stats.totalSessions).toBe(1);
      });

      expect(watcher.getActiveSessionIds()).toContain('session-1');
    });

    it('should create session lazily on PostToolUse if SessionStart was missed', async () => {
      const event = createHookEvent('PostToolUse', 'session-lazy');

      mockSocketServer._emitter.emit('hook', event);

      await vi.waitFor(() => {
        expect(watcher.getActiveSessionIds()).toContain('session-lazy');
      });
    });

    it('should reuse existing session when same sessionId receives another event', async () => {
      const event1 = createHookEvent('SessionStart', 'session-reuse');
      const event2 = createHookEvent('PostToolUse', 'session-reuse');

      mockSocketServer._emitter.emit('hook', event1);
      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      mockSocketServer._emitter.emit('hook', event2);
      await vi.waitFor(() => {
        // Should still be 1 session, not 2
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      // DocumentationAgent should only be created once
      expect(MockedDocumentationAgent).toHaveBeenCalledTimes(1);
    });

    it('should create per-session MessageRouter', async () => {
      const event = createHookEvent('SessionStart', 'session-router');

      mockSocketServer._emitter.emit('hook', event);

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      // MessageRouter should have been created for this session
      expect(MockedMessageRouter).toHaveBeenCalledTimes(1);
    });
  });

  describe('Concurrent Sessions', () => {
    it('should support multiple concurrent sessions', async () => {
      const event1 = createHookEvent('SessionStart', 'session-a');
      const event2 = createHookEvent('SessionStart', 'session-b');
      const event3 = createHookEvent('SessionStart', 'session-c');

      mockSocketServer._emitter.emit('hook', event1);
      mockSocketServer._emitter.emit('hook', event2);
      mockSocketServer._emitter.emit('hook', event3);

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(3);
      });

      expect(watcher.getActiveSessionIds()).toEqual(
        expect.arrayContaining(['session-a', 'session-b', 'session-c'])
      );

      // Each session should have its own MessageRouter and DocumentationAgent
      expect(MockedMessageRouter).toHaveBeenCalledTimes(3);
      expect(MockedDocumentationAgent).toHaveBeenCalledTimes(3);
    });

    it('should create separate DocumentationAgent per session', async () => {
      const event1 = createHookEvent('SessionStart', 'session-doc-a');
      const event2 = createHookEvent('SessionStart', 'session-doc-b');

      mockSocketServer._emitter.emit('hook', event1);
      mockSocketServer._emitter.emit('hook', event2);

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(2);
      });

      // Verify different sessionIds were passed to DocumentationAgent
      const calls = MockedDocumentationAgent.mock.calls;
      expect(calls[0][0].sessionId).toBe('session-doc-a');
      expect(calls[1][0].sessionId).toBe('session-doc-b');
    });

    it('should handle interleaved events from multiple sessions', async () => {
      // Set up transcript reader to return messages
      const mockReader = MockedTranscriptReader.mock.results[0]?.value;
      mockReader.readNewEntries.mockResolvedValue([{ type: 'user', message: { content: 'test' } }]);
      mockReader.toStreamMessages.mockReturnValue([{ type: 'user', message: { content: [{ type: 'text', text: 'test' }] } }]);

      // Create two sessions
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'interleaved-a'));
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'interleaved-b'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(2);
      });

      // Interleaved events
      mockSocketServer._emitter.emit('hook', createHookEvent('PostToolUse', 'interleaved-a'));
      mockSocketServer._emitter.emit('hook', createHookEvent('PostToolUse', 'interleaved-b'));
      mockSocketServer._emitter.emit('hook', createHookEvent('Stop', 'interleaved-a'));
      mockSocketServer._emitter.emit('hook', createHookEvent('Stop', 'interleaved-b'));

      await vi.waitFor(() => {
        // Both sessions should still be active
        expect(watcher.getStats().activeSessions).toBe(2);
      });
    });
  });

  describe('SessionEnd Handling', () => {
    it('should only finalize the specific session that ended', async () => {
      // Create two sessions
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'end-test-a'));
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'end-test-b'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(2);
      });

      // End only session A
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionEnd', 'end-test-a'));

      await vi.waitFor(() => {
        expect(watcher.getStats().activeSessions).toBe(1);
      });

      // Session B should still be active
      expect(watcher.getActiveSessionIds()).toContain('end-test-b');
      expect(watcher.getActiveSessionIds()).not.toContain('end-test-a');

      // Total sessions should still be 2 (finalized sessions are kept for stats)
      expect(watcher.getStats().totalSessions).toBe(2);
    });

    it('should call finalize on the correct DocumentationAgent', async () => {
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'finalize-test'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      const mockDocAgent = MockedDocumentationAgent.mock.results[0]?.value;

      mockSocketServer._emitter.emit('hook', createHookEvent('SessionEnd', 'finalize-test'));

      await vi.waitFor(() => {
        expect(mockDocAgent.finalize).toHaveBeenCalledTimes(1);
      });
    });

    it('should flush and destroy router for ended session', async () => {
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'cleanup-test'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      const mockRouter = MockedMessageRouter.mock.results[0]?.value;

      mockSocketServer._emitter.emit('hook', createHookEvent('SessionEnd', 'cleanup-test'));

      await vi.waitFor(() => {
        expect(mockRouter.flushAll).toHaveBeenCalled();
        expect(mockRouter.destroy).toHaveBeenCalled();
      });
    });

    it('should not process further events for finalized session', async () => {
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'post-end-test'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      mockSocketServer._emitter.emit('hook', createHookEvent('SessionEnd', 'post-end-test'));

      await vi.waitFor(() => {
        expect(watcher.getStats().activeSessions).toBe(0);
      });

      // Try to send more events to the finalized session
      const mockReader = MockedTranscriptReader.mock.results[0]?.value;

      mockSocketServer._emitter.emit('hook', createHookEvent('PostToolUse', 'post-end-test'));

      // Give time for potential processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should not have read more entries (session is finalized)
      // The event should be ignored in handleHookEvent
      expect(watcher.getStats().activeSessions).toBe(0);
    });
  });

  describe('Ghost Session Prevention', () => {
    it('should ignore SessionEnd for unknown session', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Enable verbose to check the log message
      const verboseWatcher = new SessionWatcher({ ...defaultConfig, verbose: true });
      const verboseMockServer = MockedSocketServer.mock.results[MockedSocketServer.mock.results.length - 1]?.value;

      // Send SessionEnd for a session that was never started
      verboseMockServer._emitter.emit('hook', createHookEvent('SessionEnd', 'ghost-session'));

      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have logged the ignore message
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring SessionEnd for untracked session')
      );

      // No sessions should have been created
      expect(verboseWatcher.getStats().totalSessions).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should not create session on SessionEnd event', async () => {
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionEnd', 'never-existed'));

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(watcher.getStats().totalSessions).toBe(0);
      expect(MockedDocumentationAgent).not.toHaveBeenCalled();
    });
  });

  describe('Shutdown', () => {
    it('should finalize all active sessions on shutdown', async () => {
      // Mock process.exit to prevent actual exit
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      // Create multiple sessions
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'shutdown-a'));
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'shutdown-b'));
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'shutdown-c'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(3);
      });

      // Trigger shutdown
      await watcher.shutdown();

      // All DocumentationAgents should have been finalized
      const docAgentCalls = MockedDocumentationAgent.mock.results;
      for (const result of docAgentCalls) {
        expect(result.value.finalize).toHaveBeenCalled();
      }

      // All MessageRouters should have been flushed and destroyed
      const routerCalls = MockedMessageRouter.mock.results;
      for (const result of routerCalls) {
        expect(result.value.flushAll).toHaveBeenCalled();
        expect(result.value.destroy).toHaveBeenCalled();
      }

      exitSpy.mockRestore();
    });

    it('should not finalize already-finalized sessions on shutdown', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      // Create and end a session
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'already-ended'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      mockSocketServer._emitter.emit('hook', createHookEvent('SessionEnd', 'already-ended'));

      await vi.waitFor(() => {
        expect(watcher.getStats().activeSessions).toBe(0);
      });

      const mockDocAgent = MockedDocumentationAgent.mock.results[0]?.value;
      expect(mockDocAgent.finalize).toHaveBeenCalledTimes(1);

      // Shutdown should not finalize again
      await watcher.shutdown();

      expect(mockDocAgent.finalize).toHaveBeenCalledTimes(1);

      exitSpy.mockRestore();
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing transcript path gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const verboseWatcher = new SessionWatcher({ ...defaultConfig, verbose: true });
      const verboseMockServer = MockedSocketServer.mock.results[MockedSocketServer.mock.results.length - 1]?.value;

      // Event without transcript path
      const event = {
        type: 'PostToolUse' as const,
        sessionId: 'no-transcript',
        transcriptPath: '', // Empty transcript path
        timestamp: new Date().toISOString(),
      };

      verboseMockServer._emitter.emit('hook', event);

      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have logged an error
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to')
      );

      consoleSpy.mockRestore();
    });

    it('should handle transcript path changes for existing session', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const verboseWatcher = new SessionWatcher({ ...defaultConfig, verbose: true });
      const verboseMockServer = MockedSocketServer.mock.results[MockedSocketServer.mock.results.length - 1]?.value;

      // First event with one transcript path
      verboseMockServer._emitter.emit('hook', createHookEvent('SessionStart', 'path-change', '/tmp/path1.jsonl'));

      await vi.waitFor(() => {
        expect(verboseWatcher.getStats().totalSessions).toBe(1);
      });

      // Second event with different transcript path (unusual but should be handled)
      verboseMockServer._emitter.emit('hook', createHookEvent('PostToolUse', 'path-change', '/tmp/path2.jsonl'));

      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have logged the path change
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Transcript path changed')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Stats and Getters', () => {
    it('should return correct active session IDs', async () => {
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'active-1'));
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'active-2'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(2);
      });

      // End one session
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionEnd', 'active-1'));

      await vi.waitFor(() => {
        expect(watcher.getStats().activeSessions).toBe(1);
      });

      const activeIds = watcher.getActiveSessionIds();
      expect(activeIds).toEqual(['active-2']);
    });

    it('should return most recently active session for getCurrentClaudeSessionId', async () => {
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'recent-1'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'recent-2'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(2);
      });

      // The most recently created/active session should be returned
      const currentId = watcher.getCurrentClaudeSessionId();
      expect(currentId).toBe('recent-2');
    });

    it('should return null for getCurrentClaudeSessionId when no active sessions', async () => {
      expect(watcher.getCurrentClaudeSessionId()).toBeNull();
    });

    it('should include per-session stats in getStats', async () => {
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'stats-test'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      const stats = watcher.getStats();
      expect(stats.sessions).toHaveLength(1);
      expect(stats.sessions[0]).toMatchObject({
        sessionId: 'stats-test',
        finalized: false,
      });
      expect(stats.sessions[0].routerStats).toBeDefined();
      expect(stats.sessions[0].docStats).toBeDefined();
    });

    it('should track finalized state in session stats', async () => {
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'finalized-stat'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      mockSocketServer._emitter.emit('hook', createHookEvent('SessionEnd', 'finalized-stat'));

      await vi.waitFor(() => {
        expect(watcher.getStats().activeSessions).toBe(0);
      });

      const stats = watcher.getStats();
      expect(stats.sessions[0].finalized).toBe(true);
    });

    it('should return monitor session ID', () => {
      const monitorId = watcher.getMonitorSessionId();
      expect(monitorId).toMatch(/^monitor-\d{4}-\d{2}-\d{2}-/);
    });
  });

  describe('Event Routing', () => {
    it('should route messages to correct session router', async () => {
      const mockReader = MockedTranscriptReader.mock.results[0]?.value;
      mockReader.readNewEntries.mockResolvedValue([{ type: 'user', message: { content: 'test' } }]);
      mockReader.toStreamMessages.mockReturnValue([
        { type: 'user', message: { content: [{ type: 'text', text: 'msg for session' }] } },
      ]);

      // Create session
      mockSocketServer._emitter.emit('hook', createHookEvent('SessionStart', 'route-test'));

      await vi.waitFor(() => {
        expect(watcher.getStats().totalSessions).toBe(1);
      });

      const mockRouter = MockedMessageRouter.mock.results[0]?.value;

      // Trigger a PostToolUse which should process transcript
      mockSocketServer._emitter.emit('hook', createHookEvent('PostToolUse', 'route-test'));

      await vi.waitFor(() => {
        // Router should have received the message
        expect(mockRouter.enqueue).toHaveBeenCalled();
      });
    });
  });
});
