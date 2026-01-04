#!/usr/bin/env node
/**
 * session-monitor-agent
 *
 * Background documentation agent that watches Claude Code sessions via hooks.
 * Automatically documents significant events like bug fixes, decisions, and discoveries.
 */

import { parseArgs, buildWatcherConfig, printUsage } from './cli/index.js';
import { SessionWatcher } from './watcher/index.js';
import { installHooks, uninstallHooks, checkHooksInstalled } from './hooks/index.js';
import {
  Sentinel,
  installStartup,
  uninstallStartup,
  type SentinelConfig,
  type InstallStartupOptions,
} from './sentinel/index.js';
import { RegistryManager } from './registry/index.js';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  switch (parsed.command) {
    case 'help':
      printUsage();
      process.exit(0);
      break;

    case 'install':
      await handleInstall(parsed.options);
      break;

    case 'uninstall':
      await handleUninstall(parsed.options);
      break;

    case 'status':
      await handleStatus();
      break;

    case 'start':
      await handleStart(parsed.options);
      break;

    case 'sentinel':
      await handleSentinel(parsed.options);
      break;

    case 'install-startup':
      await handleInstallStartup(parsed.options);
      break;

    case 'uninstall-startup':
      await handleUninstallStartup();
      break;
  }
}

async function handleInstall(options: { force: boolean; verbose: boolean; debug: boolean }): Promise<void> {
  console.log('Installing session-monitor hooks...\n');

  if (options.debug) {
    const os = await import('os');
    const path = await import('path');
    const logPath = path.join(os.tmpdir(), 'session-monitor-hooks.log');
    console.log(`Debug mode enabled - hooks will log to ${logPath}\n`);
  }

  const result = await installHooks({
    force: options.force,
    verbose: options.verbose,
    debug: options.debug,
  });

  if (result.errors.length > 0) {
    console.error('Errors:');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  if (result.installed.length > 0) {
    console.log('Installed hooks:');
    for (const hook of result.installed) {
      console.log(`  ✓ ${hook}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('\nSkipped (already installed):');
    for (const hook of result.skipped) {
      console.log(`  - ${hook}`);
    }
    console.log('\nUse --force to overwrite existing hooks.');
  }

  console.log('\nHooks installed successfully!');
  console.log('\nNext steps:');
  console.log('  1. Start the monitor: session-monitor start');
  console.log('  2. Use Claude Code normally in another terminal');
  console.log('  3. Documentation will be saved to .session-docs/');
}

async function handleUninstall(options: { verbose: boolean }): Promise<void> {
  console.log('Uninstalling session-monitor hooks...\n');

  const result = await uninstallHooks({
    verbose: options.verbose,
  });

  if (result.errors.length > 0) {
    console.error('Errors:');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  if (result.removed.length > 0) {
    console.log('Removed hooks:');
    for (const hook of result.removed) {
      console.log(`  ✓ ${hook}`);
    }
    console.log('\nHooks uninstalled successfully!');
  } else {
    console.log('No session-monitor hooks found to remove.');
  }
}

async function handleStatus(): Promise<void> {
  const hookResult = await checkHooksInstalled();

  console.log('Session Monitor Status\n');
  console.log('======================\n');

  // Hooks status
  console.log('Hooks:');
  if (hookResult.installed.length > 0) {
    for (const hook of hookResult.installed) {
      console.log(`  ✓ ${hook}`);
    }
  }
  if (hookResult.missing.length > 0) {
    for (const hook of hookResult.missing) {
      console.log(`  ✗ ${hook}`);
    }
  }

  // Monitor status
  console.log('\nActive Monitors:');
  const monitors = RegistryManager.getActiveMonitors();

  if (monitors.length === 0) {
    console.log('  (none)');
  } else {
    console.log('  ID        Scope                                    Output                         PID');
    console.log('  ' + '-'.repeat(90));
    for (const monitor of monitors) {
      const id = monitor.id.padEnd(10);
      const scope = monitor.scopeDirectory.slice(0, 40).padEnd(40);
      const output = monitor.outputDirectory.slice(0, 30).padEnd(30);
      console.log(`  ${id}${scope}${output}${monitor.pid}`);
    }
  }

  // Summary
  console.log('');
  if (hookResult.missing.length === 0) {
    console.log('Hooks: All installed ✓');
  } else if (hookResult.installed.length === 0) {
    console.log('Hooks: Not installed. Run: session-monitor install');
  } else {
    console.log('Hooks: Partially installed. Run: session-monitor install --force');
  }

  if (monitors.length > 0) {
    console.log(`Monitors: ${monitors.length} running`);
  } else {
    console.log('Monitors: None running. Run: session-monitor start');
  }
}

async function handleStart(options: Parameters<typeof buildWatcherConfig>[0]): Promise<void> {
  try {
    // Check if hooks are installed
    const hookStatus = await checkHooksInstalled();
    if (hookStatus.missing.length > 0) {
      console.error('Warning: Some hooks are not installed.');
      console.error('Run: session-monitor install\n');
    }

    const config = buildWatcherConfig(options);
    const watcher = new SessionWatcher(config);
    await watcher.start();
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function handleSentinel(options: SentinelConfig): Promise<void> {
  console.log('Starting sentinel daemon...\n');

  if (options.autoStart) {
    console.log('Mode: Auto-start (will automatically start monitor when needed)');
  } else {
    console.log('Mode: Notification (will show alert when monitor not running)');
  }

  if (options.verbose) {
    console.log('Verbose logging enabled\n');
  }

  const sentinel = new Sentinel(options);

  // Handle shutdown signals
  const shutdown = async () => {
    console.log('\nShutting down sentinel...');
    await sentinel.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await sentinel.start();
    console.log('Sentinel is running. Press Ctrl+C to stop.\n');
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function handleInstallStartup(options: InstallStartupOptions): Promise<void> {
  console.log('Installing LaunchAgent for sentinel...\n');

  const result = await installStartup(options);

  if (result.success) {
    console.log(`✓ ${result.message}`);
    console.log(`  Plist: ${result.plistPath}`);

    if (result.loaded) {
      console.log('  Status: Loaded and running');
    } else {
      console.log('  Status: Installed (will start on next login)');
    }

    console.log('\nThe sentinel will now run automatically when you log in.');

    if (options.autoStart) {
      console.log('Mode: Auto-start (monitor will start automatically when needed)');
    } else {
      console.log('Mode: Notification (you will be prompted to start the monitor)');
    }

    console.log('\nTo uninstall: session-monitor uninstall-startup');
  } else {
    console.error(`✗ ${result.message}`);
    process.exit(1);
  }
}

async function handleUninstallStartup(): Promise<void> {
  console.log('Uninstalling LaunchAgent for sentinel...\n');

  const result = await uninstallStartup();

  if (result.success) {
    console.log(`✓ ${result.message}`);

    if (result.unloaded) {
      console.log('  Status: Unloaded and removed');
    }
  } else {
    console.error(`✗ ${result.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
