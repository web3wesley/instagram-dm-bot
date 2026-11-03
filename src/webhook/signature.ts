/**
 * Meta webhook signature check: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(raw body, secret)>`.
 *
 * Instagram-Login webhooks are signed with the Instagram app secret; Meta's docs just say
 * "App Secret", so any configured secret is accepted and the result reports which one matched.
 * Never throws, never exposes the computed digest (it would be a valid signature for that body).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SecretName = 'instagram' | 'meta';
export interface NamedSecret {
  name: SecretName;
  value: string | undefined;
}

export type SignatureResult =
  | { ok: true; secret: SecretName }
  | { ok: false; reason: 'no_secret' | 'missing' | 'malformed' | 'mismatch' };

const HEADER = /^sha256=([0-9a-f]{64})$/i;

export function verifySignature(
  raw: Buffer,
  header: string | undefined,
  secrets: readonly NamedSecret[],
): SignatureResult {
  // HMAC happily accepts an empty key, so an unset secret must never validate anything.
  const usable = secrets.filter((s): s is { name: SecretName; value: string } => !!s.value);
  if (usable.length === 0) return { ok: false, reason: 'no_secret' };
  if (!header) return { ok: false, reason: 'missing' };
  const m = HEADER.exec(header.trim());
  if (!m?.[1]) return { ok: false, reason: 'malformed' };
  const given = Buffer.from(m[1], 'hex');
  for (const s of usable) {
    const expected = createHmac('sha256', s.value).update(raw).digest();
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      return { ok: true, secret: s.name };
    }
  }
  return { ok: false, reason: 'mismatch' };
}

/** Builds a valid header for a body — used by tests and the simulate script. */
export function signBody(raw: Buffer | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}
