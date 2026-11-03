/**
 * The single entry point for comments (webhook + poller) and inbound DMs.
 * Everything runs synchronously inside one transaction: there is no await between the
 * dedupe check and the insert, so a webhook and a poll can never both create a lead.
 */
import { jitter } from '../lib/time.ts';
import type { CommentEvent, InboundEvent } from '../webhook/parse.ts';
import { cutoff, type Ctx } from './context.ts';
import { normalize } from './match.ts';
import {
  SECOND,
  decideComment,
  linkDeadline,
  normalizeUsername,
  privateReplyDeadline,
  type CommentDecision,
} from './rules.ts';

export const PRIORITY = { link: 0, private_reply: 1, public_reply: 2 } as const;

export type IngestDecision = CommentDecision | 'wrong_account';
export interface IngestResult {
  isNew: boolean;
  decision: IngestDecision;
  leadId?: number;
}

/** Stable id for "this person" even when Meta omits `from.id`. */
export function commenterKey(ev: Pick<CommentEvent, 'fromId' | 'username' | 'commentId'>): string {
  if (ev.fromId) return ev.fromId;
  if (ev.username) return `u:${normalizeUsername(ev.username)}`;
  return `c:${ev.commentId}`;
}

export function suppressionSubjects(ids: Array<string | null | undefined>, username?: string | null): string[] {
  const out = ids.filter((x): x is string => !!x);
  if (username) out.push(`u:${normalizeUsername(username)}`);
  return out;
}

/**
 * Decisions a later look can change: the media wasn't known yet, or (on an explicit rescan) the
 * keyword didn't exist / was disabled / was scoped elsewhere when the comment first arrived.
 */
const REDECIDABLE_ON_RESCAN = new Set<string>(['no_match', 'disabled', 'out_of_scope', 'media_unresolved']);

export function ingestComment(
  ctx: Ctx,
  ev: CommentEvent,
  via: 'webhook' | 'poller',
  opts: { redecide?: boolean } = {},
): IngestResult {
  const me = ctx.me();
  if (!me) throw new NoAccountError();
  if (ev.accountId && ev.accountId !== me.userId) return { isNew: false, decision: 'wrong_account' };

  const { repo, env } = ctx;
  const now = ctx.clock.now();
  return repo.tx(() => {
    const existing = repo.getComment(ev.commentId);
    if (existing) {
      repo.markCommentSeen(ev.commentId, via, now, ev.atExact ? ev.at : undefined);
      const again =
        existing.decision === 'media_unresolved' || (opts.redecide === true && REDECIDABLE_ON_RESCAN.has(existing.decision));
      if (!again) return { isNew: false, decision: existing.decision as CommentDecision };
    }

    const commenter = commenterKey(ev);
    const shortcode = repo.getMedia(ev.mediaId)?.shortcode ?? null;
    const d = decideComment({
      text: ev.text,
      from: { id: ev.fromId, username: ev.username },
      me,
      triggers: ctx.triggers().triggers,
      mediaShortcode: shortcode,
      commentedAt: ev.at,
      now,
      cutoff: cutoff(ctx),
      maxAgeH: env.PRIVATE_REPLY_MAX_AGE_H,
      allowlist: env.allowlist,
      isSuppressed: () => repo.isSuppressed(suppressionSubjects([ev.fromId], ev.username)),
      hasActiveLead: () => repo.hasActiveLead(commenter, ev.mediaId),
    });
    const matched = d.matched.length ? d.matched.join(',') : null;
    if (existing) repo.updateCommentDecision(ev.commentId, d.decision, matched);
    else {
      repo.insertComment({
        comment_id: ev.commentId,
        media_id: ev.mediaId,
        ad_id: ev.adId ?? null,
        parent_id: ev.parentId ?? null,
        from_id: ev.fromId ?? null,
        username: ev.username ?? null,
        text: ev.text,
        commented_at: Math.min(ev.at, now),
        ts_exact: ev.atExact ? 1 : 0,
        via,
        decision: d.decision,
        matched,
        created_at: now,
      });
    }
    if (d.decision !== 'lead' || !d.trigger) return { isNew: !existing, decision: d.decision };

    const commentedAt = Math.min(ev.at, now);
    const leadId = repo.insertLead(
      {
        comment_id: ev.commentId,
        media_id: ev.mediaId,
        commenter_id: commenter,
        username: ev.username,
        keyword: d.trigger.keyword,
        link_snapshot: d.trigger.link,
        comment_text: ev.text,
        commented_at: commentedAt,
      },
      now,
    );
    repo.insertJob(
      {
        lead_id: leadId,
        kind: 'private_reply',
        priority: PRIORITY.private_reply,
        // A short human-ish pause before the intro goes out.
        run_after: now + jitter(ctx.rng, 3 * SECOND, 12 * SECOND),
        deadline: privateReplyDeadline(commentedAt, env.PRIVATE_REPLY_MAX_AGE_H),
      },
      now,
    );
    ctx.log.info(
      { leadId, commentId: ev.commentId, mediaId: ev.mediaId, username: ev.username, keyword: d.trigger.keyword, via },
      'lead created',
    );
    return { isNew: !existing, decision: 'lead', leadId };
  });
}

// ── inbound DMs ─────────────────────────────────────────────────────────

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'opt out', 'optout', 'stop please', 'please stop', 'stop messaging me']);
const START_WORDS = new Set(['start', 'unstop']);

export type InboundCommand = 'stop' | 'start' | 'delete';

/** Whole-message commands only, so "don't stop" never opts anyone out. */
export function inboundCommand(text: string | undefined): InboundCommand | null {
  const t = normalize(text ?? '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (/\bdelete my data\b/.test(t)) return 'delete';
  if (STOP_WORDS.has(t)) return 'stop';
  if (START_WORDS.has(t)) return 'start';
  return null;
}

export type InboundAction = 'replied' | 'no_open_lead' | 'opted_out' | 'resumed' | 'delete' | 'wrong_account' | 'self';
export interface InboundResult {
  action: InboundAction;
  leadIds: number[];
}

export function ingestInbound(ctx: Ctx, ev: InboundEvent): InboundResult {
  const me = ctx.me();
  if (!me) throw new NoAccountError();
  if (ev.recipientId !== me.userId && ev.accountId !== me.userId) return { action: 'wrong_account', leadIds: [] };
  if (ev.senderId === me.userId || ev.senderId === me.appScopedId) return { action: 'self', leadIds: [] };

  const { repo, env } = ctx;
  const now = ctx.clock.now();
  const at = Math.min(ev.at, now);
  const cmd = inboundCommand(ev.text);
  if (cmd === 'delete') return { action: 'delete', leadIds: [] };

  return repo.tx(() => {
    repo.kvSet('last_inbound_at', now, now);

    if (cmd === 'stop') {
      const open = repo.leadsForSender(ev.senderId, ['queued', 'dm_sent', 'dm_unknown', 'replied']);
      repo.addSuppression(ev.senderId, open[0]?.username ?? null, 'stop', now);
      for (const l of open) {
        repo.cancelOpenJobs(l.id, now);
        repo.patchLead(l.id, { state: 'opted_out', reason: 'stop' }, now);
        if (l.username) repo.addSuppression(`u:${normalizeUsername(l.username)}`, l.username, 'stop', now);
      }
      ctx.log.info({ senderId: ev.senderId, leads: open.length }, 'opted out (STOP)');
      return { action: 'opted_out', leadIds: open.map((l) => l.id) };
    }
    if (cmd === 'start') {
      const usernames = repo.leadsForSender(ev.senderId, ['opted_out']).map((l) => l.username);
      repo.removeSuppression(suppressionSubjects([ev.senderId], null).concat(usernames.flatMap((u) => suppressionSubjects([], u))));
      ctx.log.info({ senderId: ev.senderId }, 'opt-out removed (START)');
      return { action: 'resumed', leadIds: [] };
    }

    const leads = repo.openLeadsForSender(ev.senderId, at);
    const released: number[] = [];
    for (const lead of leads) {
      const moved = repo.casLeadState(
        lead.id,
        ['dm_sent', 'dm_unknown'],
        'replied',
        {
          replied_at: at,
          reply_text: (ev.text ?? ev.payload ?? `[${ev.kind}]`).slice(0, 500),
          // Their message proves which IGSID they message from.
          igsid: lead.igsid ?? ev.senderId,
        },
        now,
      );
      if (!moved) continue;
      repo.insertJob(
        {
          lead_id: lead.id,
          kind: 'link',
          priority: PRIORITY.link,
          run_after: now + jitter(ctx.rng, 1 * SECOND, 3 * SECOND),
          deadline: linkDeadline(at, env.LINK_WINDOW_MARGIN_MIN),
        },
        now,
      );
      released.push(lead.id);
    }
    if (released.length) ctx.log.info({ senderId: ev.senderId, leadIds: released }, 'reply received — link queued');
    return { action: released.length ? 'replied' : 'no_open_lead', leadIds: released };
  });
}

/** Thrown when no validated token exists yet — the webhook answers 503 so Meta retries later. */
export class NoAccountError extends Error {
  constructor() {
    super('no validated Instagram account yet (token missing or invalid)');
  }
}
