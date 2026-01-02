/**
 * SessionWatcher - Main watcher that observes Claude Code sessions via hooks
 *
 * Listens on a Unix socket for hook notifications, then reads the transcript
 * file to process new messages.
 */

import type { Config } from '../types/index.js';
import { SocketServer, type HookEvent } from '../server/socket-server.js';
import { TranscriptReader } from '../server/transcript-reader.js';
import { MessageRouter } from '../interceptor/index.js';
import { DocumentationAgent } from '../documentation/index.js';

export interface WatcherConfig extends Config {
  /** Custom socket path (optional) */
  socketPath?: string;
}

/**
 * State for a single Claude Code session
 */
interface SessionState {
  /** Claude Code session ID */
  sessionId: string;

  /** Path to this session's transcript file */
  transcriptPath: string;

  /** MessageRouter for this session's message batching */
  router: MessageRouter;

  /** DocumentationAgent for this session */
  docAgent: DocumentationAgent;

  /** When this session was first seen */
  createdAt: Date;

  /** When this session was last active */
  lastActivityAt: Date;

  /** Whether this session has been finalized */
  finalized: boolean;
}

export class SessionWatcher {
  private socketServer: SocketServer;
  private transcriptReader: TranscriptReader;
  /** Map of sessionId -> SessionState for all active sessions */
  private sessions: Map<string, SessionState> = new Map();
  private monitorSessionId: string;
  private verbose: boolean;
  private messageCount: number = 0;
  private hookCount: number = 0;

  constructor(private config: WatcherConfig) {
    this.monitorSessionId = this.generateSessionId();
    this.verbose = config.verbose;

    // Initialize components
    this.socketServer = new SocketServer({
      socketPath: config.socketPath,
    });

    this.transcriptReader = new TranscriptReader();

    // Sessions are created lazily when events arrive
    // Each session gets its own MessageRouter + DocumentationAgent

    // Wire up the pipeline
    this.setupPipeline();
  }

  private setupPipeline(): void {
    // Handle hook events from socket server
    this.socketServer.onHook(async (event) => {
      this.hookCount++;
      await this.handleHookEvent(event);
    });

    // Socket server events
    this.socketServer.on('started', ({ socketPath }) => {
      if (this.verbose) {
        console.error(`[watcher] Socket server listening: ${socketPath}`);
      }
    });

    this.socketServer.on('error', (error) => {
      console.error(`[watcher] Socket error: ${error.message}`);
    });

    this.socketServer.on('parseError', (error, line) => {
      if (this.verbose) {
        console.error(`[watcher] Parse error: ${error}`);
        console.error(`[watcher] Line: ${line.slice(0, 80)}...`);
      }
    });

    // Note: Per-session router->docAgent wiring happens in createSession()
  }

  /**
   * Create a new session with its own router and doc agent
   */
  private createSession(sessionId: string, transcriptPath: string): SessionState {
    // Create per-session router
    const router = new MessageRouter({
      maxQueueSize: this.config.maxQueueSize,
      batchSize: this.config.batchSize,
      flushIntervalMs: this.config.flushIntervalMs,
    });

    // Create per-session doc agent
    const docAgent = new DocumentationAgent({
      apiKey: this.config.apiKey,
      model: this.config.docModel,
      outputDir: this.config.outputDir,
      sessionId: sessionId,
      verbose: this.config.verbose,
    });

    // Wire this session's router to its doc agent
    router.onBatch(async (batch) => {
      try {
        await docAgent.processBatch(batch);
      } catch (error) {
        if (this.verbose) {
          console.error(`[watcher] Error processing batch for session ${sessionId}:`, error);
        }
      }
    });

    // Log dropped messages for this session
    if (this.verbose) {
      router.onDropped(() => {
        console.error(`[watcher] Message dropped (session: ${sessionId})`);
      });
    }

    const now = new Date();
    const session: SessionState = {
      sessionId,
      transcriptPath,
      router,
      docAgent,
      createdAt: now,
      lastActivityAt: now,
      finalized: false,
    };

    this.sessions.set(sessionId, session);

    // Reset transcript reader position for new session
    this.transcriptReader.resetPosition(transcriptPath);

    if (this.verbose) {
      console.error(`[watcher] Created session: ${sessionId}`);
      console.error(`[watcher] Transcript: ${transcriptPath}`);
      console.error(`[watcher] Active sessions: ${this.sessions.size}`);
    }

    return session;
  }

  /**
   * Handle a hook event
   */
  private async handleHookEvent(event: HookEvent): Promise<void> {
    if (this.verbose) {
      console.error(`[watcher] Hook: ${event.type} (session: ${event.sessionId})`);
    }

    // Handle different hook types
    switch (event.type) {
      case 'SessionStart':
        // Create session eagerly on SessionStart (but lazily is also fine)
        try {
          this.getOrCreateSession(event);
        } catch (error) {
          if (this.verbose) {
            console.error(`[watcher] Failed to create session: ${error}`);
          }
        }
        break;

      case 'PostToolUse':
      case 'Stop':
      case 'SubagentStop':
        // Get or create session and process transcript
        try {
          const session = this.getOrCreateSession(event);
          await this.processTranscriptForSession(session);
        } catch (error) {
          if (this.verbose) {
            console.error(`[watcher] Failed to process event: ${error}`);
          }
        }
        break;

      case 'SessionEnd':
        // Only process SessionEnd if we have an active session for it
        // This prevents creating ghost sessions for sessions we never tracked
        {
          const session = this.sessions.get(event.sessionId);
          if (session && !session.finalized) {
            await this.handleSessionEnd(session);
          } else if (this.verbose) {
            console.error(`[watcher] Ignoring SessionEnd for untracked session: ${event.sessionId}`);
          }
        }
        break;

      default:
        // Unknown hook type, try to process if we have a session for this event
        {
          const existingSession = this.sessions.get(event.sessionId);
          if (existingSession && !existingSession.finalized) {
            await this.processTranscriptForSession(existingSession);
          }
        }
    }
  }

  /**
   * Get or create a session for the given event
   * Returns the session state for further processing
   */
  private getOrCreateSession(event: HookEvent): SessionState {
    const sessionId = event.sessionId;
    const transcriptPath = event.transcriptPath;

    // Return existing session if found
    const session = this.sessions.get(sessionId);

    if (session) {
      // Update transcript path if it changed (shouldn't normally happen)
      if (transcriptPath && session.transcriptPath !== transcriptPath) {
        if (this.verbose) {
          console.error(`[watcher] Transcript path changed for session ${sessionId}`);
        }
        session.transcriptPath = transcriptPath;
      }
      // Update last activity
      session.lastActivityAt = new Date();
      return session;
    }

    // Create new session
    if (!transcriptPath) {
      // This shouldn't happen in normal operation, but handle gracefully
      throw new Error(`Cannot create session ${sessionId} without transcript path`);
    }

    return this.createSession(sessionId, transcriptPath);
  }

  /**
   * Handle session end - finalize documentation for this session only
   */
  private async handleSessionEnd(session: SessionState): Promise<void> {
    if (session.finalized) {
      return; // Already finalized
    }

    if (this.verbose) {
      console.error(`[watcher] Session ending: ${session.sessionId}`);
    }

    // Process any remaining transcript content
    await this.processTranscriptForSession(session);

    // Flush remaining messages in this session's router
    await session.router.flushAll();

    // Finalize this session's documentation
    await session.docAgent.finalize();
    const stats = session.docAgent.getStats();
    console.error(`[watcher] Session ${session.sessionId} complete.`);
    console.error(`[watcher] Events documented: ${stats.documentedCount}`);

    // Clean up this session's router
    session.router.destroy();

    // Mark as finalized (but keep in map for stats/debugging)
    session.finalized = true;

    if (this.verbose) {
      console.error(`[watcher] Active sessions: ${this.getActiveSessionCount()}`);
    }
  }

  /**
   * Get count of non-finalized sessions
   */
  private getActiveSessionCount(): number {
    return Array.from(this.sessions.values()).filter(s => !s.finalized).length;
  }

  /**
   * Read and process new transcript entries for a specific session
   */
  private async processTranscriptForSession(session: SessionState): Promise<void> {
    try {
      const entries = await this.transcriptReader.readNewEntries(
        session.transcriptPath
      );

      if (entries.length === 0) {
        return;
      }

      // Convert to stream messages and enqueue to this session's router
      const messages = this.transcriptReader.toStreamMessages(entries, this.verbose);
      this.messageCount += messages.length;

      if (this.verbose) {
        console.error(`[watcher] Session ${session.sessionId}: Read ${entries.length} entries, converted to ${messages.length} messages`);
      }

      for (const msg of messages) {
        session.router.enqueue(msg);
      }

      // Update last activity
      session.lastActivityAt = new Date();

      if (this.verbose && messages.length > 0) {
        console.error(`[watcher] Session ${session.sessionId}: Processed ${messages.length} new messages`);
      }
    } catch (error) {
      if (this.verbose) {
        console.error(`[watcher] Session ${session.sessionId}: Error reading transcript: ${error}`);
      }
    }
  }

  /**
   * Start the watcher
   */
  async start(): Promise<void> {
    console.error(`[session-monitor] Starting hook-based session monitor`);
    console.error(`[session-monitor] Monitor ID: ${this.monitorSessionId}`);
    console.error(`[session-monitor] Output: ${this.config.outputDir}`);
    console.error(`[session-monitor] Socket: ${this.socketServer.getSocketPath()}`);
    console.error(`[session-monitor] Waiting for Claude Code hooks...`);
    console.error(`[session-monitor] Each Claude Code session will get its own documentation folder`);
    console.error(`[session-monitor] Press Ctrl+C to stop\n`);

    await this.socketServer.start();

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.error('\n[session-monitor] Shutting down...');

    // Stop accepting new connections
    await this.socketServer.stop();

    // Finalize all active sessions
    const activeSessions = Array.from(this.sessions.values()).filter(s => !s.finalized);

    if (activeSessions.length > 0) {
      console.error(`[session-monitor] Finalizing ${activeSessions.length} active session(s)...`);

      // Finalize sessions in parallel for faster shutdown
      await Promise.all(
        activeSessions.map(async (session) => {
          try {
            await this.handleSessionEnd(session);
          } catch (error) {
            console.error(`[session-monitor] Error finalizing session ${session.sessionId}:`, error);
          }
        })
      );
    }

    // Report final statistics
    const totalDocumented = Array.from(this.sessions.values())
      .reduce((sum, s) => sum + s.docAgent.getStats().documentedCount, 0);

    console.error(`[session-monitor] Monitor stopped.`);
    console.error(`[session-monitor] Total sessions tracked: ${this.sessions.size}`);
    console.error(`[session-monitor] Hooks received: ${this.hookCount}`);
    console.error(`[session-monitor] Messages processed: ${this.messageCount}`);
    console.error(`[session-monitor] Total events documented: ${totalDocumented}`);

    process.exit(0);
  }

  /**
   * Generate a unique session ID for the monitor
   */
  private generateSessionId(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.getTime().toString(36);
    return `monitor-${dateStr}-${timeStr}`;
  }

  /**
   * Get monitor session ID
   */
  getMonitorSessionId(): string {
    return this.monitorSessionId;
  }

  /**
   * Get all active (non-finalized) Claude Code session IDs
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.values())
      .filter(s => !s.finalized)
      .map(s => s.sessionId);
  }

  /**
   * Get current Claude Code session ID (for backward compatibility)
   * Returns the most recently active session, or null if none
   * @deprecated Use getActiveSessionIds() for multi-session support
   */
  getCurrentClaudeSessionId(): string | null {
    const active = Array.from(this.sessions.values())
      .filter(s => !s.finalized)
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
    return active.length > 0 ? active[0].sessionId : null;
  }

  /**
   * Get statistics
   */
  getStats(): {
    hookCount: number;
    messageCount: number;
    totalSessions: number;
    activeSessions: number;
    sessions: Array<{
      sessionId: string;
      createdAt: Date;
      lastActivityAt: Date;
      finalized: boolean;
      routerStats: ReturnType<MessageRouter['getStats']>;
      docStats: ReturnType<DocumentationAgent['getStats']>;
    }>;
  } {
    const sessionStats = Array.from(this.sessions.values()).map(s => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      finalized: s.finalized,
      routerStats: s.router.getStats(),
      docStats: s.docAgent.getStats(),
    }));

    return {
      hookCount: this.hookCount,
      messageCount: this.messageCount,
      totalSessions: this.sessions.size,
      activeSessions: this.getActiveSessionCount(),
      sessions: sessionStats,
    };
  }
}
