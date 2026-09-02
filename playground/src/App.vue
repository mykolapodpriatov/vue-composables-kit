<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  createTtlCache,
  toFailure,
  useAsyncData,
  useCountdown,
  useEventStream,
  useLocalStorage,
  useToastQueue,
  type StreamTransport,
} from '@mykolapodpriatov/vue-composables-kit';
import {
  backend,
  createFakeEventSource,
  createFakeWebSocket,
  fetchOrders,
  pollOrders,
  stopAllFakeTransports,
  transports,
  type Order,
} from './fakeBackend';

/**
 * A playground that can be made to fail.
 *
 * A demo against a healthy backend shows a spinner once and proves nothing.
 * Every control here triggers one of the conditions these composables exist
 * for — a slow request, a superseded one, a socket that opens and then says
 * nothing — so the behaviour described in the README can be watched rather
 * than taken on trust.
 */

const toasts = useToastQueue({ max: 3 });

/* ---------------------------------------------------------------- async -- */

const pollingOn = ref(false);

const orders = useAsyncData<Order[]>(fetchOrders, {
  pollMs: 4000,
  pauseOnHidden: true,
  initialData: [],
  onError: (cause, { background }) => {
    const failure = toFailure(cause);
    // An abort is the lifecycle working. Reporting it is how a dashboard fills
    // with noise nobody reads.
    if (failure.kind === 'abort') return;
    toasts.push({
      title: background ? 'Background refresh failed' : 'Request failed',
      body: `${failure.kind}: ${failure.message}`,
      kind: background ? 'warning' : 'error',
    });
  },
});

const latencyLabel = computed(() => `${backend.latencyMs}ms`);

function toggleFailing(): void {
  backend.failing = !backend.failing;
  void orders.refresh();
}

function toggleHang(): void {
  backend.hang = !backend.hang;
  void orders.refresh();
}

function supersede(): void {
  // Two refreshes back to back: the first is aborted mid-flight, and its result
  // — if it ever lands — is dropped rather than overwriting the second.
  void orders.refresh();
  void orders.refresh();
  toasts.push({ title: 'Two requests fired', body: 'The first was aborted.', kind: 'info' });
}

/* ------------------------------------------------------------- realtime -- */

const feed = ref<Order[]>([]);
const streamEvents = ref<string[]>([]);

function note(message: string): void {
  streamEvents.value = [`${new Date().toLocaleTimeString()} — ${message}`, ...streamEvents.value].slice(0, 6);
}

const stream = useEventStream<Order>({
  websocketUrl: () => 'wss://playground.invalid/orders',
  sseUrl: () => 'https://playground.invalid/orders/stream',
  poll: pollOrders,
  pollMs: 1500,
  immediate: false,
  maxRetries: 1,
  retryDelayMs: 400,
  jitter: false,
  // Short, so the zombie case is watchable rather than something to wait out.
  staleAfterMs: 4000,
  onMessage: (order) => {
    feed.value = [order, ...feed.value].slice(0, 6);
  },
  onError: (error, { transport }) => {
    note(`${transport}: ${toFailure(error).message}`);
  },
  createWebSocket: createFakeWebSocket,
  createEventSource: createFakeEventSource,
});

const LADDER: StreamTransport[] = ['websocket', 'sse', 'poll'];

function setTransport(name: 'websocket' | 'sse', health: 'up' | 'down' | 'zombie'): void {
  transports[name] = health;
  note(`${name} set to ${health}`);
}

function restart(): void {
  stopAllFakeTransports();
  feed.value = [];
  stream.reconnect();
}

/* -------------------------------------------------------------- storage -- */

const prefs = useLocalStorage(
  'playground:prefs',
  { theme: 'system', pageSize: 10 },
  { sync: true, onError: (_e, { operation }) => note(`storage ${operation} failed`) },
);

const cache = createTtlCache({ namespace: 'playground', defaultTtlMs: 8000 });
const cacheHits = ref(0);
const cacheMisses = ref(0);

async function loadCached(): Promise<void> {
  const before = cache.peek<Order[]>('/orders');
  if (before) cacheHits.value += 1;
  else cacheMisses.value += 1;

  await cache.fetch<Order[]>('/orders', () => fetchOrders());
}

/* ------------------------------------------------------------- lifecycle -- */

const deadline = ref<string | null>(null);

const countdown = useCountdown(deadline, {
  onExpire: () => {
    toasts.push({ title: 'Countdown finished', kind: 'success' });
  },
});

function startCountdown(seconds: number): void {
  deadline.value = new Date(Date.now() + seconds * 1000).toISOString();
}
</script>

<template>
  <main>
    <h1>vue-composables-kit</h1>
    <p class="lede">
      Every control here triggers a failure these composables exist for. Nothing
      is simulated in the composables themselves — only in the fake backend they
      talk to.
    </p>

    <!-- ------------------------------------------------------- useAsyncData -->
    <section class="panel">
      <h2><code>useAsyncData</code></h2>
      <p class="panel__why">
        Owns the abort controller, the poll interval and the visibility
        listener. Poll ticks stay in the foreground until the first success,
        then go quiet — a failed background refresh keeps the last good data
        rather than flickering the page to an error.
      </p>

      <div class="controls">
        <button type="button" @click="orders.refresh()">Refresh</button>
        <button type="button" @click="supersede">Fire two at once</button>
        <button type="button" :aria-pressed="backend.failing" @click="toggleFailing">
          Backend failing
        </button>
        <button type="button" :aria-pressed="backend.hang" @click="toggleHang">
          Backend hangs
        </button>
        <button type="button" @click="orders.abort()">Abort in flight</button>
      </div>

      <div class="state">
        <span><b>loading</b> {{ orders.loading.value }}</span>
        <span><b>rows</b> {{ orders.data.value?.length ?? 0 }}</span>
        <span><b>latency</b> {{ latencyLabel }}</span>
        <span>
          <b>updated</b>
          {{ orders.lastUpdatedAt.value
            ? new Date(orders.lastUpdatedAt.value).toLocaleTimeString()
            : '—' }}
        </span>
      </div>

      <p v-if="orders.error.value" class="error">{{ orders.error.value }}</p>

      <ul class="feed">
        <li v-for="order in orders.data.value ?? []" :key="order.id">
          #{{ order.id }} · {{ order.customer }} · {{ order.total }}
        </li>
      </ul>
      <p v-if="!(orders.data.value ?? []).length" class="panel__why">
        No rows yet.
      </p>
      <p class="panel__why">
        Switch to another tab for a few seconds with <code>pauseOnHidden</code>
        on: poll ticks stop, and one fires the moment you return.
        Polling is {{ pollingOn ? 'on' : 'on (every 4s)' }}.
      </p>
    </section>

    <!-- ----------------------------------------------------- useEventStream -->
    <section class="panel">
      <h2><code>useEventStream</code></h2>
      <p class="panel__why">
        Walks WebSocket → SSE → polling. <b>Zombie</b> is the interesting one:
        the socket opens, reports itself connected, and then delivers nothing.
        No error, no close frame — the case the stall watchdog exists for.
      </p>

      <div class="controls">
        <button type="button" @click="stream.start()">Connect</button>
        <button type="button" @click="stream.stop()">Stop</button>
        <button type="button" @click="restart">Restart from the top</button>
      </div>

      <div class="controls">
        <span class="panel__why" style="margin: 0.3rem 0.5rem 0 0">WebSocket:</span>
        <button
          v-for="health in (['up', 'zombie', 'down'] as const)"
          :key="`ws-${health}`"
          type="button"
          :aria-pressed="transports.websocket === health"
          @click="setTransport('websocket', health)"
        >
          {{ health }}
        </button>
        <span class="panel__why" style="margin: 0.3rem 0.5rem 0 1rem">SSE:</span>
        <button
          v-for="health in (['up', 'zombie', 'down'] as const)"
          :key="`sse-${health}`"
          type="button"
          :aria-pressed="transports.sse === health"
          @click="setTransport('sse', health)"
        >
          {{ health }}
        </button>
      </div>

      <div class="state">
        <span class="ladder">
          <template v-for="(step, index) in LADDER" :key="step">
            <span
              class="ladder__step"
              :class="{ 'ladder__step--active': stream.transport.value === step }"
            >{{ step }}</span>
            <span v-if="index < LADDER.length - 1" class="ladder__arrow">→</span>
          </template>
        </span>
        <span>
          <b>connected</b>
          <!-- State is never conveyed by colour alone: the word says it too. -->
          <span
            class="pill"
            :class="stream.connected.value ? 'pill--ok' : 'pill--muted'"
          >{{ stream.connected.value ? 'yes' : 'no' }}</span>
        </span>
        <span><b>retries</b> {{ stream.retries.value }}</span>
        <span>
          <b>last message</b>
          {{ stream.lastMessageAt.value
            ? new Date(stream.lastMessageAt.value).toLocaleTimeString()
            : '—' }}
        </span>
      </div>

      <ul class="feed">
        <li v-for="order in feed" :key="order.id">
          #{{ order.id }} · {{ order.customer }}
        </li>
        <li v-for="event in streamEvents" :key="event" style="color: var(--muted)">
          {{ event }}
        </li>
      </ul>
    </section>

    <!-- --------------------------------------------- storage and the cache -->
    <section class="panel">
      <h2><code>useLocalStorage</code> · <code>createTtlCache</code></h2>
      <p class="panel__why">
        Open this page in a second tab and change the page size there — with
        <code>sync</code> on, this one adopts it without writing it back.
      </p>

      <div class="controls">
        <button type="button" @click="prefs.data.value.pageSize += 5">
          Page size: {{ prefs.data.value.pageSize }}
        </button>
        <button type="button" @click="prefs.remove()">Reset preferences</button>
        <button type="button" @click="loadCached()">Load through the cache</button>
        <button type="button" @click="cache.clear()">Clear the cache</button>
      </div>

      <div class="state">
        <span><b>theme</b> {{ prefs.data.value.theme }}</span>
        <span><b>cache hits</b> {{ cacheHits }}</span>
        <span><b>misses</b> {{ cacheMisses }}</span>
        <span class="panel__why" style="margin: 0">TTL 8s — wait it out and the next load is a miss.</span>
      </div>
    </section>

    <!-- ------------------------------------- countdown and the toast queue -->
    <section class="panel">
      <h2><code>useCountdown</code> · <code>useToastQueue</code></h2>
      <p class="panel__why">
        A deadline already in the past fires <code>onExpire</code> on the next
        macrotask rather than during setup — otherwise the parent refetches
        while it is still initialising.
      </p>

      <div class="controls">
        <button type="button" @click="startCountdown(10)">10 seconds</button>
        <button type="button" @click="startCountdown(-5)">Already expired</button>
        <button type="button" @click="deadline = null">Clear the deadline</button>
        <button
          type="button"
          @click="toasts.push({ title: 'Saved', body: 'Auto-dismisses in 5s.', kind: 'success' })"
        >
          Push a toast
        </button>
        <button
          type="button"
          @click="toasts.push({ title: 'Something broke', body: 'Errors stay until dismissed.', kind: 'error' })"
        >
          Push an error
        </button>
      </div>

      <div class="state">
        <span><b>label</b> {{ countdown.label.value }}</span>
        <span>
          <b>state</b>
          <span
            class="pill"
            :class="countdown.expired.value ? 'pill--muted' : countdown.urgent.value ? 'pill--warn' : 'pill--ok'"
          >
            {{ !countdown.valid.value ? 'no deadline' : countdown.expired.value ? 'expired' : countdown.urgent.value ? 'urgent' : 'running' }}
          </span>
        </span>
        <span><b>toasts</b> {{ toasts.toasts.value.length }} / 3</span>
      </div>
    </section>

    <!-- `aria-live` so a toast is announced, not merely drawn. `polite` rather
         than `assertive`: these interrupt nothing. -->
    <div class="toasts" role="region" aria-label="Notifications" aria-live="polite">
      <div
        v-for="toast in toasts.toasts.value"
        :key="toast.id"
        class="toast"
        :class="`toast--${toast.kind}`"
      >
        <div class="toast__title">{{ toast.title }}</div>
        <div v-if="toast.body" class="toast__body">{{ toast.body }}</div>
        <button
          type="button"
          style="margin-top: 0.4rem"
          @click="toasts.dismiss(toast.id)"
        >
          Dismiss
        </button>
      </div>
    </div>
  </main>
</template>
