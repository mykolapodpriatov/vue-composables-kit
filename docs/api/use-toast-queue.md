# useToastQueue

Transient messages, without the leaks.

```ts
// In the app root:
const toasts = useToastQueue({ max: 3 });
provide(toastKey, toasts);

// Anywhere below:
const { push } = inject(toastKey)!;
push({ title: 'Saved', kind: 'success' });
```

## Options

| Option | Default | |
|---|---|---|
| `max` | `4` | Most toasts on screen. Pushing past it drops the oldest |
| `defaultDuration` | `5000` | Dismissal delay for non-error toasts |

## API

| | |
|---|---|
| `toasts` | Readonly, oldest first |
| `push(options)` | Returns the id, so a caller can dismiss it early |
| `dismiss(id)` | Safe for an id that is already gone |
| `clear()` | On route change, or on logout |

## Why it is per-scope, not a singleton

A module-level singleton is the obvious shape. It also makes the component that
renders toasts unmountable without leaking, makes two independent regions
impossible, and makes tests order-dependent. `provide`/`inject` gives one shared
queue where that is wanted, with none of that.

## Three failure modes it handles

**Timer leaks.** Each toast schedules its own dismissal. Unmount the component
holding the queue and those timers keep running, holding the closure — and the
component — alive. `onScopeDispose` cancels every one.

**Unbounded growth.** A failing request in a retry loop can enqueue a toast a
second. Past `max` the *oldest* is dropped, not the newest: the most recent
message is almost always the one describing what the user just did.

**Dismissing during iteration.** Removing by index, from inside a toast's own
timer, skips its neighbour in the `v-for`. Removal is by identity.

## Errors persist by default

```ts
push({ title: 'Save failed', kind: 'error' }); // stays until dismissed
push({ title: 'Saved', kind: 'success' });     // auto-dismisses
```

The message a user most needs to read is the one most likely to appear while
they are looking elsewhere. Pass `duration` to override.

## Accessibility

Render the queue in a live region, so a toast is announced rather than merely
drawn:

```vue
<div role="region" aria-label="Notifications" aria-live="polite">
  <div v-for="toast in toasts" :key="toast.id">…</div>
</div>
```

`polite` rather than `assertive`: a toast interrupts nothing. And give each one
a dismiss control — a message that vanishes on a timer is unreadable for anyone
who needs longer than five seconds.
