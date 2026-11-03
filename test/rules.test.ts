import { describe, expect, it, vi } from 'vitest';
import {
  DAY,
  HOUR,
  MINUTE,
  decideComment,
  isOwn,
  linkDeadline,
  privateReplyDeadline,
  toMs,
  type DecideInput,
} from '../src/core/rules.ts';
import type { Trigger } from '../src/config/triggers.ts';
import { ME, T0 } from './helpers/fixtures.ts';
import { makeTriggers } from './helpers/triggers.ts';

const set = makeTriggers([
  { keyword: 'SKILL' },
  { keyword: 'LOOP', media: ['DAbCdEfGh12'] },
  { keyword: 'OLD', enabled: false },
]);

function input(over: Partial<DecideInput<Trigger>> = {}): DecideInput<Trigger> {
  return {
    text: 'SKILL please',
    from: { id: '2031528510825908', username: 'jess.builds' },
    me: ME,
    triggers: set.triggers,
    mediaShortcode: 'DAbCdEfGh12',
    commentedAt: T0,
    now: T0 + MINUTE,
    cutoff: T0 - DAY,
    maxAgeH: 166,
    allowlist: new Set(),
    isSuppressed: () => false,
    hasActiveLead: () => false,
    ...over,
  };
}

describe('the 7-day private-reply rule', () => {
  it('uses a 166 h deadline by default (7 days minus a safety margin)', () => {
    expect(privateReplyDeadline(T0, 166)).toBe(T0 + 166 * HOUR);
  });

  it.each([
    ['1 minute old', MINUTE, 'lead'],
    ['6 days old', 6 * DAY, 'lead'],
    ['165h59m old', 165 * HOUR + 59 * MINUTE, 'lead'],
    ['exactly 166 h old', 166 * HOUR, 'too_old'],
    ['7 days old', 7 * DAY, 'too_old'],
    ['8 days old', 8 * DAY, 'too_old'],
  ])('a comment %s → %s', (_label, age, expected) => {
    expect(decideComment(input({ now: T0 + age })).decision).toBe(expected);
  });

  it('clamps future comment timestamps to now', () => {
    expect(decideComment(input({ commentedAt: T0 + HOUR, now: T0 })).decision).toBe('lead');
  });

  it('normalizes webhook seconds vs milliseconds', () => {
    expect(toMs(1790596800)).toBe(1790596800_000);
    expect(toMs(1790596800_000)).toBe(1790596800_000);
  });
});

describe('the 24 h follow-up window', () => {
  it('ends 24 h after the person’s message minus the margin', () => {
    expect(linkDeadline(T0, 30)).toBe(T0 + DAY - 30 * MINUTE);
    expect(linkDeadline(T0, 0)).toBe(T0 + DAY);
  });
});

describe('isOwn', () => {
  it('detects our account by user_id, app-scoped id or username', () => {
    expect(isOwn({ id: ME.userId }, ME)).toBe(true);
    expect(isOwn({ id: ME.appScopedId }, ME)).toBe(true);
    expect(isOwn({ username: '@Your.Account' }, ME)).toBe(true);
    expect(isOwn({ id: '2031528510825908', username: 'jess.builds' }, ME)).toBe(false);
  });
});

describe('decideComment', () => {
  it('ignores our own comments before anything else', () => {
    expect(decideComment(input({ from: { id: ME.userId, username: 'your.account' } })).decision).toBe('own');
  });

  it('does not look anything up for comments without a keyword', () => {
    const isSuppressed = vi.fn(() => false);
    const hasActiveLead = vi.fn(() => false);
    const d = decideComment(input({ text: 'nice video', isSuppressed, hasActiveLead }));
    expect(d.decision).toBe('no_match');
    expect(isSuppressed).not.toHaveBeenCalled();
    expect(hasActiveLead).not.toHaveBeenCalled();
  });

  it('reports disabled triggers and media scope', () => {
    expect(decideComment(input({ text: 'OLD' })).decision).toBe('disabled');
    expect(decideComment(input({ text: 'LOOP', mediaShortcode: 'OTHERCODE1' })).decision).toBe('out_of_scope');
    expect(decideComment(input({ text: 'LOOP', mediaShortcode: null })).decision).toBe('media_unresolved');
    expect(decideComment(input({ text: 'LOOP' })).decision).toBe('lead');
  });

  it('never triggers on comments from before the go-live cutoff', () => {
    expect(decideComment(input({ cutoff: T0 + 1 })).decision).toBe('before_cutoff');
  });

  it('respects opt-outs, the allowlist and per-user-per-post dedupe', () => {
    expect(decideComment(input({ isSuppressed: () => true })).decision).toBe('opted_out');
    expect(decideComment(input({ allowlist: new Set(['tester_one']) })).decision).toBe('not_allowlisted');
    expect(decideComment(input({ allowlist: new Set(['jess.builds']) })).decision).toBe('lead');
    expect(decideComment(input({ hasActiveLead: () => true })).decision).toBe('duplicate');
  });

  it('picks the first matching trigger in config order and records every match', () => {
    const d = decideComment(input({ text: 'LOOP SKILL' }));
    expect(d.trigger?.keyword).toBe('SKILL');
    expect(d.matched).toEqual(['SKILL', 'LOOP']);
  });
});
