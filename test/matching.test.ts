import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import { app, count, createBill, paymentEvent, sendWebhook } from './helpers';

async function billStatus(id: number) {
  const { rows } = await pool.query('select status from bills where id = $1', [id]);
  return rows[0].status;
}

describe('matching payments to bills', () => {
  // Test 5
  it('leaves the bill pending when the amount is wrong', async () => {
    const bill = await createBill(50000);

    const res = await sendWebhook(paymentEvent({ reference: bill.reference, amount_paise: 45000 }));

    expect(res.body.result).toBe('amount_mismatch');
    expect(await billStatus(bill.id)).toBe('pending');
    expect(await count('payments')).toBe(0);

    const { rows } = await pool.query('select reason, amount_paise from unmatched_payments');
    expect(rows).toEqual([{ reason: 'amount_mismatch', amount_paise: 45000 }]);
  });

  it('flags a second payment for a bill that is already paid', async () => {
    const bill = await createBill();

    const first = await sendWebhook(paymentEvent({ reference: bill.reference }));
    const second = await sendWebhook(paymentEvent({ reference: bill.reference }));

    expect(first.body.result).toBe('matched');
    expect(second.body.result).toBe('double_payment');
    expect(await count('payments')).toBe(1);
    expect(await count('unmatched_payments')).toBe(1);
  });

  it('flags two different payments for the same bill arriving at once', async () => {
    const bill = await createBill();

    const responses = await Promise.all([
      sendWebhook(paymentEvent({ reference: bill.reference })),
      sendWebhook(paymentEvent({ reference: bill.reference })),
    ]);

    expect(responses.map((r) => r.body.result).sort()).toEqual(['double_payment', 'matched']);
  });

  it('sends money for a reference we never issued to the unmatched list', async () => {
    const res = await sendWebhook(paymentEvent({ reference: 'BILL-NEVERISSUED' }));

    expect(res.body.result).toBe('unknown_reference');
    expect(await count('unmatched_payments')).toBe(1);
  });

  it('lists unmatched payments with their reason', async () => {
    await sendWebhook(paymentEvent({ reference: 'BILL-NEVERISSUED' }));

    const res = await request(app).get('/unmatched');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].reason).toBe('unknown_reference');
  });

  it('writes an audit row for every matched and unmatched payment', async () => {
    const bill = await createBill();
    await sendWebhook(paymentEvent({ reference: bill.reference }));
    await sendWebhook(paymentEvent({ reference: 'BILL-NEVERISSUED' }));

    const { rows } = await pool.query('select action from audit_log order by id');
    expect(rows.map((r) => r.action)).toEqual(['payment_matched', 'payment_unmatched']);
  });
});
