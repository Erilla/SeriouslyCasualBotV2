import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'default',
          include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.e2e.ts'],
          environment: 'node',
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 60_000,
          hookTimeout: 120_000,
          setupFiles: ['tests/e2e/setup/workerSetup.ts'],
        },
      },
    ],
  },
});
