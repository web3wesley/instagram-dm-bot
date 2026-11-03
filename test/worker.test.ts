import { describe, expect, it, vi } from 'vitest';
import { ingestComment, ingestInbound } from '../src/core/ingest.ts';
import { createLimiter } from '../src/core/limiter.ts';
import { DAY, HOUR, MINUTE, SECOND } from '../src/core/rules.ts';
import { createWorker } from '../src/core/worker.ts';
import { withDryRun } from '../src/meta/dryRun.ts';
import { MetaApiError } from '../src/meta/errors.ts';
import type { MetaClient } from '../src/meta/types.ts';
import type { CommentEvent } from '../src/webhook/parse.ts';
import { makeCtx, silentLogger } from './helpers/ctx.ts';
import { createFakeMeta } from './helpers/fakeMeta.ts';
import { JESS, ME, REEL, T0 } from './helpers/fixtures.ts';
import { TEST_LINK, makeTriggers } from './helpers/triggers.ts';

const metaError = (code: number, subcode?: number) =>
  MetaApiError.fromResponse(400, { error: { message: `err ${code}`, code, error_subcode: subcode, fbtrace_id: 'T' } });

function setup(opts: { env?: Record<string, string>; dryRun?: boolean } = {}) {
  const t = makeCtx({ env: { PUBLIC_REPLIES_ENABLED: 'true', ...(opts.dryRun ? { DRY_RUN: 'true' } : {}), ...opts.env } });
  const fake = createFakeMeta();
  const meta: MetaClient = opts.dryRun ? withDryRun(fake.client, silentLogger) : fake.client;
  const limiter = createLimiter(t.repo, { dm: t.env.DM_HOURLY_CAP, public: t.env.PUBLIC_REPLY_HOURLY_CAP }, t.clock);
  let usable = true;
  const tokens = { isUsable: () => usable, markInvalid: vi.fn(() => void (usable = false)) };
  const alerts: string[] = [];
  const worker = createWorker({ ctx: t.ctx, meta, limiter, tokens, alert: (k) => alerts.push(k), sendGapMs: [0, 0] });
  let n = 0;
  const lead = (over: Partial<CommentEvent> = {}) => {
    const r = ingestComment(
      t.ctx,
      {
        t: 'comment',
        accountId: ME.userId,
        commentId: `c${++n}`,
        mediaId: `${REEL.id}${n}`,
        fromId: JESS.id,
        username: JESS.username,
        text: 'SKILL please',
        at: t.clock.now(),
        atExact: true,
        ...over,
      },
      'webhook',
    );
    return r.leadId!;
  };
  /** Moves past the intro's 3–12 s jitter. */
  const due = () => t.clock.advance(13 * SECOND);
  const reply = (at = t.clock.now()) =>
    ingestInbound(t.ctx, { t: 'inbound', accountId: ME.userId, senderId: JESS.id, recipientId: ME.userId, at, kind: 'text', text: 'yes' });
  return { ...t, fake, worker, tokens, alerts, lead, due, reply };
}

describe('intro (private reply)', () => {
  it('sends the intro to the comment, stores the recipient IGSID and queues a public reply', async () => {
    const s = setup();
    const id = s.lead();
    s.fake.setRecipient('c1', 'igsid-from-meta');
    s.due();
    expect(await s.worker.runOnce()).toBe('sent');
    const [call] = s.fake.callsTo('sendPrivateReply');
    expect(call?.args[0]).toBe('c1');
    expect(call?.args[1]).toContain('jess.builds');
    expect(call?.args[1]).not.toContain('http'); // the link waits for their reply
    expect(s.repo.getLead(id)).toMatchObject({ state: 'dm_sent', igsid: 'igsid-from-meta', public_state: 'queued' });
    const pub = s.repo.jobFor(id, 'public_reply')!;
    expect(pub.run_after - s.clock.now()).toBeGreaterThanOrEqual(30 * SECOND);
    expect(pub.run_after - s.clock.now()).toBeLessThanOrEqual(180 * SECOND);
  });

  it('does not reply publicly when the DM failed', async () => {
    const s = setup();
    const id = s.lead();
    s.fake.queue('sendPrivateReply', metaError(551));
    s.due();
    await s.worker.runOnce();
    expect(s.repo.getLead(id)).toMatchObject({ state: 'dm_failed', reason: 'user_unavailable:551' });
    expect(s.repo.jobFor(id, 'public_reply')).toBeUndefined();
  });

  it('an expired intro (past the 7-day window) makes zero API calls', async () => {
    const s = setup();
    const id = s.lead();
    s.clock.advance(7 * DAY);
    expect(await s.worker.runOnce()).toBe('progress');
    expect(s.repo.getLead(id)?.state).toBe('expired');
    expect(s.fake.calls).toHaveLength(0);
  });

  it('skips the intro when the trigger was removed from triggers.json', async () => {
    const s = setup();
    const id = s.lead();
    s.setTriggers(makeTriggers([{ keyword: 'LOOP' }]));
    s.due();
    await s.worker.runOnce();
    expect(s.repo.getLead(id)).toMatchObject({ state: 'skipped', reason: 'trigger_removed' });
    expect(s.fake.calls).toHaveLength(0);
  });

  it('re-checks the allowlist at send time', async () => {
    const s = setup({ env: { ALLOWLIST: 'tester_one' } });
    // Insert a lead directly (as if created before the allowlist changed).
    const now = s.clock.now();
    const id = s.repo.insertLead(
      { comment_id: 'cx', media_id: 'm', commenter_id: JESS.id, username: JESS.username, keyword: 'SKILL', link_snapshot: TEST_LINK, comment_text: 'SKILL', commented_at: now },
      now,
    );
    s.repo.insertJob({ lead_id: id, kind: 'private_reply', priority: 1, run_after: now, deadline: now + DAY }, now);
    await s.worker.runOnce();
    expect(s.repo.getLead(id)).toMatchObject({ state: 'skipped', reason: 'not_allowlisted' });
    expect(s.fake.calls).toHaveLength(0);
  });

  it('retries an intro after a timeout; a retry that hits "already replied" ends as dm_unknown', async () => {
    const s = setup();
    const id = s.lead();
    s.fake.queue('sendPrivateReply', new MetaApiError({ message: 'timeout', phase: 'timeout' }), metaError(10900));
    s.due();
    await s.worker.runOnce();
    const job = s.repo.jobFor(id, 'private_reply')!;
    expect(job).toMatchObject({ state: 'queued', attempts: 1 });
    expect(job.run_after).toBe(s.clock.now() + 30 * SECOND);
    s.clock.advance(31 * SECOND);
    await s.worker.runOnce();
    expect(s.repo.getLead(id)?.state).toBe('dm_unknown');
    expect(s.repo.jobFor(id, 'private_reply')?.state).toBe('unknown');
  });

  it('gives up after repeated transient errors', async () => {
    const s = setup();
    const id = s.lead();
    s.due();
    for (let i = 0; i < 8; i++) {
      s.fake.queue('sendPrivateReply', metaError(2));
      await s.worker.runOnce();
      s.clock.advance(31 * MINUTE);
    }
    expect(s.repo.getLead(id)).toMatchObject({ state: 'dm_failed', reason: 'retryable:2' });
    expect(s.fake.callsTo('sendPrivateReply')).toHaveLength(8);
  });

  it('flags "needs App Review" when Meta refuses a non-tester (100/2534001)', async () => {
    const s = setup();
    const id = s.lead();
    s.fake.queue('sendPrivateReply', metaError(100, 2534001));
    s.due();
    await s.worker.runOnce();
    expect(s.repo.getLead(id)).toMatchObject({ state: 'dm_failed', reason: 'not_approved:100/2534001' });
    expect(s.alerts).toContain('not_approved');
  });
});

describe('link (after they reply)', () => {
  async function toReplied(s: ReturnType<typeof setup>) {
    const id = s.lead();
    s.due();
    await s.worker.runOnce(); // intro
    s.clock.advance(MINUTE);
    s.reply();
    s.clock.advance(4 * SECOND);
    return id;
  }

  it('sends the keyword’s link to the person who replied', async () => {
    const s = setup({ env: { PUBLIC_REPLIES_ENABLED: 'false' } });
    const id = await toReplied(s);
    expect(await s.worker.runOnce()).toBe('sent');
    const [call] = s.fake.callsTo('sendText');
    expect(call?.args).toEqual([`igsid_c1`, `Here you go jess.builds: ${TEST_LINK}`]);
    expect(s.repo.getLead(id)).toMatchObject({ state: 'link_sent', link_snapshot: TEST_LINK });
  });

  it('uses the link snapshot when the trigger was removed meanwhile', async () => {
    const s = setup({ env: { PUBLIC_REPLIES_ENABLED: 'false' } });
    const id = await toReplied(s);
    s.setTriggers(makeTriggers([{ keyword: 'LOOP', link: 'https://example.com/other' }]));
    await s.worker.runOnce();
    expect(s.fake.callsTo('sendText')[0]?.args[1]).toContain(TEST_LINK);
    expect(s.repo.getLead(id)?.state).toBe('link_sent');
  });

  it('never sends the same link to the same person twice within 24 h', async () => {
    const s = setup({ env: { PUBLIC_REPLIES_ENABLED: 'false' } });
    s.fake.setRecipient('c1', JESS.id);
    s.fake.setRecipient('c2', JESS.id);
    const a = s.lead();
    const b = s.lead();
    s.due();
    await s.worker.runOnce();
    await s.worker.runOnce(); // both intros
    s.clock.advance(MINUTE);
    s.reply();
    s.clock.advance(4 * SECOND);
    await s.worker.runOnce();
    await s.worker.runOnce();
    expect(s.fake.callsTo('sendText')).toHaveLength(1);
    expect(s.repo.getLead(a)?.state).toBe('link_sent');
    expect(s.repo.getLead(b)).toMatchObject({ state: 'link_sent', reason: 'deduped' });
  });

  it('a link timeout is marked unknown and never retried (at-most-once)', async () => {
    const s = setup({ env: { PUBLIC_REPLIES_ENABLED: 'false' } });
    const id = await toReplied(s);
    s.fake.queue('sendText', new MetaApiError({ message: 'timeout', phase: 'timeout' }));
    await s.worker.runOnce();
    expect(s.repo.getLead(id)?.state).toBe('link_unknown');
    s.clock.advance(HOUR);
    expect(await s.worker.runOnce()).toBe('idle');
    expect(s.fake.callsTo('sendText')).toHaveLength(1);
  });

  it('a closed 24 h window ends as window_expired', async () => {
    const s = setup({ env: { PUBLIC_REPLIES_ENABLED: 'false' } });
    const id = await toReplied(s);
    s.fake.queue('sendText', metaError(10, 2534022));
    await s.worker.runOnce();
    expect(s.repo.getLead(id)?.state).toBe('window_expired');
  });

  it('links go out before queued intros', async () => {
    const s = setup({ env: { PUBLIC_REPLIES_ENABLED: 'false' } });
    await toReplied(s);
    s.lead(); // a fresh intro, also due
    s.clock.advance(13 * SECOND);
    await s.worker.runOnce();
    expect(s.fake.calls.at(-1)?.method).toBe('sendText');
  });
});

describe('public replies', () => {
  it('rotates variants without an immediate repeat and never includes a link', async () => {
    const s = setup();
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) {
      s.lead();
      s.due();
      await s.worker.runOnce(); // intro
      s.clock.advance(181 * SECOND);
      await s.worker.runOnce(); // public reply
      texts.push(String(s.fake.callsTo('replyToComment').at(-1)?.args[1]));
    }
    expect(texts).toHaveLength(6);
    for (const text of texts) expect(text).not.toMatch(/https?:|www\./);
    const recent = s.repo.kvGetJson<string[]>('public_recent')!;
    for (let i = 1; i < recent.length; i++) expect(recent[i]).not.toBe(recent[i - 1]);
  });

  it('a 368 block pauses public replies for 24 h', async () => {
    const s = setup();
    const id = s.lead();
    s.due();
    await s.worker.runOnce();
    s.clock.advance(181 * SECOND);
    s.fake.queue('replyToComment', metaError(368));
    await s.worker.runOnce();
    expect(s.repo.getLead(id)?.public_state).toBe('failed');
    expect(s.repo.kvNum('public_blocked_until')).toBe(s.clock.now() + DAY);
    expect(s.alerts).toContain('blocked_public');
  });

  it('a comment deleted after the DM (100/33) skips the public reply without counting as a failure', async () => {
    const s = setup();
    const id = s.lead();
    s.due();
    await s.worker.runOnce(); // intro
    s.clock.advance(181 * SECOND);
    s.fake.queue('replyToComment', metaError(100, 33));
    expect(await s.worker.runOnce()).toBe('progress');
    expect(s.repo.getLead(id)).toMatchObject({ state: 'dm_sent', public_state: 'comment_gone' });
    expect(s.repo.jobFor(id, 'public_reply')).toMatchObject({ state: 'cancelled', last_error: 'comment_gone:100/33' });
    expect(s.alerts).toHaveLength(0);
    expect(s.repo.failureRateSince(0)).toEqual({ total: 2, failed: 0 });
    expect(s.repo.attemptStatsSince(0)).toContainEqual({ kind: 'public_reply', ok: 0, n: 1, gone: 1 });
    // Their reply still gets the link.
    s.reply();
    s.clock.advance(4 * SECOND);
    expect(await s.worker.runOnce()).toBe('sent');
    expect(s.repo.getLead(id)?.state).toBe('link_sent');
  });

  it('a comment deleted before the intro went out is still a failed DM', async () => {
    const s = setup();
    const id = s.lead();
    s.fake.queue('sendPrivateReply', metaError(100, 33));
    s.due();
    await s.worker.runOnce();
    expect(s.repo.getLead(id)).toMatchObject({ state: 'dm_failed', reason: 'comment_gone:100/33' });
    expect(s.repo.jobFor(id, 'public_reply')).toBeUndefined();
    expect(s.repo.failureRateSince(0)).toEqual({ total: 1, failed: 1 });
    expect(s.repo.attemptStatsSince(0)).toContainEqual({ kind: 'private_reply', ok: 0, n: 1, gone: 0 });
  });
});

describe('throttling, auth and caps', () => {
  it('80002 with an ETA pauses sending until access is regained, without burning an attempt', async () => {
    const s = setup();
    const id = s.lead();
    const err = metaError(80002);
    err.usage = { maxPct: 100, callCount: 100, totalCputime: 0, totalTime: 0, etaMin: 7, source: 'buc' };
    s.fake.queue('sendPrivateReply', err);
    s.due();
    expect(await s.worker.runOnce()).toBe('blocked');
    expect(s.repo.kvNum('throttle_until')).toBe(s.clock.now() + 7 * MINUTE);
    expect(s.repo.jobFor(id, 'private_reply')).toMatchObject({ state: 'queued', attempts: 0 });
    expect(await s.worker.runOnce()).toBe('blocked');
    s.clock.advance(7 * MINUTE + 1);
    expect(await s.worker.runOnce()).toBe('sent');
  });

  it('190 marks the token invalid and pauses; the job waits', async () => {
    const s = setup();
    const id = s.lead();
    s.fake.queue('sendPrivateReply', metaError(190));
    s.due();
    expect(await s.worker.runOnce()).toBe('paused');
    expect(s.tokens.markInvalid).toHaveBeenCalledOnce();
    expect(s.repo.jobFor(id, 'private_reply')).toMatchObject({ state: 'queued', attempts: 0 });
    expect(await s.worker.runOnce()).toBe('paused');
  });

  it('the hourly DM cap blocks further sends', async () => {
    const s = setup({ env: { DM_HOURLY_CAP: '2', PUBLIC_REPLIES_ENABLED: 'false' } });
    s.lead();
    s.lead();
    s.lead();
    s.due();
    expect(await s.worker.runOnce()).toBe('sent');
    expect(await s.worker.runOnce()).toBe('sent');
    expect(await s.worker.runOnce()).toBe('blocked');
    expect(s.fake.callsTo('sendPrivateReply')).toHaveLength(2);
  });

  it('respects the kill switch', async () => {
    const s = setup();
    s.lead();
    s.due();
    s.repo.kvSet('paused', '1');
    expect(await s.worker.runOnce()).toBe('paused');
    expect(s.fake.calls).toHaveLength(0);
  });
});

describe('restart recovery', () => {
  it('requeues an interrupted intro but marks an interrupted link unknown', () => {
    const s = setup();
    const a = s.lead();
    const b = s.lead();
    const now = s.clock.now();
    s.repo.insertJob({ lead_id: b, kind: 'link', priority: 0, run_after: now, deadline: now + DAY }, now);
    s.repo.casLeadState(b, ['queued'], 'replied', {}, now);
    s.repo.patchJob(s.repo.jobFor(a, 'private_reply')!.id, { state: 'running' }, now);
    s.repo.patchJob(s.repo.jobFor(b, 'link')!.id, { state: 'running' }, now);
    expect(s.worker.recoverOnBoot()).toBe(2);
    expect(s.repo.jobFor(a, 'private_reply')?.state).toBe('queued');
    expect(s.repo.jobFor(b, 'link')?.state).toBe('unknown');
    expect(s.repo.getLead(b)?.state).toBe('link_unknown');
  });
});

describe('DRY_RUN', () => {
  it('runs the whole flow without calling any send method', async () => {
    const s = setup({ dryRun: true });
    const id = s.lead();
    s.due();
    expect(await s.worker.runOnce()).toBe('sent');
    expect(s.fake.callsTo('sendPrivateReply')).toHaveLength(0);
    // Without a real recipient id, reply matching falls back to the commenter id.
    expect(s.repo.getLead(id)).toMatchObject({ state: 'dm_sent', igsid: JESS.id });
    const attempt = s.repo.db.prepare('SELECT dry_run, ok FROM send_attempts').get();
    expect(attempt).toEqual({ dry_run: 1, ok: 1 });
    s.clock.advance(MINUTE);
    s.reply();
    s.clock.advance(4 * SECOND);
    expect(await s.worker.runOnce()).toBe('sent');
    expect(s.repo.getLead(id)?.state).toBe('link_sent');
    expect(s.fake.callsTo('sendText')).toHaveLength(0);
  });
});

it('sanity: fixture time is the comment time', () => {
  expect(T0).toBe(Date.parse('2026-09-28T12:00:00Z'));
});
