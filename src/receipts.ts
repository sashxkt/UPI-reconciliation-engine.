import type { PoolClient } from 'pg';

// Gives out the next receipt number for a financial year.
//
// The upsert locks the counter row for this year until our transaction ends,
// so two payments can never get the same number: the second one waits.
// And if our transaction rolls back, the increment rolls back with it,
// so a failed payment never burns a number. That's what keeps receipts gapless.
export async function nextReceiptNumber(client: PoolClient, fy: string): Promise<number> {
  const { rows } = await client.query(
    `insert into receipt_counters (fy, last_no) values ($1, 1)
     on conflict (fy) do update set last_no = receipt_counters.last_no + 1
     returning last_no`,
    [fy],
  );
  return rows[0].last_no;
}
