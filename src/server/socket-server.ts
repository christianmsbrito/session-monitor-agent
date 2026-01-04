/**
 * SocketServer - Unix socket server for receiving hook notifications
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

export interface HookEvent {
  type: 'PostToolUse' | 'Stop' | 'SubagentStop' | 'SessionStart' | 'SessionEnd';
  sessionId: string;
  transcriptPath: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface SocketServerConfig {
  socketPath?: string;
}

const DEFAULT_SOCKET_PATH = path.join(os.tmpdir(), 'session-monitor.sock');

export class SocketServer extends EventEmitter {
  private server: net.Server | null = null;
  private socketPath: string;
  private running: boolean = false;

  constructor(config: SocketServerConfig = {}) {
    super();
    this.socketPath = config.socketPath || DEFAULT_SOCKET_PATH;
  }

  /**
   * Start the socket server
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Clean up existing socket file
    await this.cleanup();

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        this.running = true;
        // Make socket accessible
        fs.chmodSync(this.socketPath, 0o666);
        this.emit('started', { socketPath: this.socketPath });
        resolve();
      });
    });
  }

  /**
   * Stop the socket server
   */
  async stop(): Promise<void> {
    if (!this.running || !this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.running = false;
        this.cleanup().then(resolve);
      });
    });
  }

  /**
   * Handle incoming connection
   */
  private handleConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Try to parse complete JSON messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line) as HookEvent;
            this.emit('hook', event);
          } catch (err) {
            this.emit('parseError', err, line);
          }
        }
      }
    });

    socket.on('end', () => {
      // Process any remaining data
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as HookEvent;
          this.emit('hook', event);
        } catch {
          // Ignore incomplete data
        }
      }
    });

    socket.on('error', (err) => {
      this.emit('socketError', err);
    });
  }

  /**
   * Clean up socket file
   */
  private async cleanup(): Promise<void> {
    try {
      await fs.promises.unlink(this.socketPath);
    } catch {
      // File doesn't exist, that's fine
    }
  }

  /**
   * Get socket path
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Type-safe hook event listener
   */
  onHook(handler: (event: HookEvent) => void): void {
    this.on('hook', handler);
  }
}

