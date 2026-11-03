/**
 * Meta `signed_request` (deauthorize / data-deletion callbacks): `<b64url sig>.<b64url payload>`,
 * sig = HMAC-SHA256(payload segment, app secret).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedRequestPayload {
  algorithm?: string;
  user_id?: string;
  issued_at?: number;
  [k: string]: unknown;
}

export function parseSignedRequest(sr: string, secrets: readonly (string | undefined)[]): SignedRequestPayload | null {
  const [sigPart, payloadPart] = sr.split('.', 2);
  if (!sigPart || !payloadPart) return null;
  const given = Buffer.from(sigPart, 'base64url');
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac('sha256', secret).update(payloadPart).digest();
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) continue;
    try {
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as SignedRequestPayload;
      return String(payload.algorithm ?? '').toUpperCase() === 'HMAC-SHA256' ? payload : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function makeSignedRequest(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', ...payload })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest().toString('base64url');
  return `${sig}.${body}`;
}
