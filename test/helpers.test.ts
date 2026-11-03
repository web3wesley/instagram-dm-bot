import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.ts';
import { csvCell, parseCsv, toCsv } from '../src/lib/csv.ts';
import { dayStart, isoInTz } from '../src/lib/time.ts';
import { makeSignedRequest, parseSignedRequest } from '../src/webhook/signedRequest.ts';

describe('signed_request (Meta deauthorize / data-deletion callbacks)', () => {
  it('accepts a valid signature from any configured secret and rejects tampering', () => {
    const sr = makeSignedRequest({ user_id: '1784', issued_at: 1790000000 }, 's2');
    expect(parseSignedRequest(sr, ['s1', 's2'])).toMatchObject({ user_id: '1784', algorithm: 'HMAC-SHA256' });
    expect(parseSignedRequest(sr, ['s1'])).toBeNull();
    const [sig, payload] = sr.split('.');
    const forged = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'evil' })).toString('base64url');
    expect(parseSignedRequest(`${sig}.${forged}`, ['s2'])).toBeNull();
    expect(parseSignedRequest(`${sig}.${payload}`, [undefined, ''])).toBeNull();
    expect(parseSignedRequest('garbage', ['s2'])).toBeNull();
  });
});

describe('CSV export', () => {
  it('quotes cells and neutralizes spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+81 90')).toBe(`"'+81 90"`);
    expect(csvCell('@user')).toBe(`"'@user"`);
    expect(csvCell(null)).toBe('""');
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('"a","b"\r\n"1","x"\r\n');
  });

  it('round-trips through parseCsv, including quotes, commas and newlines inside cells', () => {
    const rows = [
      ['1', 'jess.builds', 'say "hi", please'],
      ['2', 'multi\nline', ''],
    ];
    expect(parseCsv(`﻿${toCsv(['id', 'username', 'comment'], rows)}`)).toEqual([['id', 'username', 'comment'], ...rows]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('JST reporting helpers', () => {
  it('computes the Tokyo day boundary and formats with the +09:00 offset', () => {
    const t = Date.parse('2026-09-28T20:30:00Z'); // 05:30 on Sep 29 in Tokyo
    expect(new Date(dayStart(t, 'Asia/Tokyo')).toISOString()).toBe('2026-09-28T15:00:00.000Z');
    expect(isoInTz(t, 'Asia/Tokyo')).toBe('2026-09-29T05:30:00+09:00');
    expect(isoInTz(null, 'Asia/Tokyo')).toBeNull();
  });
});

describe('environment config', () => {
  it('defaults to the safe settings: DRY_RUN on, public replies off, v26.0', () => {
    const env = loadEnv({});
    expect(env).toMatchObject({ DRY_RUN: true, mode: 'dry_run', PUBLIC_REPLIES_ENABLED: false, GRAPH_VERSION: 'v26.0', DM_HOURLY_CAP: 190, POLL_PROFILE: 'primary' });
    expect(env.dbFile.replace(/\\/g, '/')).toBe('data/dry_run.sqlite');
  });

  it('treats blank values from .env.example as unset and normalizes the allowlist', () => {
    const env = loadEnv({ IG_APP_ID: '', DRY_RUN: 'false', ALLOWLIST: ' @Tester_One , second.acct ' });
    expect(env.IG_APP_ID).toBeUndefined();
    expect(env.mode).toBe('live');
    expect([...env.allowlist]).toEqual(['tester_one', 'second.acct']);
  });

  it('rejects dangerous values with a readable message', () => {
    expect(() => loadEnv({ ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN must be at least 24/);
    expect(() => loadEnv({ DM_HOURLY_CAP: '5000' })).toThrow(/DM_HOURLY_CAP/);
    expect(() => loadEnv({ PUBLIC_BASE_URL: 'https://x.up.railway.app/' })).toThrow(/PUBLIC_BASE_URL/);
  });
});
