import { bootstrapE2E, shutdownE2E } from './bootstrap.js';
import { verifyScaffold } from './verifyScaffold.js';

export async function setup(): Promise<void> {
  await bootstrapE2E();
  await verifyScaffold();
}

export async function teardown(): Promise<void> {
  await shutdownE2E();
}
