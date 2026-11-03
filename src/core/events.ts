/**
 * Routes parsed webhook events into ingest, and runs the deletion flow for
 * "delete my data" DMs. Shared by the webhook route and the simulate script.
 */
import type { MetaClient } from '../meta/types.ts';
import type { CommentEvent, IgnoreReason, InboundEvent, WebhookEvent } from '../webhook/parse.ts';
import type { Ctx } from './context.ts';
import { ingestComment, ingestInbound, type IngestResult, type InboundResult } from './ingest.ts';

export interface Mirror {
  trash(pageIds: readonly string[]): Promise<void>;
}

export interface HandleSummary {
  comments: IngestResult[];
  inbound: InboundResult[];
  ignored: Partial<Record<IgnoreReason, number>>;
}

const MEDIA_LOOKUP_TIMEOUT_MS = 3000;

export function createEventHandler(d: { ctx: Ctx; meta: Pick<MetaClient, 'getMedia'>; mirror?: Mirror | undefined }) {
  const { ctx, meta } = d;
  const { repo, log } = ctx;

  /** First time we see a media id (e.g. a brand-new reel), look up its shortcode/permalink. */
  async function ensureMedia(mediaId: string): Promise<void> {
    if (repo.getMedia(mediaId)?.shortcode) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const m = await Promise.race([
        meta.getMedia(mediaId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('media lookup timed out')), MEDIA_LOOKUP_TIMEOUT_MS);
        }),
      ]);
      repo.upsertMedia(
        {
          media_id: m.id,
          shortcode: m.shortcode,
          permalink: m.permalink,
          product_type: m.media_product_type,
          posted_at: m.timestamp ? Date.parse(m.timestamp) : undefined,
          comments_count: m.comments_count,
        },
        ctx.clock.now(),
      );
    } catch (e) {
      // Scoped triggers then decide 'media_unresolved' and the poller re-decides later.
      log.warn({ mediaId, err: (e as Error).message }, 'media lookup failed');
    } finally {
      clearTimeout(timer);
    }
  }

  async function deletePerson(ids: string[], username?: string): Promise<{ leads: number; comments: number }> {
    const r = repo.deletePerson({ ids, username });
    if (r.notionPageIds.length && d.mirror) {
      await d.mirror.trash(r.notionPageIds).catch((e: unknown) =>
        log.error({ err: e, pages: r.notionPageIds.length }, 'could not trash Notion rows for a deleted person'),
      );
    }
    log.info({ leads: r.leads, comments: r.comments }, 'personal data deleted on request');
    return { leads: r.leads, comments: r.comments };
  }

  async function handleComment(
    ev: CommentEvent,
    via: 'webhook' | 'poller',
    opts: { redecide?: boolean } = {},
  ): Promise<IngestResult> {
    await ensureMedia(ev.mediaId);
    return ingestComment(ctx, ev, via, opts);
  }

  async function handleInbound(ev: InboundEvent): Promise<InboundResult> {
    const r = ingestInbound(ctx, ev);
    if (r.action === 'delete') await deletePerson([ev.senderId]);
    return r;
  }

  /** Processes a webhook batch. Throws NoAccountError (→ 503, Meta retries) before any token exists. */
  async function handle(events: readonly WebhookEvent[], via: 'webhook' | 'poller'): Promise<HandleSummary> {
    const out: HandleSummary = { comments: [], inbound: [], ignored: {} };
    const now = ctx.clock.now();
    for (const ev of events) {
      if (ev.t === 'comment') {
        out.comments.push(await handleComment(ev, via));
        if (via === 'webhook') repo.kvSet('last_comment_webhook_at', now, now);
      } else if (ev.t === 'inbound') {
        out.inbound.push(await handleInbound(ev));
      } else {
        out.ignored[ev.reason] = (out.ignored[ev.reason] ?? 0) + 1;
      }
    }
    return out;
  }

  return { handle, handleComment, deletePerson };
}

export type EventHandler = ReturnType<typeof createEventHandler>;
