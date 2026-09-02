import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCountdown, useCountdown } from '../src/lifecycle/useCountdown.js';
import { useToastQueue } from '../src/lifecycle/useToastQueue.js';
import { withScope } from './helpers.js';

describe('formatCountdown', () => {
  const parts = (days: number, hours: number, minutes: number, seconds: number) => ({
    days,
    hours,
    minutes,
    seconds,
    totalMs: 0,
  });

  it('shows days and hours for a multi-day countdown', () => {
    // A per-second digit on a three-day countdown is noise nobody reads.
    expect(formatCountdown(parts(2, 18, 30, 5))).toBe('2d 18h');
  });

  it('shows hours and padded minutes under a day', () => {
    expect(formatCountdown(parts(0, 18, 4, 5))).toBe('18h 04m');
  });

  it('shows padded minutes and seconds under an hour', () => {
    expect(formatCountdown(parts(0, 0, 4, 9))).toBe('04:09');
  });

  it('shows zeroes rather than an empty string at expiry', () => {
    expect(formatCountdown(parts(0, 0, 0, 0))).toBe('00:00');
  });
});

describe('useCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const inFuture = (ms: number): string => new Date(Date.now() + ms).toISOString();

  it('counts down to a deadline', () => {
    const { value, dispose } = withScope(() => useCountdown(inFuture(90_000)));
    expect(value.remainingMs.value).toBeGreaterThan(89_000);
    expect(value.expired.value).toBe(false);
    dispose();
  });

  it('ticks once a second', () => {
    const { value, dispose } = withScope(() => useCountdown(inFuture(60_000)));
    const before = value.remainingMs.value;
    vi.advanceTimersByTime(2000);
    expect(value.remainingMs.value).toBeLessThan(before);
    dispose();
  });

  it('fires onExpire exactly once when the deadline passes', () => {
    const onExpire = vi.fn();
    const { dispose } = withScope(() => useCountdown(inFuture(2000), { onExpire }));

    vi.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);

    // Re-renders and a racing final tick can both reach the expiry path.
    vi.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('defers onExpire when the deadline is already past at mount', () => {
    // Firing synchronously during setup makes the parent refetch while it is
    // still initialising.
    const onExpire = vi.fn();
    const { dispose } = withScope(() => useCountdown(inFuture(-1000), { onExpire }));

    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('re-arms when the target arrives after mount', () => {
    // The deadline usually comes from a request that has not resolved yet.
    const target = ref<string | null>(null);
    const { value, dispose } = withScope(() => useCountdown(target));

    expect(value.valid.value).toBe(false);
    target.value = inFuture(60_000);
    vi.advanceTimersByTime(1);

    expect(value.valid.value).toBe(true);
    expect(value.remainingMs.value).toBeGreaterThan(0);
    dispose();
  });

  it('is an inert no-op with no target', () => {
    const onExpire = vi.fn();
    const { value, dispose } = withScope(() => useCountdown(null, { onExpire }));

    expect(value.valid.value).toBe(false);
    expect(value.remainingMs.value).toBe(0);
    expect(value.expired.value).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    dispose();
  });

  it.each([
    ['an empty string', ''],
    ['nonsense', 'not-a-date'],
    ['undefined', undefined],
  ])('treats %s as no target', (_label, target) => {
    const { value, dispose } = withScope(() => useCountdown(target));
    expect(value.valid.value).toBe(false);
    dispose();
  });

  it('accepts a Date and an epoch number', () => {
    const asDate = withScope(() => useCountdown(new Date(Date.now() + 60_000)));
    const asNumber = withScope(() => useCountdown(Date.now() + 60_000));
    expect(asDate.value.valid.value).toBe(true);
    expect(asNumber.value.valid.value).toBe(true);
    asDate.dispose();
    asNumber.dispose();
  });

  it('flags urgency under the threshold', () => {
    const { value, dispose } = withScope(() =>
      useCountdown(inFuture(30_000), { urgentBelowMs: 60_000 }),
    );
    expect(value.urgent.value).toBe(true);
    dispose();
  });

  it('splits the remaining time into whole units', () => {
    const { value, dispose } = withScope(() =>
      useCountdown(inFuture(2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000 + 5000)),
    );
    expect(value.parts.value).toMatchObject({ days: 2, hours: 3, minutes: 4 });
    dispose();
  });

  it('uses an injected formatter, so the kit carries no locale strings', () => {
    const { value, dispose } = withScope(() =>
      useCountdown(inFuture(3_600_000), { format: ({ hours }) => `${hours} часов` }),
    );
    expect(value.label.value).toBe('1 часов');
    dispose();
  });

  it('stops ticking once the scope is disposed', () => {
    const { value, dispose } = withScope(() => useCountdown(inFuture(600_000)));
    dispose();
    const frozen = value.remainingMs.value;
    vi.advanceTimersByTime(10_000);
    expect(value.remainingMs.value).toBe(frozen);
  });
});

describe('useToastQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues a toast', () => {
    const { value, dispose } = withScope(() => useToastQueue());
    value.push({ title: 'Saved' });
    expect(value.toasts.value).toHaveLength(1);
    expect(value.toasts.value[0]).toMatchObject({ title: 'Saved', kind: 'info' });
    dispose();
  });

  it('auto-dismisses after the default duration', () => {
    const { value, dispose } = withScope(() => useToastQueue({ defaultDuration: 1000 }));
    value.push({ title: 'Saved' });
    vi.advanceTimersByTime(1001);
    expect(value.toasts.value).toHaveLength(0);
    dispose();
  });

  it('keeps an error until it is dismissed', () => {
    // The message a user most needs to read is the one most likely to appear
    // while they are looking elsewhere.
    const { value, dispose } = withScope(() => useToastQueue({ defaultDuration: 100 }));
    value.push({ title: 'Failed', kind: 'error' });
    vi.advanceTimersByTime(60_000);
    expect(value.toasts.value).toHaveLength(1);
    dispose();
  });

  it('honours an explicit duration on an error', () => {
    const { value, dispose } = withScope(() => useToastQueue());
    value.push({ title: 'Failed', kind: 'error', duration: 500 });
    vi.advanceTimersByTime(501);
    expect(value.toasts.value).toHaveLength(0);
    dispose();
  });

  it('drops the oldest past the cap, not the newest', () => {
    // The most recent message is almost always the one describing what the
    // user just did.
    const { value, dispose } = withScope(() => useToastQueue({ max: 2 }));
    value.push({ title: 'first' });
    value.push({ title: 'second' });
    value.push({ title: 'third' });

    expect(value.toasts.value.map((t) => t.title)).toEqual(['second', 'third']);
    dispose();
  });

  it('dismisses by id', () => {
    const { value, dispose } = withScope(() => useToastQueue());
    const id = value.push({ title: 'a' });
    value.push({ title: 'b' });

    value.dismiss(id);
    expect(value.toasts.value.map((t) => t.title)).toEqual(['b']);
    dispose();
  });

  it('dismisses the right toast when ids are not positions', () => {
    // Removing by index is how a timer firing mid-iteration deletes the
    // neighbour instead.
    const { value, dispose } = withScope(() => useToastQueue());
    const first = value.push({ title: 'a' });
    value.push({ title: 'b' });
    value.push({ title: 'c' });

    value.dismiss(first);
    value.dismiss(first); // already gone — must be a no-op, not an error
    expect(value.toasts.value.map((t) => t.title)).toEqual(['b', 'c']);
    dispose();
  });

  it('clears everything', () => {
    const { value, dispose } = withScope(() => useToastQueue());
    value.push({ title: 'a' });
    value.push({ title: 'b' });
    value.clear();
    expect(value.toasts.value).toHaveLength(0);
    dispose();
  });

  it('cancels the timer of an evicted toast', () => {
    // Otherwise a timer fires for a toast that is already gone, and its id may
    // have been reused by nothing — a wasted wake-up at best.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { value, dispose } = withScope(() => useToastQueue({ max: 1 }));
    value.push({ title: 'first' });
    value.push({ title: 'second' });

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
    dispose();
  });

  it('cancels every pending timer on scope dispose', () => {
    // A queue that outlives its component keeps timers alive, and each timer
    // keeps the closure — and the component — alive with it.
    const { value, dispose } = withScope(() => useToastQueue({ defaultDuration: 5000 }));
    value.push({ title: 'a' });
    value.push({ title: 'b' });

    dispose();
    expect(value.toasts.value).toHaveLength(0);

    // Nothing left to fire.
    expect(() => {
      vi.advanceTimersByTime(10_000);
    }).not.toThrow();
  });

  it('gives each queue its own ids, so two regions cannot collide', () => {
    // The reason this is per-scope rather than a module-level singleton.
    const a = withScope(() => useToastQueue());
    const b = withScope(() => useToastQueue());

    a.value.push({ title: 'a1' });
    b.value.push({ title: 'b1' });

    expect(a.value.toasts.value).toHaveLength(1);
    expect(b.value.toasts.value).toHaveLength(1);
    a.dispose();
    b.dispose();
  });
});
