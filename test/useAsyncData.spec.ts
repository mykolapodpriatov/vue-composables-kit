import { nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAsyncData } from '../src/async/useAsyncData.js';
import { abortError, deferred, withScope } from './helpers.js';

describe('useAsyncData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial load', () => {
    it('starts in the loading state when immediate', () => {
      const { value, dispose } = withScope(() => useAsyncData(() => Promise.resolve(1)));
      expect(value.loading.value).toBe(true);
      expect(value.data.value).toBeNull();
      dispose();
    });

    it('does not fetch when immediate is false', () => {
      const fetcher = vi.fn(() => Promise.resolve(1));
      const { value, dispose } = withScope(() =>
        useAsyncData(fetcher, { immediate: false }),
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(value.loading.value).toBe(false);
      dispose();
    });

    it('seeds data from initialData before the first success', () => {
      const { value, dispose } = withScope(() =>
        useAsyncData(() => Promise.resolve('fresh'), {
          immediate: false,
          initialData: 'seed',
        }),
      );
      expect(value.data.value).toBe('seed');
      dispose();
    });

    it('populates data and clears loading on success', async () => {
      const { value, dispose } = withScope(() =>
        useAsyncData(() => Promise.resolve({ id: 7 })),
      );
      await vi.runAllTimersAsync();
      expect(value.data.value).toEqual({ id: 7 });
      expect(value.loading.value).toBe(false);
      expect(value.error.value).toBeNull();
      expect(value.lastUpdatedAt.value).toBeTypeOf('number');
      dispose();
    });
  });

  describe('error handling', () => {
    it('surfaces the error message on a foreground failure', async () => {
      const { value, dispose } = withScope(() =>
        useAsyncData(() => Promise.reject(new Error('boom'))),
      );
      await vi.runAllTimersAsync();
      expect(value.error.value).toBe('boom');
      expect(value.loading.value).toBe(false);
      dispose();
    });

    it('falls back to fallbackError when the failure carries no message', async () => {
      const { value, dispose } = withScope(() =>
        useAsyncData(() => Promise.reject(new Error('')), { fallbackError: 'nope' }),
      );
      await vi.runAllTimersAsync();
      expect(value.error.value).toBe('nope');
      dispose();
    });

    it('keeps the last good data when a refresh fails', async () => {
      let attempt = 0;
      const { value, dispose } = withScope(() =>
        useAsyncData(() => {
          attempt += 1;
          return attempt === 1 ? Promise.resolve('good') : Promise.reject(new Error('bad'));
        }),
      );
      await vi.runAllTimersAsync();
      expect(value.data.value).toBe('good');

      await value.refresh();
      expect(value.error.value).toBe('bad');
      expect(value.data.value).toBe('good');
      dispose();
    });

    it('reports failures to onError, including background ones', async () => {
      const onError = vi.fn();
      let attempt = 0;
      const { dispose } = withScope(() =>
        useAsyncData(
          () => {
            attempt += 1;
            return attempt === 1 ? Promise.resolve('ok') : Promise.reject(new Error('x'));
          },
          { pollMs: 1000, onError },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      expect(onError).toHaveBeenCalledWith(expect.any(Error), { background: true });
      dispose();
    });

    it('ignores AbortError without touching error state', async () => {
      const { value, dispose } = withScope(() =>
        useAsyncData(() => Promise.reject(abortError())),
      );
      await vi.runAllTimersAsync();
      expect(value.error.value).toBeNull();
      dispose();
    });
  });

  describe('request supersession', () => {
    it('aborts the in-flight request when a newer one starts', async () => {
      const signals: AbortSignal[] = [];
      const { value, dispose } = withScope(() =>
        useAsyncData(({ signal }) => {
          signals.push(signal);
          return new Promise<string>(() => {
            /* never settles */
          });
        }),
      );

      void value.refresh();
      await nextTick();

      expect(signals).toHaveLength(2);
      expect(signals[0]!.aborted).toBe(true);
      expect(signals[1]!.aborted).toBe(false);
      dispose();
    });

    it('drops a superseded result instead of overwriting a newer one', async () => {
      const slow = deferred<string>();
      const fast = deferred<string>();
      let call = 0;
      const { value, dispose } = withScope(() =>
        useAsyncData(() => {
          call += 1;
          return call === 1 ? slow.promise : fast.promise;
        }),
      );

      void value.refresh();
      fast.resolve('second');
      await vi.runAllTimersAsync();
      expect(value.data.value).toBe('second');

      // The first request finally lands — after its signal was aborted.
      slow.resolve('first');
      await vi.runAllTimersAsync();
      expect(value.data.value).toBe('second');
      dispose();
    });
  });

  describe('polling', () => {
    it('does not poll when pollMs is zero', async () => {
      const fetcher = vi.fn(() => Promise.resolve(1));
      const { dispose } = withScope(() => useAsyncData(fetcher));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      dispose();
    });

    it('refreshes on the interval', async () => {
      const fetcher = vi.fn(() => Promise.resolve(1));
      const { dispose } = withScope(() => useAsyncData(fetcher, { pollMs: 1000 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetcher).toHaveBeenCalledTimes(4);
      dispose();
    });

    it('keeps poll ticks in the foreground until the first success', async () => {
      const seen: boolean[] = [];
      let attempt = 0;
      const { value, dispose } = withScope(() =>
        useAsyncData(
          ({ background }) => {
            seen.push(background);
            attempt += 1;
            return attempt <= 2
              ? Promise.reject(new Error('down'))
              : Promise.resolve('up');
          },
          { pollMs: 1000 },
        ),
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      // Two failed attempts so far — both foreground, both surfacing the error.
      expect(seen).toEqual([false, false]);
      expect(value.error.value).toBe('down');

      await vi.advanceTimersByTimeAsync(1000);
      expect(value.data.value).toBe('up');

      // Now that data exists, further ticks go quiet.
      await vi.advanceTimersByTimeAsync(1000);
      expect(seen[3]).toBe(true);
      dispose();
    });

    it('never flips loading or error during a background tick', async () => {
      let attempt = 0;
      const { value, dispose } = withScope(() =>
        useAsyncData(
          () => {
            attempt += 1;
            return attempt === 1
              ? Promise.resolve('rendered')
              : Promise.reject(new Error('transient'));
          },
          { pollMs: 1000 },
        ),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(value.data.value).toBe('rendered');

      await vi.advanceTimersByTimeAsync(1000);
      expect(value.data.value).toBe('rendered');
      expect(value.error.value).toBeNull();
      expect(value.loading.value).toBe(false);
      dispose();
    });
  });

  describe('pauseOnHidden', () => {
    it('skips poll ticks while the document is hidden', async () => {
      const fetcher = vi.fn(() => Promise.resolve(1));
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      const { dispose } = withScope(() =>
        useAsyncData(fetcher, { pollMs: 1000, pauseOnHidden: true }),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(fetcher).toHaveBeenCalledTimes(1);

      hidden.mockRestore();
      dispose();
    });

    it('refreshes immediately when the tab becomes visible again', async () => {
      const fetcher = vi.fn(() => Promise.resolve(1));
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      const { dispose } = withScope(() =>
        useAsyncData(fetcher, { pollMs: 10_000, pauseOnHidden: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);

      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);

      expect(fetcher).toHaveBeenCalledTimes(2);
      hidden.mockRestore();
      dispose();
    });
  });

  describe('watch sources', () => {
    it('refreshes when a watched source changes', async () => {
      const page = ref(1);
      const seen: number[] = [];
      const { dispose } = withScope(() =>
        useAsyncData(
          () => {
            seen.push(page.value);
            return Promise.resolve(page.value);
          },
          { watch: [page] },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      page.value = 2;
      await nextTick();
      await vi.advanceTimersByTimeAsync(0);

      expect(seen).toEqual([1, 2]);
      dispose();
    });
  });

  describe('teardown', () => {
    it('aborts the in-flight request and stops polling on scope dispose', async () => {
      const signals: AbortSignal[] = [];
      const fetcher = vi.fn(({ signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        return new Promise<number>(() => {
          /* never settles */
        });
      });
      const { dispose } = withScope(() => useAsyncData(fetcher, { pollMs: 1000 }));
      await vi.advanceTimersByTimeAsync(0);

      dispose();
      expect(signals[0]!.aborted).toBe(true);

      const callsAtDispose = fetcher.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetcher).toHaveBeenCalledTimes(callsAtDispose);
    });

    it('abort() cancels the current request without clearing data', async () => {
      const { value, dispose } = withScope(() =>
        useAsyncData(() => Promise.resolve('kept'), { immediate: true }),
      );
      await vi.runAllTimersAsync();
      value.abort();
      expect(value.data.value).toBe('kept');
      dispose();
    });
  });
});
