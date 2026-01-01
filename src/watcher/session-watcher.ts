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

export class SessionWatcher {
  private socketServer: SocketServer;
  private transcriptReader: TranscriptReader;
  private router: MessageRouter;
  private docAgent: DocumentationAgent | null = null;
  private monitorSessionId: string;
  private currentClaudeSessionId: string | null = null;
  private currentTranscriptPath: string | null = null;
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

    this.router = new MessageRouter({
      maxQueueSize: config.maxQueueSize,
      batchSize: config.batchSize,
      flushIntervalMs: config.flushIntervalMs,
    });

    // Note: docAgent is created per Claude Code session, not here

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

    // Batches from router go to doc agent
    this.router.onBatch(async (batch) => {
      if (!this.docAgent) {
        if (this.verbose) {
          console.error('[watcher] No active doc agent, skipping batch');
        }
        return;
      }
      try {
        await this.docAgent.processBatch(batch);
      } catch (error) {
        if (this.verbose) {
          console.error('[watcher] Error processing batch:', error);
        }
      }
    });

    // Log dropped messages
    if (this.verbose) {
      this.router.onDropped(() => {
        console.error('[watcher] Message dropped due to queue full');
      });
    }
  }

  /**
   * Handle a hook event
   */
  private async handleHookEvent(event: HookEvent): Promise<void> {
    if (this.verbose) {
      console.error(`[watcher] Hook: ${event.type} (session: ${event.sessionId})`);
    }

    // Update transcript path if provided
    if (event.transcriptPath) {
      this.currentTranscriptPath = event.transcriptPath;
    }

    // Handle different hook types
    switch (event.type) {
      case 'SessionStart':
        // Create doc agent for new session
        await this.ensureDocAgentForSession(event);
        break;

      case 'PostToolUse':
      case 'Stop':
      case 'SubagentStop':
        // Create doc agent if needed (handles monitor starting mid-session)
        await this.ensureDocAgentForSession(event);
        await this.processTranscript();
        break;

      case 'SessionEnd':
        // Only process SessionEnd if we have an active doc agent for this session
        // This prevents creating ghost sessions for sessions we never tracked
        if (this.docAgent && this.currentClaudeSessionId === event.sessionId) {
          await this.handleSessionEnd(event);
        } else if (this.verbose) {
          console.error(`[watcher] Ignoring SessionEnd for untracked session: ${event.sessionId}`);
        }
        break;

      default:
        // Unknown hook type, try to process transcript if we have an active session
        if (this.docAgent) {
          await this.processTranscript();
        }
    }
  }

  /**
   * Ensure we have a DocumentationAgent for the given session
   * Creates one if needed (lazy initialization for when SessionStart isn't received)
   */
  private async ensureDocAgentForSession(event: HookEvent): Promise<void> {
    const claudeSessionId = event.sessionId;

    // If we already have a doc agent for this session, nothing to do
    if (this.docAgent && this.currentClaudeSessionId === claudeSessionId) {
      return;
    }

    // If this is a new/different session, handle the transition
    if (this.docAgent && this.currentClaudeSessionId && this.currentClaudeSessionId !== claudeSessionId) {
      if (this.verbose) {
        console.error(`[watcher] Session changed from ${this.currentClaudeSessionId} to ${claudeSessionId}`);
        console.error(`[watcher] Finalizing previous session...`);
      }
      // Flush any remaining messages for the previous session
      await this.router.flushAll();
      // Finalize the previous session's documentation
      await this.docAgent.finalize();
    }

    // Create a new DocumentationAgent for this Claude Code session
    this.currentClaudeSessionId = claudeSessionId;
    this.docAgent = new DocumentationAgent({
      apiKey: this.config.apiKey,
      model: this.config.docModel,
      outputDir: this.config.outputDir,
      sessionId: claudeSessionId,
      verbose: this.config.verbose,
    });

    if (this.verbose) {
      console.error(`[watcher] Created doc agent for session: ${claudeSessionId}`);
      if (event.transcriptPath) {
        console.error(`[watcher] Transcript: ${event.transcriptPath}`);
      }
    }

    // Reset transcript reader position for new session
    if (event.transcriptPath) {
      this.transcriptReader.resetPosition(event.transcriptPath);
    }
  }

  /**
   * Handle session end
   */
  private async handleSessionEnd(event: HookEvent): Promise<void> {
    if (this.verbose) {
      console.error(`[watcher] Session ended: ${event.sessionId}`);
    }

    // Process any remaining transcript content
    await this.processTranscript();

    // Flush remaining messages
    await this.router.flushAll();

    // Finalize this session's documentation
    if (this.docAgent) {
      await this.docAgent.finalize();
      const stats = this.docAgent.getStats();
      console.error(`[watcher] Session ${event.sessionId} complete.`);
      console.error(`[watcher] Events documented: ${stats.documentedCount}`);
    }

    // Clear the current session
    this.currentClaudeSessionId = null;
    this.docAgent = null;
  }

  /**
   * Read and process new transcript entries
   */
  private async processTranscript(): Promise<void> {
    if (!this.currentTranscriptPath) {
      return;
    }

    try {
      const entries = await this.transcriptReader.readNewEntries(
        this.currentTranscriptPath
      );

      if (entries.length === 0) {
        return;
      }

      // Convert to stream messages and enqueue
      const messages = this.transcriptReader.toStreamMessages(entries, this.verbose);
      this.messageCount += messages.length;

      if (this.verbose) {
        console.error(`[watcher] Read ${entries.length} entries, converted to ${messages.length} messages`);
      }

      for (const msg of messages) {
        this.router.enqueue(msg);
      }

      if (this.verbose && messages.length > 0) {
        console.error(`[watcher] Processed ${messages.length} new messages`);
      }
    } catch (error) {
      if (this.verbose) {
        console.error(`[watcher] Error reading transcript: ${error}`);
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

    // Stop socket server
    await this.socketServer.stop();

    // Flush remaining messages
    await this.router.flushAll();

    // Finalize any active session's documentation
    if (this.docAgent) {
      await this.docAgent.finalize();
      const stats = this.docAgent.getStats();
      console.error(`[session-monitor] Final session events documented: ${stats.documentedCount}`);
    }

    // Clean up
    this.router.destroy();

    console.error(`[session-monitor] Monitor stopped.`);
    console.error(`[session-monitor] Hooks received: ${this.hookCount}`);
    console.error(`[session-monitor] Messages processed: ${this.messageCount}`);

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
   * Get current Claude Code session ID (if any)
   */
  getCurrentClaudeSessionId(): string | null {
    return this.currentClaudeSessionId;
  }

  /**
   * Get statistics
   */
  getStats(): {
    hookCount: number;
    messageCount: number;
    currentClaudeSessionId: string | null;
    routerStats: ReturnType<MessageRouter['getStats']>;
    docStats: ReturnType<DocumentationAgent['getStats']> | null;
  } {
    return {
      hookCount: this.hookCount,
      messageCount: this.messageCount,
      currentClaudeSessionId: this.currentClaudeSessionId,
      routerStats: this.router.getStats(),
      docStats: this.docAgent?.getStats() ?? null,
    };
  }
}
