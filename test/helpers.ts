import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import { sign } from '../src/signature';

export const app = createApp();

let counter = 0;

export async function createBill(amountPaise = 50000, patientName = 'Ravi Kumar') {
  const res = await request(app).post('/bills').send({ patient_name: patientName, amount_paise: amountPaise });
  if (res.status !== 201) throw new Error(`could not create bill: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: number; reference: string; amount_paise: number; status: string; upi_link: string };
}

// A payment.success event like the bank would send. Override whatever the test cares about.
export function paymentEvent(overrides: Record<string, unknown> = {}) {
  counter++;
  return {
    event_id: `evt_test_${counter}`,
    type: 'payment.success',
    utr: String(426500000000 + counter),
    amount_paise: 50000,
    reference: 'BILL-UNKNOWN',
    payer_vpa: 'ravi@okaxis',
    paid_at: '2026-10-16T10:15:00+05:30',
    ...overrides,
  };
}

export function sendWebhook(event: object, secret = 'test_secret') {
  const body = JSON.stringify(event);
  return request(app)
    .post('/webhooks/upi')
    .set('Content-Type', 'application/json')
    .set('X-Bank-Signature', sign(body, secret))
    .send(body);
}

export async function count(table: string) {
  const { rows } = await pool.query(`select count(*)::int as n from ${table}`);
  return rows[0].n as number;
}
