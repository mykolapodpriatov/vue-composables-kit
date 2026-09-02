# useEventStream

A real-time feed that degrades instead of dying.

```ts
const { transport, connected, lastMessageAt, retries, start, stop, reconnect } =
  useEventStream<Tick[]>({
    websocketUrl: () => `wss://api.example.com/ticks?symbols=${symbols.value}`,
    sseUrl: () => 'https://api.example.com/ticks/stream',
    poll: ({ signal }) => api.getTicks(symbols.value, { signal }),
    staleAfterMs: 30_000,
    onMessage: (ticks) => store.apply(ticks),
  });
```

## The ladder

```
WebSocket  ──fails──►  SSE  ──fails──►  polling
```

Every network breaks a different one: corporate proxies drop WebSocket
upgrades, some in-app WebViews ship a broken `EventSource`, and both can be
blocked while plain HTTP still works.

Transports are opt-in. Supply only the ones your backend offers and the ladder
skips the rest; a URL getter returning `null` skips that rung at runtime, which
is how a feature flag turns WebSocket off without a rebuild.

## Options

| Option | Default | |
|---|---|---|
| `websocketUrl` | — | Re-read on every reconnect. `null` skips the rung |
| `sseUrl` | — | Same contract |
| `sseEvents` | `[]` | Named SSE events to subscribe to |
| `poll` | — | Last-resort fetch. Resolve `null` to emit nothing |
| `pollMs` | `5000` | Polling interval |
| `onMessage` | required | Called for every accepted payload |
| `parse` | JSON | Return `null` to drop a frame — heartbeats, control messages |
| `immediate` | `true` | Connect as soon as the composable runs |
| `maxRetries` | `5` | Attempts on a rung before dropping to the next |
| `retryDelayMs` | `1000` | Backoff base: attempt _n_ waits `base × 2^(n-1)` |
| `maxRetryDelayMs` | `30000` | Ceiling |
| `jitter` | `true` | Sample the delay from `[0, computed]` |
| `staleAfterMs` | `0` | Force a reconnect after this much silence. `0` disables |
| `onError` | — | Transport failures. The composable recovers on its own |
| `createWebSocket` | global | Injectable constructor, for tests |
| `createEventSource` | global | Injectable constructor, for tests |

## The stall watchdog

A WebSocket whose peer vanished without a close frame stays `readyState === OPEN`
indefinitely. `connected` reads `true`, no error fires, and the UI quietly shows
frozen data.

There is no event to listen for, because the absence of events *is* the signal.

```
Socket OPEN
   ├── message arrives  ──►  healthy, deadline re-armed
   └── silence for staleAfterMs
              ▼
        treated as dead ──► close ──► backoff ──► reconnect ──► degrade
```

Set `staleAfterMs` generously relative to your feed's quietest period. A feed
that legitimately goes silent for a minute needs a deadline longer than a
minute, or the watchdog will reconnect a healthy connection.

## Why jitter

A fixed reconnect delay turns a brief backend blip into every client retrying in
lockstep, arriving together, and knocking the service over again as it recovers.
Full jitter samples each client's delay from `[0, computed]`, spreading the
stampede out.

## `retries` resets on a message, not on `open`

Opening proves a socket connects. Only a message proves it works.

That distinction is the entire zombie case, and getting it wrong was a real bug
in this library: resetting on `open` meant the counter never accumulated for a
connection that opened perfectly and delivered nothing, so the ladder never
degraded. See [Why this exists](/guide/why#a-worked-example-of-getting-it-almost-right).
