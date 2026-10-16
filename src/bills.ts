import { randomBytes } from 'node:crypto';
import { config } from './config';
import { pool } from './db';

export function newReference(): string {
  return 'BILL-' + randomBytes(5).toString('hex').toUpperCase();
}

// 50000 -> '500.00'. Done with integers so no float ever touches money.
export function paiseToRupees(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = String(paise % 100).padStart(2, '0');
  return `${rupees}.${rest}`;
}

// The standard UPI deep link. Any UPI app can open it, and it's what goes in the QR code.
// `tr` carries our bill reference, and the bank sends it back to us in the webhook.
export function upiLink(reference: string, amountPaise: number): string {
  const params = [
    `pa=${config.hospitalVpa}`,
    `pn=${encodeURIComponent(config.hospitalName)}`,
    `am=${paiseToRupees(amountPaise)}`,
    'cu=INR',
    `tr=${reference}`,
  ];
  return `upi://pay?${params.join('&')}`;
}

export async function createBill(patientName: string, amountPaise: number) {
  const { rows } = await pool.query(
    `insert into bills (reference, patient_name, amount_paise)
     values ($1, $2, $3)
     returning id, reference, amount_paise, status`,
    [newReference(), patientName, amountPaise],
  );
  const bill = rows[0];
  return { ...bill, upi_link: upiLink(bill.reference, bill.amount_paise) };
}

export async function findBill(reference: string) {
  const { rows } = await pool.query(
    `select b.id, b.reference, b.patient_name, b.amount_paise, b.status,
            b.created_at, b.paid_at, p.utr, p.receipt_fy, p.receipt_no
     from bills b
     left join payments p on p.bill_id = b.id
     where b.reference = $1`,
    [reference],
  );
  return rows[0] ?? null;
}
