import { defineConfig } from 'vitepress';

/**
 * Documentation for vue-composables-kit.
 *
 * Organised around *problems* rather than around the export list. Someone
 * arriving here has a symptom — "my poll wiped the page", "the socket says
 * connected and nothing arrives" — not the name of the composable that fixes
 * it. An alphabetical API index answers the question they would ask second.
 */
export default defineConfig({
  title: 'vue-composables-kit',
  description:
    'Production-hardened Vue 3 composables for the messy parts of async UI: aborts, polling, transport fallback, TTL caching and timers that clean up after themselves.',
  // GitHub Pages serves the site from a subdirectory.
  base: '/vue-composables-kit/',
  lastUpdated: true,
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/use-async-data' },
      {
        text: 'GitHub',
        link: 'https://github.com/mykolapodpriatov/vue-composables-kit',
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Why this exists', link: '/guide/why' },
          { text: 'Failure handling', link: '/guide/failures' },
        ],
      },
      {
        text: 'API',
        items: [
          { text: 'useAsyncData', link: '/api/use-async-data' },
          { text: 'useEventStream', link: '/api/use-event-stream' },
          { text: 'createTtlCache', link: '/api/create-ttl-cache' },
          { text: 'useLocalStorage', link: '/api/use-local-storage' },
          { text: 'useCountdown', link: '/api/use-countdown' },
          { text: 'useToastQueue', link: '/api/use-toast-queue' },
          { text: 'lazyImport', link: '/api/lazy-import' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/mykolapodpriatov/vue-composables-kit' },
    ],

    footer: {
      message: 'MIT licensed.',
      copyright: 'Mykola Podpriatov',
    },

    search: { provider: 'local' },
  },
});
