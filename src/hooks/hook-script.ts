#!/usr/bin/env node
/**
 * Hook script that sends events to the session-monitor daemon
 *
 * This script is called by Claude Code hooks and forwards events
 * to the appropriate session-monitor based on the session's working directory.
 *
 * Usage: Called automatically by Claude Code when hooks fire
 * Input: JSON via stdin with hook data
 * Output: JSON response (optional)
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REGISTRY_PATH = path.join(os.tmpdir(), 'session-monitor-registry.json');
const SENTINEL_SOCKET_PATH = path.join(os.tmpdir(), 'session-monitor-sentinel.sock');

const DEBUG = process.env.SESSION_MONITOR_DEBUG === '1';
const LOG_FILE = path.join(os.tmpdir(), 'session-monitor-hooks.log');

interface MonitorEntry {
  id: string;
  socketPath: string;
  scopeDirectory: string;
  outputDirectory: string;
  pid: number;
  startedAt: string;
}

interface Registry {
  monitors: MonitorEntry[];
  version: number;
}

interface HookInput {
  hook_type?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;  // Working directory of the Claude session
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

function debugLog(message: string): void {
  if (DEBUG) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logLine);
  }
}

function readRegistry(): Registry {
  try {
    const content = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    return JSON.parse(content) as Registry;
  } catch {
    return { monitors: [], version: 1 };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findMatchingMonitor(sessionCwd: string): MonitorEntry | null {
  const registry = readRegistry();

  // Filter to alive monitors whose scope contains the session cwd
  const candidates = registry.monitors.filter(m => {
    if (!isProcessAlive(m.pid)) return false;

    // Normalize paths for comparison
    const normalizedCwd = path.resolve(sessionCwd);
    const normalizedScope = path.resolve(m.scopeDirectory);

    return normalizedCwd === normalizedScope ||
           normalizedCwd.startsWith(normalizedScope + path.sep);
  });

  if (candidates.length === 0) return null;

  // Return most specific (longest scopeDirectory)
  return candidates.sort((a, b) =>
    b.scopeDirectory.length - a.scopeDirectory.length
  )[0];
}

async function main(): Promise<void> {
  debugLog(`Hook script started. CLAUDE_HOOK_TYPE=${process.env.CLAUDE_HOOK_TYPE}`);

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
    process.exit(0);
  }

  // Determine hook type from environment or input
  const hookType = process.env.CLAUDE_HOOK_TYPE || hookData.hook_type || 'unknown';
  const sessionCwd = hookData.cwd || process.env.CLAUDE_PROJECT_DIR || '';

  debugLog(`Hook type: ${hookType}`);
  debugLog(`Session ID: ${hookData.session_id}`);
  debugLog(`Session CWD: ${sessionCwd}`);
  debugLog(`Transcript path: ${hookData.transcript_path}`);

  // Build event payload
  const event = {
    type: hookType,
    sessionId: hookData.session_id || '',
    transcriptPath: hookData.transcript_path || '',
    cwd: sessionCwd,
    timestamp: new Date().toISOString(),
    data: hookData,
  };

  // Find the matching monitor based on session cwd
  const monitor = sessionCwd ? findMatchingMonitor(sessionCwd) : null;

  if (monitor) {
    debugLog(`Found matching monitor: ${monitor.id} (scope: ${monitor.scopeDirectory})`);
    try {
      await sendToSocket(event, monitor.socketPath);
      debugLog(`Event sent to monitor ${monitor.id} successfully`);
    } catch (err) {
      debugLog(`Failed to send to monitor socket: ${err}`);
    }
  } else {
    debugLog(`No matching monitor found for cwd: ${sessionCwd}`);
  }

  // On SessionStart, also send to sentinel socket (fire-and-forget)
  if (hookType === 'SessionStart') {
    try {
      debugLog(`Sending SessionStart to sentinel socket...`);
      await sendToSocket(event, SENTINEL_SOCKET_PATH);
      debugLog(`Event sent to sentinel successfully`);
    } catch (err) {
      debugLog(`Failed to send to sentinel socket: ${err}`);
    }
  }

  // Exit successfully to not block Claude Code
  process.exit(0);
}

async function sendToSocket(event: unknown, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
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
