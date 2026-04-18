/**
 * Vitest setupFile — runs inside the test worker process.
 * Bootstraps the Discord client once per worker so getE2EContext() works,
 * then verifies the sandbox scaffold is minimally correct.
 */
import { afterAll } from 'vitest';
import { bootstrapE2E, shutdownE2E } from './bootstrap.js';
import { verifyScaffold } from './verifyScaffold.js';

await bootstrapE2E();
await verifyScaffold();

afterAll(async () => {
  await shutdownE2E();
});
