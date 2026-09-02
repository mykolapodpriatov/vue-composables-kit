---
layout: home

hero:
  name: vue-composables-kit
  text: The messy parts of async UI
  tagline: Aborts, polling, transport fallback, TTL caching and timers that clean up after themselves. Narrow on purpose.
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: Why this exists
      link: /guide/why
    - theme: alt
      text: GitHub
      link: https://github.com/mykolapodpriatov/vue-composables-kit

features:
  - title: A request that cannot race itself
    details: >-
      A slow first request landing after a fast second one is the bug nobody
      writes a test for. useAsyncData aborts the superseded call and drops its
      result even if it lands anyway.
    link: /api/use-async-data
  - title: A feed that degrades instead of dying
    details: >-
      WebSocket → SSE → polling, with exponential backoff and a watchdog for the
      socket that stays OPEN while delivering nothing.
    link: /api/use-event-stream
  - title: Storage that is best-effort
    details: >-
      localStorage throws in Safari private mode, in blocked WebViews and on a
      full origin. Losing persistence is acceptable. Losing the app is not.
    link: /api/use-local-storage
  - title: Timers that clean up after themselves
    details: >-
      Every interval, listener and timeout is torn down through onScopeDispose,
      so a component that unmounts mid-poll does not leak its closure.
    link: /api/use-countdown
---
