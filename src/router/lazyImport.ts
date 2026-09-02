/**
 * `lazyImport` — route chunks that survive a deploy.
 *
 * Every route but the entry one is code-split, so navigating to it fetches a
 * chunk whose filename contains a content hash. Deploy a new build and those
 * filenames change; a user whose tab was open before the deploy is holding a
 * router that will ask for files the server no longer has.
 *
 * The symptom is specific and easy to misdiagnose: the current page works
 * perfectly, and every link is dead. `vue-router` aborts the navigation and
 * leaves the user where they were, so there is no error page — just clicks that
 * do nothing. The same failure appears transiently on flaky connections and
 * inside in-app WebViews, where a single fetch can fail for no lasting reason.
 *
 * Two mechanisms, because one failure is transient and the other is permanent:
 *
 * - `lazyImport` retries the import. A dropped fetch usually succeeds on the
 *   second attempt, and the module registry does not cache a rejected import,
 *   so simply calling the loader again re-requests it.
 * - `isDynamicImportError` identifies the failure for `router.onError`, where
 *   a reload is the only remaining cure — the client needs a new index.html to
 *   learn the new filenames.
 *
 * @example
 * ```ts
 * const routes = [
 *   { path: '/orders', component: lazyImport(() => import('./OrdersView.vue')) },
 * ];
 *
 * router.onError((error, to) => {
 *   // Reload once, and only for this failure: a reload loop is worse than a
 *   // dead link.
 *   if (isDynamicImportError(error) && to?.fullPath) {
 *     if (!sessionStorage.getItem('chunk-reloaded')) {
 *       sessionStorage.setItem('chunk-reloaded', '1');
 *       location.assign(to.fullPath);
 *     }
 *   }
 * });
 * ```
 */

/**
 * `true` when an error is a chunk-load failure rather than an error thrown from
 * inside the module being loaded.
 *
 * Matching is on the message, because browsers word this differently and none
 * of them expose a stable, distinguishable error type. Chrome says "Failed to
 * fetch dynamically imported module", Firefox "error loading dynamically
 * imported module", Safari "Importing a module script failed", and webpack-era
 * tooling still throws a `ChunkLoadError`.
 *
 * The alternative — treating every route-load failure as a chunk problem —
 * would reload the page whenever a component throws during import, turning one
 * bug into an infinite reload loop.
 */
export function isDynamicImportError(error: unknown): boolean {
  if (!error) return false;

  if (typeof error === 'object' && 'name' in error) {
    const { name } = error as { name?: unknown };
    if (name === 'ChunkLoadError') return true;
  }

  // Read `message` if there is one; otherwise fall back to a string form. Note
  // that an arbitrary object stringifies to `[object Object]`, which matches
  // nothing below — correct, since an object with no message is not a chunk
  // error, and coercing it further would only invent a reason to match.
  // `error` is already known non-null: the guard at the top returned for every
  // falsy value.
  const raw: unknown =
    typeof error === 'object' && 'message' in error
      ? (error as { message?: unknown }).message
      : error;

  const message = typeof raw === 'string' ? raw : '';

  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|dynamically imported module/i.test(
    message,
  );
}

export interface LazyImportOptions {
  /**
   * How many extra attempts to make after the first.
   *
   * One is the useful default. A transient fetch failure recovers on the
   * retry; a deploy that removed the file will not recover no matter how many
   * times it is asked, and each attempt costs the user another wait before the
   * router gives up and `onError` can do something that works.
   *
   * @defaultValue `1`
   */
  retries?: number;
  /**
   * Delay before each retry, in milliseconds. `0` retries immediately.
   *
   * @defaultValue `0`
   */
  delayMs?: number;
  /** Called before each retry, for logging. */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Wrap a lazy route loader so transient chunk-load failures are retried.
 *
 * Errors that are *not* import failures are re-thrown immediately: a component
 * that throws at module scope is a bug, and retrying it hides the stack trace
 * behind a duplicate.
 */
export function lazyImport<T>(
  loader: () => Promise<T>,
  options: LazyImportOptions = {},
): () => Promise<T> {
  const { retries = 1, delayMs = 0, onRetry } = options;

  return async (): Promise<T> => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await loader();
      } catch (error: unknown) {
        // Not a chunk problem — surface it now, with its own stack.
        if (!isDynamicImportError(error)) throw error;

        lastError = error;
        if (attempt < retries) {
          onRetry?.(attempt + 1, error);
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
    }

    // Out of attempts. Propagating lets `router.onError` decide, which is where
    // the reload that actually fixes a post-deploy mismatch belongs.
    throw lastError;
  };
}
