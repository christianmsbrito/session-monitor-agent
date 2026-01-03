import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionMarkdownDebouncer } from './session-markdown-debouncer';

describe('SessionMarkdownDebouncer', () => {
  let debouncer: SessionMarkdownDebouncer;
  let regenerateFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    regenerateFn = vi.fn().mockResolvedValue(undefined);
    debouncer = new SessionMarkdownDebouncer(regenerateFn, {
      eventThreshold: 3,
      timeThresholdMs: 2 * 60 * 1000, // 2 minutes
    });
  });

  afterEach(() => {
    debouncer.destroy();
    vi.useRealTimers();
  });

  it('triggers after event threshold reached', async () => {
    debouncer.recordEvent();
    debouncer.recordEvent();
    expect(regenerateFn).not.toHaveBeenCalled();

    debouncer.recordEvent(); // 3rd event
    await vi.runAllTimersAsync();

    expect(regenerateFn).toHaveBeenCalledTimes(1);
  });

  it('triggers after time threshold', async () => {
    debouncer.recordEvent(); // Start timer

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(regenerateFn).toHaveBeenCalledTimes(1);
  });

  it('does not trigger if no events recorded', async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(regenerateFn).not.toHaveBeenCalled();
  });

  it('resets counters after trigger', async () => {
    debouncer.recordEvent();
    debouncer.recordEvent();
    debouncer.recordEvent();
    await vi.runAllTimersAsync();

    expect(regenerateFn).toHaveBeenCalledTimes(1);

    // Should need 3 more events to trigger again
    debouncer.recordEvent();
    debouncer.recordEvent();
    // Don't run timers - we're testing event threshold, not time
    expect(regenerateFn).toHaveBeenCalledTimes(1); // Still 1

    debouncer.recordEvent(); // 3rd event after reset
    await vi.runAllTimersAsync();
    expect(regenerateFn).toHaveBeenCalledTimes(2);
  });

  it('forceUpdate triggers immediately', async () => {
    debouncer.recordEvent();

    await debouncer.forceUpdate();

    expect(regenerateFn).toHaveBeenCalledTimes(1);
  });

  it('forceUpdate is no-op if no pending events', async () => {
    await debouncer.forceUpdate();

    expect(regenerateFn).not.toHaveBeenCalled();
  });

  it('clears timer on destroy', () => {
    debouncer.recordEvent();
    debouncer.destroy();

    // Timer should be cleared, so advancing time should not trigger
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(regenerateFn).not.toHaveBeenCalled();
  });
});
