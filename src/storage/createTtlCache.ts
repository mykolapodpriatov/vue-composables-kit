/**
 * `createTtlCache` — a TTL cache for responses that are expensive but not fresh.
 *
 * Reference data — exchange lists, feature configs, glossaries, country codes —
 * changes hourly at best but gets refetched on every mount, every route change
 * and every back-navigation. A cache in front of it removes most of that
 * traffic, and unlike an in-memory `Map` a storage-backed one also survives a
 * reload, which is exactly when the burst is worst.
 *
 * Two details make this safe to put in front of a real API client:
 *
 * - **Keys cover the whole request.** Keying on the URL alone silently serves
 *   one user's authenticated response to the next. The key here folds in the
 *   method, sorted headers, credentials mode and body, so two requests share a
 *   cache entry only when they would genuinely produce the same response.
 * - **Failures fall through.** Every storage operation is best-effort. A
 *   blocked or full `localStorage` degrades the cache to a pass-through instead
 *   of taking the request path down with it.
 *
 * Entries are validated on read (shape and timestamp), so a partial write or a
 * payload left behind by an older version of the app is treated as a miss
 * rather than deserialised into something the caller does not expect.
 *
 * @example
 * ```ts
 * const cache = createTtlCache({ namespace: 'app', defaultTtlMs: TTL.hour });
 *
 * const exchanges = await cache.fetch(
 *   '/api/exchanges',
 *   ({ signal }) => fetch('/api/exchanges', { signal }).then((r) => r.json()),
 * );
 * ```
 */

/** Common TTLs, so call sites read as intent rather than arithmetic. */
export const TTL = {
  minute: 60_000,
  fiveMinutes: 5 * 60_000,
  fifteenMinutes: 15 * 60_000,
  thirtyMinutes: 30 * 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
} as const;

/** The request attributes that make two calls interchangeable. */
export interface CacheKeyParts {
  method?: string;
  headers?: Record<string, string> | undefined;
  credentials?: string | undefined;
  body?: unknown;
}

export interface CreateTtlCacheOptions {
  /**
   * Prefix for every stored key. Keeps two apps on the same origin — or two
   * versions of one app — from reading each other's entries.
   *
   * @defaultValue `'ttl-cache'`
   */
  namespace?: string;
  /**
   * TTL applied when a call does not specify one.
   *
   * @defaultValue `TTL.fifteenMinutes`
   */
  defaultTtlMs?: number;
  /**
   * Storage backend.
   *
   * @defaultValue the global `localStorage`, or a no-op when unavailable
   */
  storage?: Storage;
  /** Called when a storage read or write throws. */
  onError?: (error: unknown, ctx: { operation: 'read' | 'write' | 'evict' }) => void;
}

export interface CacheFetchOptions extends CacheKeyParts {
  /** Override the cache's default TTL for this call. */
  ttlMs?: number;
  /** Bypass the cached entry and refresh it from the fetcher. */
  force?: boolean;
}

export interface TtlCache {
  /**
   * Return the cached value for `key` when it is still within its TTL,
   * otherwise run `fetcher`, store the result and return it.
   */
  fetch: <T>(
    key: string,
    fetcher: (ctx: { signal?: AbortSignal }) => Promise<T>,
    options?: CacheFetchOptions & { signal?: AbortSignal },
  ) => Promise<T>;
  /**
   * Read a still-fresh entry without fetching. `null` on miss or expiry.
   * Pass `ttlMs` to judge freshness against something other than the cache's
   * default — otherwise `peek` and `fetch` could disagree about the same entry.
   *
   * `T` is **asserted by the caller, not verified**. Nothing here can know what
   * shape was stored, and a value written by an older version of the app will
   * satisfy the type while being wrong. The generic is kept because
   * `peek<Article>(key)` is how every typed cache reads and the alternative —
   * returning `unknown` and casting at each call site — moves the same
   * unchecked assertion somewhere less visible. Validate on read if the shape
   * matters.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above: a deliberate caller-supplied assertion
  peek: <T>(key: string, parts?: CacheKeyParts & { ttlMs?: number }) => T | null;
  /** Drop one entry. */
  evict: (key: string, parts?: CacheKeyParts) => void;
  /** Drop every entry in this cache's namespace. Leaves other keys alone. */
  clear: () => void;
  /** The fully-qualified storage key for a request — exported for debugging. */
  keyFor: (key: string, parts?: CacheKeyParts) => string;
}

interface CacheEntry<T> {
  /** Epoch milliseconds when the entry was written. */
  ts: number;
  data: T;
}

/** Stable stringification for values that may not be JSON-serialisable. */
function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    // A circular or otherwise unserialisable body still needs *a* key. There is
    // no correct answer, only a deterministic one — the same object must
    // produce the same key for the lifetime of the session, and a constant
    // does that without pretending to have serialised anything.
    return '[unserialisable]';
  }
}

/**
 * Order-independent header fingerprint: `{a, b}` and `{b, a}` describe the same
 * request and must not produce two cache entries.
 */
function normalizeHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return '';
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}:${value}`)
    .join('|');
}

/** A backend that accepts everything and remembers nothing. */
const nullStorage: Storage = {
  length: 0,
  clear: () => {},
  getItem: () => null,
  key: () => null,
  removeItem: () => {},
  setItem: () => {},
};

function resolveStorage(explicit: Storage | undefined): Storage {
  if (explicit) return explicit;
  if (typeof window === 'undefined') return nullStorage;
  try {
    return window.localStorage;
  } catch {
    return nullStorage;
  }
}

export function createTtlCache(options: CreateTtlCacheOptions = {}): TtlCache {
  const {
    namespace = 'ttl-cache',
    defaultTtlMs = TTL.fifteenMinutes,
    storage: explicitStorage,
    onError,
  } = options;

  const storage = resolveStorage(explicitStorage);
  const prefix = `${namespace}:`;

  function keyFor(key: string, parts: CacheKeyParts = {}): string {
    const method = (parts.method ?? 'GET').toUpperCase();
    return [
      prefix + method,
      key,
      parts.credentials ?? '',
      normalizeHeaders(parts.headers),
      safeStringify(parts.body),
    ].join(':');
  }

  /**
   * Read and shape-check a stored entry.
   *
   * Returns `unknown` data rather than a generic `CacheEntry<T>`: a type
   * parameter that appears once in a signature is not a constraint, it is an
   * unchecked cast wearing a constraint's clothing. The caller asserts, and
   * does so visibly.
   */
  function readEntry(storageKey: string): CacheEntry<unknown> | null {
    try {
      const raw = storage.getItem(storageKey);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      // Reject anything that is not a well-formed entry: a partial write or a
      // payload from an older schema must read as a miss, not as data.
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { ts?: unknown }).ts !== 'number' ||
        !('data' in parsed)
      ) {
        return null;
      }
      return parsed as CacheEntry<unknown>;
    } catch (error: unknown) {
      onError?.(error, { operation: 'read' });
      return null;
    }
  }

  function writeEntry(storageKey: string, data: unknown): void {
    try {
      storage.setItem(storageKey, JSON.stringify({ ts: Date.now(), data }));
    } catch (error: unknown) {
      // Full or blocked storage means no caching, never a failed request.
      onError?.(error, { operation: 'write' });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-supplied assertion; see the TtlCache interface
  function peek<T>(key: string, parts: CacheKeyParts & { ttlMs?: number } = {}): T | null {
    const { ttlMs = defaultTtlMs, ...keyParts } = parts;
    const entry = readEntry(keyFor(key, keyParts));
    if (!entry) return null;
    if (Date.now() - entry.ts >= ttlMs) return null;
    return entry.data as T;
  }

  function evict(key: string, parts: CacheKeyParts = {}): void {
    try {
      storage.removeItem(keyFor(key, parts));
    } catch (error: unknown) {
      onError?.(error, { operation: 'evict' });
    }
  }

  function clear(): void {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const storageKey = storage.key(i);
        if (storageKey?.startsWith(prefix)) doomed.push(storageKey);
      }
      // Collect first, then delete: removing during iteration reindexes the
      // store and silently skips half the entries.
      for (const storageKey of doomed) storage.removeItem(storageKey);
    } catch (error: unknown) {
      onError?.(error, { operation: 'evict' });
    }
  }

  async function fetchWithCache<T>(
    key: string,
    fetcher: (ctx: { signal?: AbortSignal }) => Promise<T>,
    fetchOptions: CacheFetchOptions & { signal?: AbortSignal } = {},
  ): Promise<T> {
    const { ttlMs = defaultTtlMs, force = false, signal, ...parts } = fetchOptions;
    const storageKey = keyFor(key, parts);

    if (!force) {
      const entry = readEntry(storageKey);
      if (entry && Date.now() - entry.ts < ttlMs) return entry.data as T;
    }

    const result = signal === undefined ? await fetcher({}) : await fetcher({ signal });
    writeEntry(storageKey, result);
    return result;
  }

  return { fetch: fetchWithCache, peek, evict, clear, keyFor };
}
