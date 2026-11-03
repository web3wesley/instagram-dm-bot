import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signBody, verifySignature, type NamedSecret } from '../src/webhook/signature.ts';
import { fixtureRaw } from './helpers/fixtures.ts';

const IG = 'ig-app-secret-for-tests';
const META = 'meta-app-secret-for-tests';
const secrets: NamedSecret[] = [
  { name: 'instagram', value: IG },
  { name: 'meta', value: META },
];
const raw = fixtureRaw('webhook/comment.changes.json');

describe('verifySignature (X-Hub-Signature-256)', () => {
  it('accepts a correct HMAC-SHA256 of the raw body', () => {
    expect(verifySignature(raw, signBody(raw, IG), secrets)).toEqual({ ok: true, secret: 'instagram' });
  });

  it('accepts either configured secret and reports which one matched', () => {
    expect(verifySignature(raw, signBody(raw, META), secrets)).toEqual({ ok: true, secret: 'meta' });
  });

  it('accepts an uppercase hex digest', () => {
    const header = signBody(raw, IG).replace(/[0-9a-f]{64}$/, (h) => h.toUpperCase());
    expect(verifySignature(raw, header, secrets).ok).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(raw, signBody(raw, 'attacker'), secrets)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a tampered body', () => {
    const header = signBody(raw, IG);
    const tampered = Buffer.from(raw.toString('utf8').replace('SKILL', 'LOOP'));
    expect(verifySignature(tampered, header, secrets)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('proves the raw bytes are used: re-serialized JSON does not verify', () => {
    const header = signBody(raw, IG);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))));
    expect(reserialized.equals(raw)).toBe(false);
    expect(verifySignature(reserialized, header, secrets).ok).toBe(false);
  });

  it('verifies bodies carrying \\uXXXX escapes byte-for-byte', () => {
    const escaped = Buffer.from('{"object":"instagram","entry":[{"text":"SKILL \\ud83d\\ude4f"}]}');
    expect(verifySignature(escaped, signBody(escaped, IG), secrets).ok).toBe(true);
  });

  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['sha1=abc', 'malformed'],
    [createHmac('sha256', IG).update(raw).digest('hex'), 'malformed'], // no "sha256=" prefix
    ['sha256=abc123', 'malformed'], // wrong length
    [`sha256=${'z'.repeat(64)}`, 'malformed'], // not hex
  ] as const)('rejects header %j as %s without throwing', (header, reason) => {
    expect(verifySignature(raw, header, secrets)).toEqual({ ok: false, reason });
  });

  it('always fails when no secret is configured (HMAC accepts an empty key)', () => {
    const emptySig = signBody(raw, '');
    expect(verifySignature(raw, emptySig, [{ name: 'instagram', value: '' }])).toEqual({ ok: false, reason: 'no_secret' });
    expect(verifySignature(raw, emptySig, [{ name: 'instagram', value: undefined }])).toEqual({ ok: false, reason: 'no_secret' });
    expect(verifySignature(raw, emptySig, [])).toEqual({ ok: false, reason: 'no_secret' });
  });
});
