/**
 * Sentinel - Lightweight daemon that alerts when Claude Code sessions start
 * without a matching session-monitor covering that directory.
 *
 * Runs at system startup via LaunchAgent and monitors for SessionStart events.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { RegistryManager } from '../registry/index.js';

// Socket path for sentinel
const SENTINEL_SOCKET_PATH = path.join(os.tmpdir(), 'session-monitor-sentinel.sock');

export interface SentinelConfig {
  autoStart?: boolean;
  verbose?: boolean;
}

export interface HookEvent {
  type: string;
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
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

    const sessionCwd = event.cwd || '';
    this.log(`SessionStart detected for session: ${event.sessionId}`);
    this.log(`Session working directory: ${sessionCwd}`);

    // Check if the session is covered by any monitor
    const isCovered = sessionCwd ? RegistryManager.isCovered(sessionCwd) : false;

    if (isCovered) {
      const monitor = RegistryManager.findMatchingMonitor(sessionCwd);
      this.log(`Session is covered by monitor: ${monitor?.id} (scope: ${monitor?.scopeDirectory})`);
      return;
    }

    this.log(`Session is NOT covered by any monitor`);

    if (this.autoStart) {
      await this.autoStartMonitor(sessionCwd);
    } else {
      await this.showNotification(sessionCwd);
    }
  }

  /**
   * Show macOS notification with action button and configuration options
   */
  private async showNotification(sessionCwd: string): Promise<void> {
    this.log('Showing notification dialog...');

    const displayCwd = sessionCwd || '(unknown)';

    // First dialog: Ask what to do
    const mainScript = `
      set dialogResult to display dialog "Claude Code session started in:
${displayCwd}

No session monitor is covering this directory." ¬
        buttons {"Ignore", "Configure...", "Start (Default)"} ¬
        default button "Start (Default)" ¬
        with title "Session Monitor" ¬
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
      // Start with scope = session cwd, output = .session-docs in that directory
      const outputPath = sessionCwd ? `${sessionCwd}/.session-docs` : '.session-docs';
      this.startMonitorInTerminal(outputPath, false, undefined, sessionCwd);
      return;
    }

    // User clicked "Configure..." - show configuration dialogs
    this.log('User clicked Configure...');
    const config = await this.showConfigurationDialogs(sessionCwd);

    if (config) {
      this.startMonitorInTerminal(config.outputPath, config.verbose, config.apiKey, config.scopePath);
    }
  }

  /**
   * Show configuration dialogs for scope, output path, verbose mode, and API key if needed
   */
  private async showConfigurationDialogs(sessionCwd: string): Promise<{
    scopePath: string;
    outputPath: string;
    verbose: boolean;
    apiKey?: string;
  } | null> {
    const defaultScope = sessionCwd || process.cwd();
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

    // Dialog for scope directory
    const scopeScript = `
      set defaultScope to "${defaultScope}"
      set dialogResult to display dialog "Monitor scope directory (sessions in this directory and subdirectories will be captured):" ¬
        default answer defaultScope ¬
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

    let scopePath = defaultScope;
    const scopeResult = await this.runAppleScript(scopeScript);

    if (scopeResult === 'CANCEL') {
      this.log('User cancelled configuration');
      return null;
    }

    if (scopeResult.startsWith('BROWSE:')) {
      const browseScript = `
        set chosenFolder to choose folder with prompt "Select scope directory:" ¬
          default location (path to home folder)
        return POSIX path of chosenFolder
      `;

      const browsedPath = await this.runAppleScript(browseScript);
      if (browsedPath && !browsedPath.includes('User canceled')) {
        scopePath = browsedPath.trim().replace(/\/$/, ''); // Remove trailing slash
      }
    } else if (scopeResult.startsWith('PATH:')) {
      scopePath = scopeResult.substring(5) || defaultScope;
    }

    // Dialog for output path
    const defaultOutput = `${scopePath}/.session-docs`;
    const pathScript = `
      set defaultPath to "${defaultOutput}"
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

    let outputPath = defaultOutput;
    const pathResult = await this.runAppleScript(pathScript);

    if (pathResult === 'CANCEL') {
      this.log('User cancelled configuration');
      return null;
    }

    if (pathResult.startsWith('BROWSE:')) {
      const browseScript = `
        set chosenFolder to choose folder with prompt "Select output directory for documentation:" ¬
          default location (path to home folder)
        return POSIX path of chosenFolder
      `;

      const browsedPath = await this.runAppleScript(browseScript);
      if (browsedPath && !browsedPath.includes('User canceled')) {
        outputPath = browsedPath.trim().replace(/\/$/, '');
      } else {
        outputPath = pathResult.substring(7) || defaultOutput;
      }
    } else if (pathResult.startsWith('PATH:')) {
      outputPath = pathResult.substring(5) || defaultOutput;
    }

    // Dialog for verbose mode
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

    this.log(`Configuration: scope="${scopePath}", output="${outputPath}", verbose=${verbose}, apiKey=${apiKey ? '[provided]' : '[from env]'}`);
    return { scopePath, outputPath, verbose, apiKey };
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
  private startMonitorInTerminal(outputPath: string, verbose: boolean, apiKey?: string, scopePath?: string): void {
    // Build the command with options
    let command = '';

    // If API key is provided, set it as an environment variable for the command
    if (apiKey) {
      const escapedKey = apiKey.replace(/'/g, "'\\''");
      command += `ANTHROPIC_API_KEY='${escapedKey}' `;
    }

    command += 'session-monitor start';

    // Add scope if provided
    if (scopePath) {
      const escapedScope = scopePath.replace(/"/g, '\\"');
      command += ` --scope "${escapedScope}"`;
    }

    // Add output path
    if (outputPath) {
      const escapedPath = outputPath.replace(/"/g, '\\"');
      command += ` -o "${escapedPath}"`;
    }

    if (verbose) {
      command += ' -v';
    }

    this.log(`Starting monitor with command: ${apiKey ? '[API_KEY] ' : ''}session-monitor start${scopePath ? ` --scope "${scopePath}"` : ''}${outputPath ? ` -o "${outputPath}"` : ''}${verbose ? ' -v' : ''}`);

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
  private async autoStartMonitor(sessionCwd: string): Promise<void> {
    this.log('Auto-starting session monitor...');

    // Find the session-monitor executable
    const monitorPath = await this.findSessionMonitor();
    if (!monitorPath) {
      this.log('Could not find session-monitor executable');
      await this.showNotification(sessionCwd);
      return;
    }

    // Build args
    const args = [monitorPath, 'start'];
    if (sessionCwd) {
      args.push('--scope', sessionCwd);
      args.push('-o', `${sessionCwd}/.session-docs`);
    }

    // Spawn detached process
    const child = spawn('node', args, {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
    this.log(`Auto-started monitor (PID: ${child.pid}) with scope: ${sessionCwd || 'default'}`);
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
