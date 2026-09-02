/**
 * `useEventStream` — a real-time feed that degrades instead of dying.
 *
 * A live feed has three plausible transports and every network in the world
 * breaks a different one. Corporate proxies drop WebSocket upgrades. Some
 * in-app WebViews ship a broken `EventSource`. Both can be blocked while plain
 * HTTP still works. So the composable walks a ladder — **WebSocket → SSE →
 * polling** — and stays on the best transport that actually delivers messages.
 *
 * Two failure modes get first-class treatment because they are the ones that
 * bite in production:
 *
 * 1. **Reconnect storms.** A fixed reconnect delay turns a brief backend blip
 *    into every client retrying in lockstep. Retries here use exponential
 *    backoff capped at `maxRetryDelayMs`, with optional full jitter so a fleet
 *    of clients spreads its reconnects out instead of stampeding.
 *
 * 2. **Zombie connections.** A WebSocket whose peer vanished without a close
 *    frame stays `readyState === OPEN` indefinitely: `connected` reads `true`,
 *    no error fires, and the UI quietly shows frozen data. Setting
 *    `staleAfterMs` arms a watchdog that treats "no message for N ms" as a dead
 *    connection and forces a reconnect. Most implementations of this pattern
 *    omit that check; it is why "the dashboard was stuck but nothing errored"
 *    is such a common bug report.
 *
 * Transports are opt-in: supply only the ones your backend offers, and the
 * ladder skips the rest. Every transport is optional, but at least one must be
 * configured for `start()` to do anything.
 *
 * The socket constructors are injectable (`createWebSocket` / `createEventSource`)
 * so the composable can be unit-tested without a server and used in
 * environments where the globals are absent.
 *
 * @example
 * ```ts
 * const { transport, connected, lastMessageAt } = useEventStream<Tick[]>({
 *   websocketUrl: () => `wss://api.example.com/ticks?symbols=${symbols.value}`,
 *   sseUrl: () => `https://api.example.com/ticks/stream`,
 *   poll: ({ signal }) => api.getTicks(symbols.value, { signal }),
 *   pollMs: 5_000,
 *   staleAfterMs: 30_000,
 *   onMessage: (ticks) => store.apply(ticks),
 * });
 * ```
 */
import { onScopeDispose, readonly, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue';

/** Which transport is currently carrying the feed. */
export type StreamTransport = 'websocket' | 'sse' | 'poll' | 'none';

/** Structural subset of `WebSocket` the composable relies on. */
export interface SocketLike {
  readonly readyState: number;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

/** Structural subset of `EventSource` the composable relies on. */
export interface EventSourceLike {
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
}

export interface UseEventStreamOptions<T> {
  /**
   * WebSocket URL, re-read on every (re)connect so it can pick up changed
   * subscription parameters. Return `null` to skip the WebSocket rung.
   */
  websocketUrl?: MaybeRefOrGetter<string | null>;
  /** SSE URL, same contract as {@link UseEventStreamOptions.websocketUrl}. */
  sseUrl?: MaybeRefOrGetter<string | null>;
  /**
   * Named SSE events to subscribe to, in addition to the default unnamed
   * `message` event. Servers that emit `event: tick` frames need this.
   *
   * @defaultValue `[]`
   */
  sseEvents?: string[];
  /**
   * Last-resort HTTP fetch. Resolve with a payload to emit, or `null` to emit
   * nothing for this tick.
   */
  poll?: (ctx: { signal: AbortSignal }) => Promise<T | null>;
  /**
   * Interval for the polling rung.
   *
   * @defaultValue `5000`
   */
  pollMs?: number;
  /** Called for every payload that survives {@link UseEventStreamOptions.parse}. */
  onMessage: (message: T) => void;
  /**
   * Turn a raw frame into a payload. Return `null` to ignore the frame —
   * useful for heartbeats and control messages that should not reach
   * `onMessage`. The default parses JSON strings and passes objects through.
   */
  parse?: (raw: unknown) => T | null;
  /**
   * Connect as soon as the composable runs.
   *
   * @defaultValue `true`
   */
  immediate?: boolean;
  /**
   * Reconnect attempts on the current transport before dropping to the next
   * rung of the ladder.
   *
   * @defaultValue `5`
   */
  maxRetries?: number;
  /**
   * Base delay for exponential backoff: attempt _n_ waits `retryDelayMs * 2^(n-1)`.
   *
   * @defaultValue `1000`
   */
  retryDelayMs?: number;
  /**
   * Upper bound on the backoff delay.
   *
   * @defaultValue `30000`
   */
  maxRetryDelayMs?: number;
  /**
   * Apply full jitter — sample the actual delay uniformly from `[0, computed]`
   * — so a fleet of clients does not reconnect in lockstep after an outage.
   *
   * @defaultValue `true`
   */
  jitter?: boolean;
  /**
   * Force a reconnect when no message has arrived for this many milliseconds.
   * Guards against a peer that vanished without closing the socket. Set to `0`
   * to disable the watchdog.
   *
   * @defaultValue `0` (disabled)
   */
  staleAfterMs?: number;
  /** Notified on transport failures. The composable recovers on its own. */
  onError?: (error: unknown, ctx: { transport: StreamTransport }) => void;
  /**
   * Override the `WebSocket` constructor. Lets tests drive the transport by
   * hand, and lets non-browser runtimes supply their own implementation.
   *
   * @defaultValue the global `WebSocket`
   */
  createWebSocket?: (url: string) => SocketLike;
  /**
   * Override the `EventSource` constructor.
   *
   * @defaultValue the global `EventSource`
   */
  createEventSource?: (url: string) => EventSourceLike;
}

export interface UseEventStreamReturn {
  /** Transport currently carrying the feed, or `'none'` while disconnected. */
  transport: Readonly<Ref<StreamTransport>>;
  /** `true` between a successful open and the next close/failure. */
  connected: Readonly<Ref<boolean>>;
  /** `Date.now()` of the last accepted message, or `null` if none yet. */
  lastMessageAt: Readonly<Ref<number | null>>;
  /** Consecutive failed attempts on the current transport. */
  retries: Readonly<Ref<number>>;
  /** Connect, starting again at the top of the ladder. */
  start: () => void;
  /** Disconnect and cancel every timer. Safe to call repeatedly. */
  stop: () => void;
  /** `stop()` followed by `start()` — a manual "reconnect now" button. */
  reconnect: () => void;
}

/**
 * Default frame parser: JSON strings in, objects through untouched.
 *
 * Returns `unknown` rather than a generic `T`. A type parameter that appears
 * once in a signature is an unchecked cast wearing a constraint's clothing; the
 * cast belongs where the caller's `T` is actually known, at the option default
 * below.
 */
function defaultParse(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    // A frame that is not JSON is not addressed to us — drop it rather than
    // tearing down an otherwise healthy connection.
    return null;
  }
}

export function useEventStream<T>(options: UseEventStreamOptions<T>): UseEventStreamReturn {
  const {
    websocketUrl,
    sseUrl,
    sseEvents = [],
    poll,
    pollMs = 5000,
    onMessage,
    // The one place the caller's `T` is known, so the one honest place to
    // assert it.
    parse = defaultParse as (raw: unknown) => T | null,
    immediate = true,
    maxRetries = 5,
    retryDelayMs = 1000,
    maxRetryDelayMs = 30_000,
    jitter = true,
    staleAfterMs = 0,
    onError,
    createWebSocket,
    createEventSource,
  } = options;

  const transport = ref<StreamTransport>('none');
  const connected = ref(false);
  const lastMessageAt = ref<number | null>(null);
  const retries = ref(0);

  let socket: SocketLike | null = null;
  let source: EventSourceLike | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollController: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  /** The ladder, filtered down to the transports this call site configured. */
  function rungs(): StreamTransport[] {
    const available: StreamTransport[] = [];
    if (websocketUrl !== undefined) available.push('websocket');
    if (sseUrl !== undefined) available.push('sse');
    if (poll !== undefined) available.push('poll');
    return available;
  }

  function socketFactory(url: string): SocketLike {
    if (createWebSocket) return createWebSocket(url);
    return new WebSocket(url) as unknown as SocketLike;
  }

  function sourceFactory(url: string): EventSourceLike {
    if (createEventSource) return createEventSource(url);
    return new EventSource(url) as unknown as EventSourceLike;
  }

  function clearStaleWatchdog(): void {
    if (staleTimer !== null) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
  }

  /**
   * (Re)arm the stall watchdog. Called on connect and after every accepted
   * message, so the deadline always measures silence since the last frame.
   */
  function armStaleWatchdog(): void {
    clearStaleWatchdog();
    if (staleAfterMs <= 0 || stopped) return;
    staleTimer = setTimeout(() => {
      staleTimer = null;
      if (stopped) return;
      onError?.(new Error(`No message received for ${staleAfterMs}ms`), {
        transport: transport.value,
      });
      // The socket looks open but is not delivering — treat it as a failure of
      // the current rung so the normal retry/degrade path takes over.
      failCurrentTransport();
    }, staleAfterMs);
  }

  /**
   * Deliver an already-typed payload: stamp it, re-arm the watchdog, hand it on.
   *
   * This is also where the retry counter resets — **not** on `open`.
   *
   * Resetting on open looks equivalent and is not. A zombie connection opens
   * perfectly every time; only the messages are missing. Resetting there means
   * the counter never accumulates, the ladder never degrades, and the feed
   * reconnects to the same dead transport forever while reporting itself
   * healthy. Found by watching it happen in the playground.
   *
   * A delivered message is the only evidence a transport actually works, so it
   * is the only thing that earns a clean slate.
   */
  function emit(payload: T): void {
    lastMessageAt.value = Date.now();
    retries.value = 0;
    armStaleWatchdog();
    onMessage(payload);
  }

  /**
   * Handle a raw wire frame from WebSocket or SSE. Only these two transports
   * carry unparsed data — `poll` resolves with a typed payload and goes
   * straight to {@link emit}, so a JSON-string parser is never applied to an
   * object the API client already deserialised.
   */
  function handleFrame(raw: unknown): void {
    let payload: T | null;
    try {
      payload = parse(raw);
    } catch (error: unknown) {
      onError?.(error, { transport: transport.value });
      return;
    }
    if (payload === null) return;
    emit(payload);
  }

  function teardownSocket(): void {
    if (!socket) return;
    // Null the handlers before closing so the close does not re-enter the
    // reconnect logic we are in the middle of unwinding.
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Closing an already-closed socket throws in some WebView engines.
    }
    socket = null;
  }

  function teardownSource(): void {
    if (!source) return;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    try {
      source.close();
    } catch {
      // Same defensive close as the WebSocket path.
    }
    source = null;
  }

  function teardownPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    pollController?.abort();
    pollController = null;
  }

  function teardownTransport(): void {
    teardownSocket();
    teardownSource();
    teardownPolling();
    clearStaleWatchdog();
  }

  /** Delay for the next attempt: capped exponential backoff, optionally jittered. */
  function backoffDelay(attempt: number): number {
    const exponential = Math.min(retryDelayMs * 2 ** (attempt - 1), maxRetryDelayMs);
    return jitter ? Math.random() * exponential : exponential;
  }

  /** Move to the rung after `current`, or give up if it was the last one. */
  function degrade(current: StreamTransport): void {
    const ladder = rungs();
    const next = ladder[ladder.indexOf(current) + 1];
    if (next === undefined) {
      transport.value = 'none';
      connected.value = false;
      return;
    }
    retries.value = 0;
    connect(next);
  }

  /**
   * The current rung failed. Retry it with backoff until `maxRetries`, then
   * fall through to the next transport.
   */
  function failCurrentTransport(): void {
    if (stopped) return;
    const current = transport.value;
    connected.value = false;
    teardownTransport();

    if (current === 'none') return;

    if (retries.value >= maxRetries) {
      degrade(current);
      return;
    }

    retries.value += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) connect(current);
    }, backoffDelay(retries.value));
  }

  function connectWebSocket(url: string): void {
    try {
      const ws = socketFactory(url);
      socket = ws;
      ws.onopen = () => {
        // `connected` reflects the socket, which is genuinely open. The retry
        // counter is *not* reset here — see `emit`.
        connected.value = true;
        armStaleWatchdog();
      };
      ws.onmessage = (event) => {
        handleFrame(event.data);
      };
      ws.onerror = (event) => {
        onError?.(event, { transport: 'websocket' });
        // `onclose` may or may not follow an error depending on the engine, so
        // drive the failure from here and let teardown suppress the duplicate.
        failCurrentTransport();
      };
      ws.onclose = () => {
        if (stopped) return;
        failCurrentTransport();
      };
    } catch (error: unknown) {
      onError?.(error, { transport: 'websocket' });
      failCurrentTransport();
    }
  }

  function connectSse(url: string): void {
    try {
      const es = sourceFactory(url);
      source = es;
      es.onopen = () => {
        connected.value = true;
        armStaleWatchdog();
      };
      es.onmessage = (event) => {
        handleFrame(event.data);
      };
      for (const name of sseEvents) {
        es.addEventListener(name, (event) => {
          handleFrame(event.data);
        });
      }
      es.onerror = (event) => {
        onError?.(event, { transport: 'sse' });
        failCurrentTransport();
      };
    } catch (error: unknown) {
      onError?.(error, { transport: 'sse' });
      failCurrentTransport();
    }
  }

  function connectPolling(fetcher: NonNullable<UseEventStreamOptions<T>['poll']>): void {
    connected.value = true;
    // The last rung: there is nowhere to degrade to, so the counter is moot.
    retries.value = 0;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      pollController?.abort();
      const controller = new AbortController();
      pollController = controller;
      try {
        const payload = await fetcher({ signal: controller.signal });
        // `stopped` is re-checked after the await because `stop()` can flip it
        // while the request is in flight — which is exactly what happens when a
        // component unmounts mid-poll. TypeScript narrows it to `false` from
        // the guard at the top of this function and cannot see that a closure
        // reassigns it, so the linter calls the check redundant. It is not:
        // removing it delivers a message to a disposed scope.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (controller.signal.aborted || stopped) return;
        if (payload !== null) emit(payload);
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        // Polling is the last rung — there is nowhere left to degrade to, so
        // report and keep ticking rather than tearing the feed down.
        onError?.(error, { transport: 'poll' });
      }
    };

    void tick();
    pollTimer = setInterval(() => void tick(), pollMs);
  }

  function connect(target: StreamTransport): void {
    if (stopped) return;
    teardownTransport();
    transport.value = target;

    if (target === 'websocket') {
      const url = toValue(websocketUrl) ?? null;
      if (url === null) {
        degrade('websocket');
        return;
      }
      connectWebSocket(url);
      return;
    }

    if (target === 'sse') {
      const url = toValue(sseUrl) ?? null;
      if (url === null) {
        degrade('sse');
        return;
      }
      connectSse(url);
      return;
    }

    if (target === 'poll' && poll) {
      connectPolling(poll);
      return;
    }

    transport.value = 'none';
    connected.value = false;
  }

  function start(): void {
    if (!stopped) return;
    const ladder = rungs();
    const first = ladder[0];
    if (first === undefined) return;
    stopped = false;
    retries.value = 0;
    connect(first);
  }

  function stop(): void {
    stopped = true;
    connected.value = false;
    transport.value = 'none';
    retries.value = 0;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    teardownTransport();
  }

  function reconnect(): void {
    stop();
    start();
  }

  if (immediate) start();

  onScopeDispose(stop);

  return {
    transport: readonly(transport),
    connected: readonly(connected),
    lastMessageAt: readonly(lastMessageAt),
    retries: readonly(retries),
    start,
    stop,
    reconnect,
  };
}
