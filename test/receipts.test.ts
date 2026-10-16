import { describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import { financialYear, istDate } from '../src/time';
import { createBill, paymentEvent, sendWebhook } from './helpers';

describe('receipt numbers', () => {
  // Test 3
  it('gives 50 simultaneous payments receipts exactly 1 to 50', async () => {
    const bills = [];
    for (let i = 0; i < 50; i++) bills.push(await createBill());

    const responses = await Promise.all(bills.map((bill) => sendWebhook(paymentEvent({ reference: bill.reference }))));
    expect(responses.every((res) => res.body.result === 'matched')).toBe(true);

    const { rows } = await pool.query('select receipt_no from payments order by receipt_no');
    expect(rows.map((r) => r.receipt_no)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('does not use up a number when a payment does not match', async () => {
    const a = await createBill(50000);
    const b = await createBill(50000);

    await sendWebhook(paymentEvent({ reference: a.reference }));
    await sendWebhook(paymentEvent({ reference: b.reference, amount_paise: 1 }));
    await sendWebhook(paymentEvent({ reference: b.reference }));

    const { rows } = await pool.query('select receipt_no from payments order by receipt_no');
    expect(rows.map((r) => r.receipt_no)).toEqual([1, 2]);
  });

  it('starts a new financial year at 00:30 IST on 1 April', async () => {
    const march = await createBill();
    const april = await createBill();

    await sendWebhook(paymentEvent({ reference: march.reference, paid_at: '2027-03-31T23:59:00+05:30' }));
    await sendWebhook(paymentEvent({ reference: april.reference, paid_at: '2027-04-01T00:30:00+05:30' }));

    const { rows } = await pool.query('select receipt_fy, receipt_no from payments order by paid_at');
    expect(rows).toEqual([
      { receipt_fy: '2026-27', receipt_no: 1 },
      { receipt_fy: '2027-28', receipt_no: 1 },
    ]);
  });
});

describe('financialYear', () => {
  it('runs April to March', () => {
    expect(financialYear(new Date('2026-10-16T10:00:00+05:30'))).toBe('2026-27');
    expect(financialYear(new Date('2027-02-15T10:00:00+05:30'))).toBe('2026-27');
    expect(financialYear(new Date('2027-04-01T00:00:00+05:30'))).toBe('2027-28');
    expect(financialYear(new Date('2099-04-01T00:00:00+05:30'))).toBe('2099-00');
  });

  it('uses the date in India, not the UTC date', () => {
    // 19:00 UTC on 31 March is already 00:30 on 1 April in India.
    const moment = new Date('2027-03-31T19:00:00Z');
    expect(istDate(moment)).toBe('2027-04-01');
    expect(financialYear(moment)).toBe('2027-28');
  });
});
