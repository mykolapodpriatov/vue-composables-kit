# lazyImport

Route chunks that survive a deploy.

```ts
import { lazyImport, isDynamicImportError } from '@mykolapodpriatov/vue-composables-kit';

const routes = [
  { path: '/orders', component: lazyImport(() => import('./OrdersView.vue')) },
];

router.onError((error, to) => {
  // Reload once, and only for this failure: a reload loop is worse than a
  // dead link.
  if (isDynamicImportError(error) && to?.fullPath) {
    if (!sessionStorage.getItem('chunk-reloaded')) {
      sessionStorage.setItem('chunk-reloaded', '1');
      location.assign(to.fullPath);
    }
  }
});
```

## The failure

Every route but the entry one is code-split, so navigating fetches a chunk whose
filename contains a content hash. Deploy a new build and those filenames change
— a user whose tab was open before the deploy is holding a router that will ask
for files the server no longer has.

The symptom is specific and easy to misdiagnose:

> The current page works perfectly. Every link is dead.

`vue-router` aborts the navigation and leaves the user where they were, so there
is no error page — just clicks that do nothing.

The same failure appears transiently on flaky connections and inside in-app
WebViews, where one fetch can fail for no lasting reason.

## Two mechanisms, because there are two causes

`lazyImport` **retries**, because a dropped fetch usually succeeds on the second
attempt — the module registry does not cache a rejected import, so calling the
loader again genuinely re-requests the file.

`isDynamicImportError` **identifies** the failure for `router.onError`, where a
reload is the only remaining cure: the client needs a fresh `index.html` to
learn the new filenames.

## Options

| Option | Default | |
|---|---|---|
| `retries` | `1` | Extra attempts after the first |
| `delayMs` | `0` | Delay before each retry |
| `onRetry` | — | `(attempt, error)`, for logging |

One retry is the useful default. A transient failure recovers on it; a deploy
that removed the file will not recover however often it is asked, and each
attempt is another wait before the router gives up and `onError` can do
something that works.

## Errors from inside the module are re-thrown

A component that throws at module scope is a bug. Retrying it hides the stack
trace behind a duplicate, and treating it as a chunk failure turns one bug into
an infinite reload loop.

## Detection is by message

No engine exposes a stable, distinguishable error type, so the wording is the
only signal there is:

| Engine | Message |
|---|---|
| Chrome | `Failed to fetch dynamically imported module` |
| Firefox | `error loading dynamically imported module` |
| Safari | `Importing a module script failed` |
| webpack-era | `ChunkLoadError` (by `name`) |
