/**
 * Global test setup: every spec starts from an empty `localStorage` so
 * storage-backed composables cannot leak state across files.
 */
import { beforeEach } from 'vitest';

beforeEach(() => {
  localStorage.clear();
});
