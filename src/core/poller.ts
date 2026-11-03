/**
 * Comment poller. Meta only sends `comments` webhooks to apps with Advanced Access, so before
 * App Review this is how comments arrive; afterwards it stays on as a slower safety net for
 * downtime and dropped webhooks (a private reply is valid for 7 days, so late is still fine).
 *
 * Per tick: rescan the media list when due, then poll "hot" media — posted in the last 3 days,
 * named in a trigger, or whose comments_count changed — newest-first back to the high-water mark.
 * A periodic sweep re-reads the whole 7-day window, because a new reply under an old comment
 * does not surface at the top of the reverse-chronological list.
 */
import { sleep } from '../lib/time.ts';
import { MetaApiError, classify } from '../meta/errors.ts';
import type { ApiComment, MetaClient } from '../meta/types.ts';
import type { CommentEvent } from '../webhook/parse.ts';
import { cutoff, type Ctx } from './context.ts';
import type { EventHandler } from './events.ts';
import { DAY, HOUR, MINUTE, SECOND } from './rules.ts';
import type { PollerStatus } from './status.ts';
import type { MediaRow } from '../db/repo.ts';

export const POLL_PROFILES = {
  /** Before App Review: the poller is the only comment source. */
  primary: { scanMs: 5 * MINUTE, pollMs: 60 * SECOND, sweepMs: 30 * MINUTE, tickMs: 15 * SECOND },
  /** After approval: webhooks are primary; this just catches what they miss. */
  backup: { scanMs: 15 * MINUTE, pollMs: 5 * MINUTE, sweepMs: 2 * HOUR, tickMs: 60 * SECOND },
} as const;

const HOT_WINDOW = 3 * DAY;
const OVERLAP = 2 * MINUTE;
const PAGE_CAP = 5;
const SWEEP_PAGE_CAP = 10;
const MEDIA_SCAN_LIMIT = 50;

export interface PollerDeps {
  ctx: Ctx;
  meta: MetaClient;
  events: Pick<EventHandler, 'handleComment'>;
  tokens: { isUsable(): boolean; markInvalid(e: unknown): void };
  /** Pause between API calls (default 250 ms); tests pass 0. */
  spacingMs?: number;
}

export interface PollSummary {
  media: number;
  comments: number;
  leads: number;
}

export function createPoller(d: PollerDeps) {
  const { ctx, meta, events } = d;
  const { repo, env, log } = ctx;
  const profile = env.POLL_PROFILE === 'off' ? null : POLL_PROFILES[env.POLL_PROFILE];
  const spacing = d.spacingMs ?? 250;
  const pendingChanged = new Set<string>();
  /** comments_count seen by the last scan, written to the row only once that media is polled. */
  const latestCounts = new Map<string, number>();
  const capHits: number[] = [];
  let lastScanAt: number | null = null;
  let lastTickAt: number | null = null;
  let lastError: string | null = null;
  let running = false;
  let busy: Promise<unknown> | null = null;
  let timer: NodeJS.Timeout | undefined;

  const now = () => ctx.clock.now();
  const pace = () => (spacing > 0 ? sleep(spacing) : Promise.resolve());

  function toEvent(c: ApiComment, m: MediaRow, accountId: string): CommentEvent {
    const at = c.timestamp ? Date.parse(c.timestamp) : NaN;
    return {
      t: 'comment',
      accountId,
      commentId: c.id,
      mediaId: m.media_id,
      parentId: c.parent_id,
      fromId: c.from?.id,
      username: c.from?.username ?? c.username,
      text: c.text ?? '',
      at: Number.isFinite(at) ? at : now(),
      atExact: Number.isFinite(at),
    };
  }

  async function scanMedia(t: number): Promise<void> {
    const list = await meta.listMedia(MEDIA_SCAN_LIMIT);
    for (const m of list) {
      const old = repo.getMedia(m.id);
      if (!old) pendingChanged.add(m.id);
      else if (m.comments_count !== undefined && old.comments_count !== m.comments_count) {
        pendingChanged.add(m.id);
        latestCounts.set(m.id, m.comments_count);
      }
      repo.upsertMedia(
        {
          media_id: m.id,
          shortcode: m.shortcode,
          permalink: m.permalink,
          product_type: m.media_product_type,
          posted_at: m.timestamp ? Date.parse(m.timestamp) : undefined,
          // Known media keep their stored count until polled, so a change can't be lost.
          comments_count: old ? undefined : m.comments_count,
        },
        t,
      );
    }
    lastScanAt = t;
  }

  function hotMedia(t: number): MediaRow[] {
    const scoped = new Set(ctx.triggers().triggers.filter((tr) => tr.enabled).flatMap((tr) => tr.mediaShortcodes));
    return repo
      .allMedia()
      .filter(
        (m) =>
          (m.posted_at !== null && t - m.posted_at < HOT_WINDOW) ||
          (m.shortcode !== null && scoped.has(m.shortcode)) ||
          pendingChanged.has(m.media_id),
      );
  }

  /** Walks comments newest-first down to `horizon`, then ingests oldest-first. */
  async function pollMedia(m: MediaRow, horizon: number, pageCap: number, opts: { redecide?: boolean } = {}): Promise<PollSummary> {
    const me = ctx.me();
    if (!me) return { media: 0, comments: 0, leads: 0 };
    const collected: CommentEvent[] = [];
    let after: string | undefined;
    let pages = 0;
    let newest = 0;
    let reachedHorizon = false;
    do {
      const page = await meta.listComments(m.media_id, { after, replies: true });
      pages++;
      // While the Meta app is in Development mode the comments edge returns empty pages with a
      // next cursor: 0 of 489 visible, and even a tester's comment was hidden (2026-10-01).
      // Real pages are never empty, so an empty page means stop.
      if (page.data.length === 0) {
        after = undefined;
        break;
      }
      for (const c of page.data) {
        const ev = toEvent(c, m, me.userId);
        newest = Math.max(newest, ev.at);
        if (ev.at >= horizon) collected.push(ev);
        else reachedHorizon = true;
        for (const r of c.replies?.data ?? []) {
          const rev = toEvent(r, m, me.userId);
          rev.parentId ??= c.id;
          newest = Math.max(newest, rev.at);
          if (rev.at >= horizon) collected.push(rev);
        }
      }
      after = page.next;
      if (after && !reachedHorizon && pages < pageCap) await pace();
    } while (after && !reachedHorizon && pages < pageCap);
    if (after && !reachedHorizon) {
      capHits.push(now());
      log.warn({ mediaId: m.media_id, pages }, 'poll page cap hit — older comments on this post are left to the next sweep');
    }

    collected.sort((a, b) => a.at - b.at);
    let leads = 0;
    for (const ev of collected) {
      const r = await events.handleComment(ev, 'poller', opts);
      if (r.leadId !== undefined) leads++;
    }
    repo.setMediaPolled(m.media_id, newest || null, now(), latestCounts.get(m.media_id));
    latestCounts.delete(m.media_id);
    return { media: 1, comments: collected.length, leads };
  }

  function onError(e: unknown): void {
    lastError = e instanceof Error ? e.message : String(e);
    const cls = classify(e);
    if (cls === 'auth') d.tokens.markInvalid(e);
    if (cls === 'throttled') {
      const etaMs = (e instanceof MetaApiError ? (e.usage?.etaMin ?? 0) : 0) * MINUTE;
      repo.kvSet('throttle_until', now() + Math.max(MINUTE, etaMs), now());
    }
    log.warn({ class: cls, error: e instanceof MetaApiError ? e.toJSON() : lastError }, 'poll failed');
  }

  async function tick(): Promise<void> {
    if (!profile) return;
    const t = now();
    lastTickAt = t;
    if (!d.tokens.isUsable() || !ctx.me() || repo.kvGet('paused') || repo.kvNum('throttle_until') > t) return;
    try {
      if (lastScanAt === null || t - lastScanAt >= profile.scanMs) await scanMedia(t);
      const floor = Math.max(t - env.PRIVATE_REPLY_MAX_AGE_H * HOUR, cutoff(ctx));
      for (const m of hotMedia(t)) {
        const sweepDue = m.last_swept_at === null || t - m.last_swept_at >= profile.sweepMs;
        const pollDue = m.last_polled_at === null || t - m.last_polled_at >= profile.pollMs || pendingChanged.has(m.media_id);
        if (sweepDue) {
          await pollMedia(m, floor, SWEEP_PAGE_CAP);
          repo.setMediaSwept(m.media_id, t);
        } else if (pollDue) {
          await pollMedia(m, Math.max((m.poll_hwm ?? 0) - OVERLAP, floor), PAGE_CAP);
        } else continue;
        pendingChanged.delete(m.media_id);
        await pace();
      }
      lastError = null;
    } catch (e) {
      onError(e);
    }
  }

  async function loop() {
    if (!running || !profile) return;
    busy = tick();
    await busy;
    busy = null;
    if (running) timer = setTimeout(loop, profile.tickMs);
  }

  return {
    tick,
    /** Re-reads every known post back to `since` and re-decides comments whose keyword didn't exist yet. */
    async rescan(since: number): Promise<PollSummary> {
      const t = now();
      if (lastScanAt === null || t - lastScanAt > MINUTE) await scanMedia(t);
      const floor = Math.max(since, t - env.PRIVATE_REPLY_MAX_AGE_H * HOUR, cutoff(ctx));
      const total: PollSummary = { media: 0, comments: 0, leads: 0 };
      for (const m of repo.allMedia()) {
        if (m.posted_at !== null && m.posted_at < t - 90 * DAY && !pendingChanged.has(m.media_id)) continue;
        const r = await pollMedia(m, floor, SWEEP_PAGE_CAP, { redecide: true });
        total.media += r.media;
        total.comments += r.comments;
        total.leads += r.leads;
        await pace();
      }
      log.info({ since: new Date(floor).toISOString(), ...total }, 'rescan finished');
      return total;
    },
    status(): PollerStatus {
      const t = now();
      while (capHits.length && capHits[0]! < t - DAY) capHits.shift();
      return {
        profile: env.POLL_PROFILE,
        lastTickAt,
        lastScanAt,
        hotMedia: profile ? hotMedia(t).length : 0,
        capHits24h: capHits.length,
        lastError,
      };
    },
    start() {
      if (running || !profile) return;
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

export type Poller = ReturnType<typeof createPoller>;
