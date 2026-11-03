/**
 * Admin endpoints (Bearer or Basic auth with ADMIN_TOKEN). There is deliberately no
 * "send a DM" endpoint: the only send paths are the intro to a keyword comment and the link
 * to someone who replied.
 */
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.ts';
import { suppressionSubjects } from '../core/ingest.ts';
import { DAY, HOUR, normalizeUsername } from '../core/rules.ts';
import { buildHealth } from '../core/status.ts';
import { toCsv } from '../lib/csv.ts';
import { esc, page } from '../lib/html.ts';
import { isoInTz } from '../lib/time.ts';
import { SUBSCRIBED_FIELDS } from '../meta/types.ts';
import { adminGuard } from './guard.ts';

export async function adminRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { env, ctx, meta, events } = deps;
  const { repo } = ctx;
  const tz = env.REPORT_TZ;
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/admin')) return adminGuard(env.ADMIN_TOKEN)(req, reply);
  });

  const health = () =>
    buildHealth({
      ctx,
      tokens: deps.tokens,
      limiter: deps.limiter,
      worker: deps.worker,
      poller: deps.poller,
      mirror: deps.mirror,
      startedAt: deps.startedAt,
      version: deps.version,
    });

  app.get('/admin', async (_req, reply) => {
    const h = health();
    const leads = repo.recentLeads(50);
    const rows = leads
      .map(
        (l) => `<tr><td>${esc(isoInTz(l.created_at, tz)?.slice(5, 16).replace('T', ' '))}</td>
<td>@${esc(l.username ?? '?')}</td><td>${esc(l.keyword)}</td><td>${esc(l.state)}${l.reason ? `<br><span class="muted">${esc(l.reason)}</span>` : ''}</td>
<td>${l.permalink ? `<a href="${esc(l.permalink)}">reel</a>` : esc(l.media_id)}</td><td>${esc((l.comment_text ?? '').slice(0, 80))}</td></tr>`,
      )
      .join('');
    return reply.type('text/html').send(
      page(
        'Admin — IG DM Bot',
        `<h1>IG DM Bot <span class="${h.status}">● ${esc(h.status)}</span></h1>
<p class="muted">${esc(h.reasons.join(', ') || 'all good')} · ${h.mode.dry_run ? 'DRY RUN' : 'LIVE'}${h.mode.allowlist.length ? ` · allowlist: ${esc(h.mode.allowlist.join(', '))}` : ''}${h.mode.paused ? ' · PAUSED' : ''}</p>
<div class="card">Today (${esc(tz)}): <strong>${h.today.matched}</strong> matched ·
<strong>${h.today.intros}</strong> intros · <strong>${h.today.links}</strong> links · ${h.today.public_replies} public replies · ${h.today.failed} failed${h.today.comment_deleted ? ` · ${h.today.comment_deleted} comment deleted` : ''}<br>
7 days: ${h.funnel_7d.matched} matched → ${h.funnel_7d.dm_sent} DM'd → ${h.funnel_7d.replied} replied → ${h.funnel_7d.link_sent} links
${h.funnel_7d.reply_rate === null ? '' : `(${Math.round(h.funnel_7d.reply_rate * 100)}% reply rate)`}<br>
Token: ${esc(h.token.state)}${h.token.days_left === null ? '' : `, ${h.token.days_left} days left`} · Queue: ${h.queue.queued} ·
DM cap: ${h.rate_limits.dm.used}/${h.rate_limits.dm.cap} per hour</div>
<p><a href="/health">health JSON</a> · <a href="/admin/leads.csv">leads.csv</a> · <a href="/admin/stats">stats JSON</a></p>
<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Keyword</th><th>State</th><th>Post</th><th>Comment</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">No leads yet.</td></tr>'}</tbody></table></div>`,
      ),
    );
  });

  app.get('/admin/stats', async () => {
    const now = ctx.clock.now();
    return { health: health(), funnel_30d: repo.funnel(now - 30 * DAY), funnel_all: repo.funnel(0) };
  });

  app.get('/admin/leads.csv', async (_req, reply) => {
    const t = (ms: number | null) => isoInTz(ms, tz) ?? '';
    const rows = repo.allLeadsForExport().map((l) => [
      l.id,
      t(l.created_at),
      l.username ?? '',
      l.keyword,
      l.state,
      l.reason ?? '',
      l.permalink ?? l.media_id,
      t(l.commented_at),
      t(l.dm_sent_at),
      t(l.replied_at),
      t(l.link_sent_at),
      l.comment_text ?? '',
      l.reply_text ?? '',
    ]);
    const header = ['id', 'created', 'username', 'keyword', 'state', 'reason', 'post', 'commented', 'dm_sent', 'replied', 'link_sent', 'comment', 'reply'];
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="ig-leads-${env.mode}.csv"`)
      .send(`﻿${toCsv(header, rows)}`);
  });

  app.post('/admin/pause', async () => {
    repo.kvSet('paused', '1', ctx.clock.now());
    return { paused: true };
  });

  app.post('/admin/resume', async () => {
    repo.kvDel('paused');
    return { paused: false };
  });

  /** Re-scan comments (e.g. after adding a keyword to a reel that was already live). Max 7 days back. */
  app.post('/admin/rescan', async (req, reply) => {
    if (!deps.poller) return reply.code(503).send({ error: 'poller not running' });
    const body = (req.body ?? {}) as { since?: string; hours?: number };
    const now = ctx.clock.now();
    const since = body.since ? Date.parse(body.since) : now - (body.hours ?? 24) * HOUR;
    if (Number.isNaN(since)) return reply.code(400).send({ error: 'since must be an ISO date' });
    return deps.poller.rescan(Math.max(since, now - 7 * DAY));
  });

  app.post('/admin/delete-user', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; igsid?: string };
    if (!body.username && !body.igsid) return reply.code(400).send({ error: 'username or igsid required' });
    return events.deletePerson(body.igsid ? [body.igsid] : [], body.username ? normalizeUsername(body.username) : undefined);
  });

  app.post('/admin/unsuppress', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; igsid?: string };
    if (!body.username && !body.igsid) return reply.code(400).send({ error: 'username or igsid required' });
    return { removed: repo.removeSuppression(suppressionSubjects([body.igsid], body.username)) };
  });

  app.post('/admin/subscribe', async () => {
    const ok = await meta.subscribe(SUBSCRIBED_FIELDS);
    if (ok) repo.kvSetJson('subscribed_fields', [...SUBSCRIBED_FIELDS], ctx.clock.now());
    let current: string[] = [];
    try {
      current = await meta.subscribedFields();
    } catch {
      // informational only
    }
    return { ok, requested: SUBSCRIBED_FIELDS, current };
  });
}
