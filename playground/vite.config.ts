import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * The playground imports the **built** package, not `../src`.
 *
 * That is the point of it. Importing source would exercise TypeScript that
 * never went through the bundler, and would not notice a broken `exports` map,
 * a missing type declaration, or a module that only resolves because the test
 * runner is lenient. Those are exactly the failures a consumer hits first and
 * the maintainer hits last.
 *
 * Run `pnpm build` in the repository root before `pnpm dev` here.
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@mykolapodpriatov/vue-composables-kit': resolve(import.meta.dirname, '../dist/index.js'),
    },
  },
});
