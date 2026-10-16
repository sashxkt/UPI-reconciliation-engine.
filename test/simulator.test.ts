import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simulate } from '../sim/simulate';
import { app } from './helpers';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('bank simulator (end to end)', () => {
  it('survives 120 bills of chaos with every rupee accounted for', async () => {
    const report = await simulate({
      baseUrl,
      secret: 'test_secret',
      bills: 120,
      seed: 7,
      // Turned up from the defaults so every bad case shows up at least once.
      rates: { burst: 0.1, drop: 0.1, wrongAmount: 0.05, doublePay: 0.05, unknownReference: 0.05, pendingFirst: 0.1, failed: 0.05 },
    });

    for (const check of report.checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    }

    expect(report.webhookResults.duplicate_event).toBeGreaterThan(0);
    expect(report.webhookResults.duplicate_utr).toBeGreaterThan(0);
    expect(report.webhookResults.amount_mismatch).toBeGreaterThan(0);
    expect(report.webhookResults.double_payment).toBeGreaterThan(0);
    expect(report.webhookResults.unknown_reference).toBeGreaterThan(0);
    expect(report.webhookResults.ignored).toBeGreaterThan(0);
    expect(report.recon.summary.recovered).toBeGreaterThan(0);
  });
});
