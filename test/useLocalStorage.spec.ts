import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalStorage } from '../src/storage/useLocalStorage.js';
import { withScope } from './helpers.js';

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

describe('useLocalStorage', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
  });

  describe('reading', () => {
    it('uses the default when nothing is stored', () => {
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', { theme: 'dark' }, { storage }),
      );
      expect(value.data.value).toEqual({ theme: 'dark' });
      dispose();
    });

    it('reads an existing value', () => {
      storage.setItem('k', JSON.stringify({ theme: 'light' }));
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', { theme: 'dark' }, { storage }),
      );
      expect(value.data.value).toEqual({ theme: 'light' });
      dispose();
    });

    it('falls back to the default for corrupt JSON', () => {
      // Left behind by an older version of the app. It must not brick startup.
      storage.setItem('k', '{ not json');
      const onError = vi.fn();
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'fallback', { storage, onError }),
      );
      expect(value.data.value).toBe('fallback');
      expect(onError).toHaveBeenCalledWith(expect.anything(), { operation: 'read' });
      dispose();
    });
  });

  describe('writing', () => {
    it('persists a replaced value', async () => {
      const { value, dispose } = withScope(() => useLocalStorage('k', 0, { storage }));
      value.data.value = 42;
      await nextTick();
      expect(storage.getItem('k')).toBe('42');
      dispose();
    });

    it('persists a nested mutation', async () => {
      // The reason `deep` defaults to true: `prefs.theme = 'x'` is how people
      // actually use a settings object.
      const { value, dispose } = withScope(() =>
        useLocalStorage('prefs', { theme: 'dark' }, { storage }),
      );
      value.data.value.theme = 'light';
      await nextTick();
      expect(JSON.parse(storage.getItem('prefs') ?? '{}')).toEqual({ theme: 'light' });
      dispose();
    });

    it('reports a quota failure without throwing', async () => {
      // Safari in private mode, a full origin, a policy that blocks storage.
      // Losing persistence is acceptable; losing the app is not.
      const onError = vi.fn();
      // Built explicitly rather than spread from `memoryStorage()`: spreading
      // an object with getters copies their current values, not the getters.
      const base = memoryStorage();
      const failing: Storage = {
        get length() {
          return base.length;
        },
        clear: () => {
          base.clear();
        },
        getItem: (key) => base.getItem(key),
        key: (index) => base.key(index),
        removeItem: (key) => {
          base.removeItem(key);
        },
        setItem: () => {
          throw new DOMException('quota', 'QuotaExceededError');
        },
      };

      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 0, { storage: failing, onError }),
      );
      value.data.value = 1;
      await nextTick();

      expect(onError).toHaveBeenCalledWith(expect.anything(), { operation: 'write' });
      // The in-memory value is still correct — only durability was lost.
      expect(value.data.value).toBe(1);
      dispose();
    });
  });

  describe('remove', () => {
    it('clears the key and resets to the default', async () => {
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'default', { storage }),
      );
      value.data.value = 'changed';
      await nextTick();

      value.remove();
      await nextTick();

      expect(value.data.value).toBe('default');
      dispose();
    });

    it('does not immediately re-persist the default', async () => {
      // The bug this exists to prevent: with a live deep watcher, assigning the
      // default inside `remove()` writes it straight back, and the key is never
      // actually cleared.
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'default', { storage }),
      );
      value.data.value = 'changed';
      await nextTick();
      expect(storage.getItem('k')).not.toBeNull();

      value.remove();
      await nextTick();

      expect(storage.getItem('k')).toBeNull();
      dispose();
    });

    it('keeps persisting after a remove', async () => {
      // The watcher is re-established, so the ref does not silently stop
      // saving for the rest of the session.
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'default', { storage }),
      );
      value.remove();
      await nextTick();

      value.data.value = 'after';
      await nextTick();

      expect(storage.getItem('k')).toBe('"after"');
      dispose();
    });
  });

  describe('SSR', () => {
    it('degrades to an in-memory ref when storage is unavailable', () => {
      // Touching `localStorage` during a server render throws ReferenceError.
      // The same call site has to work on both sides.
      const nullStorage = undefined;
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'seed', { storage: nullStorage as unknown as Storage }),
      );
      expect(value.data.value).toBe('seed');
      dispose();
    });
  });

  describe('cross-tab sync', () => {
    it('adopts a value written by another tab', async () => {
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'mine', { storage, sync: true }),
      );

      window.dispatchEvent(
        new StorageEvent('storage', { key: 'k', newValue: JSON.stringify('theirs') }),
      );
      await nextTick();

      expect(value.data.value).toBe('theirs');
      dispose();
    });

    it('does not echo an adopted value back to storage', async () => {
      // Without pausing the watcher, adopting a peer's value writes it again —
      // which in a two-tab loop is an endless exchange.
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'mine', { storage, sync: true }),
      );
      const setItem = vi.spyOn(storage, 'setItem');

      window.dispatchEvent(
        new StorageEvent('storage', { key: 'k', newValue: JSON.stringify('theirs') }),
      );
      await nextTick();

      expect(setItem).not.toHaveBeenCalled();
      expect(value.data.value).toBe('theirs');
      dispose();
    });

    it('resets to the default when another tab clears the key', async () => {
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'default', { storage, sync: true }),
      );
      value.data.value = 'changed';
      await nextTick();

      window.dispatchEvent(new StorageEvent('storage', { key: 'k', newValue: null }));
      await nextTick();

      expect(value.data.value).toBe('default');
      dispose();
    });

    it('ignores events for other keys', async () => {
      const { value, dispose } = withScope(() =>
        useLocalStorage('mine', 'unchanged', { storage, sync: true }),
      );

      window.dispatchEvent(
        new StorageEvent('storage', { key: 'theirs', newValue: '"x"' }),
      );
      await nextTick();

      expect(value.data.value).toBe('unchanged');
      dispose();
    });

    it('does not listen at all when sync is off', async () => {
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'mine', { storage }),
      );

      window.dispatchEvent(
        new StorageEvent('storage', { key: 'k', newValue: '"theirs"' }),
      );
      await nextTick();

      expect(value.data.value).toBe('mine');
      dispose();
    });

    it('stops listening once the scope is disposed', async () => {
      const { value, dispose } = withScope(() =>
        useLocalStorage('k', 'mine', { storage, sync: true }),
      );
      dispose();

      window.dispatchEvent(
        new StorageEvent('storage', { key: 'k', newValue: '"theirs"' }),
      );
      await nextTick();

      expect(value.data.value).toBe('mine');
    });
  });

  describe('custom serializer', () => {
    it('round-trips a value JSON cannot', async () => {
      const { value, dispose } = withScope(() =>
        useLocalStorage('when', new Date(0), {
          storage,
          serializer: {
            read: (raw) => new Date(raw),
            write: (date) => date.toISOString(),
          },
        }),
      );

      value.data.value = new Date('2026-09-02T00:00:00.000Z');
      await nextTick();
      expect(storage.getItem('when')).toBe('2026-09-02T00:00:00.000Z');
      dispose();
    });
  });
});
