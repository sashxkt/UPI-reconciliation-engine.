import type { PoolClient } from 'pg';
import { applyPayment } from './applyPayment';
import { withTransaction } from './db';

export class BadRequestError extends Error {}

export type SettlementLine = {
  utr: string;
  amountPaise: number;
  reference: string;
  paidAt: Date;
};

type ReconStatus = 'matched' | 'recovered' | 'amount_mismatch' | 'unmatched_known' | 'not_in_settlement';

type ReconItem = {
  utr: string;
  status: ReconStatus;
  bankAmount: number | null;
  ourAmount: number | null;
  reference: string | null;
  note: string | null;
};

const HEADER = 'utr,amount_paise,reference,paid_at';

// The bank's end-of-day file. One payment per line, e.g.
// 426512345678,50000,BILL-7CAB523BEB,2026-10-16T10:15:00+05:30
export function parseSettlementCsv(csv: string): SettlementLine[] {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  if (lines[0] !== HEADER) {
    throw new BadRequestError(`the first line must be: ${HEADER}`);
  }

  return lines.slice(1).map((line, i) => {
    const lineNo = i + 2;
    const [utr, amount, reference = '', paidAt] = line.split(',');
    const amountPaise = Number(amount);

    if (!utr) throw new BadRequestError(`line ${lineNo}: missing utr`);
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      throw new BadRequestError(`line ${lineNo}: amount_paise must be a positive whole number`);
    }
    if (!paidAt || Number.isNaN(Date.parse(paidAt))) {
      throw new BadRequestError(`line ${lineNo}: paid_at is not a valid timestamp`);
    }

    return { utr, amountPaise, reference, paidAt: new Date(paidAt) };
  });
}

// Compares the bank's settlement file for one day with what we recorded, both ways:
//  - every line in the bank file must be matched, recovered or flagged
//  - every payment we recorded for that day must appear in the bank file
export async function reconcile(date: string, lines: SettlementLine[]) {
  return withTransaction(async (client) => {
    const items: ReconItem[] = [];

    for (const line of lines) {
      items.push(await checkBankLine(client, line));
    }

    const missing = await client.query(
      `select utr, amount_paise, reference from (
         select p.utr, p.amount_paise, b.reference, p.paid_at
         from payments p join bills b on b.id = p.bill_id
         union all
         select utr, amount_paise, reference, paid_at
         from unmatched_payments
       ) recorded
       where (paid_at at time zone 'Asia/Kolkata')::date = $1::date
         and not (utr = any($2::text[]))`,
      [date, lines.map((line) => line.utr)],
    );
    for (const row of missing.rows) {
      items.push({
        utr: row.utr,
        status: 'not_in_settlement',
        bankAmount: null,
        ourAmount: row.amount_paise,
        reference: row.reference,
        note: 'we recorded this payment but the bank did not settle it',
      });
    }

    const summary: Record<ReconStatus, number> = {
      matched: 0,
      recovered: 0,
      amount_mismatch: 0,
      unmatched_known: 0,
      not_in_settlement: 0,
    };
    for (const item of items) summary[item.status]++;

    const run = await client.query(
      `insert into recon_runs (settlement_date, bank_lines, summary)
       values ($1, $2, $3) returning id`,
      [date, lines.length, summary],
    );
    const runId = run.rows[0].id;

    for (const item of items) {
      await client.query(
        `insert into recon_items (run_id, utr, status, bank_amount_paise, our_amount_paise, reference, note)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [runId, item.utr, item.status, item.bankAmount, item.ourAmount, item.reference, item.note],
      );
    }

    return { runId, date, bankLines: lines.length, summary };
  });
}

async function checkBankLine(client: PoolClient, line: SettlementLine): Promise<ReconItem> {
  const item = {
    utr: line.utr,
    bankAmount: line.amountPaise,
    reference: line.reference || null,
  };

  const paid = await client.query('select amount_paise from payments where utr = $1', [line.utr]);
  if (paid.rows[0]) {
    const ourAmount = paid.rows[0].amount_paise;
    if (ourAmount === line.amountPaise) {
      return { ...item, status: 'matched', ourAmount, note: null };
    }
    return { ...item, status: 'amount_mismatch', ourAmount, note: 'bank settled a different amount than we recorded' };
  }

  const known = await client.query('select amount_paise, reason from unmatched_payments where utr = $1', [line.utr]);
  if (known.rows[0]) {
    return { ...item, status: 'unmatched_known', ourAmount: known.rows[0].amount_paise, note: known.rows[0].reason };
  }

  // The bank has money we never heard about: the webhook got lost.
  // Record it now, exactly the way the webhook would have.
  const result = await applyPayment(
    client,
    { utr: line.utr, amountPaise: line.amountPaise, reference: line.reference, payerVpa: null, paidAt: line.paidAt },
    'reconciliation',
  );
  return {
    ...item,
    status: 'recovered',
    ourAmount: line.amountPaise,
    note: result === 'matched' ? 'webhook never arrived, matched to bill' : `webhook never arrived, sent to unmatched: ${result}`,
  };
}
