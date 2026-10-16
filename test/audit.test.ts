import { describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import { count, createBill, paymentEvent, sendWebhook } from './helpers';

describe('audit log', () => {
  // Test 7
  it('cannot be edited or deleted, the database itself refuses', async () => {
    const bill = await createBill();
    await sendWebhook(paymentEvent({ reference: bill.reference }));

    await expect(pool.query('update audit_log set amount_paise = 1')).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from audit_log')).rejects.toThrow(/append-only/);

    expect(await count('audit_log')).toBe(1);
  });
});
