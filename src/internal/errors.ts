/**
 * A vocabulary for the ways async work fails.
 *
 * Every composable here reports failures as a message string, which is enough
 * to render and useless to branch on. A caller that wants to retry a timeout
 * but not a 404, or to stay silent about an abort while alerting on a parse
 * error, has to match on `error.message` — and that is a contract nobody
 * intended to make, broken by rewording a sentence.
 *
 * So failures carry a `kind`. Not a class hierarchy: a discriminated union is
 * exactly as expressive, survives being serialised, and does not break under
 * `instanceof` across module boundaries — which is a real problem for a library
 * that may end up duplicated in a bundle.
 *
 * @example
 * ```ts
 * const { error } = useAsyncData(fetchOrders, {
 *   onError: (cause) => {
 *     const failure = toFailure(cause);
 *     // An abort is the lifecycle working, not a fault. Reporting it as an
 *     // error is how dashboards end up full of noise nobody reads.
 *     if (failure.kind !== 'abort') reportToSentry(failure);
 *   },
 * });
 * ```
 */

/**
 * What went wrong, in the terms a caller can act on.
 *
 * - `abort` — a request superseded or cancelled by the composable itself. The
 *   lifecycle working correctly, not a fault, and the distinction matters
 *   because it is by far the most common thing to appear in an error handler.
 * - `timeout` — the request exceeded its budget. Usually worth retrying.
 * - `network` — the request never reached a server. Also usually worth
 *   retrying, and distinct from `timeout` because the remedies differ.
 * - `parse` — a response arrived and was not what was expected. Never worth
 *   retrying: the same request will produce the same unusable answer.
 * - `storage` — reading or writing local storage failed. Quota, private mode,
 *   or a policy that blocks it. Never fatal here; persistence is best-effort.
 * - `unknown` — anything unclassified. Present so the union is total and
 *   callers do not need a default branch that silently swallows.
 */
export type FailureKind =
  | 'abort'
  | 'timeout'
  | 'network'
  | 'parse'
  | 'storage'
  | 'unknown';

export interface Failure {
  kind: FailureKind;
  /** Human-readable, for display. Never for branching. */
  message: string;
  /** The original thrown value, for logging. */
  cause: unknown;
}

/** Read a `name` off an unknown thrown value, if it has one. */
function nameOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const { name } = error as { name?: unknown };
    if (typeof name === 'string') return name;
  }
  return '';
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

/**
 * Classify an unknown thrown value.
 *
 * Matching is on `name` rather than `instanceof`, because the same logical
 * error arrives as a different class depending on who threw it: native `fetch`
 * throws a `DOMException`, a polyfill throws an `Error`, and an API client
 * often re-wraps both. `instanceof` also fails across duplicated copies of a
 * module in a bundle, which is exactly the situation a library should assume.
 */
export function toFailure(error: unknown): Failure {
  const name = nameOf(error);
  const message = messageOf(error);

  if (name === 'AbortError') return { kind: 'abort', message, cause: error };
  if (name === 'TimeoutError') return { kind: 'timeout', message, cause: error };
  if (name === 'SyntaxError') return { kind: 'parse', message, cause: error };

  // `QuotaExceededError` is the modern name; the numeric codes are what older
  // Safari and Firefox report, and they still turn up in the wild.
  if (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    name === 'SecurityError'
  ) {
    return { kind: 'storage', message, cause: error };
  }

  // A `TypeError` from `fetch` is how every browser reports "the request never
  // left" — DNS failure, refused connection, blocked by an extension. It is
  // indistinguishable from a genuine type error by class alone, which is why
  // the message is consulted here and nowhere else.
  if (error instanceof TypeError && /fetch|network|load failed/i.test(message)) {
    return { kind: 'network', message, cause: error };
  }

  return { kind: 'unknown', message, cause: error };
}

/** `true` for a cancellation — the lifecycle working, not a fault. */
export function isAbort(error: unknown): boolean {
  return toFailure(error).kind === 'abort';
}
