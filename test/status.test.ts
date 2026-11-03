import { describe, expect, it } from 'vitest';
import { createLimiter } from '../src/core/limiter.ts';
import { buildHealth } from '../src/core/status.ts';
import { createTokens } from '../src/core/token.ts';
import type { JobKind } from '../src/db/repo.ts';
import { makeCtx, silentLogger } from './helpers/ctx.ts';
import { createFakeMeta } from './helpers/fakeMeta.ts';

function setup() {
  const t = makeCtx();
  const tokens = createTokens({ repo: t.repo, meta: createFakeMeta().client, env: t.env, clock: t.clock, log: silentLogger, alert: () => {} });
  const limiter = createLimiter(t.repo, { dm: 190, public: 30 }, t.clock);
  const health = () =>
    buildHealth({ ctx: t.ctx, tokens, limiter, worker: { lastTickAt: () => t.clock.now() }, startedAt: t.clock.now(), version: 'test' });
  let n = 0;
  /** Records one send attempt: a success, or a failure of the given error class. */
  const attempt = (kind: JobKind, errorClass?: string) =>
    t.repo.insertAttempt({ job_id: ++n, lead_id: n, kind, at: t.clock.now(), dry_run: false, request: {}, ok: !errorClass, error_class: errorClass });
  return { ...t, health, attempt };
}

describe('/health and deleted comments', () => {
  it('a public reply skipped because the comment was deleted is not a failed send', () => {
    const s = setup();
    s.attempt('private_reply');
    s.attempt('link');
    s.attempt('public_reply', 'comment_gone');
    const h = s.health();
    expect(h.status).toBe('ok');
    expect(h.today).toMatchObject({ intros: 1, links: 1, public_replies: 0, failed: 0, comment_deleted: 1 });
  });

  it('other failed sends still count, and enough of them degrade the status', () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.attempt('private_reply');
    s.attempt('public_reply', 'comment_gone');
    s.attempt('public_reply', 'permanent');
    s.attempt('private_reply', 'comment_gone'); // no DM was delivered, so this one is a real failure
    const h = s.health();
    expect(h.today).toMatchObject({ failed: 2, comment_deleted: 1 });
    expect(h.reasons).toContain('high_failure_rate'); // 2 of 6
  });

  it('flags it when most public replies hit a missing comment (that is not people deleting)', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.attempt('private_reply');
    for (let i = 0; i < 2; i++) s.attempt('public_reply');
    for (let i = 0; i < 2; i++) s.attempt('public_reply', 'comment_gone');
    expect(s.health().reasons).not.toContain('public_replies_comment_gone'); // 2 of 4: too few to tell
    s.attempt('public_reply', 'comment_gone');
    expect(s.health().reasons).toEqual(['public_replies_comment_gone']); // 3 of 5
  });
});
