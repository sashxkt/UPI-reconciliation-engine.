import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import { parseSettlementCsv } from '../src/reconcile';
import { app, count, createBill, paymentEvent, sendWebhook } from './helpers';

const PAID_AT = '2026-10-16T10:15:00+05:30';

function settlementFile(lines: { utr: string; amount_paise: number; reference: string }[]) {
  const rows = lines.map((l) => `${l.utr},${l.amount_paise},${l.reference},${PAID_AT}`);
  return ['utr,amount_paise,reference,paid_at', ...rows].join('\n');
}

function reconcile(csv: string, date = '2026-10-16') {
  return request(app).post(`/reconciliation?date=${date}`).set('Content-Type', 'text/csv').send(csv);
}

describe('reconciliation', () => {
  // Test 6
  it('recovers a payment whose webhook never arrived, with the next receipt number', async () => {
    const first = await createBill(50000);
    const second = await createBill(75000);

    const delivered = paymentEvent({ reference: first.reference, amount_paise: 50000 });
    await sendWebhook(delivered);
    const lost = paymentEvent({ reference: second.reference, amount_paise: 75000 }); // never sent

    const res = await reconcile(settlementFile([delivered, lost]));

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      matched: 1,
      recovered: 1,
      amount_mismatch: 0,
      unmatched_known: 0,
      not_in_settlement: 0,
    });

    const { rows } = await pool.query('select utr, receipt_no, source from payments order by receipt_no');
    expect(rows).toEqual([
      { utr: delivered.utr, receipt_no: 1, source: 'webhook' },
      { utr: lost.utr, receipt_no: 2, source: 'reconciliation' },
    ]);
  });

  it('marks money already in the unmatched list as unmatched_known', async () => {
    const bill = await createBill(50000);
    const short = paymentEvent({ reference: bill.reference, amount_paise: 40000 });
    await sendWebhook(short);

    const res = await reconcile(settlementFile([short]));
    expect(res.body.summary.unmatched_known).toBe(1);
  });

  it('flags a bank amount that differs from what we recorded', async () => {
    const bill = await createBill(50000);
    const event = paymentEvent({ reference: bill.reference });
    await sendWebhook(event);

    const res = await reconcile(settlementFile([{ ...event, amount_paise: 49000 }]));
    expect(res.body.summary.amount_mismatch).toBe(1);
  });

  it('reports payments we recorded that the bank never settled', async () => {
    const bill = await createBill();
    await sendWebhook(paymentEvent({ reference: bill.reference }));

    const res = await reconcile(settlementFile([]));
    expect(res.body.summary.not_in_settlement).toBe(1);
  });

  it('decides which day a payment belongs to in IST', async () => {
    const lateNight = await createBill();
    const earlyMorning = await createBill();
    await sendWebhook(paymentEvent({ reference: lateNight.reference, paid_at: '2026-10-15T23:30:00+05:30' }));
    // 00:30 IST on the 16th is still the 15th in UTC, but it belongs to the 16th.
    await sendWebhook(paymentEvent({ reference: earlyMorning.reference, paid_at: '2026-10-16T00:30:00+05:30' }));

    const res = await reconcile(settlementFile([]), '2026-10-16');
    expect(res.body.summary.not_in_settlement).toBe(1);
  });

  it('stores the run and every line result', async () => {
    const bill = await createBill();
    const event = paymentEvent({ reference: bill.reference });
    await sendWebhook(event);

    const res = await reconcile(settlementFile([event]));

    const run = await pool.query('select settlement_date, bank_lines, summary from recon_runs where id = $1', [res.body.runId]);
    expect(run.rows[0].settlement_date).toBe('2026-10-16');
    expect(run.rows[0].bank_lines).toBe(1);
    expect(run.rows[0].summary.matched).toBe(1);

    const items = await pool.query('select utr, status from recon_items where run_id = $1', [res.body.runId]);
    expect(items.rows).toEqual([{ utr: event.utr, status: 'matched' }]);
  });

  it('rejects a bad file or date with 400 and saves nothing', async () => {
    expect((await reconcile('wrong,header\n1,2,3,4')).status).toBe(400);
    expect((await reconcile(settlementFile([]), 'yesterday')).status).toBe(400);
    expect((await reconcile(`utr,amount_paise,reference,paid_at\n123,12.5,BILL-X,${PAID_AT}`)).status).toBe(400);

    expect(await count('recon_runs')).toBe(0);
  });

  it('copes with Windows line endings and blank lines', () => {
    const csv = `utr,amount_paise,reference,paid_at\r\n111,500,BILL-A,${PAID_AT}\r\n\r\n`;
    expect(parseSettlementCsv(csv)).toEqual([{ utr: '111', amountPaise: 500, reference: 'BILL-A', paidAt: new Date(PAID_AT) }]);
  });
});
