// A fake bank. It pays our bills and tells us about it by webhook, but it's a
// badly behaved bank on purpose: it repeats itself, fires the same webhook several
// times at once, loses some webhooks, sends things out of order, and lets
// patients pay the wrong amount or pay twice. Then it hands us its settlement
// file, and we check that every rupee is accounted for.
//
// It only talks to the service over HTTP, the same way a real bank would.

import { sign } from '../src/signature';
import { istDate, istTimestamp } from '../src/time';

export type ChaosRates = {
  duplicate: number; // the same webhook is sent again later
  burst: number; // the same webhook is sent 3-10 times at the same instant
  newEventSameUtr: number; // the same payment is re-sent under a new event_id
  drop: number; // the webhook is never sent, but the money still settles
  wrongAmount: number; // the patient pays less than the bill
  doublePay: number; // the patient pays the same bill twice
  unknownReference: number; // money arrives for a reference we never issued
  pendingFirst: number; // a payment.pending event shows up as well
  failed: number; // the payment fails, no money moves
};

export const defaultRates: ChaosRates = {
  duplicate: 0.1,
  burst: 0.05,
  newEventSameUtr: 0.05,
  drop: 0.05,
  wrongAmount: 0.03,
  doublePay: 0.03,
  unknownReference: 0.02,
  pendingFirst: 0.05,
  failed: 0.03,
};

type Options = {
  baseUrl: string;
  secret: string;
  bills: number;
  rates?: Partial<ChaosRates>;
  seed?: number;
};

type Payment = { utr: string; amount_paise: number; reference: string; paid_at: string };
type BankEvent = Payment & { event_id: string; type: string; payer_vpa: string };

const PATIENTS = ['Ravi Kumar', 'Anita Sharma', 'Mohammed Irfan', 'Priya Nair', 'Gurpreet Singh', 'Lakshmi Iyer', 'Arjun Das', 'Fatima Sheikh'];
const AMOUNTS = [20000, 35000, 50000, 75000, 120000, 150000]; // paise
const VPAS = ['ravi@okaxis', 'anita@ybl', 'irfan@paytm', 'priya@okicici', 'gs@oksbi'];

export async function simulate(options: Options) {
  const rates = { ...defaultRates, ...options.rates };
  const random = seededRandom(options.seed ?? Date.now());
  const chance = (rate: number) => random() < rate;
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];

  const now = new Date();
  const paidAt = istTimestamp(now);
  const settlementDate = istDate(now);

  const injected = {
    bills: 0,
    failed: 0,
    pending: 0,
    dropped: 0,
    duplicates: 0,
    bursts: 0,
    newEventSameUtr: 0,
    wrongAmount: 0,
    doublePay: 0,
    unknownReference: 0,
    forged: 1,
  };

  // 1. The front desk creates bills.
  const bills: { reference: string; amount_paise: number }[] = [];
  for (let i = 0; i < options.bills; i++) {
    const res = await post(`${options.baseUrl}/bills`, {
      patient_name: pick(PATIENTS),
      amount_paise: pick(AMOUNTS),
    });
    if (res.status !== 201) throw new Error(`creating a bill failed: ${res.status} ${await res.text()}`);
    bills.push(await res.json());
  }
  injected.bills = bills.length;

  // 2. Patients pay, and the bank decides how badly to tell us about it.
  // Each delivery is a group of webhooks fired at the same instant.
  const deliveries: BankEvent[][] = [];
  const settlement: Payment[] = [];
  const usedIds = new Set<string>();
  const newId = (make: () => string) => {
    let id = make();
    while (usedIds.has(id)) id = make();
    usedIds.add(id);
    return id;
  };
  const newUtr = () => newId(() => String(Math.floor(random() * 1e12)).padStart(12, '0'));
  const newEventId = () => newId(() => 'evt_' + hex(random, 16));
  const event = (type: string, payment: Payment): BankEvent => ({
    event_id: newEventId(),
    type,
    ...payment,
    payer_vpa: pick(VPAS),
  });

  // Bills that should end up paid: the patient paid the right amount at least once.
  let expectedPaid = 0;

  for (const bill of bills) {
    if (chance(rates.failed)) {
      injected.failed++;
      const attempt = { utr: newUtr(), amount_paise: bill.amount_paise, reference: bill.reference, paid_at: paidAt };
      deliveries.push([event('payment.failed', attempt)]);
      continue;
    }

    let amount = bill.amount_paise;
    if (chance(rates.wrongAmount)) {
      injected.wrongAmount++;
      amount -= 5000; // paid Rs 50 short
    }
    let willBePaid = amount === bill.amount_paise;

    const payment = { utr: newUtr(), amount_paise: amount, reference: bill.reference, paid_at: paidAt };
    settlement.push(payment);

    if (chance(rates.pendingFirst)) {
      injected.pending++;
      deliveries.push([event('payment.pending', payment)]);
    }

    if (chance(rates.drop)) {
      injected.dropped++;
    } else {
      const success = event('payment.success', payment);

      if (chance(rates.burst)) {
        injected.bursts++;
        const copies = 3 + Math.floor(random() * 8);
        deliveries.push(Array.from({ length: copies }, () => success));
      } else {
        deliveries.push([success]);
      }

      if (chance(rates.duplicate)) {
        injected.duplicates++;
        deliveries.push([success]);
      }

      if (chance(rates.newEventSameUtr)) {
        injected.newEventSameUtr++;
        deliveries.push([{ ...success, event_id: newEventId() }]);
      }
    }

    if (chance(rates.doublePay)) {
      injected.doublePay++;
      willBePaid = true;
      const second = { utr: newUtr(), amount_paise: bill.amount_paise, reference: bill.reference, paid_at: paidAt };
      settlement.push(second);
      deliveries.push([event('payment.success', second)]);
    }

    if (chance(rates.unknownReference)) {
      injected.unknownReference++;
      const stray = { utr: newUtr(), amount_paise: pick(AMOUNTS), reference: 'BILL-' + hex(random, 10).toUpperCase(), paid_at: paidAt };
      settlement.push(stray);
      deliveries.push([event('payment.success', stray)]);
    }

    if (willBePaid) expectedPaid++;
  }

  // 3. Send everything, shuffled so it arrives out of order, a few deliveries at a time.
  shuffle(deliveries, random);
  const webhookResults: Record<string, number> = {};
  let webhookErrors = 0;

  for (let i = 0; i < deliveries.length; i += 8) {
    const wave = deliveries.slice(i, i + 8).flat();
    const responses = await Promise.all(wave.map((e) => sendWebhook(options.baseUrl, e, options.secret)));
    for (const res of responses) {
      if (res.status !== 200) {
        webhookErrors++;
        continue;
      }
      const { result } = await res.json();
      webhookResults[result] = (webhookResults[result] ?? 0) + 1;
    }
  }

  // 4. Someone pretends to be the bank and tries to mark a bill as paid.
  const forged = event('payment.success', {
    utr: newUtr(),
    amount_paise: bills[0]?.amount_paise ?? 50000,
    reference: bills[0]?.reference ?? 'BILL-FORGED',
    paid_at: paidAt,
  });
  const forgedRes = await sendWebhook(options.baseUrl, forged, 'not-the-real-secret');

  // 5. End of day: the bank sends its settlement file and we reconcile.
  const settlementCsv = [
    'utr,amount_paise,reference,paid_at',
    ...settlement.map((p) => `${p.utr},${p.amount_paise},${p.reference},${p.paid_at}`),
  ].join('\n');

  const reconRes = await fetch(`${options.baseUrl}/reconciliation?date=${settlementDate}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: settlementCsv,
  });
  if (reconRes.status !== 200) throw new Error(`reconciliation failed: ${reconRes.status} ${await reconRes.text()}`);
  const recon = await reconRes.json();

  // 6. Check the results the way an auditor would.
  const receiptNumbers: number[] = [];
  for (const bill of bills) {
    const res = await fetch(`${options.baseUrl}/bills/${bill.reference}`);
    const found = await res.json();
    if (found.status === 'paid') receiptNumbers.push(found.receipt_no);
  }
  receiptNumbers.sort((a, b) => a - b);

  const s = recon.summary;
  const accountedFor = s.matched + s.recovered + s.amount_mismatch + s.unmatched_known;
  const checks = [
    { name: 'every bank line accounted for', ok: accountedFor === settlement.length, detail: `${accountedFor} of ${settlement.length}` },
    { name: 'nothing missing from the bank file', ok: s.not_in_settlement === 0, detail: `${s.not_in_settlement} not_in_settlement` },
    { name: 'bills paid as expected', ok: receiptNumbers.length === expectedPaid, detail: `${receiptNumbers.length} paid, expected ${expectedPaid}` },
    { name: 'receipts gapless from 1', ok: receiptNumbers.every((n, i) => n === i + 1), detail: rangeText(receiptNumbers) },
    { name: 'forged webhook rejected', ok: forgedRes.status === 401, detail: `HTTP ${forgedRes.status}` },
    { name: 'no webhook errors', ok: webhookErrors === 0, detail: `${webhookErrors} non-200 replies` },
  ];

  return {
    settlementDate,
    settlementCsv,
    injected,
    webhooksSent: deliveries.flat().length + 1,
    webhookResults,
    recon,
    checks,
    ok: checks.every((c) => c.ok),
  };
}

function sendWebhook(baseUrl: string, event: BankEvent, secret: string) {
  const body = JSON.stringify(event);
  return fetch(`${baseUrl}/webhooks/upi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bank-Signature': sign(body, secret) },
    body,
  });
}

function post(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rangeText(numbers: number[]) {
  if (numbers.length === 0) return 'none issued';
  return `${numbers[0]}..${numbers[numbers.length - 1]} (${numbers.length} receipts)`;
}

// Small seeded random number generator (mulberry32), so a run can be repeated with --seed.
function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(random: () => number, length: number) {
  let out = '';
  for (let i = 0; i < length; i++) out += Math.floor(random() * 16).toString(16);
  return out;
}

function shuffle<T>(list: T[], random: () => number) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}
