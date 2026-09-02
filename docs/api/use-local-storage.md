# useLocalStorage

A ref that survives reloads, other tabs, and Safari.

```ts
const { data: prefs, remove } = useLocalStorage(
  'prefs',
  { theme: 'dark' },
  { sync: true },
);

prefs.value.theme = 'light'; // persisted, and picked up by other tabs
```

## Options

| Option | Default | |
|---|---|---|
| `sync` | `false` | Adopt writes made by other tabs, via the `storage` event |
| `deep` | `true` | Watch nested mutations, so `prefs.theme = 'x'` persists |
| `serializer` | JSON | Override for values JSON cannot round-trip |
| `onError` | — | Called on a failed read, write or remove |
| `storage` | `localStorage` | Swap for `sessionStorage` or a double |

## Why every operation is guarded

`localStorage` is the one browser API that throws for reasons unrelated to your
code: Safari in private mode used to throw on every write, embedded WebViews
throw when third-party storage is blocked, and any browser throws
`QuotaExceededError` once the origin is full.

A naive `setItem` in a watcher turns each of those into a white screen. Here a
failed write is reported and dropped, and the in-memory ref keeps working — a
user with storage disabled loses persistence, not the app.

## Three things hand-rolled versions miss

**SSR.** Touching `localStorage` during a server render throws `ReferenceError`.
With `window` absent this degrades to a plain in-memory ref, so the same call
site renders on both sides.

**Cross-tab drift.** Two open tabs each keep their own copy, and the last to
write wins — silently clobbering the other. `sync: true` adopts a peer's write,
and pauses the local watcher while doing so, so the adopted value is not
immediately echoed back into storage.

**`remove()` re-persisting the default.** Clearing the key while a deep watcher
is live writes the default straight back, and the key is never actually cleared.
The watcher is stopped across the reset and re-established afterwards, so
persistence keeps working for the rest of the session.

## Custom serializer

```ts
const { data: lastSeen } = useLocalStorage('lastSeen', new Date(0), {
  serializer: {
    read: (raw) => new Date(raw),
    write: (date) => date.toISOString(),
  },
});
```
