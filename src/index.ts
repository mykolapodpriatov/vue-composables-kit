/**
 * Production-hardened Vue 3 composables for the messy parts of async UI.
 *
 * Scope is deliberately narrow: **async lifecycle and resilience**. Aborts,
 * polling, transport fallback, TTL caching, storage that survives a hostile
 * browser, timers that clean up after themselves.
 *
 * What is *not* here, and will not be: `useMouse`, `useClipboard`,
 * `useMediaQuery`, `useDark`. VueUse covers those, covers them better, and a
 * second library that half-covers them serves nobody.
 */

// Async lifecycle — the request shape every app rewrites by hand.
export { useAsyncData } from './async/useAsyncData.js';
export type {
  AsyncDataContext,
  AsyncDataFetcher,
  UseAsyncDataOptions,
  UseAsyncDataReturn,
} from './async/useAsyncData.js';

// Real-time feeds that degrade instead of dying.
export { useEventStream } from './realtime/useEventStream.js';
export type {
  EventSourceLike,
  SocketLike,
  StreamTransport,
  UseEventStreamOptions,
  UseEventStreamReturn,
} from './realtime/useEventStream.js';

// Storage that is best-effort rather than load-bearing.
export { createTtlCache, TTL } from './storage/createTtlCache.js';
export type {
  CacheFetchOptions,
  CacheKeyParts,
  CreateTtlCacheOptions,
  TtlCache,
} from './storage/createTtlCache.js';

export { useLocalStorage } from './storage/useLocalStorage.js';
export type {
  UseLocalStorageOptions,
  UseLocalStorageReturn,
} from './storage/useLocalStorage.js';

// Timers that clean up after themselves.
export { formatCountdown, useCountdown } from './lifecycle/useCountdown.js';
export type {
  CountdownFormatter,
  CountdownParts,
  UseCountdownOptions,
  UseCountdownReturn,
} from './lifecycle/useCountdown.js';

export { useToastQueue } from './lifecycle/useToastQueue.js';
export type {
  PushToastOptions,
  Toast,
  ToastKind,
  UseToastQueueOptions,
  UseToastQueueReturn,
} from './lifecycle/useToastQueue.js';

// Route chunks that survive a deploy.
export { isDynamicImportError, lazyImport } from './router/lazyImport.js';
export type { LazyImportOptions } from './router/lazyImport.js';

// A vocabulary for the ways async work fails.
export { isAbort, toFailure } from './internal/errors.js';
export type { Failure, FailureKind } from './internal/errors.js';
