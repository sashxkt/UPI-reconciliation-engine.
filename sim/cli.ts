// npm run simulate -- 200
// npm run simulate -- 200 --seed=42 --drop=0.2 --burst=0.1
//
// Resets the database, starts the service on a random port, lets the fake bank
// loose on it and prints what happened.

import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, resetDatabase } from '../src/db';
import { defaultRates, simulate, type ChaosRates } from './simulate';

const args = process.argv.slice(2);
const bills = Number(args.find((arg) => !arg.startsWith('--')) ?? 200);
let seed = Date.now() % 100000;
const rates: Partial<ChaosRates> = {};

for (const arg of args.filter((a) => a.startsWith('--'))) {
  const [name, value] = arg.slice(2).split('=');
  if (name === 'seed') {
    seed = Number(value);
  } else if (name in defaultRates) {
    rates[name as keyof ChaosRates] = Number(value);
  } else {
    console.error(`Unknown option --${name}. Rates you can set: ${Object.keys(defaultRates).join(', ')}`);
    process.exit(1);
  }
}

if (!Number.isInteger(bills) || bills < 1) {
  console.error('Usage: npm run simulate -- <number of bills> [--seed=N] [--drop=0.1 ...]');
  process.exit(1);
}

console.log('Resetting the database...');
await resetDatabase();

const server = createApp().listen(0);
await once(server, 'listening');
const { port } = server.address() as AddressInfo;

console.log(`Simulating ${bills} bills (seed ${seed})...\n`);
const report = await simulate({ baseUrl: `http://localhost:${port}`, secret: config.webhookSecret, bills, rates, seed });

await mkdir('sim-output', { recursive: true });
const csvPath = `sim-output/settlement-${report.settlementDate}.csv`;
await writeFile(csvPath, report.settlementCsv + '\n');

const i = report.injected;
console.log('What the bank did');
console.log(`  bills created           ${i.bills}`);
console.log(`  webhooks sent           ${report.webhooksSent}`);
console.log(`  duplicates sent later   ${i.duplicates}`);
console.log(`  same-instant bursts     ${i.bursts}`);
console.log(`  same UTR, new event id  ${i.newEventSameUtr}`);
console.log(`  webhooks dropped        ${i.dropped}`);
console.log(`  wrong amounts           ${i.wrongAmount}`);
console.log(`  bills paid twice        ${i.doublePay}`);
console.log(`  unknown references      ${i.unknownReference}`);
console.log(`  pending events          ${i.pending}`);
console.log(`  failed payments         ${i.failed}`);
console.log(`  forged webhooks         ${i.forged}`);

console.log('\nWhat the service answered');
for (const [result, count] of Object.entries(report.webhookResults).sort()) {
  console.log(`  ${result.padEnd(22)}  ${count}`);
}

console.log(`\nReconciliation for ${report.settlementDate} (${report.recon.bankLines} bank lines, saved to ${csvPath})`);
for (const [status, count] of Object.entries(report.recon.summary)) {
  console.log(`  ${status.padEnd(22)}  ${count}`);
}

console.log('\nChecks');
for (const check of report.checks) {
  console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(36)} ${check.detail}`);
}
console.log(report.ok ? '\nEvery rupee is accounted for.' : '\nSomething does not add up.');

server.close();
await pool.end();
process.exitCode = report.ok ? 0 : 1;
