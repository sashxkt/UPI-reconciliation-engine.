import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { paiseToRupees } from '../src/bills';
import { app, createBill } from './helpers';

describe('bills', () => {
  it('creates a bill with a UPI link', async () => {
    const bill = await createBill(50050);

    expect(bill.reference).toMatch(/^BILL-[0-9A-F]{10}$/);
    expect(bill.status).toBe('pending');
    expect(bill.amount_paise).toBe(50050);
    expect(bill.upi_link).toBe(`upi://pay?pa=cityclinic@okhdfc&pn=City%20Clinic&am=500.50&cu=INR&tr=${bill.reference}`);
  });

  it('rejects amounts that are not a positive whole number of paise', async () => {
    for (const amount_paise of [0, -100, 10.5, '500', null]) {
      const res = await request(app).post('/bills').send({ patient_name: 'Ravi', amount_paise });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a missing patient name', async () => {
    const res = await request(app).post('/bills').send({ amount_paise: 50000 });
    expect(res.status).toBe(400);
  });

  it('looks up a bill by reference, and 404s for unknown ones', async () => {
    const bill = await createBill();

    const found = await request(app).get(`/bills/${bill.reference}`);
    expect(found.status).toBe(200);
    expect(found.body.status).toBe('pending');
    expect(found.body.receipt_no).toBeNull();

    const missing = await request(app).get('/bills/BILL-NOPE');
    expect(missing.status).toBe(404);
  });

  it('serves a QR code for the front desk', async () => {
    const bill = await createBill();
    const res = await request(app).get(`/bills/${bill.reference}/qr.svg`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
  });

  it('formats paise as rupees without floats', () => {
    expect(paiseToRupees(50000)).toBe('500.00');
    expect(paiseToRupees(105)).toBe('1.05');
    expect(paiseToRupees(1)).toBe('0.01');
  });
});
