import { describe, expect, it } from 'vitest';
import { createLimiter } from '../src/core/limiter.ts';
import { HOUR, MINUTE } from '../src/core/rules.ts';
import type { JobKind } from '../src/db/repo.ts';
import { makeCtx } from './helpers/ctx.ts';

function attempt(t: ReturnType<typeof makeCtx>, kind: JobKind, at: number) {
  t.repo.insertAttempt({ job_id: null, lead_id: null, kind, at, dry_run: false, request: {}, ok: true });
}

describe('hourly send caps', () => {
  it('counts intros + links together in the dm bucket over a sliding hour', () => {
    const t = makeCtx();
    const now = t.clock.now();
    attempt(t, 'private_reply', now - 2 * HOUR); // outside the window
    attempt(t, 'private_reply', now - 50 * MINUTE);
    attempt(t, 'link', now - 10 * MINUTE);
    attempt(t, 'public_reply', now - 5 * MINUTE);
    const limiter = createLimiter(t.repo, { dm: 3, public: 1 }, t.clock);
    expect(limiter.usage('dm')).toEqual({ used: 2, cap: 3, util: 0.667, nextSlotAt: null });
    expect(limiter.hasCapacity('dm')).toBe(true);
    expect(limiter.hasCapacity('public')).toBe(false);
    expect(limiter.usage('public').nextSlotAt).toBe(now - 5 * MINUTE + HOUR);
  });

  it('reports when the next slot opens once the cap is full', () => {
    const t = makeCtx();
    const now = t.clock.now();
    for (const ago of [40, 30, 20]) attempt(t, 'private_reply', now - ago * MINUTE);
    const limiter = createLimiter(t.repo, { dm: 2, public: 30 }, t.clock);
    // 3 used, cap 2 → the 2nd-oldest must age out: (now − 30 min) + 1 h.
    expect(limiter.usage('dm')).toMatchObject({ used: 3, nextSlotAt: now - 30 * MINUTE + HOUR });
    expect(limiter.hasCapacity('dm')).toBe(false);
  });

  it('survives a restart (the window lives in the send log, not memory)', () => {
    const t = makeCtx();
    for (let i = 0; i < 5; i++) attempt(t, 'private_reply', t.clock.now() - i * MINUTE);
    const before = createLimiter(t.repo, { dm: 5, public: 30 }, t.clock).usage('dm');
    const after = createLimiter(t.repo, { dm: 5, public: 30 }, t.clock).usage('dm');
    expect(after).toEqual(before);
    expect(after.used).toBe(5);
    t.clock.advance(HOUR);
    expect(createLimiter(t.repo, { dm: 5, public: 30 }, t.clock).usage('dm').used).toBe(0);
  });

  it('tracks private replies against Meta’s published 750/hour', () => {
    const t = makeCtx();
    attempt(t, 'private_reply', t.clock.now() - MINUTE);
    expect(createLimiter(t.repo, { dm: 190, public: 30 }, t.clock).metaPrivateReplies()).toEqual({ used: 1, limit: 750, util: 0.001 });
  });
});
