# vue-composables-kit

Production-hardened Vue 3 composables for the messy parts of async UI: aborts,
polling, transport fallback, TTL caching, storage that survives a hostile
browser, and timers that clean up after themselves.

[![ci](https://github.com/mykolapodpriatov/vue-composables-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/mykolapodpriatov/vue-composables-kit/actions/workflows/ci.yml)
![Vue 3.5](https://img.shields.io/badge/Vue-3.5-42b883)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6)
![tests](https://img.shields.io/badge/tests-151-brightgreen)
![ESM only](https://img.shields.io/badge/ESM-only-yellow)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## Why this exists

VueUse covers utilities — `useMouse`, `useDark`, `useClipboard` — and covers
them well. What it does not opinionate on is the **async lifecycle**, which is
the code every team ends up rewriting in every component:

```ts
const data = ref(null);
const loading = ref(false);
const error = ref(null);
let controller = null;
let pollTimer = null;
// …thirty more lines, slightly different each time
```

Thirty lines per component is the visible cost. The invisible one is that the
subtle parts get re-derived, slightly differently, each time — and they are
subtle in ways that only show up under load:

- a slow first request landing **after** a fast second one, overwriting it;
- a failed poll tick replacing a rendered page with an error state;
- a timer that outlives its component, holding the closure alive;
- a `localStorage` write that throws in Safari private mode and takes the app
  with it.

Everything here is one of those. Nothing here is a utility.

## Install

```bash
pnpm add @mykolapodpriatov/vue-composables-kit
```

ESM only. `vue` is a peer dependency; there are no runtime dependencies.

## What is in it

### `useAsyncData` — the request shape, once

```ts
const { data, loading, error, refresh } = useAsyncData(
  ({ signal }) => fetch(`/api/orders?page=${page.value}`, { signal }).then((r) => r.json()),
  { pollMs: 30_000, pauseOnHidden: true, watch: [page] },
);
```

Owns the `AbortController`, the poll interval, the visibility listener and the
watchers, and tears all of them down via `onScopeDispose`.

The behaviour worth knowing: poll ticks stay in the **foreground** — spinner
visible, errors surfaced — until the first successful fetch. After that they go
quiet, and a failed background refresh keeps the last good data rather than
flickering the page to an error state. A failed *initial* load therefore keeps
retrying visibly instead of freezing on an empty screen.

`pauseOnHidden` skips ticks while the tab is hidden and refreshes immediately on
return, so a backgrounded tab stops burning request quota without showing stale
data when the user comes back.

### `useEventStream` — a feed that degrades instead of dying

```ts
const { transport, connected, lastMessageAt } = useEventStream<Tick[]>({
  websocketUrl: () => `wss://api.example.com/ticks?symbols=${symbols.value}`,
  sseUrl: () => 'https://api.example.com/ticks/stream',
  poll: ({ signal }) => api.getTicks(symbols.value, { signal }),
  staleAfterMs: 30_000,
  onMessage: (ticks) => store.apply(ticks),
});
```

Walks **WebSocket → SSE → polling**, because every network breaks a different
one: corporate proxies drop WebSocket upgrades, some in-app WebViews ship a
broken `EventSource`, and plain HTTP usually survives both.

Two things it does that most implementations of this pattern skip:

**Exponential backoff with full jitter.** A fixed reconnect delay turns a brief
backend blip into every client retrying in lockstep.

**A stall watchdog.** A WebSocket whose peer vanished without a close frame
stays `readyState === OPEN` indefinitely — `connected` reads `true`, no error
fires, and the UI quietly shows frozen data.

> **`WebSocket OPEN` does not mean `WebSocket` alive.**

```
Socket OPEN
   ├── message arrives  ──►  healthy, watchdog re-armed
   └── silence for staleAfterMs
              ▼
        treated as dead ──► close ──► backoff ──► reconnect ──► degrade
```

It is why *"the dashboard was stuck but nothing errored"* is such a common bug
report.

### `createTtlCache` — a cache you can put in front of a real API

```ts
const cache = createTtlCache({ namespace: 'app', defaultTtlMs: TTL.hour });

const exchanges = await cache.fetch('/api/exchanges', ({ signal }) =>
  fetch('/api/exchanges', { signal }).then((r) => r.json()),
);
```

The key folds in the method, **sorted** headers, credentials mode and body.
Keying on the URL alone is how one user's authenticated response gets served to
the next. Entries are shape-checked on read, so a partial write or a payload
from an older version of the app reads as a miss rather than as data.

### `useLocalStorage` — persistence that is best-effort

```ts
const { data: prefs, remove } = useLocalStorage('prefs', { theme: 'dark' }, { sync: true });
```

`localStorage` throws for reasons that have nothing to do with your code: Safari
in private mode, embedded WebViews with third-party storage blocked, any browser
once the origin is full. A user with storage disabled should lose persistence,
not the app.

Also: SSR-safe (degrades to an in-memory ref when `window` is absent), optional
cross-tab sync, and `remove()` that does not immediately re-persist the default
— which a live deep watcher otherwise does, leaving the key never actually
cleared.

### `useCountdown`, `useToastQueue`, `lazyImport`

A countdown with a one-shot expiry hook that defers when the deadline is already
past at mount — firing synchronously during setup makes the parent refetch while
it is still initialising.

A toast queue that is **per-scope rather than a singleton**, cancels every timer
on dispose, and removes by identity rather than index — because a timer firing
mid-iteration otherwise deletes the neighbour.

Chunk-load retry for lazy routes. After a deploy the old asset hashes are gone,
and the symptom is specific: the current page works, every link is dead, and
`vue-router` shows no error because it simply aborts the navigation.

### `toFailure` — a vocabulary for failure

```ts
const failure = toFailure(caught);
// An abort is the lifecycle working, not a fault. Reporting it is how
// dashboards fill with noise nobody reads.
if (failure.kind !== 'abort') report(failure);
```

`abort · timeout · network · parse · storage · unknown`. A discriminated union
rather than a class hierarchy: equally expressive, survives serialisation, and
does not break under `instanceof` across duplicated module copies in a bundle.

## Scope

Deliberately narrow: **async lifecycle and resilience**.

Not here, and not coming: `useMouse`, `useClipboard`, `useMediaQuery`,
`useDark`. VueUse does those better, and a second library that half-covers them
serves nobody.

## Playground

```bash
pnpm build            # the playground imports dist/, not src/
cd playground && pnpm install && pnpm dev
```

Every control triggers a failure these composables exist for: a slow request, a
superseded one, a backend that hangs, and a socket that opens, reports itself
connected, and then delivers nothing.

That last case is why the playground exists rather than a screenshot. It found a
real flaw: `retries` used to reset on `open`, and a zombie connection opens
perfectly every time — so the counter never accumulated, the ladder never
degraded, and the feed reconnected to the same dead transport forever while
reporting itself healthy. The counter now resets on a **delivered message**,
because that is the only evidence a transport actually works.

```
WS zombie, SSE down:
  t≈2s   transport: websocket   retries: 0
  t≈7s   transport: websocket   retries: 1
  t≈12s  transport: poll        retries: 0   ← degraded, as it should
```

It imports the built package rather than `../src`, so a broken `exports` map or
a missing declaration file shows up here instead of in someone's install.

## Testing

150 tests. Composables register `onScopeDispose`, which only works inside an
active effect scope — so rather than mounting a throwaway component for each
case, they run inside a bare `effectScope` and `dispose()` simulates unmount.
The tests are then about the composable's own lifecycle rather than a
component's.

`useEventStream` is driven by hand-written `FakeSocket` / `FakeSource` doubles
exposing `open()`, `emit()`, `fail()` and `remoteClose()`, so the whole
transport ladder — including backoff timing and the stall watchdog — is
exercised without a server.

```bash
pnpm verify   # lint + typecheck + tests + build
```

## Design notes

**ESM only.** A library for a bundler, not for `require()`. Adding a CJS build
to raise the format count would double the surface for no consumer this targets.

**Socket constructors are injectable.** `createWebSocket` / `createEventSource`
widen the API slightly and make the transport ladder testable without mocking
globals — which is what keeps those tests readable.

**One deliberate lint suppression.** In `useEventStream`, `stopped` is
re-checked after an `await`; TypeScript narrows it to `false` from the guard at
the top of the function and cannot see that a closure reassigns it. Removing the
"redundant" check delivers a message to a disposed scope.

## License

[MIT](./LICENSE)
