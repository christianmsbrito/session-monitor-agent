/**
 * Hook installation utilities
 *
 * Installs the session-monitor hooks into Claude Code's settings
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLAUDE_SETTINGS_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_SETTINGS_DIR, 'settings.json');

/**
 * Hook format for Claude Code:
 * {
 *   "PostToolUse": [
 *     {
 *       "matcher": "*",  // String pattern: tool name, regex, or "*" for all
 *       "hooks": [{"type": "command", "command": "..."}]
 *     }
 *   ]
 * }
 *
 * Note: SessionStart/SessionEnd don't require a matcher field
 */

interface HookEntry {
  matcher?: string;  // Tool pattern (string, not object)
  hooks: Array<{
    type: 'command';
    command: string;
  }>;
}

interface ClaudeSettings {
  hooks?: {
    [hookName: string]: HookEntry[];
  };
  [key: string]: unknown;
}

interface HookDefinition {
  name: string;
  matcher?: string;  // String pattern for tool matching
  envVar: string;
}

// Hooks we want to install
const HOOKS_TO_INSTALL: HookDefinition[] = [
  {
    name: 'PostToolUse',
    matcher: '*',  // Match all tools
    envVar: 'PostToolUse',
  },
  {
    name: 'Stop',
    matcher: '*',  // Match all stops
    envVar: 'Stop',
  },
  {
    name: 'SessionStart',
    // No matcher needed for session events
    envVar: 'SessionStart',
  },
  {
    name: 'SessionEnd',
    // No matcher needed for session events
    envVar: 'SessionEnd',
  },
];

/**
 * Get the path to the compiled hook script
 */
export function getHookScriptPath(): string {
  // In production, this would be the installed location
  // For now, use the dist path relative to the package
  const scriptPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    '..',
    'dist',
    'hooks',
    'hook-script.js'
  );
  return scriptPath;
}

/**
 * Read current Claude settings
 */
async function readSettings(): Promise<ClaudeSettings> {
  try {
    const content = await fs.promises.readFile(CLAUDE_SETTINGS_FILE, 'utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Write Claude settings
 */
async function writeSettings(settings: ClaudeSettings): Promise<void> {
  await fs.promises.mkdir(CLAUDE_SETTINGS_DIR, { recursive: true });
  await fs.promises.writeFile(
    CLAUDE_SETTINGS_FILE,
    JSON.stringify(settings, null, 2),
    'utf8'
  );
}

/**
 * Install session-monitor hooks into Claude Code settings
 */
export async function installHooks(options: {
  force?: boolean;
  verbose?: boolean;
  debug?: boolean;
} = {}): Promise<{ installed: string[]; skipped: string[]; errors: string[] }> {
  const result = {
    installed: [] as string[],
    skipped: [] as string[],
    errors: [] as string[],
  };

  const hookScriptPath = getHookScriptPath();

  // Verify hook script exists
  try {
    await fs.promises.access(hookScriptPath, fs.constants.X_OK);
  } catch {
    // Try to make it executable
    try {
      await fs.promises.chmod(hookScriptPath, 0o755);
    } catch {
      result.errors.push(`Hook script not found or not executable: ${hookScriptPath}`);
      return result;
    }
  }

  const settings = await readSettings();
  settings.hooks = settings.hooks || {};

  // Add debug flag if requested
  const debugEnv = options.debug ? 'SESSION_MONITOR_DEBUG=1 ' : '';

  for (const hook of HOOKS_TO_INSTALL) {
    const command = `${debugEnv}CLAUDE_HOOK_TYPE=${hook.envVar} node "${hookScriptPath}"`;

    // Build hook entry - only include matcher if defined
    const newHookEntry: HookEntry = {
      hooks: [{ type: 'command', command }],
    };
    if (hook.matcher) {
      newHookEntry.matcher = hook.matcher;
    }

    const existingHooks = settings.hooks[hook.name];

    if (Array.isArray(existingHooks)) {
      // Check if our hook is already installed
      const alreadyInstalled = existingHooks.some((entry) =>
        entry.hooks?.some((h) =>
          h.command.includes('session-monitor') || h.command.includes(hookScriptPath)
        )
      );

      if (alreadyInstalled && !options.force) {
        result.skipped.push(hook.name);
        continue;
      }

      // Remove existing session-monitor hooks and add new one
      const filtered = existingHooks.filter((entry) =>
        !entry.hooks?.some((h) =>
          h.command.includes('session-monitor') || h.command.includes(hookScriptPath)
        )
      );
      filtered.push(newHookEntry);
      settings.hooks[hook.name] = filtered;
    } else {
      // No existing hooks or wrong format, create new array
      settings.hooks[hook.name] = [newHookEntry];
    }

    result.installed.push(hook.name);
  }

  // Write updated settings
  try {
    await writeSettings(settings);
  } catch (err) {
    result.errors.push(`Failed to write settings: ${err}`);
  }

  if (options.verbose) {
    console.error(`Hook script path: ${hookScriptPath}`);
    console.error(`Settings file: ${CLAUDE_SETTINGS_FILE}`);
  }

  return result;
}

/**
 * Uninstall session-monitor hooks from Claude Code settings
 */
export async function uninstallHooks(options: {
  verbose?: boolean;
} = {}): Promise<{ removed: string[]; errors: string[] }> {
  const result = {
    removed: [] as string[],
    errors: [] as string[],
  };

  const hookScriptPath = getHookScriptPath();
  const settings = await readSettings();

  if (!settings.hooks) {
    return result;
  }

  for (const hook of HOOKS_TO_INSTALL) {
    const existingHooks = settings.hooks[hook.name];

    if (Array.isArray(existingHooks)) {
      // Filter out our hooks using new format
      const filtered = existingHooks.filter((entry) =>
        !entry.hooks?.some((h) =>
          h.command.includes('session-monitor') || h.command.includes(hookScriptPath)
        )
      );
      if (filtered.length < existingHooks.length) {
        result.removed.push(hook.name);
        if (filtered.length === 0) {
          delete settings.hooks[hook.name];
        } else {
          settings.hooks[hook.name] = filtered;
        }
      }
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  try {
    await writeSettings(settings);
  } catch (err) {
    result.errors.push(`Failed to write settings: ${err}`);
  }

  if (options.verbose) {
    console.error(`Settings file: ${CLAUDE_SETTINGS_FILE}`);
  }

  return result;
}

/**
 * Check if hooks are installed
 */
export async function checkHooksInstalled(): Promise<{
  installed: string[];
  missing: string[];
}> {
  const result = {
    installed: [] as string[],
    missing: [] as string[],
  };

  const hookScriptPath = getHookScriptPath();
  const settings = await readSettings();

  if (!settings.hooks) {
    result.missing = HOOKS_TO_INSTALL.map((h) => h.name);
    return result;
  }

  for (const hook of HOOKS_TO_INSTALL) {
    const existingHooks = settings.hooks[hook.name];
    let isInstalled = false;

    if (Array.isArray(existingHooks)) {
      // Check using new format
      isInstalled = existingHooks.some((entry) =>
        entry.hooks?.some((h) =>
          h.command.includes('session-monitor') || h.command.includes(hookScriptPath)
        )
      );
    }

    if (isInstalled) {
      result.installed.push(hook.name);
    } else {
      result.missing.push(hook.name);
    }
  }

  return result;
}
