/**
 * `useAsyncData` — one lifecycle for the request shape every app rewrites by hand.
 *
 * Almost every data-bound component ends up owning the same five things: an
 * `AbortController` so a superseded request cannot land after a newer one, a
 * `loading` flag, an `error` string, a `try/catch/finally`, and — sooner or
 * later — a polling interval plus its cleanup. Written inline that is ~30 lines
 * per component, and the subtle parts (abort-after-resolve, poll failures
 * clobbering good data) get re-derived slightly differently each time.
 *
 * Two variants of that shape usually coexist in a codebase and both collapse
 * into this one composable:
 *
 * 1. **One-shot / refetch-on-change.** Every call aborts the previous in-flight
 *    request and always toggles `loading`, so a spinner shows on the refresh
 *    button. On failure it surfaces `error` but keeps the last good `data`.
 *
 * 2. **Polling with stale-while-refresh.** The first load shows `loading` and
 *    surfaces `error`. Poll ticks stay in the *foreground* until the first
 *    successful fetch has populated `data` — so a failed mount keeps retrying
 *    visibly instead of freezing on an empty screen. Once data has loaded at
 *    least once, later ticks become silent background refreshes: a failed
 *    background refresh keeps the previous `data` and does not surface an
 *    error, so the UI never flickers from rendered content to an error state.
 *
 * The composable owns the controller, the interval, the visibility listener and
 * the watchers, and tears all of them down via `onScopeDispose` — no
 * `onBeforeUnmount` boilerplate at the call site.
 *
 * @example
 * ```ts
 * const { data, loading, error, refresh } = useAsyncData(
 *   ({ signal }) => fetch(`/api/orders?page=${page.value}`, { signal }).then((r) => r.json()),
 *   { pollMs: 30_000, pauseOnHidden: true, watch: [page] },
 * );
 * ```
 */
import {
  onScopeDispose,
  ref,
  watch as vueWatch,
  type Ref,
  type WatchSource,
} from 'vue';

/** Context handed to the fetcher on every invocation. */
export interface AsyncDataContext {
  /**
   * Abort signal for this attempt. Forward it to `fetch`/your API client so a
   * superseded or unmounted request is actually cancelled on the wire.
   */
  signal: AbortSignal;
  /**
   * `true` when this run is a silent background poll tick (data already
   * rendered). Useful for skipping expensive work or a loading telemetry event.
   */
  background: boolean;
}

/** The user-supplied request function. */
export type AsyncDataFetcher<T> = (ctx: AsyncDataContext) => Promise<T>;

export interface UseAsyncDataOptions<T> {
  /**
   * Fetch once as soon as the composable runs. Set `false` to drive the first
   * load yourself via `refresh()`.
   *
   * @defaultValue `true`
   */
  immediate?: boolean;
  /**
   * When greater than zero, refresh every `pollMs` milliseconds. Ticks are
   * foreground until the first success, silent background refreshes after.
   *
   * @defaultValue `0` (no polling)
   */
  pollMs?: number;
  /** Seed value for `data` before the first successful fetch. */
  initialData?: T | null;
  /**
   * Message used when a foreground failure carries no usable `message`.
   *
   * @defaultValue `'Request failed'`
   */
  fallbackError?: string;
  /**
   * Skip poll ticks while the document is hidden, and fire one immediate
   * refresh when it becomes visible again. Stops background tabs from burning
   * request quota and guarantees a fresh view the moment the user returns.
   *
   * Ignored when `pollMs` is zero.
   *
   * @defaultValue `false`
   */
  pauseOnHidden?: boolean;
  /**
   * Reactive sources that trigger a foreground refresh when they change —
   * pagination, filters, a selected id. Equivalent to a `watch` at the call
   * site, minus the abort bookkeeping.
   */
  watch?: WatchSource[];
  /**
   * Called for every non-abort failure, including silent background ones that
   * never reach `error`. The place to wire logging without turning the kit into
   * a logging framework.
   */
  onError?: (error: unknown, ctx: { background: boolean }) => void;
}

export interface UseAsyncDataReturn<T> {
  /** Last successfully fetched value, or `initialData` before the first success. */
  data: Ref<T | null>;
  /** `true` while a foreground request is in flight. Background ticks never set it. */
  loading: Ref<boolean>;
  /** Message of the most recent foreground failure, cleared by the next attempt. */
  error: Ref<string | null>;
  /** `Date.now()` of the last successful fetch, or `null` if none succeeded yet. */
  lastUpdatedAt: Ref<number | null>;
  /** Foreground refresh — always toggles `loading`, always surfaces errors. */
  refresh: () => Promise<void>;
  /** Abort the in-flight request, if any. Leaves `data` untouched. */
  abort: () => void;
}

/** Extract a human-readable message from an unknown thrown value. */
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

/**
 * `true` for the shapes an aborted request throws. Matching on `name` rather
 * than `instanceof DOMException` covers native fetch, polyfills and API clients
 * that re-wrap the abort in a plain `Error`.
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export function useAsyncData<T>(
  fetcher: AsyncDataFetcher<T>,
  options: UseAsyncDataOptions<T> = {},
): UseAsyncDataReturn<T> {
  const {
    immediate = true,
    pollMs = 0,
    initialData = null,
    fallbackError = 'Request failed',
    pauseOnHidden = false,
    watch: watchSources,
    onError,
  } = options;

  const data = ref(initialData) as Ref<T | null>;
  // Start in the loading state when we are about to fetch immediately, so the
  // first paint is a skeleton rather than a flash of empty state.
  const loading = ref(immediate);
  const error = ref<string | null>(null);
  const lastUpdatedAt = ref<number | null>(null);

  let controller: AbortController | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Flips on the first resolved fetch. Until then poll ticks stay foreground so
  // a failed initial load keeps retrying visibly instead of silently.
  let hasSucceeded = false;
  let disposed = false;

  function abort(): void {
    controller?.abort();
    controller = null;
  }

  async function run(background: boolean): Promise<void> {
    if (disposed) return;

    // A newer request supersedes any in-flight one.
    controller?.abort();
    const active = new AbortController();
    controller = active;
    const { signal } = active;

    if (!background) {
      loading.value = true;
      error.value = null;
    }

    try {
      const result = await fetcher({ signal, background });
      // Drop the result if a newer request aborted this one mid-flight —
      // otherwise a slow first request can overwrite a fast second one.
      if (signal.aborted) return;
      data.value = result;
      error.value = null;
      lastUpdatedAt.value = Date.now();
      hasSucceeded = true;
    } catch (caught: unknown) {
      if (signal.aborted || isAbortError(caught)) return;
      onError?.(caught, { background });
      // Background failures keep the last good data silently: the user is
      // looking at a rendered screen and a transient poll error must not
      // replace it with an error state.
      if (background) return;
      error.value = messageOf(caught, fallbackError);
    } finally {
      if (!background && !signal.aborted) loading.value = false;
      if (controller === active) controller = null;
    }
  }

  const refresh = (): Promise<void> => run(false);

  function tick(): void {
    if (pauseOnHidden && typeof document !== 'undefined' && document.hidden) return;
    void run(hasSucceeded);
  }

  function onVisibilityChange(): void {
    if (document.hidden) return;
    // Returning to a tab that skipped ticks: refresh now rather than waiting
    // out the remainder of the interval on stale data.
    void run(hasSucceeded);
  }

  if (immediate) void run(false);

  if (pollMs > 0) {
    pollTimer = setInterval(tick, pollMs);
    if (pauseOnHidden && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  }

  const stopWatch =
    watchSources && watchSources.length > 0
      ? vueWatch(watchSources, () => void run(false))
      : null;

  onScopeDispose(() => {
    disposed = true;
    abort();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (pollMs > 0 && pauseOnHidden && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    stopWatch?.();
  });

  return { data, loading, error, lastUpdatedAt, refresh, abort };
}
