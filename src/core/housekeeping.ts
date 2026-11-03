/**
 * Periodic chores: token refresh/validation (+ expiry alerts), retention purge and a daily
 * SQLite backup to DATA_DIR/backups (7 kept).
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import type { Alert, Ctx } from './context.ts';
import type { Mirror } from './events.ts';
import { DAY, HOUR } from './rules.ts';
import type { Tokens } from './token.ts';

const COMMENT_RETENTION = 14 * DAY;
const ATTEMPT_RETENTION = 90 * DAY;
const BACKUPS_KEPT = 7;

export function createHousekeeping(d: { ctx: Ctx; tokens: Tokens; mirror?: Mirror | undefined; alert: Alert }) {
  const { ctx, tokens } = d;
  const { repo, env, log } = ctx;
  let lastValidate = 0;
  let lastDaily = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function hourly(): Promise<void> {
    const now = ctx.clock.now();
    await tokens.maybeRefresh();
    if (now - lastValidate >= 6 * HOUR) {
      await tokens.validate();
      lastValidate = now;
    }
    const s = tokens.status();
    if (s.state === 'ok' && s.daysLeft !== null && s.daysLeft < 7) {
      d.alert('token_expiring', `Instagram token expires in ${s.daysLeft} days and refresh is failing — reconnect at /auth/login.`);
    }
    repo.kvDelPrefixOlderThan('oauth_state:', now - HOUR);
    if (now - lastDaily >= DAY) {
      lastDaily = now;
      await daily(now);
    }
  }

  async function daily(now: number): Promise<void> {
    const purged = repo.purge({
      comments: now - COMMENT_RETENTION,
      attempts: now - ATTEMPT_RETENTION,
      leads: now - env.LEAD_RETENTION_DAYS * DAY,
    });
    if (purged.notionPageIds.length && d.mirror) {
      await d.mirror.trash(purged.notionPageIds).catch((e: unknown) => log.warn({ err: e }, 'could not trash expired Notion rows'));
    }
    await backupDb(now);
  }

  async function backupDb(now: number): Promise<void> {
    if (env.dbFile === ':memory:') return;
    try {
      const dir = join(env.DATA_DIR, 'backups');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date(now).toISOString().slice(0, 10);
      const target = join(dir, `${env.mode}-${stamp}.sqlite`);
      await backup(repo.db, target);
      const files = readdirSync(dir).filter((f) => f.startsWith(`${env.mode}-`) && f.endsWith('.sqlite')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - BACKUPS_KEPT))) rmSync(join(dir, old));
      log.info({ target }, 'daily backup written');
    } catch (e) {
      log.error({ err: e }, 'daily backup failed');
    }
  }

  return {
    hourly,
    start() {
      if (running) return;
      running = true;
      const loop = async () => {
        if (!running) return;
        await hourly().catch((e: unknown) => log.error({ err: e }, 'housekeeping failed'));
        if (running) timer = setTimeout(loop, HOUR);
      };
      // First pass shortly after boot so a stale token is noticed quickly.
      timer = setTimeout(loop, 60_000);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}
