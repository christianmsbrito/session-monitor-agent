/**
 * Sentinel module exports
 */

export {
  Sentinel,
  getSentinelSocketPath,
  getMonitorSocketPath,
  type SentinelConfig,
  type HookEvent,
} from './sentinel.js';

export {
  installStartup,
  uninstallStartup,
  type InstallStartupOptions,
  type InstallStartupResult,
  type UninstallStartupResult,
} from './launchagent.js';
