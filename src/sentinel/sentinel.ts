/**
 * Sentinel - Lightweight daemon that alerts when Claude Code sessions start
 * without the main session-monitor running.
 *
 * Runs at system startup via LaunchAgent and monitors for SessionStart events.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import { EventEmitter } from 'events';

// Socket paths
const SENTINEL_SOCKET_PATH = path.join(os.tmpdir(), 'session-monitor-sentinel.sock');
const MONITOR_SOCKET_PATH = path.join(os.tmpdir(), 'session-monitor.sock');

export interface SentinelConfig {
  autoStart?: boolean;
  verbose?: boolean;
}

export interface HookEvent {
  type: string;
  sessionId: string;
  transcriptPath: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export class Sentinel extends EventEmitter {
  private server: net.Server | null = null;
  private running: boolean = false;
  private autoStart: boolean;
  private verbose: boolean;

  constructor(config: SentinelConfig = {}) {
    super();
    this.autoStart = config.autoStart ?? false;
    this.verbose = config.verbose ?? false;
  }

  /**
   * Start the sentinel daemon
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

      this.server.listen(SENTINEL_SOCKET_PATH, () => {
        this.running = true;
        // Make socket accessible
        fs.chmodSync(SENTINEL_SOCKET_PATH, 0o666);
        this.log(`Sentinel started, listening on ${SENTINEL_SOCKET_PATH}`);
        this.emit('started');
        resolve();
      });
    });
  }

  /**
   * Stop the sentinel daemon
   */
  async stop(): Promise<void> {
    if (!this.running || !this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.running = false;
        this.cleanup().then(() => {
          this.log('Sentinel stopped');
          resolve();
        });
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
            this.handleEvent(event);
          } catch (err) {
            this.log(`Parse error: ${err}`);
          }
        }
      }
    });

    socket.on('end', () => {
      // Process any remaining data
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as HookEvent;
          this.handleEvent(event);
        } catch {
          // Ignore incomplete data
        }
      }
    });
  }

  /**
   * Handle a hook event
   */
  private async handleEvent(event: HookEvent): Promise<void> {
    // Only care about SessionStart events
    if (event.type !== 'SessionStart') {
      return;
    }

    this.log(`SessionStart detected for session: ${event.sessionId}`);

    // Check if the main monitor is running
    const monitorRunning = await this.isMonitorRunning();

    if (monitorRunning) {
      this.log('Monitor is running, no action needed');
      return;
    }

    this.log('Monitor is NOT running');

    if (this.autoStart) {
      await this.autoStartMonitor();
    } else {
      await this.showNotification();
    }
  }

  /**
   * Check if the main session-monitor is running
   */
  private async isMonitorRunning(): Promise<boolean> {
    // First check if socket file exists
    try {
      await fs.promises.access(MONITOR_SOCKET_PATH);
    } catch {
      return false;
    }

    // Try to connect to verify it's actually listening
    return new Promise((resolve) => {
      const client = net.createConnection(MONITOR_SOCKET_PATH, () => {
        client.destroy();
        resolve(true);
      });

      client.on('error', () => {
        resolve(false);
      });

      // Quick timeout
      setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 100);
    });
  }

  /**
   * Show macOS notification with action button and configuration options
   */
  private async showNotification(): Promise<void> {
    this.log('Showing notification dialog...');

    // First dialog: Ask what to do
    const mainScript = `
      set dialogResult to display dialog "Session monitor is not running. Start it now?" ¬
        buttons {"Ignore", "Configure...", "Start (Default)"} ¬
        default button "Start (Default)" ¬
        with title "Claude Code Session Started" ¬
        with icon caution

      return button returned of dialogResult
    `;

    const mainResult = await this.runAppleScript(mainScript);

    if (mainResult === 'Ignore') {
      this.log('User clicked Ignore');
      return;
    }

    if (mainResult === 'Start (Default)') {
      this.log('User clicked Start (Default)');
      this.startMonitorInTerminal('.session-docs', false);
      return;
    }

    // User clicked "Configure..." - show configuration dialogs
    this.log('User clicked Configure...');
    const config = await this.showConfigurationDialogs();

    if (config) {
      this.startMonitorInTerminal(config.outputPath, config.verbose, config.apiKey);
    }
  }

  /**
   * Show configuration dialogs for output path, verbose mode, and API key if needed
   */
  private async showConfigurationDialogs(): Promise<{ outputPath: string; verbose: boolean; apiKey?: string } | null> {
    const defaultPath = '.session-docs';
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

    // If no API key in environment, ask for it first
    let apiKey: string | undefined;
    if (!hasApiKey) {
      const apiKeyScript = `
        set dialogResult to display dialog "ANTHROPIC_API_KEY not found in environment.

Enter your Anthropic API key:" ¬
          default answer "" ¬
          buttons {"Cancel", "Next"} ¬
          default button "Next" ¬
          with title "Configure Session Monitor" ¬
          with icon note ¬
          with hidden answer

        set buttonPressed to button returned of dialogResult
        set textEntered to text returned of dialogResult

        if buttonPressed is "Cancel" then
          return "CANCEL"
        else
          return "KEY:" & textEntered
        end if
      `;

      const apiKeyResult = await this.runAppleScript(apiKeyScript);

      if (apiKeyResult === 'CANCEL') {
        this.log('User cancelled configuration');
        return null;
      }

      if (apiKeyResult.startsWith('KEY:')) {
        apiKey = apiKeyResult.substring(4);
        if (!apiKey) {
          this.log('No API key provided');
          await this.runAppleScript(`
            display dialog "API key is required to run the session monitor." ¬
              buttons {"OK"} ¬
              default button "OK" ¬
              with title "Error" ¬
              with icon stop
          `);
          return null;
        }
      }
    }

    // Dialog for output path with text field
    const pathScript = `
      set defaultPath to "${defaultPath}"
      set dialogResult to display dialog "Output directory for documentation:" ¬
        default answer defaultPath ¬
        buttons {"Cancel", "Browse...", "Next"} ¬
        default button "Next" ¬
        with title "Configure Session Monitor" ¬
        with icon note

      set buttonPressed to button returned of dialogResult
      set textEntered to text returned of dialogResult

      if buttonPressed is "Cancel" then
        return "CANCEL"
      else if buttonPressed is "Browse..." then
        return "BROWSE:" & textEntered
      else
        return "PATH:" & textEntered
      end if
    `;

    let outputPath = defaultPath;
    const pathResult = await this.runAppleScript(pathScript);

    if (pathResult === 'CANCEL') {
      this.log('User cancelled configuration');
      return null;
    }

    if (pathResult.startsWith('BROWSE:')) {
      // User wants to browse for folder
      const currentPath = pathResult.substring(7);
      const browseScript = `
        set chosenFolder to choose folder with prompt "Select output directory for documentation:" ¬
          default location (path to home folder)
        return POSIX path of chosenFolder
      `;

      const browsedPath = await this.runAppleScript(browseScript);
      if (browsedPath && !browsedPath.includes('User canceled')) {
        outputPath = browsedPath.trim();
      } else {
        // User cancelled browse, use the text they entered
        outputPath = currentPath || defaultPath;
      }
    } else if (pathResult.startsWith('PATH:')) {
      outputPath = pathResult.substring(5) || defaultPath;
    }

    // Dialog for verbose mode (checkbox simulation using buttons)
    const verboseScript = `
      set dialogResult to display dialog "Enable verbose logging?" ¬
        buttons {"Cancel", "No", "Yes"} ¬
        default button "No" ¬
        with title "Configure Session Monitor" ¬
        with icon note

      return button returned of dialogResult
    `;

    const verboseResult = await this.runAppleScript(verboseScript);

    if (verboseResult === 'Cancel') {
      this.log('User cancelled configuration');
      return null;
    }

    const verbose = verboseResult === 'Yes';

    this.log(`Configuration: outputPath="${outputPath}", verbose=${verbose}, apiKey=${apiKey ? '[provided]' : '[from env]'}`);
    return { outputPath, verbose, apiKey };
  }

  /**
   * Run an AppleScript and return the result
   */
  private async runAppleScript(script: string): Promise<string> {
    return new Promise((resolve) => {
      // Escape single quotes for shell
      const escapedScript = script.replace(/'/g, "'\"'\"'");
      exec(`osascript -e '${escapedScript}'`, (error, stdout, _stderr) => {
        if (error) {
          this.log(`AppleScript error: ${error.message}`);
          resolve('');
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * Start the monitor in a new Terminal window with options
   */
  private startMonitorInTerminal(outputPath: string, verbose: boolean, apiKey?: string): void {
    // Build the command with options
    let command = '';

    // If API key is provided, set it as an environment variable for the command
    if (apiKey) {
      // Escape the API key for shell
      const escapedKey = apiKey.replace(/'/g, "'\\''");
      command += `ANTHROPIC_API_KEY='${escapedKey}' `;
    }

    command += 'session-monitor start';

    if (outputPath && outputPath !== '.session-docs') {
      // Escape the path for shell
      const escapedPath = outputPath.replace(/"/g, '\\"');
      command += ` -o "${escapedPath}"`;
    }

    if (verbose) {
      command += ' -v';
    }

    this.log(`Starting monitor with command: ${apiKey ? '[API_KEY] ' : ''}session-monitor start${outputPath !== '.session-docs' ? ` -o "${outputPath}"` : ''}${verbose ? ' -v' : ''}`);

    const script = `
      tell application "Terminal"
        activate
        do script "${command.replace(/"/g, '\\"')}"
      end tell
    `;

    exec(`osascript -e '${script}'`, (error) => {
      if (error) {
        this.log(`Failed to start monitor in Terminal: ${error.message}`);
      } else {
        this.log('Started monitor in new Terminal window');
      }
    });
  }

  /**
   * Auto-start the monitor in the background
   */
  private async autoStartMonitor(): Promise<void> {
    this.log('Auto-starting session monitor...');

    // Find the session-monitor executable
    const monitorPath = await this.findSessionMonitor();
    if (!monitorPath) {
      this.log('Could not find session-monitor executable');
      // Fall back to showing notification
      await this.showNotification();
      return;
    }

    // Spawn detached process
    const child = spawn('node', [monitorPath, 'start'], {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
    this.log(`Auto-started monitor (PID: ${child.pid})`);
  }

  /**
   * Find the session-monitor executable
   */
  private async findSessionMonitor(): Promise<string | null> {
    // Try to find via which command
    return new Promise((resolve) => {
      exec('which session-monitor', (error, stdout) => {
        if (!error && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          // Try the local dist path
          const localPath = path.join(__dirname, '..', 'index.js');
          fs.promises.access(localPath)
            .then(() => resolve(localPath))
            .catch(() => resolve(null));
        }
      });
    });
  }

  /**
   * Clean up socket file
   */
  private async cleanup(): Promise<void> {
    try {
      await fs.promises.unlink(SENTINEL_SOCKET_PATH);
    } catch {
      // File doesn't exist, that's fine
    }
  }

  /**
   * Log message if verbose mode enabled
   */
  private log(message: string): void {
    if (this.verbose) {
      const timestamp = new Date().toISOString();
      console.error(`[${timestamp}] [sentinel] ${message}`);
    }
  }

  /**
   * Check if sentinel is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

/**
 * Get the sentinel socket path
 */
export function getSentinelSocketPath(): string {
  return SENTINEL_SOCKET_PATH;
}

/**
 * Get the monitor socket path
 */
export function getMonitorSocketPath(): string {
  return MONITOR_SOCKET_PATH;
}
