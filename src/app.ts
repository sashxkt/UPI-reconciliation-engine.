import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { createBill, findBill, upiLink } from './bills';
import { pool } from './db';
import { BadRequestError, parseSettlementCsv, reconcile } from './reconcile';
import { handleWebhook } from './webhook';

export function createApp() {
  const app = express();

  // The webhook needs the raw body for the signature check, so it gets
  // its own body parser and is registered before express.json().
  app.post('/webhooks/upi', express.raw({ type: '*/*', limit: '100kb' }), handleWebhook);

  app.use(express.json());

  app.post('/bills', async (req, res) => {
    const { patient_name, amount_paise } = req.body ?? {};

    if (typeof patient_name !== 'string' || patient_name.trim() === '') {
      throw new BadRequestError('patient_name is required');
    }
    if (!Number.isSafeInteger(amount_paise) || amount_paise <= 0) {
      throw new BadRequestError('amount_paise must be a positive whole number of paise');
    }

    const bill = await createBill(patient_name.trim(), amount_paise);
    res.status(201).json(bill);
  });

  app.get('/bills/:reference', async (req, res) => {
    const bill = await findBill(req.params.reference);
    if (!bill) {
      res.status(404).json({ error: 'no bill with that reference' });
      return;
    }
    res.json(bill);
  });

  // The QR code the front desk shows the patient.
  app.get('/bills/:reference/qr.svg', async (req, res) => {
    const bill = await findBill(req.params.reference);
    if (!bill) {
      res.status(404).json({ error: 'no bill with that reference' });
      return;
    }
    const svg = await QRCode.toString(upiLink(bill.reference, bill.amount_paise), { type: 'svg', margin: 2 });
    res.type('image/svg+xml').send(svg);
  });

  app.post('/reconciliation', express.text({ type: 'text/csv', limit: '10mb' }), async (req, res) => {
    const date = String(req.query.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestError('pass the settlement day as ?date=YYYY-MM-DD');
    }
    if (typeof req.body !== 'string') {
      throw new BadRequestError('send the settlement file as text/csv');
    }

    const report = await reconcile(date, parseSettlementCsv(req.body));
    res.json(report);
  });

  app.get('/unmatched', async (_req, res) => {
    const { rows } = await pool.query(
      `select utr, amount_paise, reference, payer_vpa, paid_at, reason, source, created_at
       from unmatched_payments
       order by created_at`,
    );
    res.json(rows);
  });

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequestError || err.status === 400) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  });

  return app;
}
