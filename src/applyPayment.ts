import type { PoolClient } from 'pg';
import { nextReceiptNumber } from './receipts';
import { financialYear } from './time';

export type BankPayment = {
  utr: string;
  amountPaise: number;
  reference: string;
  payerVpa: string | null;
  paidAt: Date;
};

export type UnmatchedReason = 'unknown_reference' | 'amount_mismatch' | 'double_payment';
export type PaymentResult = 'matched' | 'duplicate_utr' | UnmatchedReason;

// Records one real payment from the bank. Must run inside a transaction.
//
// The payment either ends up attached to its bill with a receipt number,
// or in unmatched_payments for a human to sort out. Never both, never neither.
export async function applyPayment(
  client: PoolClient,
  payment: BankPayment,
  source: 'webhook' | 'reconciliation',
): Promise<PaymentResult> {
  // One UTR is one payment. The lock makes two requests carrying the same UTR
  // take turns, so the second one sees what the first one wrote.
  // (A hashtext collision between two different UTRs only means a short wait.)
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [payment.utr]);

  const seen = await client.query(
    `select 1 from payments where utr = $1
     union all
     select 1 from unmatched_payments where utr = $1`,
    [payment.utr],
  );
  if (seen.rows.length > 0) return 'duplicate_utr';

  // Lock the bill, so two different payments for it can't both mark it paid.
  const { rows } = await client.query(
    'select id, amount_paise, status from bills where reference = $1 for update',
    [payment.reference],
  );
  const bill = rows[0];

  let reason: UnmatchedReason | null = null;
  if (!bill) {
    reason = 'unknown_reference';
  } else if (bill.status !== 'pending') {
    // Already paid (or cancelled). This money needs to go back to the patient.
    reason = 'double_payment';
  } else if (bill.amount_paise !== payment.amountPaise) {
    reason = 'amount_mismatch';
  }

  if (reason) {
    await client.query(
      `insert into unmatched_payments (utr, amount_paise, reference, payer_vpa, paid_at, reason, source)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [payment.utr, payment.amountPaise, payment.reference, payment.payerVpa, payment.paidAt, reason, source],
    );
    await client.query(
      `insert into audit_log (action, bill_id, utr, amount_paise, details)
       values ('payment_unmatched', $1, $2, $3, $4)`,
      [bill?.id ?? null, payment.utr, payment.amountPaise, { reason, source, reference: payment.reference }],
    );
    return reason;
  }

  const fy = financialYear(payment.paidAt);
  const receiptNo = await nextReceiptNumber(client, fy);

  await client.query(
    `insert into payments (bill_id, utr, amount_paise, payer_vpa, paid_at, receipt_fy, receipt_no, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [bill.id, payment.utr, payment.amountPaise, payment.payerVpa, payment.paidAt, fy, receiptNo, source],
  );
  await client.query(`update bills set status = 'paid', paid_at = $2 where id = $1`, [bill.id, payment.paidAt]);
  await client.query(
    `insert into audit_log (action, bill_id, utr, amount_paise, details)
     values ('payment_matched', $1, $2, $3, $4)`,
    [bill.id, payment.utr, payment.amountPaise, { source, receipt_fy: fy, receipt_no: receiptNo }],
  );

  return 'matched';
}
