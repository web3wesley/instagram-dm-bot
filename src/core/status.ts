/**
 * The /health report: token, webhook freshness, queue, today's sends (in REPORT_TZ, JST by
 * default), rate-limit utilization and the 7-day funnel — plus an overall ok/degraded/down.
 */
import { dayStart, isoInTz } from '../lib/time.ts';
import type { Ctx } from './context.ts';
import type { Limiter } from './limiter.ts';
import { DAY, MINUTE } from './rules.ts';
import type { Tokens } from './token.ts';

export interface PollerStatus {
  profile: string;
  lastTickAt: number | null;
  lastScanAt: number | null;
  hotMedia: number;
  capHits24h: number;
  lastError: string | null;
}

export interface MirrorStatus {
  enabled: boolean;
  backlog: number;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface StatusDeps {
  ctx: Ctx;
  tokens: Pick<Tokens, 'status'>;
  limiter: Limiter;
  worker: { lastTickAt(): number };
  poller?: { status(): PollerStatus } | undefined;
  mirror?: { status(): MirrorStatus } | undefined;
  startedAt: number;
  version: string;
}

export type Level = 'ok' | 'degraded' | 'down';

export function buildHealth(d: StatusDeps) {
  const { ctx } = d;
  const { repo, env } = ctx;
  const now = ctx.clock.now();
  const tz = env.REPORT_TZ;
  const iso = (ms: number | null | undefined) => isoInTz(ms || null, tz);
  const reasons: { level: Level; reason: string }[] = [];
  const flag = (level: Level, reason: string) => reasons.push({ level, reason });

  const me = ctx.me();
  const token = d.tokens.status();
  if (token.state !== 'ok') flag('down', `token_${token.state}`);
  else if (token.daysLeft !== null && token.daysLeft < 10) flag('degraded', `token_expires_in_${token.daysLeft}d`);

  const workerTick = d.worker.lastTickAt();
  if (now - d.startedAt > 2 * MINUTE && now - workerTick > 5 * MINUTE) flag('down', 'worker_stalled');

  const paused = !!repo.kvGet('paused');
  if (paused) flag('degraded', 'paused');
  const throttledUntil = repo.kvNum('throttle_until');
  if (throttledUntil > now) flag('degraded', 'throttled');
  const publicBlockedUntil = repo.kvNum('public_blocked_until');
  if (publicBlockedUntil > now) flag('degraded', 'public_replies_blocked');

  const q = repo.queueStats(now);
  if (q.oldestQueuedAt !== null && q.due > 0 && now - q.oldestQueuedAt > 30 * MINUTE) flag('degraded', 'queue_backlog');
  if (q.unknown > 0) flag('degraded', 'unknown_outcome_jobs');

  const fr = repo.failureRateSince(now - DAY);
  if (fr.total >= 5 && fr.failed / fr.total > 0.2) flag('degraded', 'high_failure_rate');
  // A deleted comment now and then is normal. Most public replies ending that way is not: it would
  // mean Meta is refusing the comment replies themselves (a lost permission looks the same).
  const pub = repo.attemptStatsSince(now - DAY).filter((a) => a.kind === 'public_reply');
  const pubTotal = pub.reduce((s, a) => s + a.n, 0);
  const pubGone = pub.reduce((s, a) => s + a.gone, 0);
  if (pubTotal >= 5 && pubGone / pubTotal > 0.5) flag('degraded', 'public_replies_comment_gone');

  const lastWebhook = repo.kvNum('last_webhook_at');
  if (env.POLL_PROFILE === 'backup' && now - lastWebhook > DAY) flag('degraded', 'no_webhook_24h');

  const sigFailures = (repo.kvGetJson<number[]>('sig_failures') ?? []).filter((t) => t > now - DAY).length;

  const since = dayStart(now, tz);
  const attempts = repo.attemptStatsSince(since);
  const sent = (kind: string) => attempts.filter((a) => a.kind === kind && a.ok === 1).reduce((s, a) => s + a.n, 0);
  const failedToday = attempts.filter((a) => a.ok === 0).reduce((s, a) => s + a.n - a.gone, 0);
  const commentsDeletedToday = attempts.reduce((s, a) => s + a.gone, 0);
  const decisions = Object.fromEntries(repo.commentDecisionsSince(since).map((r) => [r.decision, r.n]));
  const commentsToday = Object.values(decisions).reduce((s, n) => s + n, 0);

  const funnelRows = repo.funnel(now - 7 * DAY);
  const sum = (k: 'matched' | 'dm_sent' | 'replied' | 'link_sent' | 'failed') => funnelRows.reduce((s, r) => s + r[k], 0);
  const funnel = { matched: sum('matched'), dm_sent: sum('dm_sent'), replied: sum('replied'), link_sent: sum('link_sent'), failed: sum('failed') };

  const mirror = d.mirror?.status();
  if (mirror?.enabled && (mirror.backlog > 50 || (mirror.lastError && mirror.backlog > 0))) flag('degraded', 'notion_backlog');

  const poller = d.poller?.status();
  const triggers = ctx.triggers();
  const level: Level = reasons.some((r) => r.level === 'down') ? 'down' : reasons.length ? 'degraded' : 'ok';

  return {
    status: level,
    reasons: reasons.map((r) => r.reason),
    version: d.version,
    uptime_s: Math.round((now - d.startedAt) / 1000),
    mode: {
      dry_run: env.mode === 'dry_run',
      allowlist: [...env.allowlist],
      public_replies: env.PUBLIC_REPLIES_ENABLED,
      paused,
      poll_profile: env.POLL_PROFILE,
    },
    account: me ? { username: me.username, user_id: me.userId, account_type: me.accountType ?? null } : null,
    token: {
      state: token.state,
      source: token.source,
      expires_at: iso(token.expiresAt),
      days_left: token.daysLeft,
      last_refresh_at: iso(token.lastRefreshAt),
      last_validated_at: iso(token.lastValidatedAt),
      last_error: token.lastError,
    },
    webhooks: {
      last_received_at: iso(lastWebhook),
      last_comment_at: iso(repo.kvNum('last_comment_webhook_at')),
      last_inbound_at: iso(repo.kvNum('last_inbound_at')),
      sig_failures_24h: sigFailures,
      sig_secret_used: repo.kvGet('sig_secret_used') ?? null,
      subscribed_fields: repo.kvGetJson<string[]>('subscribed_fields') ?? [],
    },
    poller: poller
      ? {
          profile: poller.profile,
          last_tick_at: iso(poller.lastTickAt),
          last_scan_at: iso(poller.lastScanAt),
          hot_media: poller.hotMedia,
          cap_hits_24h: poller.capHits24h,
          missed_by_webhook_24h: repo.missedByWebhookSince(now - DAY),
          last_error: poller.lastError,
        }
      : null,
    queue: {
      queued: q.queued,
      due: q.due,
      oldest_queued_s: q.oldestQueuedAt === null ? null : Math.round((now - q.oldestQueuedAt) / 1000),
      unknown: q.unknown,
      throttled_until: throttledUntil > now ? iso(throttledUntil) : null,
      public_replies_blocked_until: publicBlockedUntil > now ? iso(publicBlockedUntil) : null,
    },
    today: {
      tz,
      since: iso(since),
      comments: commentsToday,
      matched: decisions.lead ?? 0,
      dms_sent: sent('private_reply') + sent('link'),
      intros: sent('private_reply'),
      links: sent('link'),
      public_replies: sent('public_reply'),
      failed: failedToday,
      /** Public replies skipped because the comment was deleted after the DM (not counted as failures). */
      comment_deleted: commentsDeletedToday,
      decisions,
    },
    rate_limits: {
      dm: d.limiter.usage('dm'),
      public: d.limiter.usage('public'),
      meta_private_replies: d.limiter.metaPrivateReplies(),
      meta_buc: repo.kvGetJson('meta_usage') ?? null,
    },
    funnel_7d: {
      ...funnel,
      reply_rate: funnel.dm_sent ? Math.round((funnel.replied / funnel.dm_sent) * 1000) / 1000 : null,
      by_keyword_and_reel: funnelRows,
    },
    notion: mirror
      ? { enabled: mirror.enabled, backlog: mirror.backlog, last_ok_at: iso(mirror.lastOkAt), last_error: mirror.lastError }
      : { enabled: false },
    triggers: {
      count: triggers.triggers.length,
      enabled: triggers.triggers.filter((t) => t.enabled).length,
      keywords: triggers.triggers.filter((t) => t.enabled).map((t) => t.keyword),
      hash: triggers.hash,
    },
    suppressions: repo.suppressionCount(),
  };
}

export type HealthReport = ReturnType<typeof buildHealth>;
