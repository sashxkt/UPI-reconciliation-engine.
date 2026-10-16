import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file shares one real Postgres database, so run them one at a time.
    fileParallelism: false,
    setupFiles: ['test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://upi:upi@localhost:5432/upi_test',
      WEBHOOK_SECRET: 'test_secret',
      HOSPITAL_VPA: 'cityclinic@okhdfc',
      HOSPITAL_NAME: 'City Clinic',
    },
  },
});
