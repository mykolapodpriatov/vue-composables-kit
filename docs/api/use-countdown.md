# useCountdown

A live countdown to a deadline, with a one-shot expiry hook.

```ts
const { label, remainingMs, expired, urgent, valid, parts, stop } = useCountdown(
  () => user.value?.trialEndsAt,
  { onExpire: () => refreshUser() },
);
```

## Options

| Option | Default | |
|---|---|---|
| `onExpire` | — | Fires exactly once when the deadline is reached |
| `format` | built-in | `(parts) => string` — the composable carries no locale strings |
| `intervalMs` | `1000` | Tick interval |
| `urgentBelowMs` | `3600000` | Threshold for the `urgent` flag |

Accepts an ISO string, a `Date`, an epoch number, or a ref/getter of any of
those.

## Three edge cases it handles

**Mounting after the deadline.** Firing `onExpire` synchronously during setup
makes the parent refetch while it is still initialising. The callback is
deferred to a macrotask so the component finishes mounting first.

**A deadline that arrives late.** The target usually comes from a request that
has not resolved at mount, so it is read reactively and the countdown re-arms
when it changes. A missing or unparseable target is an inert no-op — no
interval, no callback — so the same call site works whether or not a deadline is
currently set.

**Firing twice.** Re-renders and a racing final tick can both reach the expiry
path. `onExpire` is guarded to fire exactly once per armed target.

## Formatting is injected

```ts
const { label } = useCountdown(deadline, {
  format: ({ days, hours }) => t('trial.remaining', { days, hours }),
});
```

The default formatter is locale-free — `2d 18h`, `18h 04m`, `04:09` — and
deliberately coarse, because a per-second digit on a multi-day countdown is
noise. Anything user-facing should come from your i18n layer.
