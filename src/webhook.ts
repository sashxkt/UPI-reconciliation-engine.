import type { Request, Response } from 'express';
import { applyPayment, type BankPayment } from './applyPayment';
import { config } from './config';
import { withTransaction } from './db';
import { isValidSignature } from './signature';

// What the bank sends us:
// { event_id, type, utr, amount_paise, reference, payer_vpa, paid_at }
type BankEvent = Record<string, unknown> & { event_id: string; type: string };

export async function handleWebhook(req: Request, res: Response) {
  // This route uses express.raw(), so req.body is the exact bytes the bank sent.
  // The signature has to be checked against those bytes, before we parse anything.
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  if (!isValidSignature(rawBody, req.get('X-Bank-Signature'), config.webhookSecret)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  let event: BankEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'body is not valid JSON' });
    return;
  }

  if (typeof event?.event_id !== 'string' || typeof event.type !== 'string') {
    res.status(400).json({ error: 'event_id and type are required' });
    return;
  }

  // Only a successful payment moves money. Pending, failed and anything
  // we don't recognise are stored and then ignored.
  let payment: BankPayment | null = null;
  if (event.type === 'payment.success') {
    payment = readPayment(event);
    if (!payment) {
      res.status(400).json({ error: 'payment.success needs utr, amount_paise, reference and paid_at' });
      return;
    }
  }

  try {
    const result = await withTransaction(async (client) => {
      // Duplicate guard #1. If the same event is being handled by another request
      // right now, this insert waits for that transaction and then does nothing.
      const inserted = await client.query(
        `insert into webhook_events (provider_event_id, event_type, payload)
         values ($1, $2, $3)
         on conflict (provider_event_id) do nothing
         returning id`,
        [event.event_id, event.type, event],
      );
      if (inserted.rows.length === 0) return 'duplicate_event';

      const result = payment ? await applyPayment(client, payment, 'webhook') : 'ignored';

      await client.query('update webhook_events set result = $1 where id = $2', [result, inserted.rows[0].id]);
      return result;
    });

    res.json({ result });
  } catch (err) {
    // Nothing was saved. The bank will retry and we'll process it from scratch.
    console.error(`webhook ${event.event_id} failed:`, err);
    res.status(500).json({ error: 'could not process the webhook, please retry' });
  }
}

function readPayment(event: BankEvent): BankPayment | null {
  const { utr, amount_paise, reference, payer_vpa, paid_at } = event;

  if (typeof utr !== 'string' || utr === '') return null;
  if (typeof reference !== 'string') return null;
  if (typeof amount_paise !== 'number' || !Number.isSafeInteger(amount_paise) || amount_paise <= 0) return null;
  if (typeof paid_at !== 'string' || Number.isNaN(Date.parse(paid_at))) return null;

  return {
    utr,
    reference,
    amountPaise: amount_paise,
    payerVpa: typeof payer_vpa === 'string' ? payer_vpa : null,
    paidAt: new Date(paid_at),
  };
}
