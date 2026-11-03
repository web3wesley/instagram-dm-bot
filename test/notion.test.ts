import { describe, expect, it, vi } from 'vitest';
import { ingestComment } from '../src/core/ingest.ts';
import { NOTION_VERSION, createMirror, leadToProperties } from '../src/notion/mirror.ts';
import { makeCtx } from './helpers/ctx.ts';
import { JESS, ME, REEL, T0 } from './helpers/fixtures.ts';

function notionFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const r = responses.shift() ?? { body: { id: 'page-x' } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  });
  return { impl: impl as unknown as typeof fetch, seen };
}

function setup(responses: Parameters<typeof notionFetch>[0] = []) {
  const t = makeCtx();
  const f = notionFetch(responses);
  const mirror = createMirror({ ctx: t.ctx, token: 'secret_notion', dataSourceId: 'ds-123', fetchImpl: f.impl, spacingMs: 0 });
  const { leadId } = ingestComment(
    t.ctx,
    { t: 'comment', accountId: ME.userId, commentId: 'c1', mediaId: REEL.id, fromId: JESS.id, username: JESS.username, text: 'SKILL please', at: T0, atExact: true },
    'webhook',
  );
  return { ...t, mirror, seen: f.seen, leadId: leadId! };
}

describe('Notion mirror', () => {
  it('maps a lead to the IG Leads properties (and never copies the IGSID)', () => {
    const t = makeCtx();
    const lead = {
      id: 1,
      username: 'jess.builds',
      state: 'link_sent',
      keyword: 'SKILL',
      permalink: 'https://www.instagram.com/reel/DAbCdEfGh12/',
      comment_text: 'SKILL please',
      commented_at: T0,
      dm_sent_at: T0 + 1000,
      replied_at: null,
      link_sent_at: null,
      reason: null,
      igsid: '2031528510825908',
    } as unknown as Parameters<typeof leadToProperties>[0];
    const props = leadToProperties(lead, t.env.mode);
    expect(props).toMatchObject({
      Name: { title: [{ text: { content: '@jess.builds' } }] },
      Status: { select: { name: 'Link sent' } },
      Keyword: { select: { name: 'SKILL' } },
      Mode: { select: { name: 'live' } },
      Reel: { url: 'https://www.instagram.com/reel/DAbCdEfGh12/' },
      Profile: { url: 'https://www.instagram.com/jess.builds/' },
      Commented: { date: { start: new Date(T0).toISOString() } },
      Replied: { date: null },
    });
    expect(JSON.stringify(props)).not.toContain('2031528510825908');
  });

  it('creates the page once, then updates it on later state changes', async () => {
    const s = setup([{ body: { id: 'page-1' } }, { body: { id: 'page-1' } }]);
    expect(await s.mirror.syncOnce()).toBe(1);
    const [create] = s.seen;
    expect(create?.method).toBe('POST');
    expect(create?.url).toBe('https://api.notion.com/v1/pages');
    expect(create?.headers['notion-version']).toBe(NOTION_VERSION);
    expect(create?.headers.authorization).toBe('Bearer secret_notion');
    expect(create?.body.parent).toEqual({ type: 'data_source_id', data_source_id: 'ds-123' });
    expect(s.repo.getLead(s.leadId)).toMatchObject({ notion_page_id: 'page-1', notion_dirty: 0 });

    expect(await s.mirror.syncOnce()).toBe(0); // nothing dirty

    s.repo.casLeadState(s.leadId, ['queued'], 'dm_sent', { dm_sent_at: T0 + 5000 }, s.clock.now());
    expect(await s.mirror.syncOnce()).toBe(1);
    expect(s.seen[1]).toMatchObject({ method: 'PATCH', url: 'https://api.notion.com/v1/pages/page-1' });
  });

  it('recreates the row if it was deleted in Notion', async () => {
    const s = setup([{ body: { id: 'page-1' } }, { status: 404, body: { code: 'object_not_found' } }, { body: { id: 'page-2' } }]);
    await s.mirror.syncOnce();
    s.repo.patchLead(s.leadId, { reason: 'x' }, s.clock.now() + 1);
    await s.mirror.syncOnce();
    expect(s.repo.getLead(s.leadId)?.notion_page_id).toBe('page-2');
  });

  it('honours Retry-After on 429 and never blocks DMs', async () => {
    const s = setup([{ status: 429, body: { code: 'rate_limited', message: 'slow down' }, headers: { 'retry-after': '7' } }]);
    expect(await s.mirror.syncOnce()).toBe(0);
    expect(s.mirror.status()).toMatchObject({ enabled: true, backlog: 1, lastError: 'Notion 429: slow down' });
    expect(await s.mirror.syncOnce()).toBe(0); // still backing off
    expect(s.seen).toHaveLength(1);
    s.clock.advance(7001);
    expect(await s.mirror.syncOnce()).toBe(1);
  });

  it('trashes pages for deleted people', async () => {
    const s = setup();
    await s.mirror.trash(['page-9']);
    expect(s.seen[0]).toMatchObject({ method: 'PATCH', url: 'https://api.notion.com/v1/pages/page-9', body: { in_trash: true } });
  });

  it('is off without a token or data source', async () => {
    const t = makeCtx();
    const m = createMirror({ ctx: t.ctx, token: undefined, dataSourceId: 'ds', spacingMs: 0 });
    expect(m.status()).toEqual({ enabled: false, backlog: 0, lastOkAt: null, lastError: null });
    expect(await m.syncOnce()).toBe(0);
  });
});
