# createTtlCache

A TTL cache for responses that are expensive but not fresh.

```ts
import { createTtlCache, TTL } from '@mykolapodpriatov/vue-composables-kit';

const cache = createTtlCache({ namespace: 'app', defaultTtlMs: TTL.hour });

const exchanges = await cache.fetch('/api/exchanges', ({ signal }) =>
  fetch('/api/exchanges', { signal }).then((r) => r.json()),
);
```

Reference data — exchange lists, feature configs, country codes — changes hourly
at best and gets refetched on every mount, every route change and every
back-navigation. Unlike an in-memory `Map`, a storage-backed cache also survives
a reload, which is exactly when the burst is worst.

## API

| | |
|---|---|
| `fetch(key, fetcher, options?)` | Return the cached value if fresh, otherwise fetch and store |
| `peek<T>(key, parts?)` | Read a fresh entry without fetching. `null` on miss |
| `evict(key, parts?)` | Drop one entry |
| `clear()` | Drop every entry in this namespace, leaving others alone |
| `keyFor(key, parts?)` | The storage key, exported for debugging |

`TTL` exports `minute`, `fiveMinutes`, `fifteenMinutes`, `thirtyMinutes`, `hour`
and `day`, so call sites read as intent rather than arithmetic.

## Keys cover the whole request

```ts
cache.keyFor('/me', { credentials: 'include' })
// ≠
cache.keyFor('/me', { credentials: 'omit' })
```

Keying on the URL alone is how one user's authenticated response gets served to
the next. The key folds in the method, sorted and lower-cased headers, the
credentials mode and the body — so two requests share an entry only when they
would genuinely produce the same response.

Header *order* is normalised: `{a, b}` and `{b, a}` describe the same request
and must not produce two entries.

## Entries are validated on read

A partial write, or a payload left by an older version of the app, reads as a
**miss** rather than being deserialised into something the caller does not
expect. The shape check is `ts` is a number and `data` is present.

## `peek` takes a TTL

```ts
cache.peek<Article[]>('/articles', { ttlMs: TTL.minute });
```

Without it, `peek` and `fetch` could disagree about whether the same entry is
still fresh.

## `T` is asserted, not verified

`peek<Article>(key)` is how every typed cache reads, and nothing here can know
what shape was actually stored — a value written by an older version of the app
will satisfy the type while being wrong. Validate on read if the shape matters.

## Failures fall through

Every storage operation is best-effort. A blocked or full store degrades the
cache to a pass-through rather than taking the request path down with it; pass
`onError` to see it happen.
