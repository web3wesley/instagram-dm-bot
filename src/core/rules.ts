/**
 * Pure policy rules: Meta's time windows, own-comment detection and the per-comment
 * trigger decision. No I/O — everything the decision needs is passed in.
 */
import { findMatches, type MatchableTrigger } from './match.ts';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Meta sends seconds for comment entries and milliseconds for messaging; normalize to ms. */
export function toMs(t: number): number {
  return t < 1e12 ? t * 1000 : t;
}

/**
 * Private replies must go out within 7 days of the comment. We stop earlier (default 166 h)
 * so a queued reply never races the hard limit.
 */
export function privateReplyDeadline(commentedAt: number, maxAgeH: number): number {
  return commentedAt + maxAgeH * HOUR;
}

/** Follow-ups must be sent within 24 h of the person's latest message (minus a safety margin). */
export function linkDeadline(userMessageAt: number, marginMin: number): number {
  return userMessageAt + DAY - marginMin * MINUTE;
}

export interface Me {
  /** Instagram professional account ID (`user_id` from GET /me) — the `id` on webhook entries. */
  userId: string;
  username: string;
  /** App-scoped ID (`id` from GET /me). */
  appScopedId?: string | undefined;
  accountType?: string | undefined;
}

export function normalizeUsername(u: string): string {
  return u.trim().replace(/^@/, '').toLowerCase();
}

export function isOwn(from: { id?: string | undefined; username?: string | undefined }, me: Me): boolean {
  if (from.id && (from.id === me.userId || from.id === me.appScopedId)) return true;
  return !!from.username && normalizeUsername(from.username) === normalizeUsername(me.username);
}

export type CommentDecision =
  | 'lead'
  | 'no_match'
  | 'own'
  | 'disabled'
  | 'out_of_scope'
  | 'media_unresolved'
  | 'before_cutoff'
  | 'too_old'
  | 'opted_out'
  | 'not_allowlisted'
  | 'duplicate';

export interface RuleTrigger extends MatchableTrigger {
  keyword: string;
  enabled: boolean;
  /** Empty = the keyword works on every post/reel. */
  mediaShortcodes: readonly string[];
}

export interface DecideInput<T extends RuleTrigger> {
  text: string;
  from: { id?: string | undefined; username?: string | undefined };
  me: Me;
  triggers: readonly T[];
  /** The media's shortcode, or null when we could not resolve it (only matters for scoped triggers). */
  mediaShortcode: string | null;
  commentedAt: number;
  now: number;
  /** Comments before this instant never trigger (go-live / BACKFILL_SINCE). */
  cutoff: number;
  maxAgeH: number;
  /** Normalized usernames; empty = everyone. */
  allowlist: ReadonlySet<string>;
  /** Lazy so non-matching comments (the vast majority) cost no DB lookups. */
  isSuppressed: () => boolean;
  hasActiveLead: () => boolean;
}

export interface Decision<T> {
  decision: CommentDecision;
  trigger?: T;
  /** Keywords of every trigger whose keyword appeared, for the audit trail. */
  matched: string[];
}

export function decideComment<T extends RuleTrigger>(i: DecideInput<T>): Decision<T> {
  if (isOwn(i.from, i.me)) return { decision: 'own', matched: [] };

  const hits = findMatches(i.text, i.triggers);
  const matched = hits.map((t) => t.keyword);
  if (hits.length === 0) return { decision: 'no_match', matched };

  const enabled = hits.filter((t) => t.enabled);
  if (enabled.length === 0) return { decision: 'disabled', matched };

  const unscoped = enabled.filter((t) => t.mediaShortcodes.length === 0);
  const scoped = enabled.filter((t) => t.mediaShortcodes.length > 0);
  let trigger: T | undefined;
  for (const t of enabled) {
    if (t.mediaShortcodes.length === 0) {
      trigger = t;
      break;
    }
    if (i.mediaShortcode !== null && t.mediaShortcodes.includes(i.mediaShortcode)) {
      trigger = t;
      break;
    }
  }
  if (!trigger) {
    // Only scoped triggers matched and none applies to this media.
    const unresolved = i.mediaShortcode === null && scoped.length > 0 && unscoped.length === 0;
    return { decision: unresolved ? 'media_unresolved' : 'out_of_scope', matched };
  }

  const commentedAt = Math.min(i.commentedAt, i.now);
  if (commentedAt < i.cutoff) return { decision: 'before_cutoff', trigger, matched };
  if (i.now >= privateReplyDeadline(commentedAt, i.maxAgeH)) return { decision: 'too_old', trigger, matched };
  if (i.isSuppressed()) return { decision: 'opted_out', trigger, matched };
  if (i.allowlist.size > 0) {
    const u = i.from.username ? normalizeUsername(i.from.username) : '';
    if (!i.allowlist.has(u)) return { decision: 'not_allowlisted', trigger, matched };
  }
  if (i.hasActiveLead()) return { decision: 'duplicate', trigger, matched };
  return { decision: 'lead', trigger, matched };
}
