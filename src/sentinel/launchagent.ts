/**
 * LaunchAgent installer for macOS
 *
 * Creates/removes a LaunchAgent plist that starts the sentinel daemon
 * automatically on user login.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

const LAUNCH_AGENT_LABEL = 'com.session-monitor.sentinel';
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LAUNCH_AGENT_LABEL}.plist`);

export interface InstallStartupOptions {
  autoStart?: boolean;
  verbose?: boolean;
}

export interface InstallStartupResult {
  success: boolean;
  plistPath: string;
  message: string;
  loaded?: boolean;
}

export interface UninstallStartupResult {
  success: boolean;
  message: string;
  unloaded?: boolean;
}

/**
 * Generate the LaunchAgent plist content
 */
function generatePlist(options: InstallStartupOptions = {}): string {
  const nodePath = process.execPath;
  const sentinelScript = findSentinelScript();

  const programArgs = [nodePath, sentinelScript, 'sentinel'];
  if (options.autoStart) {
    programArgs.push('--auto-start');
  }
  if (options.verbose) {
    programArgs.push('--verbose');
  }

  const programArgsXml = programArgs
    .map((arg) => `        <string>${escapeXml(arg)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(os.tmpdir(), 'session-monitor-sentinel.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(os.tmpdir(), 'session-monitor-sentinel.log'))}</string>
</dict>
</plist>
`;
}

/**
 * Find the sentinel script path
 */
function findSentinelScript(): string {
  // Try to find the installed global binary
  const globalPath = process.argv[1];
  if (globalPath && fs.existsSync(globalPath)) {
    return globalPath;
  }

  // Fall back to the local dist path
  const localPath = path.resolve(__dirname, '..', 'index.js');
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  // Last resort: assume session-monitor is in PATH
  return 'session-monitor';
}

/**
 * Escape XML special characters
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Install the LaunchAgent
 */
export async function installStartup(
  options: InstallStartupOptions = {}
): Promise<InstallStartupResult> {
  // Ensure LaunchAgents directory exists
  try {
    await fs.promises.mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  } catch (err) {
    return {
      success: false,
      plistPath: PLIST_PATH,
      message: `Failed to create LaunchAgents directory: ${err}`,
    };
  }

  // Check if already installed
  const exists = await fileExists(PLIST_PATH);
  if (exists) {
    // Unload existing agent before updating
    await unloadLaunchAgent();
  }

  // Generate and write plist
  const plistContent = generatePlist(options);

  try {
    await fs.promises.writeFile(PLIST_PATH, plistContent, 'utf8');
  } catch (err) {
    return {
      success: false,
      plistPath: PLIST_PATH,
      message: `Failed to write plist: ${err}`,
    };
  }

  // Load the launch agent
  const loaded = await loadLaunchAgent();

  return {
    success: true,
    plistPath: PLIST_PATH,
    message: exists
      ? 'LaunchAgent updated and reloaded'
      : 'LaunchAgent installed and loaded',
    loaded,
  };
}

/**
 * Uninstall the LaunchAgent
 */
export async function uninstallStartup(): Promise<UninstallStartupResult> {
  const exists = await fileExists(PLIST_PATH);

  if (!exists) {
    return {
      success: true,
      message: 'LaunchAgent not installed, nothing to remove',
    };
  }

  // Unload the agent first
  const unloaded = await unloadLaunchAgent();

  // Remove the plist file
  try {
    await fs.promises.unlink(PLIST_PATH);
  } catch (err) {
    return {
      success: false,
      message: `Failed to remove plist: ${err}`,
      unloaded,
    };
  }

  return {
    success: true,
    message: 'LaunchAgent uninstalled',
    unloaded,
  };
}

/**
 * Load the LaunchAgent
 */
async function loadLaunchAgent(): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`launchctl load "${PLIST_PATH}"`, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Unload the LaunchAgent
 */
async function unloadLaunchAgent(): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`launchctl unload "${PLIST_PATH}"`, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Check if file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

