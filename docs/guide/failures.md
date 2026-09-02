# Failure handling

Every composable here reports failures as a message string, which is enough to
render and useless to branch on. A caller that wants to retry a timeout but not
a 404, or stay silent about an abort while alerting on a parse error, would have
to match on `error.message` — a contract nobody intended to make, broken by
rewording a sentence.

So `toFailure` classifies.

```ts
import { toFailure } from '@mykolapodpriatov/vue-composables-kit';

const { data } = useAsyncData(fetchOrders, {
  onError: (cause, { background }) => {
    const failure = toFailure(cause);

    // An abort is the lifecycle working, not a fault. Reporting it is how
    // dashboards fill with noise nobody reads.
    if (failure.kind === 'abort') return;

    report({ kind: failure.kind, message: failure.message, background });
  },
});
```

## The vocabulary

| `kind` | What it means | Worth retrying? |
|---|---|---|
| `abort` | Superseded or cancelled by the composable itself | Not a failure at all |
| `timeout` | Exceeded its budget | Usually |
| `network` | Never reached a server | Usually |
| `parse` | Arrived, and was not what was expected | No — the same request gives the same unusable answer |
| `storage` | Quota, private mode, or blocked by policy | No, and never fatal |
| `unknown` | Unclassified | Judgement |

`abort` is the one that matters most in practice, because it is by far the most
common thing to reach an error handler and the least likely to mean anything.

## Why a union rather than error classes

A discriminated union is exactly as expressive as a class hierarchy, survives
being serialised, and does not break under `instanceof`.

That last point is not theoretical for a library. If two versions end up in one
bundle — or a bundler duplicates a module across chunks — `instanceof` compares
against a *different* constructor and returns `false` for an object that is
plainly of that type. The bug appears only in a production build.

## Why classification is by `name`

The same logical error arrives as a different class depending on who threw it.
Native `fetch` throws a `DOMException`; a polyfill throws an `Error`; an API
client usually re-wraps both. `error.name` is the one field they agree on.

One exception is documented in the source: a `TypeError` from `fetch` is how
every browser reports "the request never left", and it is indistinguishable from
a genuine type error by class alone. That single case consults the message.

## What each composable does on failure

| | Behaviour |
|---|---|
| `useAsyncData` | Foreground failures set `error`; background poll failures keep the last good data and only reach `onError` |
| `useEventStream` | Reports and recovers — retry, then degrade to the next transport. Polling is the last rung and keeps ticking |
| `createTtlCache` | Degrades to a pass-through. A blocked store means no caching, never a failed request |
| `useLocalStorage` | Reads fall back to the default, writes are dropped. The in-memory ref stays correct |
| `lazyImport` | Retries a chunk-load failure; re-throws anything else immediately, so a real bug keeps its stack trace |
