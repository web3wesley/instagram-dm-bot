/**
 * Plain-language status report for the running bot (no usernames, only counts).
 *
 *   npm run status                              # since go-live (BACKFILL_SINCE), else the last 24 h
 *   npm run status -- --since 2026-10-13T03:36:00Z
 *   npm run status -- --hours 6
 */
import { parseArgs } from 'node:util';
import { parseCsv } from '../src/lib/csv.ts';
import { adminFetch, botUrl } from './lib.ts';

const { values } = parseArgs({ options: { since: { type: 'string' }, hours: { type: 'string' } } });
const now = Date.now();
const HOUR = 3_600_000;
const since = values.hours
  ? now - Number(values.hours) * HOUR
  : Date.parse(values.since ?? process.env.BACKFILL_SINCE ?? '') || now - 24 * HOUR;

interface Health {
  status: string;
  reasons: string[];
  uptime_s: number;
  mode: { dry_run: boolean; allowlist: string[]; public_replies: boolean; paused: boolean; poll_profile: string };
  token: { state: string; days_left: number | null; last_error: string | null };
  webhooks: { last_comment_at: string | null; last_received_at: string | null; sig_failures_24h: number };
  poller: { missed_by_webhook_24h: number; last_error: string | null } | null;
  queue: { queued: number; unknown: number; throttled_until: string | null; public_replies_blocked_until: string | null };
  today: { comments: number; public_replies: number; failed: number; comment_deleted?: number };
  rate_limits: { dm: { used: number; cap: number }; public: { used: number; cap: number }; meta_private_replies: { used: number; limit: number } };
  notion: { enabled: boolean; backlog?: number; last_error?: string | null };
  triggers: { keywords: string[] };
}

const h = (await (await adminFetch('/health')).json()) as Health;
const [header = [], ...data] = parseCsv(await (await adminFetch('/admin/leads.csv')).text());
const col = (name: string) => header.indexOf(name);
const leads = data
  .filter((r) => r.length === header.length)
  .map((r) => ({
    created: Date.parse(r[col('created')] ?? ''),
    keyword: r[col('keyword')] ?? '',
    state: r[col('state')] ?? '',
    reason: (r[col('reason')] ?? '').replace(/^'/, ''),
    intro: !!r[col('dm_sent')],
    replied: !!r[col('replied')],
    link: !!r[col('link_sent')],
  }))
  .filter((l) => l.created >= since);

const count = (pred: (l: (typeof leads)[number]) => boolean) => leads.filter(pred).length;
const FAILED = new Set(['dm_failed', 'link_failed']);
const UNCONFIRMED = new Set(['dm_unknown', 'link_unknown']);
const DROPPED = new Set(['expired', 'window_expired', 'skipped', 'opted_out']);
const intros = count((l) => l.intro);
const replies = count((l) => l.replied);
const links = count((l) => l.link);
const failed = count((l) => FAILED.has(l.state));
const unconfirmed = count((l) => UNCONFIRMED.has(l.state));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
const jst = (ms: number) => new Date(ms + 9 * HOUR).toISOString().slice(0, 16).replace('T', ' ');
const ago = (iso: string | null) => (iso ? `${Math.round((now - Date.parse(iso)) / 60_000)} min ago` : 'never');

const out: string[] = [];
out.push(`IG DM BOT STATUS  ${jst(now)} JST  (${botUrl()})`);
out.push(`Overall: ${h.status.toUpperCase()}${h.reasons.length ? ` (${h.reasons.join(', ')})` : ''}`);
out.push(
  `Mode: ${h.mode.dry_run ? 'DRY RUN (not sending)' : 'LIVE'}${h.mode.allowlist.length ? `, allowlist ${h.mode.allowlist.join(', ')}` : ', everyone'}${h.mode.paused ? ', PAUSED' : ''}; keywords ${h.triggers.keywords.join(', ') || 'none'}`,
);
out.push(`Window: since ${jst(since)} JST (${((now - since) / HOUR).toFixed(1)} h)`);
out.push('');
out.push(`Keyword comments:  ${leads.length}`);
out.push(`Intro DMs sent:    ${intros}`);
out.push(`Replies:           ${replies}  (${pct(replies, intros)} of intros)`);
out.push(`Links sent:        ${links}  (${pct(links, replies)} of replies)`);
out.push(`Waiting to send:   ${count((l) => l.state === 'queued')}`);
out.push(`Failed:            ${failed}`);
out.push(`Unconfirmed:       ${unconfirmed}`);
out.push(`Expired/skipped/opted out: ${count((l) => DROPPED.has(l.state))}`);
out.push('');
out.push('By keyword:');
const keywords = [...new Set(leads.map((l) => l.keyword))].sort();
if (!keywords.length) out.push('  (no keyword comments in this window)');
for (const k of keywords) {
  const ks = leads.filter((l) => l.keyword === k);
  out.push(
    `  ${k.padEnd(8)} ${ks.length} comments, ${ks.filter((l) => l.intro).length} intros, ${ks.filter((l) => l.replied).length} replies, ${ks.filter((l) => l.link).length} links`,
  );
}
out.push('');
const reasons = new Map<string, number>();
for (const l of leads) {
  if (FAILED.has(l.state) || UNCONFIRMED.has(l.state)) {
    const key = `${l.state}: ${l.reason || 'no reason recorded'}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
}
out.push(`Problems: ${reasons.size ? '' : 'none'}`);
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) out.push(`  ${n} x ${r}`);
out.push('');
out.push('Health:');
out.push(
  `  Sending: ${h.queue.throttled_until ? `THROTTLED until ${h.queue.throttled_until}` : 'not throttled'}; DMs this hour ${h.rate_limits.dm.used}/${h.rate_limits.dm.cap} (Meta private-reply limit ${h.rate_limits.meta_private_replies.used}/${h.rate_limits.meta_private_replies.limit})`,
);
out.push(
  `  Public replies: ${h.mode.public_replies ? 'on' : 'off'}, ${h.today.public_replies} today${h.today.comment_deleted ? ` (${h.today.comment_deleted} skipped: the person deleted their comment after the DM)` : ''}, ${h.rate_limits.public.used}/${h.rate_limits.public.cap} this hour${h.queue.public_replies_blocked_until ? `, BLOCKED until ${h.queue.public_replies_blocked_until}` : ''}`,
);
out.push(`  Failed send attempts today (all kinds, retries included): ${h.today.failed}`);
out.push(
  `  Webhooks: last comment webhook ${ago(h.webhooks.last_comment_at)}; missed by webhook (24 h) ${h.poller?.missed_by_webhook_24h ?? 'n/a'}; signature failures (24 h) ${h.webhooks.sig_failures_24h}`,
);
out.push(`  Token: ${h.token.state}${h.token.days_left === null ? '' : `, ${h.token.days_left} days left`}${h.token.last_error ? `, last error: ${h.token.last_error}` : ''}`);
out.push(`  Notion: ${h.notion.enabled ? `on, ${h.notion.backlog ?? 0} waiting${h.notion.last_error ? `, last error: ${h.notion.last_error}` : ''}` : 'off'}`);
out.push(`  Uptime: ${(h.uptime_s / 3600).toFixed(1)} h; comments seen today: ${h.today.comments}`);
out.push('');

const attention: string[] = [];
if (h.status !== 'ok') attention.push(`bot status is ${h.status} (${h.reasons.join(', ')})`);
if (failed) attention.push(`${failed} failed send(s)`);
if (unconfirmed) attention.push(`${unconfirmed} unconfirmed send(s)`);
if (h.queue.public_replies_blocked_until) attention.push('public replies blocked by Instagram');
if (h.notion.enabled && h.notion.last_error) attention.push('Notion sync error');
if (h.mode.dry_run) attention.push('bot is in DRY RUN, not sending');
out.push(`VERDICT: ${attention.length ? `NEEDS ATTENTION: ${attention.join('; ')}` : 'ALL GOOD'}`);
console.log(out.join('\n'));
