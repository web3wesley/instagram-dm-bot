import { describe, expect, it, vi } from 'vitest';
import { createEventHandler } from '../src/core/events.ts';
import { createPoller } from '../src/core/poller.ts';
import { DAY, HOUR, MINUTE } from '../src/core/rules.ts';
import { MetaApiError } from '../src/meta/errors.ts';
import type { ApiComment } from '../src/meta/types.ts';
import { makeCtx } from './helpers/ctx.ts';
import { createFakeMeta } from './helpers/fakeMeta.ts';
import { REEL, T0 } from './helpers/fixtures.ts';
import { makeTriggers } from './helpers/triggers.ts';

const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '+0000');
const c = (id: string, at: number, text: string, user = `user_${id}`, replies?: ApiComment[]): ApiComment => ({
  id,
  text,
  timestamp: iso(at),
  from: { id: `igsid_${user}`, username: user },
  ...(replies ? { replies: { data: replies } } : {}),
});

function setup(opts: { cutoff?: number; env?: Record<string, string> } = {}) {
  const t = makeCtx({ now: T0 + HOUR, cutoff: opts.cutoff ?? T0 - DAY, env: opts.env });
  const fake = createFakeMeta();
  fake.setMedia([{ id: REEL.id, shortcode: REEL.shortcode, permalink: `https://www.instagram.com/reel/${REEL.shortcode}/`, timestamp: iso(T0 - HOUR), comments_count: 3 }]);
  const events = createEventHandler({ ctx: t.ctx, meta: fake.client });
  let usable = true;
  const tokens = { isUsable: () => usable, markInvalid: vi.fn() };
  const poller = createPoller({ ctx: t.ctx, meta: fake.client, events, tokens, spacingMs: 0 });
  const leads = () => t.repo.db.prepare('SELECT comment_id FROM leads ORDER BY id').all().map((r) => (r as { comment_id: string }).comment_id);
  return { ...t, fake, poller, tokens, leads, setUsable: (u: boolean) => (usable = u) };
}

describe('comment poller', () => {
  it('finds keyword comments on a new reel and ingests them oldest-first', async () => {
    const s = setup();
    s.fake.setComments(REEL.id, [{ data: [c('3', T0 + 30 * MINUTE, 'SKILL!!'), c('2', T0 + 20 * MINUTE, 'nice'), c('1', T0 + 10 * MINUTE, 'skill please')] }]);
    await s.poller.tick();
    expect(s.leads()).toEqual(['1', '3']);
    expect(s.repo.getComment('2')?.decision).toBe('no_match');
    expect(s.repo.getMedia(REEL.id)?.poll_hwm).toBe(T0 + 30 * MINUTE);
  });

  it('stops paging at the high-water mark on later polls', async () => {
    const s = setup();
    s.fake.setComments(REEL.id, [{ data: [c('1', T0 + 10 * MINUTE, 'SKILL')] }]);
    await s.poller.tick();
    s.clock.advance(2 * MINUTE);
    s.fake.setComments(REEL.id, [
      { data: [c('5', T0 + 70 * MINUTE, 'SKILL'), c('1', T0 + 10 * MINUTE, 'SKILL'), c('0', T0 + MINUTE, 'SKILL')], next: '1' },
      { data: [c('00', T0, 'SKILL')] },
    ]);
    await s.poller.tick();
    // Page 1 already reached comments older than the mark (minus 2 min overlap), so page 2 is never fetched.
    const second = s.fake.callsTo('listComments').slice(1).map((x) => (x.args[1] as { after?: string }).after);
    expect(second).toEqual([undefined]);
    expect(s.leads()).toEqual(['1', '5']);
  });

  it('expands threaded replies', async () => {
    const s = setup();
    s.fake.setComments(REEL.id, [{ data: [c('1', T0 + 10 * MINUTE, 'great', 'a', [c('1r', T0 + 12 * MINUTE, 'SKILL', 'b')])] }]);
    await s.poller.tick();
    expect(s.leads()).toEqual(['1r']);
    expect(s.repo.getComment('1r')?.parent_id).toBe('1');
  });

  it('ignores comments from before go-live', async () => {
    const s = setup({ cutoff: T0 + 15 * MINUTE });
    s.fake.setComments(REEL.id, [{ data: [c('2', T0 + 20 * MINUTE, 'SKILL'), c('1', T0 + 10 * MINUTE, 'SKILL')] }]);
    await s.poller.tick();
    expect(s.leads()).toEqual(['2']);
    expect(s.repo.getComment('1')).toBeUndefined(); // never even stored
  });

  it('stops at the page cap and records it', async () => {
    const s = setup();
    const pages = Array.from({ length: 12 }, (_, i) => ({
      data: [c(`p${i}`, T0 + (50 - i) * MINUTE, 'hello')],
      next: String(i + 1),
    }));
    s.fake.setComments(REEL.id, pages);
    await s.poller.tick(); // first poll of a reel is a sweep (10 pages)
    expect(s.fake.callsTo('listComments')).toHaveLength(10);
    expect(s.poller.status().capHits24h).toBe(1);
  });

  it('stops at an empty page (Standard Access hides non-tester comments behind empty pages)', async () => {
    const s = setup();
    s.fake.setComments(REEL.id, [
      { data: [], next: '1' },
      { data: [], next: '2' },
      { data: [c('1', T0 + 10 * MINUTE, 'SKILL')] },
    ]);
    await s.poller.tick();
    expect(s.fake.callsTo('listComments')).toHaveLength(1);
    expect(s.poller.status().capHits24h).toBe(0);
  });

  it('re-polls a quiet older reel when its comment count changes', async () => {
    const s = setup();
    s.fake.setMedia([{ id: 'old', shortcode: 'OLDCODE12', timestamp: iso(T0 - 20 * DAY), comments_count: 5 }]);
    await s.poller.tick(); // new media → polled once
    const before = s.fake.callsTo('listComments').length;
    s.clock.advance(10 * MINUTE);
    await s.poller.tick(); // unchanged, older than 3 days → skipped
    expect(s.fake.callsTo('listComments').length).toBe(before);
    s.fake.setMedia([{ id: 'old', shortcode: 'OLDCODE12', timestamp: iso(T0 - 20 * DAY), comments_count: 6 }]);
    s.clock.advance(5 * MINUTE); // media scan due
    await s.poller.tick();
    expect(s.fake.callsTo('listComments').length).toBe(before + 1);
    expect(s.repo.getMedia('old')?.comments_count).toBe(6);
  });

  it('does nothing while paused, throttled or without a token', async () => {
    const s = setup();
    s.repo.kvSet('paused', '1');
    await s.poller.tick();
    s.repo.kvDel('paused');
    s.repo.kvSet('throttle_until', s.clock.now() + MINUTE);
    await s.poller.tick();
    s.repo.kvDel('throttle_until');
    s.setUsable(false);
    await s.poller.tick();
    expect(s.fake.calls).toHaveLength(0);
  });

  it('rescan re-decides comments that arrived before their keyword existed', async () => {
    const s = setup();
    s.setTriggers(makeTriggers([{ keyword: 'LOOP' }]));
    s.fake.setComments(REEL.id, [{ data: [c('1', T0 + 10 * MINUTE, 'SKILL please')] }]);
    await s.poller.tick();
    expect(s.repo.getComment('1')?.decision).toBe('no_match');
    s.setTriggers(makeTriggers([{ keyword: 'SKILL' }]));
    const r = await s.poller.rescan(T0);
    expect(r).toMatchObject({ leads: 1 });
    expect(s.leads()).toEqual(['1']);
  });

  it('marks the token invalid on an auth error', async () => {
    const s = setup();
    s.fake.queue('listMedia', MetaApiError.fromResponse(400, { error: { code: 190, message: 'bad token' } }));
    await s.poller.tick();
    expect(s.tokens.markInvalid).toHaveBeenCalledOnce();
    expect(s.poller.status().lastError).toBe('bad token');
  });

  it('backs off when Meta throttles the account', async () => {
    const s = setup();
    s.fake.queue('listMedia', MetaApiError.fromResponse(400, { error: { code: 80002, message: 'too many calls' } }));
    await s.poller.tick();
    expect(s.repo.kvNum('throttle_until')).toBe(s.clock.now() + MINUTE);
  });
});
