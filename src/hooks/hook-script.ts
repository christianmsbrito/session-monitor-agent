#!/usr/bin/env node
/**
 * Hook script that sends events to the session-monitor daemon
 *
 * This script is called by Claude Code hooks and forwards events
 * to the session-monitor via Unix socket.
 *
 * Usage: Called automatically by Claude Code when hooks fire
 * Input: JSON via stdin with hook data
 * Output: JSON response (optional)
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SOCKET_PATH = process.env.SESSION_MONITOR_SOCKET ||
  path.join(os.tmpdir(), 'session-monitor.sock');

const DEBUG = process.env.SESSION_MONITOR_DEBUG === '1';
const LOG_FILE = path.join(os.tmpdir(), 'session-monitor-hooks.log');

function debugLog(message: string): void {
  if (DEBUG) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logLine);
  }
}

interface HookInput {
  hook_type?: string;
  session_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  debugLog(`Hook script started. CLAUDE_HOOK_TYPE=${process.env.CLAUDE_HOOK_TYPE}`);
  debugLog(`Socket path: ${SOCKET_PATH}`);

  // Read stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  debugLog(`Received input: ${input.slice(0, 500)}`);

  let hookData: HookInput;
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    debugLog(`Failed to parse JSON: ${err}`);
    // Invalid JSON, exit silently
    process.exit(0);
  }

  // Determine hook type from environment or input
  const hookType = process.env.CLAUDE_HOOK_TYPE || hookData.hook_type || 'unknown';

  debugLog(`Hook type: ${hookType}`);
  debugLog(`Session ID: ${hookData.session_id}`);
  debugLog(`Transcript path: ${hookData.transcript_path}`);

  // Build event payload
  const event = {
    type: hookType,
    sessionId: hookData.session_id || '',
    transcriptPath: hookData.transcript_path || '',
    timestamp: new Date().toISOString(),
    data: hookData,
  };

  // Send to socket server
  try {
    debugLog(`Sending event to socket...`);
    await sendToSocket(event);
    debugLog(`Event sent successfully`);
  } catch (err) {
    debugLog(`Failed to send to socket: ${err}`);
    // Socket not available, monitor might not be running
    // Exit silently to not block Claude Code
  }

  // Exit successfully to not block Claude Code
  process.exit(0);
}

async function sendToSocket(event: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH, () => {
      client.write(JSON.stringify(event) + '\n');
      client.end();
    });

    client.on('error', (err) => {
      reject(err);
    });

    client.on('close', () => {
      resolve();
    });

    // Timeout after 1 second
    setTimeout(() => {
      client.destroy();
      resolve();
    }, 1000);
  });
}

main().catch(() => {
  process.exit(0);
});
