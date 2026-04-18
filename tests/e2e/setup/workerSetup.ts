/**
 * Vitest setupFile — runs inside the test worker process.
 * Bootstraps the Discord client once per worker so getE2EContext() works.
 */
import { afterAll } from 'vitest';
import { bootstrapE2E, shutdownE2E } from './bootstrap.js';

await bootstrapE2E();

afterAll(async () => {
  await shutdownE2E();
});
