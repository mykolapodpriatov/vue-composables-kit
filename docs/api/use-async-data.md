# useAsyncData

One lifecycle for the request shape every app rewrites by hand.

```ts
const { data, loading, error, lastUpdatedAt, refresh, abort } = useAsyncData(
  ({ signal }) => fetch('/api/orders', { signal }).then((r) => r.json()),
  { pollMs: 30_000, pauseOnHidden: true, watch: [page] },
);
```

## Options

| Option | Default | |
|---|---|---|
| `immediate` | `true` | Fetch as soon as the composable runs |
| `pollMs` | `0` | Refresh on an interval. `0` disables polling |
| `initialData` | `null` | Seed value before the first success |
| `fallbackError` | `'Request failed'` | Used when a failure carries no message |
| `pauseOnHidden` | `false` | Skip ticks while the tab is hidden; refresh on return |
| `watch` | — | Reactive sources that trigger a foreground refresh |
| `onError` | — | Called for every non-abort failure, including silent ones |

## Returns

| | |
|---|---|
| `data` | Last successful value, or `initialData` |
| `loading` | `true` during a foreground request. Background ticks never set it |
| `error` | Message of the last foreground failure, cleared by the next attempt |
| `lastUpdatedAt` | `Date.now()` of the last success, or `null` |
| `refresh()` | Foreground refresh — always toggles `loading`, always surfaces errors |
| `abort()` | Cancel the in-flight request. Leaves `data` untouched |

## The behaviour worth knowing

**Poll ticks are foreground until the first success.** A failed initial load
keeps retrying visibly — spinner, error message — rather than freezing on an
empty screen. Once data has rendered at least once, later ticks go quiet, and a
failed background refresh keeps the last good data rather than flickering the
page to an error state.

**A superseded result is dropped, not just aborted.** Aborting is not enough on
its own: a request already past the network can still resolve. The result is
discarded if its signal was aborted while it was in flight, so a slow first
request cannot overwrite a fast second one.

**`pauseOnHidden` refreshes on return.** Skipping ticks in a hidden tab saves
request quota; refreshing on `visibilitychange` means the user does not come
back to data that is a full interval stale.

## Forward the signal

```ts
// Correct: the abort reaches the network.
useAsyncData(({ signal }) => fetch(url, { signal }).then((r) => r.json()));

// Wrong: the request still lands, still resolves, still overwrites.
useAsyncData(() => fetch(url).then((r) => r.json()));
```

A fetcher that ignores `signal` makes the whole abort story a lie. The
composable will still drop the stale *result* — the check is on the signal, not
on the promise — but the request itself completes and the bandwidth is spent.
