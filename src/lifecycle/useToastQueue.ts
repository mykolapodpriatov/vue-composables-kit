/**
 * `useToastQueue` — transient messages, without the leaks.
 *
 * A toast queue looks like ten lines of code and is not, because three of its
 * failure modes only appear under conditions a demo never reaches:
 *
 * 1. **Timer leaks.** Each toast schedules its own dismissal. Unmount the
 *    component holding the queue and those timers keep running, holding the
 *    closure — and the component — alive. On a route change that is a leak per
 *    navigation.
 * 2. **Unbounded growth.** A failing request in a retry loop can enqueue a
 *    toast a second. Without a cap the screen fills and the oldest message —
 *    usually the informative one — scrolls away.
 * 3. **Dismissing during iteration.** Removing an item from the array a
 *    `v-for` is rendering, from inside that item's own timer, skips its
 *    neighbour. The array is mutated by identity here, never by index.
 *
 * The queue is **per-scope**, not a module-level singleton. A singleton is the
 * obvious shape and it makes the component that renders toasts unmountable
 * without leaking, makes two independent regions impossible, and makes tests
 * order-dependent. `provide`/`inject` gives one shared queue where that is
 * wanted, with none of that.
 *
 * @example
 * ```ts
 * // In the app root:
 * const toasts = useToastQueue({ max: 3 });
 * provide(toastKey, toasts);
 *
 * // Anywhere below:
 * const { push } = inject(toastKey)!;
 * push({ title: 'Saved', kind: 'success' });
 * ```
 */
import { onScopeDispose, readonly, ref, type Ref } from 'vue';

/** Severity, for styling and for choosing an ARIA live-region politeness. */
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  /** Monotonic within a queue. Use as the `:key` in a `v-for`. */
  id: number;
  title: string;
  /** Optional detail. Keep it short — a toast is not a dialog. */
  body?: string;
  kind: ToastKind;
  /** `Date.now()` when it was pushed. */
  createdAt: number;
}

export interface PushToastOptions {
  title: string;
  body?: string;
  /** @defaultValue `'info'` */
  kind?: ToastKind;
  /**
   * Milliseconds before automatic dismissal. `0` keeps it until dismissed.
   *
   * Errors default to persistent, deliberately: a message that says something
   * went wrong is the one a user most needs time to read, and the one most
   * likely to appear while they are looking elsewhere.
   */
  duration?: number;
}

export interface UseToastQueueOptions {
  /**
   * Most toasts on screen at once. Pushing past it drops the oldest.
   *
   * @defaultValue `4`
   */
  max?: number;
  /**
   * Default dismissal delay for non-error toasts.
   *
   * @defaultValue `5000`
   */
  defaultDuration?: number;
}

export interface UseToastQueueReturn {
  /** The visible toasts, oldest first. Readonly — mutate through the methods. */
  toasts: Readonly<Ref<readonly Toast[]>>;
  /** Enqueue a toast. Returns its id, so a caller can dismiss it early. */
  push: (options: PushToastOptions) => number;
  /** Dismiss one toast. Safe to call for an id that is already gone. */
  dismiss: (id: number) => void;
  /** Dismiss everything — on route change, or on logout. */
  clear: () => void;
}

export function useToastQueue(options: UseToastQueueOptions = {}): UseToastQueueReturn {
  const { max = 4, defaultDuration = 5000 } = options;

  const toasts = ref<Toast[]>([]);
  /** Dismissal timers, by toast id, so every one can be cancelled on teardown. */
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  function cancelTimer(id: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function dismiss(id: number): void {
    cancelTimer(id);
    // Located by identity rather than by index: a timer firing while the array
    // is being iterated elsewhere would otherwise remove the wrong element.
    const index = toasts.value.findIndex((toast) => toast.id === id);
    if (index !== -1) toasts.value.splice(index, 1);
  }

  function push(pushOptions: PushToastOptions): number {
    const { title, body, kind = 'info' } = pushOptions;
    // Errors persist unless the caller says otherwise: the message a user most
    // needs to read is the one most likely to appear while they look away.
    const duration =
      pushOptions.duration ?? (kind === 'error' ? 0 : defaultDuration);

    const id = nextId++;
    const toast: Toast = {
      id,
      title,
      kind,
      createdAt: Date.now(),
      ...(body !== undefined ? { body } : {}),
    };

    toasts.value.push(toast);

    // Drop the oldest rather than refusing the newest: the most recent message
    // is almost always the one describing what the user just did.
    while (toasts.value.length > max) {
      const evicted = toasts.value.shift();
      if (evicted) cancelTimer(evicted.id);
    }

    if (duration > 0) {
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          dismiss(id);
        }, duration),
      );
    }

    return id;
  }

  function clear(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    toasts.value = [];
  }

  // Without this, a queue that outlives its component keeps every pending
  // timer alive — and each timer keeps the closure, and the component, alive
  // with it. One leak per navigation.
  onScopeDispose(clear);

  return {
    toasts: readonly(toasts),
    push,
    dismiss,
    clear,
  };
}
