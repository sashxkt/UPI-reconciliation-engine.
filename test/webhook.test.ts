import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import { sign } from '../src/signature';
import { app, count, createBill, paymentEvent, sendWebhook } from './helpers';

describe('webhook', () => {
  // Test 1
  it('processes the same webhook only once', async () => {
    const bill = await createBill();
    const event = paymentEvent({ reference: bill.reference });

    const first = await sendWebhook(event);
    const second = await sendWebhook(event);

    expect(first.body.result).toBe('matched');
    expect(second.status).toBe(200);
    expect(second.body.result).toBe('duplicate_event');
    expect(await count('payments')).toBe(1);

    const found = await request(app).get(`/bills/${bill.reference}`);
    expect(found.body.status).toBe('paid');
    expect(found.body.utr).toBe(event.utr);
    expect(found.body.receipt_fy).toBe('2026-27');
    expect(found.body.receipt_no).toBe(1);
  });

  // Test 2
  it('handles 10 identical webhooks arriving at the same instant', async () => {
    const bill = await createBill();
    const event = paymentEvent({ reference: bill.reference });

    const responses = await Promise.all(Array.from({ length: 10 }, () => sendWebhook(event)));
    const results = responses.map((res) => res.body.result);

    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(results.filter((r) => r === 'matched')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate_event')).toHaveLength(9);
    expect(await count('payments')).toBe(1);
    expect(await count('webhook_events')).toBe(1);
  });

  // Test 2b
  it('treats the same UTR under two event ids as one payment, even at once', async () => {
    const bill = await createBill();
    const event = paymentEvent({ reference: bill.reference });
    const resent = { ...event, event_id: 'evt_resent_by_bank' };

    const responses = await Promise.all([sendWebhook(event), sendWebhook(resent)]);
    const results = responses.map((res) => res.body.result).sort();

    expect(results).toEqual(['duplicate_utr', 'matched']);
    expect(await count('payments')).toBe(1);
    expect(await count('unmatched_payments')).toBe(0);
  });

  // Test 4
  it('rejects a bad or missing signature and stores nothing', async () => {
    const bill = await createBill();
    const event = paymentEvent({ reference: bill.reference });

    const forged = await sendWebhook(event, 'wrong_secret');
    const unsigned = await request(app).post('/webhooks/upi').set('Content-Type', 'application/json').send(event);

    expect(forged.status).toBe(401);
    expect(unsigned.status).toBe(401);
    expect(await count('webhook_events')).toBe(0);
    expect(await count('payments')).toBe(0);
  });

  it('rejects a body that was changed after signing', async () => {
    const bill = await createBill();
    const body = JSON.stringify(paymentEvent({ reference: bill.reference }));
    const tampered = body.replace('"amount_paise":50000', '"amount_paise":5');

    const res = await request(app)
      .post('/webhooks/upi')
      .set('Content-Type', 'application/json')
      .set('X-Bank-Signature', sign(body, 'test_secret'))
      .send(tampered);

    expect(res.status).toBe(401);
  });

  it('returns 400 for a signed body that is not JSON', async () => {
    const body = 'this is not json';
    const res = await request(app)
      .post('/webhooks/upi')
      .set('Content-Type', 'application/json')
      .set('X-Bank-Signature', sign(body, 'test_secret'))
      .send(body);

    expect(res.status).toBe(400);
    expect(await count('webhook_events')).toBe(0);
  });

  it('stores pending and failed events but never moves money for them', async () => {
    const bill = await createBill();

    const pending = await sendWebhook(paymentEvent({ type: 'payment.pending', reference: bill.reference }));
    const failed = await sendWebhook(paymentEvent({ type: 'payment.failed', reference: bill.reference }));

    expect(pending.body.result).toBe('ignored');
    expect(failed.body.result).toBe('ignored');
    expect(await count('webhook_events')).toBe(2);
    expect(await count('payments')).toBe(0);

    const { rows } = await pool.query('select status from bills where id = $1', [bill.id]);
    expect(rows[0].status).toBe('pending');
  });
});
