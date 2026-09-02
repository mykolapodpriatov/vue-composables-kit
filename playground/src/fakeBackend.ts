/**
 * A backend that misbehaves on demand.
 *
 * The composables in this kit exist for what happens when a request is slow,
 * superseded, aborted or answered by a socket that has quietly died. A demo
 * against a healthy API shows none of that — it shows a spinner, briefly, once.
 *
 * So the playground ships a fake backend with the failures built in and under
 * the reader's control. Every scenario the README describes can be triggered
 * from a button rather than described in prose.
 */

/** Sleep, so latency is visible rather than theoretical. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface Order {
  id: number;
  customer: string;
  total: number;
  placedAt: string;
}

const CUSTOMERS = [
  'Ada Lovelace',
  'Grace Hopper',
  'Alan Turing',
  'Karen Spärck Jones',
  'Edsger Dijkstra',
];

let sequence = 1000;

function makeOrder(): Order {
  sequence += 1;
  return {
    id: sequence,
    // `?? ''` rather than a non-null assertion: the modulo cannot go out of
    // range, but an assertion here would be a habit, and habits spread.
    customer: CUSTOMERS[sequence % CUSTOMERS.length] ?? 'Unknown',
    total: Math.round((20 + (sequence % 37) * 3.5) * 100) / 100,
    placedAt: new Date().toISOString(),
  };
}

/** Knobs the demo UI turns. */
export const backend = {
  /** Artificial latency, so `loading` is observable. */
  latencyMs: 600,
  /** When true, every request rejects. */
  failing: false,
  /** When true, the next request never settles — for the abort demo. */
  hang: false,
};

/**
 * Fetch a page of orders.
 *
 * Honours the abort signal properly, because a fetcher that ignores it makes
 * the whole abort story a lie — the request would still land and still
 * overwrite newer data.
 */
export async function fetchOrders({
  signal,
}: {
  signal?: AbortSignal;
} = {}): Promise<Order[]> {
  if (backend.hang) {
    return new Promise<Order[]>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  }

  await delay(backend.latencyMs);

  if (signal?.aborted) {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }

  if (backend.failing) {
    throw new Error('The orders service is unavailable (503)');
  }

  return Array.from({ length: 4 }, makeOrder);
}

/* ------------------------------------------------------------------------ *
 * Fake transports, so the WS → SSE → polling ladder can be driven by hand.
 * ------------------------------------------------------------------------ */

export type TransportHealth = 'up' | 'down' | 'zombie';

/**
 * Per-transport health.
 *
 * `zombie` is the interesting one: the socket opens, reports itself connected,
 * and then delivers nothing. It is the failure the stall watchdog exists for,
 * and the one that cannot be demonstrated with a real server without unplugging
 * something.
 */
export const transports: Record<'websocket' | 'sse', TransportHealth> = {
  websocket: 'down',
  sse: 'down',
};

interface Handlers {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

/** Everything currently ticking, so a reset can stop all of it. */
const liveTimers = new Set<ReturnType<typeof setInterval>>();

export function stopAllFakeTransports(): void {
  for (const timer of liveTimers) clearInterval(timer);
  liveTimers.clear();
}

function scheduleMessages(handlers: Handlers, closed: () => boolean): void {
  const timer = setInterval(() => {
    if (closed()) {
      clearInterval(timer);
      liveTimers.delete(timer);
      return;
    }
    handlers.onmessage?.({ data: JSON.stringify(makeOrder()) });
  }, 1200);
  liveTimers.add(timer);
}

/** A `WebSocket` stand-in whose behaviour follows `transports.websocket`. */
export function createFakeWebSocket(url: string) {
  let closed = false;
  const socket = {
    url,
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    close(): void {
      closed = true;
      socket.readyState = 3;
    },
  } as Handlers & { url: string; readyState: number; close: () => void };

  // Asynchronous, because a synchronous open would fire before the caller has
  // finished attaching handlers.
  setTimeout(() => {
    if (closed) return;
    if (transports.websocket === 'down') {
      socket.onerror?.(new Error('WebSocket upgrade refused'));
      return;
    }
    socket.readyState = 1;
    socket.onopen?.({});
    // A zombie opens and then says nothing at all — no error, no close frame.
    if (transports.websocket === 'up') scheduleMessages(socket, () => closed);
  }, 200);

  return socket;
}

/** An `EventSource` stand-in following `transports.sse`. */
export function createFakeEventSource(url: string) {
  let closed = false;
  const source = {
    url,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    addEventListener(): void {
      // The playground's fake server emits only unnamed messages.
    },
    close(): void {
      closed = true;
    },
  } as Handlers & { url: string; addEventListener: () => void; close: () => void };

  setTimeout(() => {
    if (closed) return;
    if (transports.sse === 'down') {
      source.onerror?.(new Error('EventSource failed'));
      return;
    }
    source.onopen?.({});
    if (transports.sse === 'up') scheduleMessages(source, () => closed);
  }, 200);

  return source;
}

/** The polling rung: always works, which is the point of it being last. */
export async function pollOrders({
  signal,
}: {
  signal: AbortSignal;
}): Promise<Order | null> {
  await delay(200);
  if (signal.aborted) return null;
  return makeOrder();
}
