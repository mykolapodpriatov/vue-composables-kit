/**
 * Test helpers.
 *
 * Composables in this kit register `onScopeDispose` cleanup, which only works
 * inside an active effect scope. Rather than mounting a throwaway component for
 * every case, tests run the composable inside a bare `effectScope` and call the
 * returned `dispose` to simulate unmount. That keeps the tests focused on the
 * composable's own lifecycle instead of a component's.
 */
import { effectScope } from 'vue';

export interface ScopedResult<T> {
  /** Whatever the composable returned. */
  value: T;
  /** Stop the scope — equivalent to unmounting the owning component. */
  dispose: () => void;
}

/** Run `fn` inside an effect scope so `onScopeDispose` is honoured. */
export function withScope<T>(fn: () => T): ScopedResult<T> {
  const scope = effectScope();
  const value = scope.run(fn);
  /* v8 ignore next 3 -- a scope that has not been stopped always returns a value */
  if (value === undefined) {
    throw new Error('withScope: composable returned undefined');
  }
  return {
    value,
    dispose: () => {
      scope.stop();
    },
  };
}

/** Resolve after all currently queued microtasks have drained. */
export function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A promise plus its resolve/reject handles, for driving fetch timing by hand. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An `AbortError` shaped like the one native `fetch` rejects with. */
export function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
