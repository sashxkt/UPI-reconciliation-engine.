import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(body: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function isValidSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;

  const expected = Buffer.from(sign(body, secret), 'hex');
  const received = Buffer.from(signature, 'hex');

  // timingSafeEqual throws when the lengths differ. The length isn't secret,
  // so checking it first doesn't leak anything.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}
