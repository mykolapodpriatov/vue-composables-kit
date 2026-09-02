/**
 * `useCountdown` — a live countdown to a deadline, with a one-shot expiry hook.
 *
 * Trial banners, offer timers, auction endings and rate-limit cooldowns all
 * want the same thing: a value that ticks once a second, a formatted label, and
 * a callback the moment the deadline passes so the parent can refetch and
 * re-render without a reload.
 *
 * Three edge cases account for most of the code, and for most of the bugs in
 * hand-rolled versions:
 *
 * - **Mounting after the deadline.** Firing `onExpire` synchronously during
 *   setup makes the parent refetch while it is still initialising. The callback
 *   is deferred to a macrotask so the component finishes mounting first.
 * - **A deadline that arrives late.** The target usually comes from a request
 *   that has not resolved at mount, so it is read reactively and the countdown
 *   re-arms whenever it changes. A missing or unparseable target is an inert
 *   no-op — no interval, no callback — so the same call site works whether or
 *   not a deadline is currently set.
 * - **Firing twice.** Re-renders and a racing final tick can both reach the
 *   expiry path; `onExpire` is guarded to fire exactly once per armed target.
 *
 * The label is produced by an injectable formatter, so the composable carries
 * no locale strings of its own and drops into an i18n setup unchanged.
 *
 * @example
 * ```ts
 * const { label, expired, urgent } = useCountdown(() => user.value?.trialEndsAt, {
 *   onExpire: () => refreshUser(),
 *   format: (ms) => t('trial.remaining', { hours: Math.floor(ms / 3_600_000) }),
 * });
 * ```
 */
import {
  computed,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
} from 'vue';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Remaining time split into whole units — the input to a formatter. */
export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** Total milliseconds left, for formatters that want their own thresholds. */
  totalMs: number;
}

export type CountdownFormatter = (parts: CountdownParts) => string;

/**
 * Default, locale-free formatter: `2d 18h`, `18h 04m`, `04:09`. Coarse units
 * win because a per-second digit on a multi-day countdown is noise.
 */
export const formatCountdown: CountdownFormatter = ({ days, hours, minutes, seconds }) => {
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

export interface UseCountdownOptions {
  /**
   * Invoked exactly once when the deadline is reached. Re-arms if the target
   * changes to a new future time.
   */
  onExpire?: () => void;
  /**
   * Turn the remaining time into a display string.
   *
   * @defaultValue {@link formatCountdown}
   */
  format?: CountdownFormatter;
  /**
   * Tick interval. Lower it for a deadline inside a minute, raise it for a
   * multi-day countdown that only shows hours.
   *
   * @defaultValue `1000`
   */
  intervalMs?: number;
  /**
   * `remainingMs` below this threshold flips `urgent`, for the "hurry up"
   * visual treatment.
   *
   * @defaultValue `3600000` (one hour)
   */
  urgentBelowMs?: number;
}

export interface UseCountdownReturn {
  /** Milliseconds left. `0` when expired or when no valid target is set. */
  remainingMs: ComputedRef<number>;
  /** `true` once a valid target's time has passed. */
  expired: ComputedRef<boolean>;
  /** `true` while `remainingMs` is under `urgentBelowMs`. */
  urgent: ComputedRef<boolean>;
  /** `false` when the target is missing or unparseable. */
  valid: ComputedRef<boolean>;
  /** Remaining time split into whole units. */
  parts: ComputedRef<CountdownParts>;
  /** The formatted label. */
  label: ComputedRef<string>;
  /** Stop ticking. The computed values freeze at their current reading. */
  stop: () => void;
}

export function useCountdown(
  target: MaybeRefOrGetter<string | number | Date | null | undefined>,
  options: UseCountdownOptions = {},
): UseCountdownReturn {
  const {
    onExpire,
    format = formatCountdown,
    intervalMs = SECOND_MS,
    urgentBelowMs = HOUR_MS,
  } = options;

  /** Reactive "now", bumped on every tick while the countdown is armed. */
  const now = ref(Date.now());
  let timerId: ReturnType<typeof setInterval> | null = null;
  let deferredId: ReturnType<typeof setTimeout> | null = null;
  /** Guards `onExpire` so it fires at most once per armed target. */
  let expireNotified = false;

  const targetMs = computed(() => {
    const raw = toValue(target);
    if (raw === null || raw === undefined || raw === '') return Number.NaN;
    if (raw instanceof Date) return raw.getTime();
    if (typeof raw === 'number') return raw;
    return new Date(raw).getTime();
  });

  const valid = computed(() => Number.isFinite(targetMs.value));

  const remainingMs = computed(() =>
    valid.value ? Math.max(0, targetMs.value - now.value) : 0,
  );

  const expired = computed(() => valid.value && remainingMs.value <= 0);
  const urgent = computed(() => valid.value && remainingMs.value < urgentBelowMs);

  const parts = computed<CountdownParts>(() => {
    const totalMs = remainingMs.value;
    return {
      days: Math.floor(totalMs / DAY_MS),
      hours: Math.floor((totalMs % DAY_MS) / HOUR_MS),
      minutes: Math.floor((totalMs % HOUR_MS) / MINUTE_MS),
      seconds: Math.floor((totalMs % MINUTE_MS) / SECOND_MS),
      totalMs,
    };
  });

  const label = computed(() => format(parts.value));

  function stop(): void {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
    if (deferredId !== null) {
      clearTimeout(deferredId);
      deferredId = null;
    }
  }

  function notifyExpired(): void {
    if (expireNotified) return;
    expireNotified = true;
    stop();
    onExpire?.();
  }

  function tick(): void {
    now.value = Date.now();
    if (expired.value) notifyExpired();
  }

  /** (Re)arm for the current target. */
  function arm(): void {
    stop();
    expireNotified = false;
    now.value = Date.now();
    if (!valid.value) return;

    if (expired.value) {
      // Already past the deadline at mount. Defer the callback out of this
      // synchronous watcher pass so the parent is not asked to refetch while
      // it is still setting up.
      expireNotified = true;
      if (onExpire) {
        deferredId = setTimeout(() => {
          deferredId = null;
          onExpire();
        }, 0);
      }
      return;
    }

    timerId = setInterval(tick, intervalMs);
  }

  // `immediate` covers the initial arm; later runs handle a target that
  // arrives or changes after mount.
  watch(targetMs, arm, { immediate: true });

  onScopeDispose(stop);

  return { remainingMs, expired, urgent, valid, parts, label, stop };
}
