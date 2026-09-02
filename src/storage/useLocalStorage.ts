/**
 * `useLocalStorage` — a ref that survives reloads, other tabs, and Safari.
 *
 * `localStorage` is the one browser API that throws for reasons that have
 * nothing to do with your code: Safari in private mode used to throw on every
 * write, embedded WebViews throw when third-party storage is blocked, and any
 * browser throws `QuotaExceededError` once the origin is full. A naive
 * `localStorage.setItem` in a watcher turns each of those into a white screen.
 *
 * This composable treats persistence as best-effort. Reads that fail fall back
 * to the default, writes that fail are reported and dropped, and the in-memory
 * ref keeps working either way — a user with storage disabled loses persistence,
 * not the app.
 *
 * On top of that it fixes three things hand-rolled versions usually miss:
 *
 * - **SSR.** Touching `localStorage` during server render throws
 *   `ReferenceError`. When `window` is absent the composable degrades to a plain
 *   in-memory ref, so the same code renders on the server.
 * - **Cross-tab drift.** Two open tabs each keep their own copy and the last
 *   one to write wins, silently clobbering the other. Opting into `sync` listens
 *   for the `storage` event and adopts writes made by other tabs.
 * - **`remove()` re-persisting the default.** Clearing the key while a deep
 *   watcher is live immediately writes the default value straight back. The
 *   watcher is stopped across the reset and re-established afterwards.
 *
 * @example
 * ```ts
 * const { data: prefs, remove } = useLocalStorage('prefs', { theme: 'dark' }, { sync: true });
 * prefs.value.theme = 'light'; // persisted, and picked up by other tabs
 * ```
 */
import { onScopeDispose, ref, watch, type Ref, type WatchStopHandle } from 'vue';

export interface UseLocalStorageOptions<T> {
  /**
   * Adopt writes made to the same key by other tabs, via the `storage` event.
   *
   * @defaultValue `false`
   */
  sync?: boolean;
  /**
   * Watch nested mutations, so `prefs.value.theme = 'x'` persists without
   * replacing the whole object. Costs a deep traversal per change.
   *
   * @defaultValue `true`
   */
  deep?: boolean;
  /**
   * Serializer pair. Override to persist values `JSON` cannot round-trip —
   * `Date`, `Map`, `BigInt`.
   */
  serializer?: {
    read: (raw: string) => T;
    write: (value: T) => string;
  };
  /**
   * Called when reading or writing throws — quota exceeded, storage blocked,
   * malformed JSON left behind by an older version of the app.
   */
  onError?: (error: unknown, ctx: { operation: 'read' | 'write' | 'remove' }) => void;
  /**
   * Storage backend. Swap for `sessionStorage` or an in-memory double.
   *
   * @defaultValue the global `localStorage`
   */
  storage?: Storage;
}

export interface UseLocalStorageReturn<T> {
  /** The reactive value. Mutating it persists it (subject to storage working). */
  data: Ref<T>;
  /** Drop the key from storage and reset `data` to the default value. */
  remove: () => void;
}

/**
 * The default serializer.
 *
 * Untyped on purpose: it has no idea what shape was stored, and a generic
 * parameter that appears once in a signature is an unchecked cast wearing a
 * constraint's clothing. The cast happens where the caller's `T` is actually
 * known, in `useLocalStorage` itself, and is visible there.
 */
const jsonSerializer = {
  read: (raw: string): unknown => JSON.parse(raw),
  write: (value: unknown): string => JSON.stringify(value),
};

/**
 * Resolve the backing store, or `null` when storage is unavailable — during SSR
 * or when the browser blocks it outright.
 */
function resolveStorage(explicit: Storage | undefined): Storage | null {
  if (explicit) return explicit;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Accessing the property itself throws when storage is blocked by policy.
    return null;
  }
}

export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  options: UseLocalStorageOptions<T> = {},
): UseLocalStorageReturn<T> {
  const {
    sync = false,
    deep = true,
    // The default serializer is `unknown`-typed; the assertion here is the one
    // place where the caller's `T` is known, so it is the honest place for it.
    serializer = jsonSerializer as {
      read: (raw: string) => T;
      write: (value: T) => string;
    },
    onError,
    storage: explicitStorage,
  } = options;

  const storage = resolveStorage(explicitStorage);

  function read(): T {
    if (!storage) return defaultValue;
    try {
      const raw = storage.getItem(key);
      if (raw === null) return defaultValue;
      return serializer.read(raw);
    } catch (error: unknown) {
      // Stale or corrupt data must not brick the app — fall back and move on.
      onError?.(error, { operation: 'read' });
      return defaultValue;
    }
  }

  function write(value: T): void {
    if (!storage) return;
    try {
      storage.setItem(key, serializer.write(value));
    } catch (error: unknown) {
      // Quota exceeded or storage blocked. The in-memory ref stays correct;
      // only durability is lost, which is never worth throwing over.
      onError?.(error, { operation: 'write' });
    }
  }

  const data = ref(read()) as Ref<T>;

  function startWatching(): WatchStopHandle {
    return watch(
      data,
      (value) => {
        write(value);
      },
      { deep },
    );
  }

  // Reassigned by `remove()`, so every consumer must call it through the
  // variable rather than capturing the current handle.
  let stopWatch = startWatching();

  function remove(): void {
    // Stop first: otherwise assigning the default below immediately persists it
    // again and the key is never actually cleared.
    stopWatch();
    if (storage) {
      try {
        storage.removeItem(key);
      } catch (error: unknown) {
        onError?.(error, { operation: 'remove' });
      }
    }
    data.value = defaultValue;
    stopWatch = startWatching();
  }

  function onStorageEvent(event: StorageEvent): void {
    if (event.key !== key) return;
    // Another tab cleared the key.
    if (event.newValue === null) {
      stopWatch();
      data.value = defaultValue;
      stopWatch = startWatching();
      return;
    }
    try {
      const incoming = serializer.read(event.newValue);
      // Pause our own watcher so adopting a peer's value does not echo a write
      // straight back into storage.
      stopWatch();
      data.value = incoming;
      stopWatch = startWatching();
    } catch (error: unknown) {
      onError?.(error, { operation: 'read' });
    }
  }

  const canSync = sync && typeof window !== 'undefined';
  if (canSync) window.addEventListener('storage', onStorageEvent);

  onScopeDispose(() => {
    stopWatch();
    if (canSync) window.removeEventListener('storage', onStorageEvent);
  });

  return { data, remove };
}
