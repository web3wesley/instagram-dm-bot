/**
 * Best-effort mirror of leads into a Notion database ("IG Leads"). SQLite stays the source of
 * truth: a lead is marked dirty on every state change and this loop upserts one page per lead.
 * It never blocks or affects DMs. The IGSID is deliberately not copied (data minimization).
 */
import type { Ctx } from '../core/context.ts';
import { SECOND } from '../core/rules.ts';
import type { MirrorStatus } from '../core/status.ts';
import type { LeadRow } from '../db/repo.ts';
import { sleep } from '../lib/time.ts';

export const NOTION_VERSION = '2026-03-11';
const API = 'https://api.notion.com/v1';

/** Property names the Notion database must have (created to match at setup). */
export const NOTION_PROPS = {
  name: 'Name',
  status: 'Status',
  keyword: 'Keyword',
  mode: 'Mode',
  reel: 'Reel',
  profile: 'Profile',
  comment: 'Comment',
  commented: 'Commented',
  dmSent: 'DM sent',
  replied: 'Replied',
  linkSent: 'Link sent',
  error: 'Error',
} as const;

/** Plain-language labels for the Status column (the Notion database is created with these options). */
export const STATUS_LABELS: Record<LeadRow['state'], string> = {
  queued: 'Queued',
  dm_sent: 'Intro sent',
  dm_unknown: 'Intro unconfirmed',
  dm_failed: 'Intro failed',
  expired: 'Expired after 7 days',
  skipped: 'Skipped',
  opted_out: 'Opted out',
  replied: 'Replied',
  link_sent: 'Link sent',
  link_unknown: 'Link unconfirmed',
  link_failed: 'Link failed',
  window_expired: 'Missed 24h window',
};

type LeadWithPermalink = LeadRow & { permalink: string | null };

const text = (s: string) => [{ type: 'text', text: { content: s } }];
const date = (ms: number | null) => ({ date: ms ? { start: new Date(ms).toISOString() } : null });
/** Select option names can't contain commas. */
const option = (s: string) => ({ select: { name: s.replace(/,/g, ' ').slice(0, 100) || '—' } });

export function leadToProperties(l: LeadWithPermalink, mode: 'dry_run' | 'live'): Record<string, unknown> {
  const P = NOTION_PROPS;
  return {
    [P.name]: { title: text(`@${l.username ?? 'unknown'}`) },
    [P.status]: option(STATUS_LABELS[l.state] ?? l.state),
    [P.keyword]: option(l.keyword),
    [P.mode]: option(mode),
    [P.reel]: { url: l.permalink ?? null },
    [P.profile]: { url: l.username ? `https://www.instagram.com/${encodeURIComponent(l.username)}/` : null },
    [P.comment]: { rich_text: text((l.comment_text ?? '').slice(0, 200)) },
    [P.commented]: date(l.commented_at),
    [P.dmSent]: date(l.dm_sent_at),
    [P.replied]: date(l.replied_at),
    [P.linkSent]: date(l.link_sent_at),
    [P.error]: { rich_text: l.reason ? text(l.reason.slice(0, 200)) : [] },
  };
}

class NotionError extends Error {
  readonly status: number;
  readonly retryAfterS: number | null;
  constructor(status: number, message: string, retryAfterS: number | null) {
    super(message);
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

export function createMirror(d: {
  ctx: Ctx;
  token: string | undefined;
  dataSourceId: string | undefined;
  fetchImpl?: typeof fetch;
  /** Gap between Notion requests (Notion averages 3 req/s); tests pass 0. */
  spacingMs?: number;
}) {
  const { ctx } = d;
  const { repo, log, env } = ctx;
  const enabled = !!(d.token && d.dataSourceId);
  const doFetch = d.fetchImpl ?? fetch;
  const spacing = d.spacingMs ?? 350;
  let lastOkAt: number | null = null;
  let lastError: string | null = null;
  let backoffUntil = 0;
  let failures = 0;
  let running = false;
  let busy: Promise<unknown> | null = null;
  let timer: NodeJS.Timeout | undefined;

  async function request(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await doFetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${d.token}`,
        'notion-version': NOTION_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      throw new NotionError(res.status, `Notion ${res.status}: ${String(json.message ?? json.code ?? 'error')}`, Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    return json;
  }

  async function upsert(l: LeadWithPermalink): Promise<string> {
    const properties = leadToProperties(l, env.mode);
    if (l.notion_page_id) {
      try {
        await request('PATCH', `/pages/${l.notion_page_id}`, { properties });
        return l.notion_page_id;
      } catch (e) {
        // The row was deleted in Notion by hand — recreate it.
        if (!(e instanceof NotionError && e.status === 404)) throw e;
      }
    }
    const page = await request('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: d.dataSourceId }, properties });
    return String(page.id);
  }

  async function syncOnce(limit = 10): Promise<number> {
    if (!enabled) return 0;
    const t = ctx.clock.now();
    if (t < backoffUntil) return 0;
    let done = 0;
    for (const lead of repo.dirtyLeads(limit)) {
      try {
        const pageId = await upsert(lead);
        repo.markNotionSynced(lead.id, pageId, lead.updated_at);
        lastOkAt = ctx.clock.now();
        lastError = null;
        failures = 0;
        done++;
      } catch (e) {
        failures++;
        lastError = e instanceof Error ? e.message : String(e);
        repo.markNotionError(lead.id, lastError);
        const wait = e instanceof NotionError && e.retryAfterS ? e.retryAfterS * SECOND : Math.min(10 * 60 * SECOND, 5 * SECOND * 2 ** failures);
        backoffUntil = ctx.clock.now() + wait;
        log.warn({ leadId: lead.id, err: lastError, retryInMs: wait }, 'Notion sync failed');
        break;
      }
      if (spacing) await sleep(spacing);
    }
    return done;
  }

  async function loop() {
    if (!running) return;
    busy = syncOnce().catch((e: unknown) => log.error({ err: e }, 'Notion loop failed'));
    await busy;
    busy = null;
    if (running) timer = setTimeout(loop, 3 * SECOND);
  }

  return {
    syncOnce,
    /** Moves pages to Notion's trash (used when someone asks for their data to be deleted). */
    async trash(pageIds: readonly string[]): Promise<void> {
      if (!enabled) return;
      for (const id of pageIds) {
        try {
          await request('PATCH', `/pages/${id}`, { in_trash: true });
        } catch (e) {
          if (!(e instanceof NotionError && e.status === 404)) throw e;
        }
        if (spacing) await sleep(spacing);
      }
    },
    status(): MirrorStatus {
      return { enabled, backlog: enabled ? repo.notionBacklog() : 0, lastOkAt, lastError };
    },
    start() {
      if (running || !enabled) return;
      running = true;
      timer = setTimeout(loop, 0);
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await busy;
    },
  };
}

export type NotionMirror = ReturnType<typeof createMirror>;
