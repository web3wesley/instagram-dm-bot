import { describe, expect, it } from 'vitest';
import { ingestComment, ingestInbound, inboundCommand, NoAccountError } from '../src/core/ingest.ts';
import { DAY, HOUR, MINUTE } from '../src/core/rules.ts';
import type { CommentEvent, InboundEvent } from '../src/webhook/parse.ts';
import { makeCtx } from './helpers/ctx.ts';
import { JESS, ME, REEL, T0 } from './helpers/fixtures.ts';
import { makeTriggers } from './helpers/triggers.ts';

const comment = (over: Partial<CommentEvent> = {}): CommentEvent => ({
  t: 'comment',
  accountId: ME.userId,
  commentId: 'c1',
  mediaId: REEL.id,
  fromId: JESS.id,
  username: JESS.username,
  text: 'SKILL please',
  at: T0,
  atExact: false,
  ...over,
});

const inbound = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  t: 'inbound',
  accountId: ME.userId,
  senderId: JESS.id,
  recipientId: ME.userId,
  at: T0 + 5 * MINUTE,
  kind: 'text',
  text: 'yes please',
  ...over,
});

const count = (t: ReturnType<typeof makeCtx>, table: string) =>
  (t.repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Simulates a delivered intro so the lead is waiting for a reply. */
function markDelivered(t: ReturnType<typeof makeCtx>, leadId: number, igsid: string | null = JESS.id, at = T0 + MINUTE) {
  t.repo.casLeadState(leadId, ['queued'], 'dm_sent', { dm_sent_at: at, igsid }, at);
}

describe('dedupe', () => {
  it('webhook then poller for the same comment → one comment row, one lead, one intro job', () => {
    const t = makeCtx();
    const first = ingestComment(t.ctx, comment(), 'webhook');
    const second = ingestComment(t.ctx, comment({ at: T0 - 5000, atExact: true }), 'poller');
    expect(first).toMatchObject({ isNew: true, decision: 'lead' });
    expect(second).toEqual({ isNew: false, decision: 'lead' });
    const row = t.repo.getComment('c1')!;
    expect(row.webhook_at).not.toBeNull();
    expect(row.poller_at).not.toBeNull();
    expect(row.commented_at).toBe(T0 - 5000); // the poller's exact timestamp wins
    expect(count(t, 'leads')).toBe(1);
    expect(t.repo.jobFor(first.leadId!, 'private_reply')).toMatchObject({ state: 'queued', priority: 1, deadline: T0 + 166 * HOUR });
  });

  it('a redelivered webhook is a no-op', () => {
    const t = makeCtx();
    ingestComment(t.ctx, comment(), 'webhook');
    expect(ingestComment(t.ctx, comment(), 'webhook')).toEqual({ isNew: false, decision: 'lead' });
    expect(count(t, 'leads')).toBe(1);
    expect(count(t, 'jobs')).toBe(1);
  });

  it('one DM per user per post: a second keyword comment on the same post is a duplicate', () => {
    const t = makeCtx();
    ingestComment(t.ctx, comment(), 'webhook');
    expect(ingestComment(t.ctx, comment({ commentId: 'c2', text: 'LOOP too' }), 'webhook').decision).toBe('duplicate');
    expect(count(t, 'leads')).toBe(1);
  });

  it('the same user on a different post gets their own lead', () => {
    const t = makeCtx();
    ingestComment(t.ctx, comment(), 'webhook');
    expect(ingestComment(t.ctx, comment({ commentId: 'c2', mediaId: '17939513463099999' }), 'webhook').decision).toBe('lead');
    expect(count(t, 'leads')).toBe(2);
  });

  it('a failed lead does not block a later re-comment on the same post', () => {
    const t = makeCtx();
    const { leadId } = ingestComment(t.ctx, comment(), 'webhook');
    t.repo.casLeadState(leadId!, ['queued'], 'dm_failed', { reason: 'test' }, t.clock.now());
    expect(ingestComment(t.ctx, comment({ commentId: 'c2' }), 'webhook').decision).toBe('lead');
  });

  it('falls back to the username as identity when Meta omits from.id', () => {
    const t = makeCtx();
    ingestComment(t.ctx, comment({ fromId: undefined }), 'poller');
    expect(ingestComment(t.ctx, comment({ commentId: 'c2', fromId: undefined }), 'poller').decision).toBe('duplicate');
  });
});

describe('what gets recorded but never DMed', () => {
  it('records non-matching and own comments', () => {
    const t = makeCtx();
    expect(ingestComment(t.ctx, comment({ commentId: 'n1', text: 'unskilled lol' }), 'webhook').decision).toBe('no_match');
    expect(ingestComment(t.ctx, comment({ commentId: 'o1', fromId: ME.userId, username: ME.username }), 'webhook').decision).toBe('own');
    expect(count(t, 'comments')).toBe(2);
    expect(count(t, 'leads')).toBe(0);
  });

  it('drops events for another account without storing them', () => {
    const t = makeCtx();
    expect(ingestComment(t.ctx, comment({ accountId: '999' }), 'webhook').decision).toBe('wrong_account');
    expect(count(t, 'comments')).toBe(0);
  });

  it('never triggers on comments from before go-live', () => {
    const t = makeCtx({ cutoff: T0 + 1 });
    expect(ingestComment(t.ctx, comment(), 'poller').decision).toBe('before_cutoff');
  });

  it('refuses to decide before an account is connected', () => {
    const t = makeCtx({ me: null });
    expect(() => ingestComment(t.ctx, comment(), 'webhook')).toThrow(NoAccountError);
  });

  it('re-decides a comment whose media could not be resolved once the media is known', () => {
    const t = makeCtx({ triggers: makeTriggers([{ keyword: 'LOOP', media: [REEL.shortcode] }]) });
    expect(ingestComment(t.ctx, comment({ text: 'LOOP' }), 'webhook').decision).toBe('media_unresolved');
    t.repo.upsertMedia({ media_id: REEL.id, shortcode: REEL.shortcode }, t.clock.now());
    expect(ingestComment(t.ctx, comment({ text: 'LOOP', atExact: true }), 'poller')).toMatchObject({ decision: 'lead' });
  });
});

describe('inbound replies', () => {
  it('a reply to the intro moves the lead to replied and queues the link inside the 24 h window', () => {
    const t = makeCtx();
    const { leadId } = ingestComment(t.ctx, comment(), 'webhook');
    markDelivered(t, leadId!);
    t.clock.t = T0 + 6 * MINUTE;
    expect(ingestInbound(t.ctx, inbound())).toEqual({ action: 'replied', leadIds: [leadId] });
    expect(t.repo.getLead(leadId!)).toMatchObject({ state: 'replied', replied_at: T0 + 5 * MINUTE, reply_text: 'yes please' });
    expect(t.repo.jobFor(leadId!, 'link')).toMatchObject({ state: 'queued', priority: 0, deadline: T0 + 5 * MINUTE + DAY - 30 * MINUTE });
  });

  it('matches by commenter id when the intro response carried no recipient id', () => {
    const t = makeCtx();
    const { leadId } = ingestComment(t.ctx, comment(), 'webhook');
    markDelivered(t, leadId!, null);
    t.clock.t = T0 + 6 * MINUTE;
    expect(ingestInbound(t.ctx, inbound()).action).toBe('replied');
    expect(t.repo.getLead(leadId!)?.igsid).toBe(JESS.id);
  });

  it('a DM that arrives before the intro went out does not release the link', () => {
    const t = makeCtx();
    const { leadId } = ingestComment(t.ctx, comment(), 'webhook');
    expect(ingestInbound(t.ctx, inbound()).action).toBe('no_open_lead'); // still queued
    markDelivered(t, leadId!, JESS.id, T0 + 10 * MINUTE);
    t.clock.t = T0 + 11 * MINUTE;
    expect(ingestInbound(t.ctx, inbound({ at: T0 + 2 * MINUTE })).action).toBe('no_open_lead'); // older message
  });

  it('a second reply is a no-op', () => {
    const t = makeCtx();
    const { leadId } = ingestComment(t.ctx, comment(), 'webhook');
    markDelivered(t, leadId!);
    t.clock.t = T0 + 6 * MINUTE;
    ingestInbound(t.ctx, inbound());
    expect(ingestInbound(t.ctx, inbound({ text: 'hello?' })).action).toBe('no_open_lead');
    expect(count(t, 'jobs')).toBe(2); // intro + one link
  });

  it('ignores DMs from people with no open lead (nothing else ever fires a DM)', () => {
    const t = makeCtx();
    expect(ingestInbound(t.ctx, inbound({ senderId: 'stranger' }))).toEqual({ action: 'no_open_lead', leadIds: [] });
    expect(count(t, 'jobs')).toBe(0);
  });

  it('STOP opts out: no link, and future keyword comments are not DMed', () => {
    const t = makeCtx();
    const { leadId } = ingestComment(t.ctx, comment(), 'webhook');
    markDelivered(t, leadId!);
    t.clock.t = T0 + 6 * MINUTE;
    expect(ingestInbound(t.ctx, inbound({ text: 'STOP' })).action).toBe('opted_out');
    expect(t.repo.getLead(leadId!)?.state).toBe('opted_out');
    expect(t.repo.jobFor(leadId!, 'link')).toBeUndefined();
    const later = ingestComment(t.ctx, comment({ commentId: 'c9', mediaId: 'another-post' }), 'webhook');
    expect(later.decision).toBe('opted_out');

    expect(ingestInbound(t.ctx, inbound({ text: 'start' })).action).toBe('resumed');
    expect(ingestComment(t.ctx, comment({ commentId: 'c10', mediaId: 'third-post' }), 'webhook').decision).toBe('lead');
  });

  it('recognises whole-message commands only', () => {
    expect(inboundCommand('STOP')).toBe('stop');
    expect(inboundCommand('Stop!')).toBe('stop');
    expect(inboundCommand('please stop')).toBe('stop');
    expect(inboundCommand("don't stop")).toBeNull();
    expect(inboundCommand('Please delete my data, thanks')).toBe('delete');
    expect(inboundCommand('start')).toBe('start');
    expect(inboundCommand('')).toBeNull();
  });

  it('"delete my data" is handed to the deletion flow', () => {
    const t = makeCtx();
    expect(ingestInbound(t.ctx, inbound({ text: 'delete my data' })).action).toBe('delete');
  });
});
