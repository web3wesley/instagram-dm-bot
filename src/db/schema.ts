/**
 * SQLite schema, applied with PRAGMA user_version. Append new migrations; never edit old ones.
 * STRICT tables keep Instagram IDs (> 2^53) as TEXT instead of silently coercing them.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE media (
    media_id TEXT PRIMARY KEY,
    shortcode TEXT,
    permalink TEXT,
    product_type TEXT,
    posted_at INTEGER,
    comments_count INTEGER,
    poll_hwm INTEGER,
    last_polled_at INTEGER,
    last_swept_at INTEGER,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX media_shortcode ON media(shortcode);

  CREATE TABLE comments (
    comment_id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    ad_id TEXT,
    parent_id TEXT,
    from_id TEXT,
    username TEXT,
    text TEXT NOT NULL,
    commented_at INTEGER NOT NULL,
    ts_exact INTEGER NOT NULL,
    via TEXT NOT NULL CHECK (via IN ('webhook', 'poller')),
    webhook_at INTEGER,
    poller_at INTEGER,
    decision TEXT NOT NULL,
    matched TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX comments_media_ts ON comments(media_id, commented_at);
  CREATE INDEX comments_created ON comments(created_at);
  CREATE INDEX comments_from ON comments(from_id);

  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    comment_id TEXT NOT NULL UNIQUE,
    media_id TEXT NOT NULL,
    commenter_id TEXT NOT NULL,
    username TEXT,
    igsid TEXT,
    keyword TEXT NOT NULL,
    link_snapshot TEXT NOT NULL,
    comment_text TEXT,
    state TEXT NOT NULL CHECK (state IN (
      'queued', 'dm_sent', 'dm_unknown', 'dm_failed', 'expired', 'skipped', 'opted_out',
      'replied', 'link_sent', 'link_unknown', 'link_failed', 'window_expired')),
    reason TEXT,
    commented_at INTEGER NOT NULL,
    dm_sent_at INTEGER,
    dm_mid TEXT,
    replied_at INTEGER,
    reply_text TEXT,
    link_sent_at INTEGER,
    link_mid TEXT,
    public_state TEXT,
    public_reply_id TEXT,
    notion_page_id TEXT,
    notion_dirty INTEGER NOT NULL DEFAULT 1,
    notion_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  -- One DM per person per post; failed/expired/skipped leads don't block a later re-comment.
  CREATE UNIQUE INDEX leads_user_media ON leads(commenter_id, media_id)
    WHERE state NOT IN ('dm_failed', 'expired', 'skipped');
  CREATE INDEX leads_igsid ON leads(igsid);
  CREATE INDEX leads_commenter ON leads(commenter_id);
  CREATE INDEX leads_state ON leads(state);
  CREATE INDEX leads_created ON leads(created_at);
  CREATE INDEX leads_notion_dirty ON leads(updated_at) WHERE notion_dirty = 1;

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('private_reply', 'link', 'public_reply')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'unknown', 'expired', 'cancelled')),
    priority INTEGER NOT NULL,
    run_after INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (lead_id, kind)
  ) STRICT;
  CREATE INDEX jobs_ready ON jobs(state, priority, run_after);

  -- Audit log of every send attempt (exact request + exact Meta response/error). Also the
  -- rate limiter's source of truth, so limits survive restarts.
  CREATE TABLE send_attempts (
    id INTEGER PRIMARY KEY,
    job_id INTEGER,
    lead_id INTEGER,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    dry_run INTEGER NOT NULL,
    request TEXT NOT NULL,
    ok INTEGER NOT NULL,
    http_status INTEGER,
    error_class TEXT,
    error TEXT,
    response TEXT,
    duration_ms INTEGER
  ) STRICT;
  CREATE INDEX send_attempts_kind_at ON send_attempts(kind, at);
  CREATE INDEX send_attempts_lead ON send_attempts(lead_id);

  CREATE TABLE suppressions (
    subject TEXT PRIMARY KEY,
    username TEXT,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  `,
];
