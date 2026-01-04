/**
 * CLI argument parsing
 */

import { Command } from 'commander';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_CONFIG } from '../types/index.js';
import type { WatcherConfig } from '../watcher/index.js';

export interface WatchOptions {
  output: string;
  apiKey?: string;
  model: string;
  verbose: boolean;
  maxQueue: number;
  batchSize: number;
  flushInterval: number;
  socketPath?: string;
  scope?: string;
}

export interface InstallOptions {
  force: boolean;
  verbose: boolean;
  debug: boolean;
}

export interface ParsedStartArgs {
  command: 'start';
  options: WatchOptions;
}

export interface ParsedInstallArgs {
  command: 'install';
  options: InstallOptions;
}

export interface ParsedUninstallArgs {
  command: 'uninstall';
  options: { verbose: boolean };
}

export interface ParsedStatusArgs {
  command: 'status';
}

export interface ParsedHelpArgs {
  command: 'help';
}

export interface SentinelOptions {
  autoStart: boolean;
  verbose: boolean;
}

export interface ParsedSentinelArgs {
  command: 'sentinel';
  options: SentinelOptions;
}

export interface InstallStartupOptions {
  autoStart: boolean;
  verbose: boolean;
}

export interface ParsedInstallStartupArgs {
  command: 'install-startup';
  options: InstallStartupOptions;
}

export interface ParsedUninstallStartupArgs {
  command: 'uninstall-startup';
}

export type ParsedArgs =
  | ParsedStartArgs
  | ParsedInstallArgs
  | ParsedUninstallArgs
  | ParsedStatusArgs
  | ParsedHelpArgs
  | ParsedSentinelArgs
  | ParsedInstallStartupArgs
  | ParsedUninstallStartupArgs;

// Default socket path
const DEFAULT_SOCKET_PATH = path.join(os.tmpdir(), 'session-monitor.sock');

export function parseArgs(argv: string[]): ParsedArgs {
  const program = new Command();

  program
    .name('session-monitor')
    .description(
      'Background documentation agent that watches Claude Code sessions via hooks'
    )
    .version('0.1.0');

  // Start command - main daemon
  program
    .command('start')
    .description('Start the session monitor daemon')
    .option(
      '-o, --output <dir>',
      'Output directory for documentation',
      DEFAULT_CONFIG.outputDir
    )
    .option(
      '-k, --api-key <key>',
      'Anthropic API key (or set ANTHROPIC_API_KEY)'
    )
    .option(
      '-m, --model <model>',
      'Model for documentation agent',
      DEFAULT_CONFIG.docModel
    )
    .option('-v, --verbose', 'Enable verbose logging', false)
    .option(
      '--max-queue <n>',
      'Maximum message queue size',
      String(DEFAULT_CONFIG.maxQueueSize)
    )
    .option(
      '--batch-size <n>',
      'Messages per batch',
      String(DEFAULT_CONFIG.batchSize)
    )
    .option(
      '--flush-interval <ms>',
      'Flush interval in milliseconds',
      String(DEFAULT_CONFIG.flushIntervalMs)
    )
    .option(
      '--socket <path>',
      'Unix socket path',
      DEFAULT_SOCKET_PATH
    )
    .option(
      '--scope <dir>',
      'Directory scope for this monitor (default: current directory)'
    )
    .action((opts) => {
      program.setOptionValue('_parsed', {
        command: 'start',
        options: {
          output: opts.output,
          apiKey: opts.apiKey,
          model: opts.model,
          verbose: opts.verbose,
          maxQueue: parseInt(opts.maxQueue, 10),
          batchSize: parseInt(opts.batchSize, 10),
          flushInterval: parseInt(opts.flushInterval, 10),
          socketPath: opts.socket,
          scope: opts.scope,
        },
      });
    });

  // Install hooks command
  program
    .command('install')
    .description('Install Claude Code hooks for session monitoring')
    .option('-f, --force', 'Overwrite existing hooks', false)
    .option('-v, --verbose', 'Enable verbose logging', false)
    .option('-d, --debug', 'Enable debug logging in hooks (writes to system temp directory)', false)
    .action((opts) => {
      program.setOptionValue('_parsed', {
        command: 'install',
        options: {
          force: opts.force,
          verbose: opts.verbose,
          debug: opts.debug,
        },
      });
    });

  // Uninstall hooks command
  program
    .command('uninstall')
    .description('Remove session-monitor hooks from Claude Code')
    .option('-v, --verbose', 'Enable verbose logging', false)
    .action((opts) => {
      program.setOptionValue('_parsed', {
        command: 'uninstall',
        options: {
          verbose: opts.verbose,
        },
      });
    });

  // Status command
  program
    .command('status')
    .description('Check if hooks are installed')
    .action(() => {
      program.setOptionValue('_parsed', {
        command: 'status',
      });
    });

  // Sentinel command - lightweight daemon for session start alerts
  program
    .command('sentinel')
    .description('Run the sentinel daemon (alerts when monitor is not running)')
    .option('-a, --auto-start', 'Auto-start the monitor instead of showing notification', false)
    .option('-v, --verbose', 'Enable verbose logging', false)
    .action((opts) => {
      program.setOptionValue('_parsed', {
        command: 'sentinel',
        options: {
          autoStart: opts.autoStart,
          verbose: opts.verbose,
        },
      });
    });

  // Install startup (LaunchAgent) command
  program
    .command('install-startup')
    .description('Install LaunchAgent to auto-start sentinel on login (macOS)')
    .option('-a, --auto-start', 'Configure sentinel to auto-start the monitor', false)
    .option('-v, --verbose', 'Enable verbose logging in sentinel', false)
    .action((opts) => {
      program.setOptionValue('_parsed', {
        command: 'install-startup',
        options: {
          autoStart: opts.autoStart,
          verbose: opts.verbose,
        },
      });
    });

  // Uninstall startup (LaunchAgent) command
  program
    .command('uninstall-startup')
    .description('Remove LaunchAgent for sentinel (macOS)')
    .action(() => {
      program.setOptionValue('_parsed', {
        command: 'uninstall-startup',
      });
    });

  program.parse(argv);

  const parsed = program.getOptionValue('_parsed');

  if (!parsed) {
    return { command: 'help' };
  }

  return parsed;
}

export function buildWatcherConfig(options: WatchOptions): WatcherConfig {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error(
      'Error: ANTHROPIC_API_KEY environment variable or --api-key option required'
    );
    process.exit(1);
  }

  // Resolve output directory to absolute path
  const outputDir = path.isAbsolute(options.output)
    ? options.output
    : path.resolve(process.cwd(), options.output);

  // Resolve scope directory to absolute path (default: cwd)
  const scopeDirectory = options.scope
    ? (path.isAbsolute(options.scope)
        ? options.scope
        : path.resolve(process.cwd(), options.scope))
    : process.cwd();

  return {
    socketPath: options.socketPath,
    outputDir,
    scopeDirectory,
    maxQueueSize: options.maxQueue,
    batchSize: options.batchSize,
    flushIntervalMs: options.flushInterval,
    maxRecentMessages: DEFAULT_CONFIG.maxRecentMessages,
    summarizeAfter: DEFAULT_CONFIG.summarizeAfter,
    apiKey,
    docModel: options.model,
    verbose: options.verbose,
  };
}

export function printUsage(): void {
  console.log(`
session-monitor - Background documentation agent for Claude Code sessions

USAGE:
  session-monitor <command> [options]

COMMANDS:
  install           Install Claude Code hooks for session monitoring
  uninstall         Remove session-monitor hooks from Claude Code
  status            Check if hooks are installed
  start             Start the session monitor daemon
  sentinel          Run the sentinel daemon (alerts when monitor not running)
  install-startup   Install LaunchAgent to auto-start sentinel on login (macOS)
  uninstall-startup Remove LaunchAgent for sentinel (macOS)

QUICK START:
  1. Install the hooks:
     session-monitor install

  2. Start the monitor daemon (in a separate terminal):
     session-monitor start

  3. Use Claude Code normally - sessions will be documented automatically

AUTOMATIC STARTUP (macOS):
  # Install sentinel to run at login (shows alert if monitor not running)
  session-monitor install-startup

  # Or with auto-start (automatically starts monitor when needed)
  session-monitor install-startup --auto-start

  # Remove the startup agent
  session-monitor uninstall-startup

OPTIONS (for 'start' command):
  -o, --output <dir>       Output directory for docs (default: .session-docs)
  --scope <dir>            Directory scope for this monitor (default: cwd)
  -k, --api-key <key>      Anthropic API key (or set ANTHROPIC_API_KEY)
  -m, --model <model>      Model for doc agent (default: claude-3-haiku-20240307)
  -v, --verbose            Enable verbose logging
  --socket <path>          Unix socket path (default: /tmp/session-monitor.sock)
  --max-queue <n>          Max message queue size (default: 1000)
  --batch-size <n>         Messages per batch (default: 10)
  --flush-interval <ms>    Flush interval in ms (default: 5000)

OPTIONS (for 'install' command):
  -f, --force              Overwrite existing hooks
  -v, --verbose            Enable verbose logging

OPTIONS (for 'sentinel' command):
  -a, --auto-start         Auto-start monitor instead of showing notification
  -v, --verbose            Enable verbose logging

OPTIONS (for 'install-startup' command):
  -a, --auto-start         Configure sentinel to auto-start the monitor
  -v, --verbose            Enable verbose logging in sentinel

EXAMPLES:
  # Install hooks
  session-monitor install

  # Start monitor with verbose output
  session-monitor start -v

  # Start with custom output directory
  session-monitor start -o ./my-docs

  # Check hook status
  session-monitor status

  # Uninstall hooks
  session-monitor uninstall

  # Run sentinel manually
  session-monitor sentinel -v

  # Install sentinel to run at login
  session-monitor install-startup

  # Install with auto-start mode
  session-monitor install-startup --auto-start
`);
}
