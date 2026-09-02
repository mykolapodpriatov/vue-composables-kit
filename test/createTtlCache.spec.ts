import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTtlCache, TTL } from '../src/storage/createTtlCache.js';

/** An in-memory `Storage`, so tests do not depend on the environment's. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

/** A `Storage` that throws on every write, like Safari with storage blocked. */
function hostileStorage(): Storage {
  return {
    length: 0,
    clear: () => {
      throw new Error('blocked');
    },
    getItem: () => {
      throw new Error('blocked');
    },
    key: () => null,
    removeItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new DOMException('quota', 'QuotaExceededError');
    },
  };
}

describe('createTtlCache', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
  });

  describe('cache keys', () => {
    it('namespaces every key', () => {
      const cache = createTtlCache({ namespace: 'app', storage });
      expect(cache.keyFor('/api/x')).toContain('app:');
    });

    it('separates two apps sharing an origin', () => {
      const a = createTtlCache({ namespace: 'a', storage });
      const b = createTtlCache({ namespace: 'b', storage });
      expect(a.keyFor('/api/x')).not.toBe(b.keyFor('/api/x'));
    });

    it('distinguishes methods', () => {
      const cache = createTtlCache({ storage });
      expect(cache.keyFor('/x', { method: 'GET' })).not.toBe(
        cache.keyFor('/x', { method: 'POST' }),
      );
    });

    it('treats the method case-insensitively', () => {
      const cache = createTtlCache({ storage });
      expect(cache.keyFor('/x', { method: 'get' })).toBe(
        cache.keyFor('/x', { method: 'GET' }),
      );
    });

    it('distinguishes credentials modes', () => {
      // Keying on the URL alone is how one user's authenticated response gets
      // served to the next.
      const cache = createTtlCache({ storage });
      expect(cache.keyFor('/me', { credentials: 'include' })).not.toBe(
        cache.keyFor('/me', { credentials: 'omit' }),
      );
    });

    it('distinguishes headers', () => {
      const cache = createTtlCache({ storage });
      expect(cache.keyFor('/x', { headers: { authorization: 'a' } })).not.toBe(
        cache.keyFor('/x', { headers: { authorization: 'b' } }),
      );
    });

    it('ignores header order', () => {
      // Two objects describing the same request must not produce two entries.
      const cache = createTtlCache({ storage });
      expect(cache.keyFor('/x', { headers: { a: '1', b: '2' } })).toBe(
        cache.keyFor('/x', { headers: { b: '2', a: '1' } }),
      );
    });

    it('ignores header name case', () => {
      const cache = createTtlCache({ storage });
      expect(cache.keyFor('/x', { headers: { Accept: 'json' } })).toBe(
        cache.keyFor('/x', { headers: { accept: 'json' } })
      );
    });

    it('distinguishes bodies', () => {
      const cache = createTtlCache({ storage });
      expect(cache.keyFor('/x', { body: { q: 'a' } })).not.toBe(
        cache.keyFor('/x', { body: { q: 'b' } }),
      );
    });

    it('survives an unserialisable body', () => {
      // A circular body still needs *a* key. There is no correct answer, only
      // a deterministic one.
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const cache = createTtlCache({ storage });
      expect(() => cache.keyFor('/x', { body: circular })).not.toThrow();
      expect(cache.keyFor('/x', { body: circular })).toBe(
        cache.keyFor('/x', { body: circular }),
      );
    });
  });

  describe('fetch', () => {
    it('calls the fetcher on a miss and caches the result', async () => {
      const cache = createTtlCache({ storage });
      const fetcher = vi.fn(() => Promise.resolve({ id: 1 }));

      await cache.fetch('/x', fetcher);
      await cache.fetch('/x', fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('refetches once the TTL has passed', async () => {
      vi.useFakeTimers();
      const cache = createTtlCache({ storage, defaultTtlMs: 1000 });
      const fetcher = vi.fn(() => Promise.resolve('v'));

      await cache.fetch('/x', fetcher);
      vi.advanceTimersByTime(1001);
      await cache.fetch('/x', fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('honours a per-call TTL over the default', async () => {
      vi.useFakeTimers();
      const cache = createTtlCache({ storage, defaultTtlMs: TTL.hour });
      const fetcher = vi.fn(() => Promise.resolve('v'));

      await cache.fetch('/x', fetcher);
      vi.advanceTimersByTime(2000);
      await cache.fetch('/x', fetcher, { ttlMs: 1000 });

      expect(fetcher).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('bypasses the cache when forced', async () => {
      const cache = createTtlCache({ storage });
      const fetcher = vi.fn(() => Promise.resolve('v'));

      await cache.fetch('/x', fetcher);
      await cache.fetch('/x', fetcher, { force: true });

      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('forwards an abort signal to the fetcher', async () => {
      const cache = createTtlCache({ storage });
      const controller = new AbortController();
      const fetcher = vi.fn(({ signal }: { signal?: AbortSignal }) =>
        Promise.resolve(signal),
      );

      const result = await cache.fetch('/x', fetcher, { signal: controller.signal });
      expect(result).toBe(controller.signal);
    });

    it('does not pass an undefined signal when none was given', async () => {
      // `{ signal: undefined }` is not the same as `{}` to a fetch wrapper that
      // checks `'signal' in options`.
      const cache = createTtlCache({ storage });
      const fetcher = vi.fn((ctx: { signal?: AbortSignal }) => Promise.resolve(ctx));

      const ctx = await cache.fetch('/x', fetcher);
      expect('signal' in ctx).toBe(false);
    });

    it('propagates a fetcher failure rather than caching it', async () => {
      const cache = createTtlCache({ storage });
      await expect(
        cache.fetch('/x', () => Promise.reject(new Error('down'))),
      ).rejects.toThrow('down');
      // Nothing was stored, so the next call retries.
      expect(cache.peek('/x')).toBeNull();
    });
  });

  describe('reading a damaged store', () => {
    it('treats a non-JSON entry as a miss', async () => {
      storage.setItem(createTtlCache({ storage }).keyFor('/x'), 'not json');
      const cache = createTtlCache({ storage });
      const fetcher = vi.fn(() => Promise.resolve('fresh'));

      expect(await cache.fetch('/x', fetcher)).toBe('fresh');
    });

    it('treats an entry with no timestamp as a miss', async () => {
      // What a partial write, or a payload from an older schema, looks like.
      const cache = createTtlCache({ storage });
      storage.setItem(cache.keyFor('/x'), JSON.stringify({ data: 'stale' }));

      expect(await cache.fetch('/x', () => Promise.resolve('fresh'))).toBe('fresh');
    });

    it('treats an entry with no data member as a miss', async () => {
      const cache = createTtlCache({ storage });
      storage.setItem(cache.keyFor('/x'), JSON.stringify({ ts: Date.now() }));

      expect(await cache.fetch('/x', () => Promise.resolve('fresh'))).toBe('fresh');
    });

    it('reports a read failure without throwing', async () => {
      const onError = vi.fn();
      const cache = createTtlCache({ storage: hostileStorage(), onError });

      // Blocked storage degrades the cache to a pass-through rather than
      // taking the request path down with it.
      expect(await cache.fetch('/x', () => Promise.resolve('v'))).toBe('v');
      expect(onError).toHaveBeenCalled();
    });

    it('still returns the fetched value when the write fails', async () => {
      const onError = vi.fn();
      const cache = createTtlCache({ storage: hostileStorage(), onError });
      expect(await cache.fetch('/x', () => Promise.resolve('v'))).toBe('v');
      expect(onError).toHaveBeenCalledWith(expect.anything(), { operation: 'read' });
    });
  });

  describe('peek', () => {
    it('returns a fresh entry without fetching', async () => {
      const cache = createTtlCache({ storage });
      await cache.fetch('/x', () => Promise.resolve({ id: 1 }));
      expect(cache.peek('/x')).toEqual({ id: 1 });
    });

    it('returns null for an expired entry', async () => {
      vi.useFakeTimers();
      const cache = createTtlCache({ storage, defaultTtlMs: 100 });
      await cache.fetch('/x', () => Promise.resolve('v'));
      vi.advanceTimersByTime(101);
      expect(cache.peek('/x')).toBeNull();
      vi.useRealTimers();
    });

    it('accepts an explicit TTL so it cannot disagree with fetch', async () => {
      vi.useFakeTimers();
      const cache = createTtlCache({ storage, defaultTtlMs: TTL.hour });
      await cache.fetch('/x', () => Promise.resolve('v'));
      vi.advanceTimersByTime(2000);
      expect(cache.peek('/x', { ttlMs: 1000 })).toBeNull();
      vi.useRealTimers();
    });

    it('returns null for a key never stored', () => {
      expect(createTtlCache({ storage }).peek('/nope')).toBeNull();
    });
  });

  describe('eviction', () => {
    it('drops one entry', async () => {
      const cache = createTtlCache({ storage });
      await cache.fetch('/x', () => Promise.resolve('v'));
      cache.evict('/x');
      expect(cache.peek('/x')).toBeNull();
    });

    it('clears only its own namespace', async () => {
      const mine = createTtlCache({ namespace: 'mine', storage });
      const theirs = createTtlCache({ namespace: 'theirs', storage });
      await mine.fetch('/x', () => Promise.resolve('a'));
      await theirs.fetch('/x', () => Promise.resolve('b'));
      storage.setItem('unrelated-app-key', 'do not touch');

      mine.clear();

      expect(mine.peek('/x')).toBeNull();
      expect(theirs.peek('/x')).toBe('b');
      expect(storage.getItem('unrelated-app-key')).toBe('do not touch');
    });

    it('removes every matching entry, not every other one', async () => {
      // Deleting while iterating reindexes the store and skips half the
      // entries — the reason `clear` collects first.
      const cache = createTtlCache({ namespace: 'n', storage });
      for (const key of ['/a', '/b', '/c', '/d']) {
        await cache.fetch(key, () => Promise.resolve('v'));
      }
      cache.clear();

      for (const key of ['/a', '/b', '/c', '/d']) {
        expect(cache.peek(key)).toBeNull();
      }
    });
  });
});
