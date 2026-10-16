import { afterAll, beforeAll, beforeEach } from 'vitest';
import { pool, resetDatabase } from '../src/db';

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  // TRUNCATE doesn't fire row-level triggers, so it can clear audit_log too.
  await pool.query(`
    truncate bills, webhook_events, payments, receipt_counters,
             unmatched_payments, audit_log, recon_runs, recon_items
    restart identity cascade
  `);
});

afterAll(async () => {
  await pool.end();
});
