import { describe, expect, it } from 'vitest';
import { MetaApiError, classify, parseUsageHeaders, type ErrorClass } from '../src/meta/errors.ts';

const resp = (code: number, subcode?: number, status = 400) =>
  MetaApiError.fromResponse(status, {
    error: { message: 'x', type: 'OAuthException', code, error_subcode: subcode, fbtrace_id: 'AbC123' },
  });

describe('classify()', () => {
  it.each<[string, MetaApiError, ErrorClass]>([
    ['190 invalid token', resp(190), 'auth'],
    ['190/463 expired token', resp(190, 463), 'auth'],
    ['102 session', resp(102), 'auth'],
    ['4 app throttled', resp(4), 'throttled'],
    ['17 user throttled', resp(17), 'throttled'],
    ['32 page throttled', resp(32), 'throttled'],
    ['613 calls exceeded', resp(613), 'throttled'],
    ['80002 Instagram BUC', resp(80002), 'throttled'],
    ['368 temporarily blocked', resp(368), 'blocked'],
    ['10/2534022 outside window', resp(10, 2534022), 'window_closed'],
    ['10/2018278 outside window', resp(10, 2018278), 'window_closed'],
    ['10/2018108 cannot receive', resp(10, 2018108), 'user_unavailable'],
    ['10 permission', resp(10), 'not_approved'],
    ['200 permission', resp(200), 'not_approved'],
    ['100/2534001 thread does not exist (Standard Access)', resp(100, 2534001), 'not_approved'],
    ['10900 already replied', resp(10900), 'already_replied'],
    ['100/2534025 cannot private-reply', resp(100, 2534025), 'already_replied'],
    ['100/33 object gone', resp(100, 33), 'comment_gone'],
    ['551 unavailable', resp(551), 'user_unavailable'],
    ['100/2534014 no matching user', resp(100, 2534014), 'user_unavailable'],
    ['1 unknown', resp(1, undefined, 500), 'retryable'],
    ['2 service', resp(2, undefined, 503), 'retryable'],
    ['100 bad param', resp(100), 'permanent'],
  ])('%s → %s', (_label, err, expected) => {
    expect(classify(err)).toBe(expected);
  });

  it('separates connection failures (safe to retry) from timeouts (outcome unknown)', () => {
    expect(classify(new MetaApiError({ message: 'ECONNREFUSED', phase: 'connect' }))).toBe('retryable');
    expect(classify(new MetaApiError({ message: 'timeout', phase: 'timeout' }))).toBe('unknown_outcome');
    expect(classify(new MetaApiError({ message: 'reset', phase: 'reset' }))).toBe('unknown_outcome');
    expect(classify(MetaApiError.fromResponse(502, '<html>bad gateway</html>'))).toBe('unknown_outcome');
    expect(classify(new Error('random'))).toBe('unknown_outcome');
  });

  it('keeps the exact Meta error payload for logging', () => {
    const e = resp(10, 2534022);
    expect(e.toJSON()).toMatchObject({ code: 10, subcode: 2534022, fbtrace_id: 'AbC123', status: 400 });
    expect(e.body).toEqual({
      error: { message: 'x', type: 'OAuthException', code: 10, error_subcode: 2534022, fbtrace_id: 'AbC123' },
    });
  });
});

describe('parseUsageHeaders', () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

  it('reads the Business Use Case header and keeps the worst entry', () => {
    const u = parseUsageHeaders(
      headers({
        'x-business-use-case-usage': JSON.stringify({
          '17841400000000001': [
            { type: 'instagram', call_count: 12, total_cputime: 3, total_time: 5, estimated_time_to_regain_access: 0 },
            { type: 'instagram', call_count: 100, total_cputime: 40, total_time: 20, estimated_time_to_regain_access: 7 },
          ],
        }),
      }),
    );
    expect(u).toEqual({ maxPct: 100, callCount: 100, totalCputime: 40, totalTime: 20, etaMin: 7, source: 'buc' });
  });

  it('falls back to X-App-Usage and tolerates junk', () => {
    expect(parseUsageHeaders(headers({ 'x-app-usage': '{"call_count":5,"total_cputime":1,"total_time":2}' }))).toMatchObject({
      maxPct: 5,
      source: 'app',
    });
    expect(parseUsageHeaders(headers({ 'x-business-use-case-usage': 'not json' }))).toBeNull();
    expect(parseUsageHeaders(headers({}))).toBeNull();
  });
});
