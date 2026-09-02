# Why this exists

Almost every data-bound component ends up owning the same five things:

```ts
const data = ref(null);
const loading = ref(false);
const error = ref(null);
let controller = null;
let pollTimer = null;
// …thirty more lines, slightly different each time
```

Thirty lines per component is the visible cost. It is not the expensive one.

The expensive one is that the subtle parts get re-derived, slightly
differently, in each component — and they are subtle in ways that only appear
under conditions a developer's machine rarely reaches.

## The four that actually bite

**A slow request landing after a fast one.** Type in a search box, and request
one is still in flight when request two returns. Without an abort *and* a check
on the resolved result, the stale answer overwrites the fresh one — and the UI
shows results for a query the user has already changed. The abort alone is not
enough: a request already past the network can still resolve.

**A failed poll wiping a rendered page.** Polling naively means every tick sets
`loading`, and every failed tick sets `error`. A thirty-second poll on a flaky
connection turns a perfectly good page into an error screen once a minute. But
polling *silently* from the start is also wrong: an initial load that fails then
shows an empty page forever, with no spinner and no explanation.

The distinction that resolves it: ticks stay in the foreground until the
**first success**, then go quiet.

**A timer outliving its component.** Every `setInterval` holds its closure, and
the closure holds the component. On a route change that is one leak per
navigation — invisible for an hour, then not.

**`localStorage` throwing.** Safari in private mode, WebViews with third-party
storage blocked, any browser once the origin is full. A `setItem` in a watcher
turns each of those into a white screen. A user with storage disabled should
lose persistence, not the app.

## The one that is hardest to find

A WebSocket whose peer vanished without sending a close frame stays
`readyState === OPEN` indefinitely.

- `connected` reads `true`.
- No error fires.
- No close handler runs.
- The data on screen is simply frozen.

> **`WebSocket OPEN` does not mean `WebSocket` alive.**

There is no event to listen for, because the absence of events *is* the signal.
The only detection is a deadline: no message in N milliseconds means the
connection is dead regardless of what its `readyState` claims.

It is why *"the dashboard was stuck but nothing errored"* is such a common bug
report, and why it is usually closed as unreproducible.

## A worked example of getting it almost right

The watchdog above was in this library from the first commit. It still did not
work, and the playground is what showed it.

A zombie connection **opens perfectly every time** — only the messages are
missing. The retry counter reset on `open`, so it never accumulated, the ladder
never degraded, and the feed reconnected to the same dead transport forever
while reporting itself healthy. The watchdog fired every four seconds and
achieved nothing but a reconnect to the same silence.

```
before — WS zombie, SSE down:        after:
  t≈2s   websocket  retries: 0         t≈2s   websocket  retries: 0
  t≈6s   websocket  retries: 0         t≈7s   websocket  retries: 1
  t≈11s  websocket  retries: 0         t≈12s  poll       retries: 0
```

Twenty-four unit tests on that module missed it, because every one of them
opened a socket and immediately sent a message.

The counter now resets on a **delivered message**. Opening proves a socket
connects; only a message proves it works.
