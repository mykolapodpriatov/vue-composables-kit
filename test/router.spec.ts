import { describe, expect, it, vi } from 'vitest';
import { isDynamicImportError, lazyImport } from '../src/router/lazyImport.js';
import { toFailure, isAbort } from '../src/internal/errors.js';
import { abortError } from './helpers.js';

/** The wording each engine actually uses for a failed chunk load. */
const CHUNK_ERRORS = [
  ['Chrome', 'Failed to fetch dynamically imported module: https://x/a.js'],
  ['Firefox', 'error loading dynamically imported module'],
  ['Safari', 'Importing a module script failed.'],
] as const;

describe('isDynamicImportError', () => {
  it.each(CHUNK_ERRORS)('recognises the %s wording', (_engine, message) => {
    // No engine exposes a distinguishable error type, so the message is the
    // only signal there is.
    expect(isDynamicImportError(new Error(message))).toBe(true);
  });

  it('recognises a webpack-era ChunkLoadError by name', () => {
    const error = Object.assign(new Error('Loading chunk 3 failed'), {
      name: 'ChunkLoadError',
    });
    expect(isDynamicImportError(error)).toBe(true);
  });

  it('rejects an error thrown from inside the imported module', () => {
    // The distinction that matters: treating this as a chunk failure turns one
    // bug into an infinite reload loop.
    expect(isDynamicImportError(new TypeError('x is not a function'))).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a plain object', {}],
  ])('rejects %s', (_label, value) => {
    expect(isDynamicImportError(value)).toBe(false);
  });

  it('reads a string error directly', () => {
    expect(isDynamicImportError('Failed to fetch dynamically imported module')).toBe(true);
  });
});

describe('lazyImport', () => {
  const chunkError = (): Error =>
    new Error('Failed to fetch dynamically imported module: https://x/a.js');

  it('returns the module on the first attempt', async () => {
    const loader = vi.fn(() => Promise.resolve({ default: 'Component' }));
    expect(await lazyImport(loader)()).toEqual({ default: 'Component' });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('retries once after a transient chunk failure', async () => {
    // The module registry does not cache a rejected import, so calling the
    // loader again genuinely re-requests the file.
    let attempt = 0;
    const loader = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(chunkError()) : Promise.resolve('ok');
    });

    expect(await lazyImport(loader)()).toBe('ok');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not retry an error from inside the module', async () => {
    // Retrying would hide the real stack trace behind a duplicate.
    const loader = vi.fn(() => Promise.reject(new TypeError('boom')));
    await expect(lazyImport(loader)()).rejects.toThrow('boom');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured retries and propagates', async () => {
    // A deploy that removed the file will not recover however often it is
    // asked; each extra attempt is another wait before router.onError can do
    // the reload that actually works.
    const loader = vi.fn(() => Promise.reject(chunkError()));
    await expect(lazyImport(loader, { retries: 2 })()).rejects.toThrow(/dynamically/);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('honours retries: 0', async () => {
    const loader = vi.fn(() => Promise.reject(chunkError()));
    await expect(lazyImport(loader, { retries: 0 })()).rejects.toThrow();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('waits between attempts when a delay is set', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const loader = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(chunkError()) : Promise.resolve('ok');
    });

    const promise = lazyImport(loader, { delayMs: 500 })();
    await vi.advanceTimersByTimeAsync(499);
    expect(loader).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    await expect(promise).resolves.toBe('ok');
    vi.useRealTimers();
  });

  it('reports each retry, for logging', async () => {
    const onRetry = vi.fn();
    const loader = vi.fn(() => Promise.reject(chunkError()));

    await expect(lazyImport(loader, { retries: 2, onRetry })()).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
  });
});

describe('toFailure', () => {
  it.each([
    ['an abort', abortError(), 'abort'],
    ['a timeout', Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout'],
    ['a syntax error', new SyntaxError('bad json'), 'parse'],
    ['a quota error', new DOMException('q', 'QuotaExceededError'), 'storage'],
    ['a blocked-storage error', new DOMException('s', 'SecurityError'), 'storage'],
    ['an unrecognised error', new Error('who knows'), 'unknown'],
  ])('classifies %s', (_label, error, kind) => {
    expect(toFailure(error).kind).toBe(kind);
  });

  it('classifies a fetch TypeError as network', () => {
    // Every browser reports "the request never left" as a TypeError, which is
    // indistinguishable from a genuine type error by class alone.
    expect(toFailure(new TypeError('Failed to fetch')).kind).toBe('network');
  });

  it('does not classify an ordinary TypeError as network', () => {
    expect(toFailure(new TypeError('x is not a function')).kind).toBe('unknown');
  });

  it('carries the original value for logging', () => {
    const original = new Error('boom');
    expect(toFailure(original).cause).toBe(original);
  });

  it('extracts a message from a thrown string', () => {
    expect(toFailure('just a string').message).toBe('just a string');
  });

  it('produces a message for a value with none', () => {
    expect(toFailure({}).message).toBe('Unknown error');
  });

  it('classifies by name, not by class', () => {
    // The same logical error arrives as a different class depending on who
    // threw it — and `instanceof` fails across duplicated module copies in a
    // bundle, which a library must assume.
    const wrapped = Object.assign(new Error('re-wrapped'), { name: 'AbortError' });
    expect(toFailure(wrapped).kind).toBe('abort');
  });
});

describe('isAbort', () => {
  it('is true for a cancellation', () => {
    expect(isAbort(abortError())).toBe(true);
  });

  it('is false for a genuine failure', () => {
    // An abort is the lifecycle working. Reporting it as an error is how
    // dashboards fill with noise nobody reads.
    expect(isAbort(new Error('server exploded'))).toBe(false);
  });
});
