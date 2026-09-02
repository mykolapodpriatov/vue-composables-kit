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
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    files: ['**/*.ts'],
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

  prettier,
]);
