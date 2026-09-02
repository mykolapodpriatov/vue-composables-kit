import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default defineConfig([
  globalIgnores([
    'dist/**',
    'coverage/**',
    'docs/.vitepress/cache/**',
    'docs/.vitepress/dist/**',
    // Build output, including the playground's — linting a bundle produces
    // thousands of findings about code nobody wrote.
    'playground/dist/**',
    'playground/node_modules/**',
    // Parsing an SFC needs `vue-eslint-parser`, and this library ships no
    // components — pulling it in as a devDependency to lint one demo file is a
    // worse trade than leaving that file to `vue-tsc` in the playground's own
    // build. Its TypeScript is still linted.
    'playground/**/*.vue',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    files: ['src/**/*.ts', 'test/**/*.ts', '*.config.ts', 'docs/.vitepress/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The kit deliberately swallows storage and transport failures; every
      // such site carries a comment explaining why, so an outright ban on empty
      // blocks would only push the noise into `void 0` placeholders.
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Tests intentionally construct rejected promises and empty executors.
      '@typescript-eslint/no-empty-function': 'off',
    },
  },

  // The flat config itself is plain JS outside the build tsconfig — lint it
  // with the syntactic rules only.
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // The playground is a separate Vite app with its own tsconfig. Type-aware
  // rules would need it added to a project here; the syntactic set is enough
  // for a demo whose job is to be run, not shipped.
  {
    files: ['playground/**/*.{ts,vue}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
]);
