# Getting started

## Install

```bash
pnpm add @mykolapodpriatov/vue-composables-kit
```

ESM only. `vue` is a peer dependency; there are no runtime dependencies.

## The shortest useful example

```vue
<script setup lang="ts">
import { useAsyncData } from '@mykolapodpriatov/vue-composables-kit';

const page = ref(1);

const { data, loading, error, refresh } = useAsyncData(
  ({ signal }) =>
    fetch(`/api/orders?page=${page.value}`, { signal }).then((r) => r.json()),
  { pollMs: 30_000, pauseOnHidden: true, watch: [page] },
);
</script>

<template>
  <p v-if="error" role="alert">{{ error }}</p>
  <ul v-else-if="data">
    <li v-for="order in data" :key="order.id">{{ order.customer }}</li>
  </ul>
  <p v-else-if="loading">Loading…</p>
</template>
```

That call owns an `AbortController`, a poll interval, a `visibilitychange`
listener and a watcher, and tears all four down when the component unmounts.

## Run the playground

Every behaviour described in these docs can be watched rather than taken on
trust. The playground ships a deliberately hostile fake backend: configurable
latency, a failing mode, a hanging mode, and per-transport health including a
socket that opens, reports itself connected and then delivers nothing.

```bash
git clone https://github.com/mykolapodpriatov/vue-composables-kit
cd vue-composables-kit
pnpm install && pnpm build      # the playground imports dist/, not src/
cd playground && pnpm install && pnpm dev
```

## Requirements

| | |
|---|---|
| Vue | 3.4 or newer |
| Node | 20.19 or newer, for the build |
| Module format | ESM only |

## What this is not

Not a utility library. `useMouse`, `useClipboard`, `useMediaQuery` and `useDark`
are [VueUse](https://vueuse.org)'s job, it does them better, and a second
library that half-covers them serves nobody.

The scope here is one thing: **async lifecycle and resilience**.
