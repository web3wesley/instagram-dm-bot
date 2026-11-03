/**
 * All SQL lives here. node:sqlite cannot bind `undefined` or booleans, so every value goes
 * through `v()` first, and named parameters must match the statement exactly.
 */
import type { StatementSync } from 'node:sqlite';
import { tx, type Db } from './db.ts';

type Bindable = string | number | bigint | null | Uint8Array;
const v = (x: unknown): Bindable => {
  if (x === undefined || x === null) return null;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'string' || typeof x === 'number' || typeof x === 'bigint' || x instanceof Uint8Array) return x;
  return JSON.stringify(x);
};

export type LeadState =
  | 'queued'
  | 'dm_sent'
  | 'dm_unknown'
  | 'dm_failed'
  | 'expired'
  | 'skipped'
  | 'opted_out'
  | 'replied'
  | 'link_sent'
  | 'link_unknown'
  | 'link_failed'
  | 'window_expired';
export type JobKind = 'private_reply' | 'link' | 'public_reply';
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'unknown' | 'expired' | 'cancelled';

export interface MediaRow {
  media_id: string;
  shortcode: string | null;
  permalink: string | null;
  product_type: string | null;
  posted_at: number | null;
  comments_count: number | null;
  poll_hwm: number | null;
  last_polled_at: number | null;
  last_swept_at: number | null;
  updated_at: number;
}

export interface CommentRow {
  comment_id: string;
  media_id: string;
  ad_id: string | null;
  parent_id: string | null;
  from_id: string | null;
  username: string | null;
  text: string;
  commented_at: number;
  ts_exact: number;
  via: 'webhook' | 'poller';
  webhook_at: number | null;
  poller_at: number | null;
  decision: string;
  matched: string | null;
  created_at: number;
}

export interface LeadRow {
  id: number;
  comment_id: string;
  media_id: string;
  commenter_id: string;
  username: string | null;
  igsid: string | null;
  keyword: string;
  link_snapshot: string;
  comment_text: string | null;
  state: LeadState;
  reason: string | null;
  commented_at: number;
  dm_sent_at: number | null;
  dm_mid: string | null;
  replied_at: number | null;
  reply_text: string | null;
  link_sent_at: number | null;
  link_mid: string | null;
  public_state: string | null;
  public_reply_id: string | null;
  notion_page_id: string | null;
  notion_dirty: number;
  notion_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: number;
  lead_id: number;
  kind: JobKind;
  state: JobState;
  priority: number;
  run_after: number;
  deadline: number;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface AttemptInput {
  job_id: number | null;
  lead_id: number | null;
  kind: JobKind;
  at: number;
  dry_run: boolean;
  request: unknown;
  ok: boolean;
  http_status?: number | undefined;
  error_class?: string | undefined;
  error?: unknown;
  response?: unknown;
  duration_ms?: number | undefined;
}

type LeadPatch = Partial<Omit<LeadRow, 'id' | 'created_at'>>;
type JobPatch = Partial<Pick<JobRow, 'state' | 'run_after' | 'attempts' | 'last_error'>>;

const LEAD_COLUMNS = new Set<string>([
  'igsid', 'username', 'state', 'reason', 'dm_sent_at', 'dm_mid', 'replied_at', 'reply_text',
  'link_sent_at', 'link_mid', 'public_state', 'public_reply_id', 'notion_page_id', 'notion_dirty',
  'notion_error', 'link_snapshot', 'keyword',
]);

/** Leads that no longer hold the (commenter, media) slot. */
const INACTIVE_LEAD_STATES = `('dm_failed', 'expired', 'skipped')`;

export function createRepo(db: Db) {
  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const get = <T>(sql: string, ...params: Bindable[]) => stmt(sql).get(...params) as T | undefined;
  const all = <T>(sql: string, ...params: Bindable[]) => stmt(sql).all(...params) as T[];
  const run = (sql: string, ...params: Bindable[]) => stmt(sql).run(...params);

  const repo = {
    db,
    tx: <T>(fn: () => T): T => tx(db, fn),

    // ── kv ──────────────────────────────────────────────────────────────
    kvGet(key: string): string | undefined {
      return get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value;
    },
    kvSet(key: string, value: string | number, now = Date.now()): void {
      run(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        String(value),
        now,
      );
    },
    kvDel(key: string): void {
      run('DELETE FROM kv WHERE key = ?', key);
    },
    kvGetJson<T>(key: string): T | undefined {
      const raw = repo.kvGet(key);
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    kvSetJson(key: string, value: unknown, now = Date.now()): void {
      repo.kvSet(key, JSON.stringify(value), now);
    },
    kvNum(key: string): number {
      const n = Number(repo.kvGet(key) ?? 0);
      return Number.isFinite(n) ? n : 0;
    },
    kvDelPrefixOlderThan(prefix: string, before: number): void {
      run('DELETE FROM kv WHERE key LIKE ? AND updated_at < ?', `${prefix}%`, before);
    },

    // ── media ───────────────────────────────────────────────────────────
    upsertMedia(m: {
      media_id: string;
      shortcode?: string | undefined;
      permalink?: string | undefined;
      product_type?: string | undefined;
      posted_at?: number | undefined;
      comments_count?: number | undefined;
    }, now: number): void {
      run(
        `INSERT INTO media (media_id, shortcode, permalink, product_type, posted_at, comments_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(media_id) DO UPDATE SET
           shortcode = COALESCE(excluded.shortcode, media.shortcode),
           permalink = COALESCE(excluded.permalink, media.permalink),
           product_type = COALESCE(excluded.product_type, media.product_type),
           posted_at = COALESCE(excluded.posted_at, media.posted_at),
           comments_count = COALESCE(excluded.comments_count, media.comments_count),
           updated_at = excluded.updated_at`,
        m.media_id,
        v(m.shortcode),
        v(m.permalink),
        v(m.product_type),
        v(m.posted_at),
        v(m.comments_count),
        now,
      );
    },
    getMedia(id: string): MediaRow | undefined {
      return get<MediaRow>('SELECT * FROM media WHERE media_id = ?', id);
    },
    allMedia(): MediaRow[] {
      return all<MediaRow>('SELECT * FROM media ORDER BY posted_at DESC');
    },
    setMediaPolled(id: string, hwm: number | null, now: number, commentsCount?: number): void {
      run(
        `UPDATE media SET poll_hwm = MAX(COALESCE(poll_hwm, 0), COALESCE(?, 0)), last_polled_at = ?,
           comments_count = COALESCE(?, comments_count), updated_at = ? WHERE media_id = ?`,
        v(hwm),
        now,
        v(commentsCount),
        now,
        id,
      );
    },
    setMediaSwept(id: string, now: number): void {
      run('UPDATE media SET last_swept_at = ?, updated_at = ? WHERE media_id = ?', now, now, id);
    },

    // ── comments ────────────────────────────────────────────────────────
    getComment(id: string): CommentRow | undefined {
      return get<CommentRow>('SELECT * FROM comments WHERE comment_id = ?', id);
    },
    insertComment(c: Omit<CommentRow, 'webhook_at' | 'poller_at'>): void {
      run(
        `INSERT INTO comments (comment_id, media_id, ad_id, parent_id, from_id, username, text, commented_at,
           ts_exact, via, webhook_at, poller_at, decision, matched, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.comment_id,
        c.media_id,
        v(c.ad_id),
        v(c.parent_id),
        v(c.from_id),
        v(c.username),
        c.text,
        c.commented_at,
        c.ts_exact,
        c.via,
        c.via === 'webhook' ? c.created_at : null,
        c.via === 'poller' ? c.created_at : null,
        c.decision,
        v(c.matched),
        c.created_at,
      );
    },
    /** Records that another source saw the comment; upgrades an estimated timestamp to an exact one. */
    markCommentSeen(id: string, via: 'webhook' | 'poller', now: number, exactAt?: number): void {
      const col = via === 'webhook' ? 'webhook_at' : 'poller_at';
      run(`UPDATE comments SET ${col} = COALESCE(${col}, ?) WHERE comment_id = ?`, now, id);
      if (exactAt !== undefined) {
        run('UPDATE comments SET commented_at = ?, ts_exact = 1 WHERE comment_id = ? AND ts_exact = 0', exactAt, id);
      }
    },
    updateCommentDecision(id: string, decision: string, matched: string | null): void {
      run('UPDATE comments SET decision = ?, matched = ? WHERE comment_id = ?', decision, matched, id);
    },
    commentDecisionsSince(since: number): Array<{ decision: string; n: number }> {
      return all('SELECT decision, COUNT(*) AS n FROM comments WHERE created_at >= ? GROUP BY decision', since);
    },
    /** Comments the poller found that the webhook never delivered (> 10 min late). */
    missedByWebhookSince(since: number): number {
      return (
        get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM comments WHERE created_at >= ? AND via = 'poller' AND webhook_at IS NULL
             AND created_at - commented_at > 600000`,
          since,
        )?.n ?? 0
      );
    },

    // ── leads ───────────────────────────────────────────────────────────
    insertLead(l: {
      comment_id: string;
      media_id: string;
      commenter_id: string;
      username: string | undefined;
      keyword: string;
      link_snapshot: string;
      comment_text: string;
      commented_at: number;
    }, now: number): number {
      const r = run(
        `INSERT INTO leads (comment_id, media_id, commenter_id, username, keyword, link_snapshot, comment_text,
           state, commented_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        l.comment_id,
        l.media_id,
        l.commenter_id,
        v(l.username),
        l.keyword,
        l.link_snapshot,
        l.comment_text.slice(0, 500),
        l.commented_at,
        now,
        now,
      );
      return Number(r.lastInsertRowid);
    },
    getLead(id: number): LeadRow | undefined {
      return get<LeadRow>('SELECT * FROM leads WHERE id = ?', id);
    },
    hasActiveLead(commenterId: string, mediaId: string): boolean {
      return !!get(
        `SELECT 1 FROM leads WHERE commenter_id = ? AND media_id = ? AND state NOT IN ${INACTIVE_LEAD_STATES} LIMIT 1`,
        commenterId,
        mediaId,
      );
    },
    /**
     * Leads waiting for this person's reply. A message only counts if it came after the intro
     * went out (5 s clock slack), so a DM sent before the intro can't release the link early.
     */
    openLeadsForSender(senderId: string, messageAt: number): LeadRow[] {
      return all<LeadRow>(
        `SELECT * FROM leads WHERE state IN ('dm_sent', 'dm_unknown') AND (igsid = ? OR commenter_id = ?)
           AND COALESCE(dm_sent_at, created_at) <= ? ORDER BY id`,
        senderId,
        senderId,
        messageAt + 5000,
      );
    },
    leadsForSender(senderId: string, states: readonly LeadState[]): LeadRow[] {
      const placeholders = states.map(() => '?').join(', ');
      return all<LeadRow>(
        `SELECT * FROM leads WHERE (igsid = ? OR commenter_id = ?) AND state IN (${placeholders})`,
        senderId,
        senderId,
        ...states,
      );
    },
    /** Updates whitelisted columns, bumps updated_at and marks the row for the Notion mirror. */
    patchLead(id: number, patch: LeadPatch, now: number): void {
      const keys = Object.keys(patch).filter((k) => LEAD_COLUMNS.has(k));
      const sets = keys.map((k) => `${k} = ?`);
      const markDirty = !('notion_dirty' in patch);
      run(
        `UPDATE leads SET ${[...sets, 'updated_at = ?', ...(markDirty ? ['notion_dirty = 1'] : [])].join(', ')} WHERE id = ?`,
        ...keys.map((k) => v(patch[k as keyof LeadPatch])),
        now,
        id,
      );
    },
    /** Compare-and-set on state: returns false when another event already moved the lead. */
    casLeadState(id: number, from: readonly LeadState[], to: LeadState, patch: LeadPatch, now: number): boolean {
      const keys = Object.keys(patch).filter((k) => LEAD_COLUMNS.has(k) && k !== 'state');
      const sets = ['state = ?', ...keys.map((k) => `${k} = ?`), 'updated_at = ?', 'notion_dirty = 1'];
      const r = run(
        `UPDATE leads SET ${sets.join(', ')} WHERE id = ? AND state IN (${from.map(() => '?').join(', ')})`,
        to,
        ...keys.map((k) => v(patch[k as keyof LeadPatch])),
        now,
        id,
        ...from,
      );
      return Number(r.changes) > 0;
    },
    linkSentRecently(igsid: string, link: string, since: number, exceptLeadId: number): boolean {
      return !!get(
        `SELECT 1 FROM leads WHERE (igsid = ? OR commenter_id = ?) AND link_snapshot = ? AND state = 'link_sent'
           AND link_sent_at >= ? AND id != ? LIMIT 1`,
        igsid,
        igsid,
        link,
        since,
        exceptLeadId,
      );
    },
    recentLeads(limit: number): Array<LeadRow & { permalink: string | null }> {
      return all(
        `SELECT leads.*, media.permalink FROM leads LEFT JOIN media ON media.media_id = leads.media_id
         ORDER BY leads.id DESC LIMIT ?`,
        limit,
      );
    },
    allLeadsForExport(): Array<LeadRow & { permalink: string | null }> {
      return all(
        `SELECT leads.*, media.permalink FROM leads LEFT JOIN media ON media.media_id = leads.media_id ORDER BY leads.id`,
      );
    },
    dirtyLeads(limit: number): Array<LeadRow & { permalink: string | null }> {
      return all(
        `SELECT leads.*, media.permalink FROM leads LEFT JOIN media ON media.media_id = leads.media_id
         WHERE notion_dirty = 1 ORDER BY leads.updated_at LIMIT ?`,
        limit,
      );
    },
    notionBacklog(): number {
      return get<{ n: number }>('SELECT COUNT(*) AS n FROM leads WHERE notion_dirty = 1')?.n ?? 0;
    },
    markNotionSynced(id: number, pageId: string, expectUpdatedAt: number): void {
      // Only clear the flag if the lead didn't change while the request was in flight.
      run(
        `UPDATE leads SET notion_page_id = ?, notion_error = NULL,
           notion_dirty = CASE WHEN updated_at = ? THEN 0 ELSE notion_dirty END WHERE id = ?`,
        pageId,
        expectUpdatedAt,
        id,
      );
    },
    markNotionError(id: number, error: string): void {
      run('UPDATE leads SET notion_error = ? WHERE id = ?', error.slice(0, 500), id);
    },

    // ── jobs ────────────────────────────────────────────────────────────
    insertJob(j: { lead_id: number; kind: JobKind; priority: number; run_after: number; deadline: number }, now: number): boolean {
      const r = run(
        `INSERT OR IGNORE INTO jobs (lead_id, kind, state, priority, run_after, deadline, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
        j.lead_id,
        j.kind,
        j.priority,
        j.run_after,
        j.deadline,
        now,
        now,
      );
      return Number(r.changes) > 0;
    },
    getJob(id: number): JobRow | undefined {
      return get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
    },
    jobFor(leadId: number, kind: JobKind): JobRow | undefined {
      return get<JobRow>('SELECT * FROM jobs WHERE lead_id = ? AND kind = ?', leadId, kind);
    },
    readyJobs(now: number, limit: number): JobRow[] {
      return all<JobRow>(
        `SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? ORDER BY priority, run_after, id LIMIT ?`,
        now,
        limit,
      );
    },
    jobsInState(state: JobState): JobRow[] {
      return all<JobRow>('SELECT * FROM jobs WHERE state = ?', state);
    },
    patchJob(id: number, patch: JobPatch, now: number): void {
      const keys = Object.keys(patch) as Array<keyof JobPatch>;
      run(
        `UPDATE jobs SET ${[...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`,
        ...keys.map((k) => v(patch[k])),
        now,
        id,
      );
    },
    cancelOpenJobs(leadId: number, now: number): void {
      run(`UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE lead_id = ? AND state IN ('queued', 'running')`, now, leadId);
    },
    queueStats(now: number): { queued: number; oldestQueuedAt: number | null; unknown: number; due: number } {
      const q = get<{ n: number; oldest: number | null; due: number }>(
        `SELECT COUNT(*) AS n, MIN(created_at) AS oldest, SUM(CASE WHEN run_after <= ? THEN 1 ELSE 0 END) AS due
         FROM jobs WHERE state = 'queued'`,
        now,
      );
      const u = get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'unknown'`);
      return { queued: q?.n ?? 0, oldestQueuedAt: q?.oldest ?? null, unknown: u?.n ?? 0, due: q?.due ?? 0 };
    },

    // ── send attempts / rate limiting ───────────────────────────────────
    insertAttempt(a: AttemptInput): void {
      run(
        `INSERT INTO send_attempts (job_id, lead_id, kind, at, dry_run, request, ok, http_status, error_class, error,
           response, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        v(a.job_id),
        v(a.lead_id),
        a.kind,
        a.at,
        v(a.dry_run),
        JSON.stringify(a.request),
        v(a.ok),
        v(a.http_status),
        v(a.error_class),
        a.error === undefined ? null : JSON.stringify(a.error),
        a.response === undefined ? null : JSON.stringify(a.response),
        v(a.duration_ms),
      );
    },
    countAttempts(kinds: readonly JobKind[], since: number): number {
      return (
        get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM send_attempts WHERE at > ? AND kind IN (${kinds.map(() => '?').join(', ')})`,
          since,
          ...kinds,
        )?.n ?? 0
      );
    },
    /** Timestamp of the attempt at `offset` (0-based, oldest first) within the window. */
    attemptAtOffset(kinds: readonly JobKind[], since: number, offset: number): number | undefined {
      return get<{ at: number }>(
        `SELECT at FROM send_attempts WHERE at > ? AND kind IN (${kinds.map(() => '?').join(', ')})
         ORDER BY at LIMIT 1 OFFSET ?`,
        since,
        ...kinds,
        offset,
      )?.at;
    },
    /**
     * `gone` = public replies that had nothing to reply under because the comment was deleted after
     * the DM went out. That is not a fault of ours, so it is counted separately and kept out of the
     * failure rate. An intro that hits the same error still counts as a failure: no DM was delivered.
     */
    attemptStatsSince(since: number): Array<{ kind: JobKind; ok: number; n: number; gone: number }> {
      return all(
        `SELECT kind, ok, COUNT(*) AS n,
           SUM(CASE WHEN kind = 'public_reply' AND error_class = 'comment_gone' THEN 1 ELSE 0 END) AS gone
         FROM send_attempts WHERE at >= ? GROUP BY kind, ok`,
        since,
      );
    },
    failureRateSince(since: number): { total: number; failed: number } {
      const r = get<{ total: number; failed: number }>(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN ok = 0 AND NOT (kind = 'public_reply' AND COALESCE(error_class, '') = 'comment_gone')
               THEN 1 ELSE 0 END) AS failed
         FROM send_attempts WHERE at >= ?`,
        since,
      );
      return { total: r?.total ?? 0, failed: r?.failed ?? 0 };
    },

    // ── suppressions (STOP) ─────────────────────────────────────────────
    isSuppressed(subjects: readonly string[]): boolean {
      const s = subjects.filter(Boolean);
      if (s.length === 0) return false;
      return !!get(`SELECT 1 FROM suppressions WHERE subject IN (${s.map(() => '?').join(', ')}) LIMIT 1`, ...s);
    },
    addSuppression(subject: string, username: string | null, reason: string, now: number): void {
      run(
        `INSERT INTO suppressions (subject, username, reason, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(subject) DO NOTHING`,
        subject,
        v(username),
        reason,
        now,
      );
    },
    removeSuppression(subjects: readonly string[]): number {
      const s = subjects.filter(Boolean);
      if (s.length === 0) return 0;
      return Number(run(`DELETE FROM suppressions WHERE subject IN (${s.map(() => '?').join(', ')})`, ...s).changes);
    },
    suppressionCount(): number {
      return get<{ n: number }>('SELECT COUNT(*) AS n FROM suppressions')?.n ?? 0;
    },

    // ── reporting ───────────────────────────────────────────────────────
    funnel(since: number): Array<{
      keyword: string;
      media_id: string;
      permalink: string | null;
      matched: number;
      dm_sent: number;
      replied: number;
      link_sent: number;
      failed: number;
    }> {
      return all(
        `SELECT keyword, leads.media_id, media.permalink,
           COUNT(*) AS matched,
           SUM(CASE WHEN dm_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS dm_sent,
           SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
           SUM(CASE WHEN link_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS link_sent,
           SUM(CASE WHEN state IN ('dm_failed', 'link_failed') THEN 1 ELSE 0 END) AS failed
         FROM leads LEFT JOIN media ON media.media_id = leads.media_id
         WHERE leads.created_at >= ? GROUP BY keyword, leads.media_id ORDER BY matched DESC`,
        since,
      );
    },

    // ── privacy / retention ─────────────────────────────────────────────
    /** Deletes everything we hold about one person. Returns Notion page ids to trash. */
    deletePerson(match: { ids: string[]; username?: string | undefined }): { leads: number; comments: number; notionPageIds: string[] } {
      return tx(db, () => {
        const ids = match.ids.filter(Boolean);
        const uname = match.username?.toLowerCase();
        const idList = ids.map(() => '?').join(', ') || "''";
        const leads = all<{ id: number; notion_page_id: string | null }>(
          `SELECT id, notion_page_id FROM leads WHERE igsid IN (${idList}) OR commenter_id IN (${idList})
             ${uname ? 'OR lower(username) = ?' : ''}`,
          ...ids,
          ...ids,
          ...(uname ? [uname] : []),
        );
        for (const l of leads) {
          run('DELETE FROM send_attempts WHERE lead_id = ?', l.id);
          run('DELETE FROM leads WHERE id = ?', l.id); // jobs cascade
        }
        const c = run(
          `DELETE FROM comments WHERE from_id IN (${idList}) ${uname ? 'OR lower(username) = ?' : ''}`,
          ...ids,
          ...(uname ? [uname] : []),
        );
        return {
          leads: leads.length,
          comments: Number(c.changes),
          notionPageIds: leads.map((l) => l.notion_page_id).filter((x): x is string => !!x),
        };
      });
    },
    purge(before: { comments: number; attempts: number; leads: number }): { notionPageIds: string[] } {
      return tx(db, () => {
        run(`DELETE FROM comments WHERE created_at < ? AND decision != 'lead'`, before.comments);
        run('DELETE FROM send_attempts WHERE at < ?', before.attempts);
        const old = all<{ id: number; comment_id: string; notion_page_id: string | null }>(
          'SELECT id, comment_id, notion_page_id FROM leads WHERE created_at < ?',
          before.leads,
        );
        for (const l of old) {
          run('DELETE FROM send_attempts WHERE lead_id = ?', l.id);
          run('DELETE FROM leads WHERE id = ?', l.id);
          run('DELETE FROM comments WHERE comment_id = ?', l.comment_id);
        }
        return { notionPageIds: old.map((l) => l.notion_page_id).filter((x): x is string => !!x) };
      });
    },
  };
  return repo;
}

export type Repo = ReturnType<typeof createRepo>;
