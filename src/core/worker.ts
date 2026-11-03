/**
 * The send worker: a serial outbox over the `jobs` table, one send in flight at a time.
 *
 * Priority: link (someone is waiting) > intro (private reply) > public reply.
 * Delivery semantics:
 * - intro:  retried on unknown outcomes — Meta allows only one private reply per comment, so a
 *           retry after a lost response cannot double-DM (it fails as "already replied").
 * - link / public reply: at-most-once. A timeout or crash mid-send marks them `unknown`.
 */
import { triggerKey, type Trigger } from '../config/triggers.ts';
import type { JobRow, LeadRow } from '../db/repo.ts';
import { jitter } from '../lib/time.ts';
import { MetaApiError, classify, type ErrorClass } from '../meta/errors.ts';
import type { MetaClient, SendResult } from '../meta/types.ts';
import type { Alert, Ctx } from './context.ts';
import { PRIORITY, suppressionSubjects } from './ingest.ts';
import { bucketOf, type Limiter } from './limiter.ts';
import { DAY, HOUR, MINUTE, SECOND, normalizeUsername } from './rules.ts';
import { pickVariant, renderTemplate } from './template.ts';

export type RunResult = 'sent' | 'progress' | 'idle' | 'blocked' | 'paused';

export interface WorkerDeps {
  ctx: Ctx;
  meta: MetaClient;
  limiter: Limiter;
  tokens: { isUsable(): boolean; markInvalid(e: unknown): void };
  alert: Alert;
  /** Random pause between sends (default 2–6 s); tests pass [0, 0]. */
  sendGapMs?: readonly [number, number];
}

const MAX_ATTEMPTS = 8;
/** Public replies that can't go out within this window are dropped, never posted late. */
const PUBLIC_REPLY_WINDOW = 30 * MINUTE;
/** States in which the intro DM has gone out, so a public "check your DMs" reply is truthful. */
const DM_DELIVERED = new Set(['dm_sent', 'dm_unknown', 'replied', 'link_sent', 'link_unknown', 'link_failed', 'window_expired']);

type Plan =
  | { skip: true; note: string; apply: (t: number) => void }
  | {
      skip: false;
      request: unknown;
      call: () => Promise<SendResult | { id: string }>;
      onSuccess: (res: SendResult & { id?: string }, t: number) => void;
    };

const isRealId = (id: string | null | undefined): id is string => !!id && !id.startsWith('u:') && !id.startsWith('c:');

export function createWorker(d: WorkerDeps) {
  const { ctx, meta, limiter } = d;
  const { repo, env, log } = ctx;
  const [gapMin, gapMax] = d.sendGapMs ?? [2 * SECOND, 6 * SECOND];
  const dryRun = env.mode === 'dry_run';
  const now = () => ctx.clock.now();

  let nextSendAt = 0;
  let lastTickAt = 0;
  let throttleStreak = 0;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<RunResult> | null = null;

  // ── job/lead transitions ──────────────────────────────────────────────
  function requeue(job: JobRow, t: number, extra: { run_after?: number; attempts?: number; last_error?: string } = {}) {
    repo.patchJob(job.id, { state: 'queued', run_after: extra.run_after ?? t, ...extra }, t);
  }

  function expire(job: JobRow, t: number, reason: string) {
    repo.tx(() => {
      repo.patchJob(job.id, { state: 'expired', last_error: reason }, t);
      if (job.kind === 'private_reply') repo.casLeadState(job.lead_id, ['queued'], 'expired', { reason }, t);
      else if (job.kind === 'link') repo.casLeadState(job.lead_id, ['replied'], 'window_expired', { reason }, t);
      else repo.patchLead(job.lead_id, { public_state: 'expired' }, t);
    });
    log.warn({ jobId: job.id, leadId: job.lead_id, kind: job.kind, reason }, `${job.kind} expired`);
  }

  function fail(job: JobRow, t: number, reason: string) {
    repo.tx(() => {
      repo.patchJob(job.id, { state: 'failed', last_error: reason }, t);
      if (job.kind === 'private_reply') repo.casLeadState(job.lead_id, ['queued'], 'dm_failed', { reason }, t);
      else if (job.kind === 'link') repo.casLeadState(job.lead_id, ['replied'], 'link_failed', { reason }, t);
      else repo.patchLead(job.lead_id, { public_state: 'failed' }, t);
    });
  }

  function markUnknown(job: JobRow, t: number, reason: string) {
    repo.tx(() => {
      repo.patchJob(job.id, { state: 'unknown', last_error: reason }, t);
      if (job.kind === 'private_reply') repo.casLeadState(job.lead_id, ['queued'], 'dm_unknown', { reason }, t);
      else if (job.kind === 'link') repo.casLeadState(job.lead_id, ['replied'], 'link_unknown', { reason }, t);
      else repo.patchLead(job.lead_id, { public_state: 'unknown' }, t);
    });
  }

  function cancel(job: JobRow, t: number, note: string) {
    repo.patchJob(job.id, { state: 'cancelled', last_error: note }, t);
  }

  // ── what to send ──────────────────────────────────────────────────────
  function liveTrigger(lead: LeadRow): Trigger | undefined {
    return ctx.triggers().byKey.get(triggerKey(lead.keyword));
  }

  function isSuppressed(lead: LeadRow): boolean {
    return repo.isSuppressed(suppressionSubjects([lead.commenter_id, lead.igsid], lead.username));
  }

  function plan(job: JobRow, lead: LeadRow): Plan {
    const username = lead.username ?? undefined;
    const trigger = liveTrigger(lead);

    if (job.kind === 'private_reply') {
      if (lead.state !== 'queued') return { skip: true, note: `lead is ${lead.state}`, apply: (t) => cancel(job, t, `lead is ${lead.state}`) };
      const skipLead = (reason: string, state: 'skipped' | 'opted_out' = 'skipped'): Plan => ({
        skip: true,
        note: reason,
        apply: (t) =>
          repo.tx(() => {
            cancel(job, t, reason);
            repo.casLeadState(lead.id, ['queued'], state, { reason }, t);
          }),
      });
      if (!trigger) return skipLead('trigger_removed');
      if (!trigger.enabled) return skipLead('trigger_disabled');
      if (env.allowlist.size > 0 && !env.allowlist.has(normalizeUsername(lead.username ?? ''))) return skipLead('not_allowlisted');
      if (isSuppressed(lead)) return skipLead('opted_out', 'opted_out');

      const text = renderTemplate(trigger.intro, { username, keyword: trigger.keyword }, ctx.rng);
      return {
        skip: false,
        request: { recipient: { comment_id: lead.comment_id }, message: { text } },
        call: () => meta.sendPrivateReply(lead.comment_id, text),
        onSuccess: (res, t) => {
          const igsid = res.recipientId || (isRealId(lead.commenter_id) ? lead.commenter_id : null);
          repo.casLeadState(lead.id, ['queued'], 'dm_sent', { dm_sent_at: t, dm_mid: res.messageId, igsid, reason: null }, t);
          if (env.PUBLIC_REPLIES_ENABLED && trigger.publicReply) {
            const at = t + jitter(ctx.rng, 30 * SECOND, 180 * SECOND);
            repo.insertJob(
              { lead_id: lead.id, kind: 'public_reply', priority: PRIORITY.public_reply, run_after: at, deadline: t + PUBLIC_REPLY_WINDOW },
              t,
            );
            repo.patchLead(lead.id, { public_state: 'queued' }, t);
          }
        },
      };
    }

    if (job.kind === 'link') {
      if (lead.state !== 'replied') return { skip: true, note: `lead is ${lead.state}`, apply: (t) => cancel(job, t, `lead is ${lead.state}`) };
      if (isSuppressed(lead)) {
        return {
          skip: true,
          note: 'opted_out',
          apply: (t) =>
            repo.tx(() => {
              cancel(job, t, 'opted_out');
              repo.casLeadState(lead.id, ['replied'], 'opted_out', { reason: 'opted_out' }, t);
            }),
        };
      }
      const link = trigger?.link ?? lead.link_snapshot;
      const igsid = lead.igsid ?? (isRealId(lead.commenter_id) ? lead.commenter_id : null);
      if (!igsid) return { skip: true, note: 'no_recipient', apply: (t) => fail(job, t, 'no_recipient') };
      if (repo.linkSentRecently(igsid, link, now() - DAY, lead.id)) {
        return {
          skip: true,
          note: 'deduped',
          apply: (t) =>
            repo.tx(() => {
              repo.patchJob(job.id, { state: 'done', last_error: 'deduped' }, t);
              repo.casLeadState(lead.id, ['replied'], 'link_sent', { link_sent_at: t, reason: 'deduped' }, t);
            }),
        };
      }
      const tpl = trigger?.linkMessage ?? ctx.triggers().defaults.linkMessage;
      const text = renderTemplate(tpl, { username, keyword: trigger?.keyword ?? lead.keyword, link }, ctx.rng);
      return {
        skip: false,
        request: { recipient: { id: igsid }, message: { text } },
        call: () => meta.sendText(igsid, text),
        onSuccess: (res, t) => {
          repo.casLeadState(lead.id, ['replied'], 'link_sent', { link_sent_at: t, link_mid: res.messageId, link_snapshot: link }, t);
        },
      };
    }

    // public_reply
    const cancelPublic = (note: string): Plan => ({
      skip: true,
      note,
      apply: (t) =>
        repo.tx(() => {
          cancel(job, t, note);
          repo.patchLead(lead.id, { public_state: 'cancelled' }, t);
        }),
    });
    if (!env.PUBLIC_REPLIES_ENABLED || !trigger?.publicReply || trigger.publicReplies.length === 0) return cancelPublic('public_replies_off');
    if (!DM_DELIVERED.has(lead.state) || isSuppressed(lead)) return cancelPublic(`lead is ${lead.state}`);
    const recent = repo.kvGetJson<string[]>('public_recent') ?? [];
    const recentIdx = recent.map((tpl) => trigger.publicReplies.indexOf(tpl)).filter((i) => i >= 0);
    const idx = pickVariant(trigger.publicReplies.length, recentIdx, ctx.rng);
    const tpl = trigger.publicReplies[idx]!;
    const text = renderTemplate(tpl, { username, keyword: trigger.keyword }, ctx.rng);
    return {
      skip: false,
      request: { comment_id: lead.comment_id, message: text },
      call: () => meta.replyToComment(lead.comment_id, text),
      onSuccess: (res, t) => {
        repo.patchLead(lead.id, { public_state: 'sent', public_reply_id: res.id ?? null }, t);
        repo.kvSetJson('public_recent', [...recent, tpl].slice(-10), t);
      },
    };
  }

  // ── error policy ──────────────────────────────────────────────────────
  function onError(job: JobRow, e: unknown, t: number): RunResult {
    const cls: ErrorClass = classify(e);
    const tag = e instanceof MetaApiError ? `${cls}:${e.tag}` : cls;
    const attemptsBefore = job.attempts; // attempts was incremented when the job was claimed
    const attemptsNow = job.attempts + 1;

    switch (cls) {
      case 'auth':
        requeue(job, t, { attempts: attemptsBefore, last_error: tag });
        d.tokens.markInvalid(e);
        d.alert('auth', 'Instagram token rejected (190) — sending paused. Reconnect at /auth/login.');
        return 'paused';

      case 'throttled': {
        throttleStreak++;
        const etaMs = ((e instanceof MetaApiError ? e.usage?.etaMin : 0) ?? 0) * MINUTE;
        const backoff = Math.min(HOUR, MINUTE * 2 ** (throttleStreak - 1));
        const until = t + Math.max(backoff, etaMs);
        repo.kvSet('throttle_until', until, t);
        requeue(job, t, { attempts: attemptsBefore, last_error: tag });
        d.alert('throttled', `Meta rate limit hit (${tag}); sending paused until ${new Date(until).toISOString()}`);
        return 'blocked';
      }

      case 'blocked':
        if (job.kind === 'public_reply') {
          repo.kvSet('public_blocked_until', t + DAY, t);
          fail(job, t, tag);
          d.alert('blocked_public', 'Instagram blocked a public comment reply (368). Public replies paused for 24 h.');
          return 'progress';
        }
        repo.kvSet('throttle_until', t + HOUR, t);
        requeue(job, t, { attempts: attemptsBefore, last_error: tag });
        d.alert('blocked_dm', 'Instagram temporarily blocked a DM (368). All sending paused for 1 h.');
        return 'blocked';

      case 'unknown_outcome':
      case 'retryable': {
        // Only the intro is safe to resend after an unknown outcome (one private reply per comment).
        if (cls === 'unknown_outcome' && job.kind !== 'private_reply') {
          markUnknown(job, t, tag);
          return 'progress';
        }
        const backoff = Math.min(30 * MINUTE, 30 * SECOND * 2 ** (attemptsNow - 1));
        if (attemptsNow < MAX_ATTEMPTS && t + backoff < job.deadline) {
          requeue(job, t, { run_after: t + backoff, last_error: tag });
        } else {
          fail(job, t, tag);
        }
        return 'progress';
      }

      case 'window_closed':
        expire(job, t, tag);
        return 'progress';

      case 'already_replied':
        if (job.kind === 'private_reply') markUnknown(job, t, tag);
        else fail(job, t, tag);
        return 'progress';

      case 'comment_gone':
        // Some people delete their keyword comment once the DM arrives (first seen live on
        // 2026-10-13, 73 s after a successful intro). For the public reply that just means there is
        // nothing left to reply under; it is not a failure worth alarming on.
        if (job.kind === 'public_reply') {
          repo.tx(() => {
            repo.patchJob(job.id, { state: 'cancelled', last_error: tag }, t);
            repo.patchLead(job.lead_id, { public_state: 'comment_gone' }, t);
          });
          return 'progress';
        }
        fail(job, t, tag);
        return 'progress';

      case 'not_approved':
        fail(job, t, tag);
        d.alert(
          'not_approved',
          'Meta refused a DM (needs Advanced Access via App Review, or the recipient must be an Instagram Tester).',
        );
        return 'progress';

      default:
        fail(job, t, tag);
        return 'progress';
    }
  }

  // ── the loop ──────────────────────────────────────────────────────────
  async function execute(job: JobRow, t: number): Promise<RunResult> {
    const lead = repo.getLead(job.lead_id);
    if (!lead) {
      cancel(job, t, 'lead_missing');
      return 'progress';
    }
    const p = plan(job, lead);
    if (p.skip) {
      p.apply(t);
      log.info({ jobId: job.id, leadId: lead.id, kind: job.kind, note: p.note }, `${job.kind} skipped`);
      return 'progress';
    }

    repo.patchJob(job.id, { state: 'running', attempts: job.attempts + 1 }, t);
    const started = now();
    try {
      const res = (await p.call()) as SendResult & { id?: string };
      const done = now();
      nextSendAt = done + jitter(ctx.rng, gapMin, gapMax);
      throttleStreak = 0;
      repo.tx(() => {
        repo.insertAttempt({
          job_id: job.id,
          lead_id: lead.id,
          kind: job.kind,
          at: started,
          dry_run: dryRun,
          request: p.request,
          ok: true,
          response: res,
          duration_ms: done - started,
        });
        repo.patchJob(job.id, { state: 'done', last_error: null }, done);
        p.onSuccess(res, done);
      });
      log.info({ jobId: job.id, leadId: lead.id, kind: job.kind, dryRun, request: p.request, response: res }, `${job.kind} sent`);
      return 'sent';
    } catch (e) {
      const done = now();
      nextSendAt = done + jitter(ctx.rng, gapMin, gapMax);
      const error = e instanceof MetaApiError ? e.toJSON() : { message: e instanceof Error ? e.message : String(e) };
      repo.insertAttempt({
        job_id: job.id,
        lead_id: lead.id,
        kind: job.kind,
        at: started,
        dry_run: dryRun,
        request: p.request,
        ok: false,
        http_status: e instanceof MetaApiError ? e.status : undefined,
        error_class: classify(e),
        error,
        duration_ms: done - started,
      });
      // The exact Meta error payload, as the brief requires.
      log.warn({ jobId: job.id, leadId: lead.id, kind: job.kind, class: classify(e), error, request: p.request }, `${job.kind} failed`);
      return onError({ ...job, state: 'running' }, e, done);
    }
  }

  async function runOnce(): Promise<RunResult> {
    const t = now();
    lastTickAt = t;
    if (repo.kvGet('paused')) return 'paused';
    if (!d.tokens.isUsable()) return 'paused';
    if (repo.kvNum('throttle_until') > t) return 'blocked';
    if (t < nextSendAt) return 'blocked';

    for (const job of repo.readyJobs(t, 25)) {
      if (job.deadline <= t) {
        expire(job, t, 'deadline_passed');
        return 'progress';
      }
      if (job.kind === 'public_reply' && repo.kvNum('public_blocked_until') > t) {
        repo.tx(() => {
          cancel(job, t, 'public_replies_blocked');
          repo.patchLead(job.lead_id, { public_state: 'cancelled' }, t);
        });
        return 'progress';
      }
      if (!limiter.hasCapacity(bucketOf(job.kind))) continue;
      return execute(job, t);
    }
    return repo.readyJobs(t, 1).length ? 'blocked' : 'idle';
  }

  /** A crash mid-send leaves jobs `running`: retry intros, never guess about links/public replies. */
  function recoverOnBoot(): number {
    const t = now();
    const stuck = repo.jobsInState('running');
    for (const job of stuck) {
      if (job.kind === 'private_reply') requeue(job, t, { last_error: 'recovered_after_restart' });
      else markUnknown(job, t, 'interrupted_by_restart');
    }
    if (stuck.length) log.warn({ jobs: stuck.map((j) => j.id) }, 'recovered jobs interrupted by a restart');
    return stuck.length;
  }

  async function tick() {
    if (!running) return;
    let r: RunResult = 'idle';
    try {
      current = runOnce();
      r = await current;
    } catch (e) {
      log.error({ err: e }, 'worker tick failed');
    } finally {
      current = null;
    }
    if (!running) return;
    const delay = r === 'progress' ? 0 : r === 'sent' ? Math.max(50, nextSendAt - now()) : r === 'paused' ? 5000 : 1000;
    timer = setTimeout(tick, delay);
  }

  return {
    runOnce,
    recoverOnBoot,
    lastTickAt: () => lastTickAt,
    start() {
      if (running) return;
      running = true;
      timer = setTimeout(tick, 0);
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await current?.catch(() => undefined);
    },
  };
}

export type Worker = ReturnType<typeof createWorker>;
