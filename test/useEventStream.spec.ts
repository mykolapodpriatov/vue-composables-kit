import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useEventStream,
  type EventSourceLike,
  type SocketLike,
} from '../src/realtime/useEventStream.js';
import { withScope } from './helpers.js';

/**
 * Hand-drivable stand-ins for the two push transports. Real `WebSocket` and
 * `EventSource` need a server and a lot of patience; these expose `open()`,
 * `emit()`, `fail()` and `remoteClose()` so a test can put the ladder in any
 * state in one line.
 */
class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(): void {
    this.onerror?.(new Error('socket error'));
  }

  remoteClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

class FakeSource implements EventSourceLike {
  static instances: FakeSource[] = [];

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(readonly url: string) {
    FakeSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  open(): void {
    this.onopen?.({});
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitNamed(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  fail(): void {
    this.onerror?.(new Error('sse error'));
  }

  close(): void {
    this.closed = true;
  }
}

const createWebSocket = (url: string): SocketLike => new FakeSocket(url);
const createEventSource = (url: string): EventSourceLike => new FakeSource(url);

/** The socket the composable most recently constructed. */
function latestSocket(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error('no socket was created');
  return socket;
}

function latestSource(): FakeSource {
  const source = FakeSource.instances.at(-1);
  if (!source) throw new Error('no event source was created');
  return source;
}

describe('useEventStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    FakeSource.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('transport ladder', () => {
    it('starts on the WebSocket rung when a URL is supplied', () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          onMessage: () => {},
          createWebSocket,
        }),
      );
      expect(value.transport.value).toBe('websocket');
      expect(latestSocket().url).toBe('wss://example.test/feed');
      dispose();
    });

    it('skips a rung whose URL resolves to null', () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => null,
          sseUrl: () => 'https://example.test/sse',
          onMessage: () => {},
          createWebSocket,
          createEventSource,
        }),
      );
      expect(value.transport.value).toBe('sse');
      expect(FakeSocket.instances).toHaveLength(0);
      dispose();
    });

    it('starts on polling when it is the only transport configured', async () => {
      const poll = vi.fn(() => Promise.resolve('tick'));
      const onMessage = vi.fn();
      const { value, dispose } = withScope(() =>
        useEventStream<string>({ poll, pollMs: 1000, onMessage }),
      );

      expect(value.transport.value).toBe('poll');
      await vi.advanceTimersByTimeAsync(0);
      expect(onMessage).toHaveBeenCalledWith('tick');

      await vi.advanceTimersByTimeAsync(2000);
      expect(poll).toHaveBeenCalledTimes(3);
      dispose();
    });

    it('does nothing when no transport is configured', () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({ onMessage: () => {} }),
      );
      expect(value.transport.value).toBe('none');
      expect(value.connected.value).toBe(false);
      dispose();
    });

    it('degrades WebSocket → SSE → polling once retries are exhausted', async () => {
      const poll = vi.fn(() => Promise.resolve(null));
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          sseUrl: () => 'https://example.test/sse',
          poll,
          maxRetries: 1,
          retryDelayMs: 100,
          jitter: false,
          onMessage: () => {},
          createWebSocket,
          createEventSource,
        }),
      );

      expect(value.transport.value).toBe('websocket');

      // First failure schedules one retry on the same rung.
      latestSocket().fail();
      expect(value.retries.value).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(value.transport.value).toBe('websocket');

      // Second failure exhausts maxRetries and drops to SSE.
      latestSocket().fail();
      expect(value.transport.value).toBe('sse');

      latestSource().fail();
      await vi.advanceTimersByTimeAsync(100);
      latestSource().fail();
      expect(value.transport.value).toBe('poll');
      dispose();
    });

    it('lands on none when the last rung is exhausted', () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          maxRetries: 0,
          onMessage: () => {},
          createWebSocket,
        }),
      );
      latestSocket().fail();
      expect(value.transport.value).toBe('none');
      expect(value.connected.value).toBe(false);
      dispose();
    });
  });

  describe('messages', () => {
    it('parses JSON frames by default', () => {
      const onMessage = vi.fn();
      const { dispose } = withScope(() =>
        useEventStream<{ price: number }>({
          websocketUrl: () => 'wss://example.test/feed',
          onMessage,
          createWebSocket,
        }),
      );
      latestSocket().open();
      latestSocket().emit('{"price":42}');
      expect(onMessage).toHaveBeenCalledWith({ price: 42 });
      dispose();
    });

    it('drops frames that a custom parser rejects', () => {
      const onMessage = vi.fn();
      const { dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          parse: (raw) => (raw === 'heartbeat' ? null : String(raw)),
          onMessage,
          createWebSocket,
        }),
      );
      latestSocket().open();
      latestSocket().emit('heartbeat');
      expect(onMessage).not.toHaveBeenCalled();

      latestSocket().emit('payload');
      expect(onMessage).toHaveBeenCalledWith('payload');
      dispose();
    });

    it('keeps the connection alive when a frame is malformed', () => {
      const onMessage = vi.fn();
      const { value, dispose } = withScope(() =>
        useEventStream<unknown>({
          websocketUrl: () => 'wss://example.test/feed',
          onMessage,
          createWebSocket,
        }),
      );
      latestSocket().open();
      latestSocket().emit('not json at all {');
      expect(onMessage).not.toHaveBeenCalled();
      expect(value.connected.value).toBe(true);
      dispose();
    });

    it('reports a throwing parser without dropping the connection', () => {
      const onError = vi.fn();
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          parse: () => {
            throw new Error('parser blew up');
          },
          onMessage: () => {},
          onError,
          createWebSocket,
        }),
      );
      latestSocket().open();
      latestSocket().emit('anything');
      expect(onError).toHaveBeenCalledWith(expect.any(Error), { transport: 'websocket' });
      expect(value.connected.value).toBe(true);
      dispose();
    });

    it('records the timestamp of the last accepted message', () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          parse: (raw) => String(raw),
          onMessage: () => {},
          createWebSocket,
        }),
      );
      expect(value.lastMessageAt.value).toBeNull();
      latestSocket().open();
      latestSocket().emit('hi');
      expect(value.lastMessageAt.value).toBeTypeOf('number');
      dispose();
    });

    it('subscribes to named SSE events', () => {
      const onMessage = vi.fn();
      const { dispose } = withScope(() =>
        useEventStream<string>({
          sseUrl: () => 'https://example.test/sse',
          sseEvents: ['tick'],
          parse: (raw) => String(raw),
          onMessage,
          createEventSource,
        }),
      );
      latestSource().open();
      latestSource().emitNamed('tick', 'named-payload');
      expect(onMessage).toHaveBeenCalledWith('named-payload');
      dispose();
    });
  });

  describe('backoff', () => {
    it('grows the delay exponentially and caps it', async () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          maxRetries: 5,
          retryDelayMs: 100,
          maxRetryDelayMs: 250,
          jitter: false,
          onMessage: () => {},
          createWebSocket,
        }),
      );

      // Attempt 1 waits 100ms.
      latestSocket().fail();
      await vi.advanceTimersByTimeAsync(99);
      expect(FakeSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances).toHaveLength(2);

      // Attempt 2 waits 200ms.
      latestSocket().fail();
      await vi.advanceTimersByTimeAsync(199);
      expect(FakeSocket.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances).toHaveLength(3);

      // Attempt 3 would be 400ms but is capped at maxRetryDelayMs = 250ms.
      latestSocket().fail();
      await vi.advanceTimersByTimeAsync(250);
      expect(FakeSocket.instances).toHaveLength(4);
      expect(value.retries.value).toBe(3);
      dispose();
    });

    it('samples the delay below the ceiling when jitter is on', async () => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
      const { dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          maxRetries: 3,
          retryDelayMs: 1000,
          jitter: true,
          onMessage: () => {},
          createWebSocket,
        }),
      );

      latestSocket().fail();
      // Full jitter with random() = 0.25 turns the 1000ms delay into 250ms.
      await vi.advanceTimersByTimeAsync(250);
      expect(FakeSocket.instances).toHaveLength(2);

      random.mockRestore();
      dispose();
    });

    it('resets the retry counter after a successful open', async () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          maxRetries: 5,
          retryDelayMs: 10,
          jitter: false,
          onMessage: () => {},
          createWebSocket,
        }),
      );

      latestSocket().fail();
      expect(value.retries.value).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      latestSocket().open();
      expect(value.retries.value).toBe(0);
      dispose();
    });
  });

  describe('stall watchdog', () => {
    it('forces a reconnect when no message arrives within staleAfterMs', async () => {
      const onError = vi.fn();
      const { dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          staleAfterMs: 5000,
          retryDelayMs: 10,
          jitter: false,
          onMessage: () => {},
          onError,
          createWebSocket,
        }),
      );

      latestSocket().open();
      expect(FakeSocket.instances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(onError).toHaveBeenCalledWith(expect.any(Error), { transport: 'websocket' });

      await vi.advanceTimersByTimeAsync(10);
      expect(FakeSocket.instances).toHaveLength(2);
      dispose();
    });

    it('re-arms the deadline on every message', async () => {
      const { dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          staleAfterMs: 1000,
          parse: (raw) => String(raw),
          onMessage: () => {},
          createWebSocket,
        }),
      );

      latestSocket().open();
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(900);
        latestSocket().emit('still alive');
      }
      // 4.5s of wall clock, never 1s of silence — no reconnect.
      expect(FakeSocket.instances).toHaveLength(1);
      dispose();
    });

    it('stays disabled when staleAfterMs is zero', async () => {
      const { dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          staleAfterMs: 0,
          onMessage: () => {},
          createWebSocket,
        }),
      );
      latestSocket().open();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(FakeSocket.instances).toHaveLength(1);
      dispose();
    });
  });

  describe('lifecycle', () => {
    it('reconnects on a remote close', async () => {
      const { dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          retryDelayMs: 10,
          jitter: false,
          onMessage: () => {},
          createWebSocket,
        }),
      );
      latestSocket().open();
      latestSocket().remoteClose();
      await vi.advanceTimersByTimeAsync(10);
      expect(FakeSocket.instances).toHaveLength(2);
      dispose();
    });

    it('does not connect when immediate is false', () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          immediate: false,
          onMessage: () => {},
          createWebSocket,
        }),
      );
      expect(FakeSocket.instances).toHaveLength(0);

      value.start();
      expect(FakeSocket.instances).toHaveLength(1);
      dispose();
    });

    it('stop() closes the socket and cancels pending retries', async () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          retryDelayMs: 100,
          jitter: false,
          onMessage: () => {},
          createWebSocket,
        }),
      );
      const socket = latestSocket();
      socket.open();
      socket.remoteClose();

      value.stop();
      expect(value.transport.value).toBe('none');
      expect(value.connected.value).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeSocket.instances).toHaveLength(1);
      dispose();
    });

    it('reconnect() restarts from the top of the ladder', () => {
      const { value, dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          sseUrl: () => 'https://example.test/sse',
          maxRetries: 0,
          onMessage: () => {},
          createWebSocket,
          createEventSource,
        }),
      );
      latestSocket().fail();
      expect(value.transport.value).toBe('sse');

      value.reconnect();
      expect(value.transport.value).toBe('websocket');
      dispose();
    });

    it('closes the socket and stops polling on scope dispose', async () => {
      const poll = vi.fn(() => Promise.resolve(null));
      const { dispose } = withScope(() =>
        useEventStream<string>({
          websocketUrl: () => 'wss://example.test/feed',
          poll,
          pollMs: 100,
          onMessage: () => {},
          createWebSocket,
        }),
      );
      const socket = latestSocket();
      socket.open();

      dispose();
      expect(socket.closed).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(poll).not.toHaveBeenCalled();
    });

    it('keeps polling after a failed tick — there is nowhere left to degrade', async () => {
      const onError = vi.fn();
      const poll = vi.fn(() => Promise.reject(new Error('offline')));
      const { value, dispose } = withScope(() =>
        useEventStream<string>({ poll, pollMs: 100, onMessage: () => {}, onError }),
      );

      await vi.advanceTimersByTimeAsync(350);
      expect(onError).toHaveBeenCalledWith(expect.any(Error), { transport: 'poll' });
      expect(value.transport.value).toBe('poll');
      expect(poll.mock.calls.length).toBeGreaterThan(2);
      dispose();
    });
  });
});
