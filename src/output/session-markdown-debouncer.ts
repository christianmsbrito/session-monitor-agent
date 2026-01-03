export interface DebouncerConfig {
  eventThreshold: number; // Default: 3
  timeThresholdMs: number; // Default: 2 minutes
}

export class SessionMarkdownDebouncer {
  private eventCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private pendingUpdate = false;
  private regenerateFn: () => Promise<void>;
  private config: DebouncerConfig;

  constructor(
    regenerateFn: () => Promise<void>,
    config: Partial<DebouncerConfig> = {}
  ) {
    this.regenerateFn = regenerateFn;
    this.config = {
      eventThreshold: config.eventThreshold ?? 3,
      timeThresholdMs: config.timeThresholdMs ?? 2 * 60 * 1000,
    };
  }

  recordEvent(): void {
    this.eventCount++;
    this.pendingUpdate = true;

    // Start timer on first event if not already running
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.trigger();
      }, this.config.timeThresholdMs);
      this.timer.unref(); // Don't keep process alive
    }

    // Check event threshold
    if (this.eventCount >= this.config.eventThreshold) {
      this.trigger();
    }
  }

  async forceUpdate(): Promise<void> {
    if (this.pendingUpdate) {
      await this.trigger();
    }
  }

  private async trigger(): Promise<void> {
    if (!this.pendingUpdate) return;

    // Clear timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Reset state
    this.eventCount = 0;
    this.pendingUpdate = false;

    // Execute regeneration
    await this.regenerateFn();
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
