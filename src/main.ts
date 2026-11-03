/**
 * Boot: config → DB → token → HTTP server → background loops (send worker, comment poller,
 * Notion mirror, housekeeping). Graceful shutdown on SIGTERM (Railway redeploys).
 */
import { readFileSync } from 'node:fs';
import { buildApp } from './app.ts';
import { EnvError, loadEnv } from './config/env.ts';
import { TriggerConfigError, loadTriggersFile } from './config/triggers.ts';
import type { Ctx } from './core/context.ts';
import { createEventHandler } from './core/events.ts';
import { createHousekeeping } from './core/housekeeping.ts';
import { createLimiter } from './core/limiter.ts';
import { createPoller } from './core/poller.ts';
import { createTokens } from './core/token.ts';
import { createWorker } from './core/worker.ts';
import { openDb } from './db/db.ts';
import { createRepo } from './db/repo.ts';
import { createAlerter } from './lib/alert.ts';
import { createLogger } from './lib/log.ts';
import { systemClock } from './lib/time.ts';
import { createMetaClient } from './meta/client.ts';
import { withDryRun } from './meta/dryRun.ts';
import { createMirror } from './notion/mirror.ts';

function version(): string {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    return sha ? `${pkg.version}+${sha}` : pkg.version;
  } catch {
    return sha ?? 'unknown';
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);
  const triggers = loadTriggersFile(env.TRIGGERS_PATH);
  const repo = createRepo(openDb(env.dbFile, env.mode));
  const clock = systemClock;
  const startedAt = clock.now();

  // Comments from before go-live never trigger, so launching can't DM historical commenters.
  if (env.backfillSince !== undefined) repo.kvSet('go_live_at', env.backfillSince, startedAt);
  else if (!repo.kvGet('go_live_at')) repo.kvSet('go_live_at', startedAt, startedAt);

  const alert = createAlerter({ url: env.ALERT_WEBHOOK_URL, repo, clock, log });
  const rawMeta = createMetaClient({
    version: env.GRAPH_VERSION,
    getToken: () => tokens.current(),
    getUserId: () => tokens.me()?.userId,
    appId: env.IG_APP_ID,
    appSecret: env.IG_APP_SECRET,
    onUsage: (u) => repo.kvSetJson('meta_usage', { ...u, observed_at: new Date().toISOString() }),
  });
  const meta = env.mode === 'dry_run' ? withDryRun(rawMeta, log) : rawMeta;
  const tokens = createTokens({ repo, meta: rawMeta, env, clock, log, alert });

  const ctx: Ctx = { env, repo, clock, rng: Math.random, log, triggers: () => triggers, me: () => tokens.me() };
  const limiter = createLimiter(repo, { dm: env.DM_HOURLY_CAP, public: env.PUBLIC_REPLY_HOURLY_CAP }, clock);
  const mirror = createMirror({ ctx, token: env.NOTION_TOKEN, dataSourceId: env.NOTION_DATA_SOURCE_ID });
  const events = createEventHandler({ ctx, meta, mirror });
  const worker = createWorker({ ctx, meta, limiter, tokens, alert });
  const poller = createPoller({ ctx, meta, events, tokens });
  const housekeeping = createHousekeeping({ ctx, tokens, mirror, alert });

  const app = await buildApp({
    env,
    ctx,
    meta,
    tokens,
    events,
    limiter,
    worker,
    poller: env.POLL_PROFILE === 'off' ? undefined : poller,
    mirror,
    startedAt,
    version: version(),
    logger: log,
  });

  log.info(
    {
      mode: env.mode,
      allowlist: [...env.allowlist],
      keywords: triggers.triggers.filter((t) => t.enabled).map((t) => t.keyword),
      triggersHash: triggers.hash,
      graph: env.GRAPH_VERSION,
      poll: env.POLL_PROFILE,
      publicReplies: env.PUBLIC_REPLIES_ENABLED,
      notion: mirror.status().enabled,
      goLiveAt: new Date(repo.kvNum('go_live_at')).toISOString(),
    },
    'ig-dm-bot starting',
  );

  await tokens.bootstrap();
  worker.recoverOnBoot();
  await app.listen({ port: env.PORT, host: env.HOST });
  worker.start();
  poller.start();
  mirror.start();
  housekeeping.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down (finishing any in-flight send)');
    housekeeping.stop();
    await Promise.allSettled([poller.stop(), worker.stop(), mirror.stop()]);
    await app.close();
    repo.db.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  // Config problems print as a readable list; anything else with its stack.
  console.error(e instanceof EnvError || e instanceof TriggerConfigError ? e.message : e);
  process.exit(1);
});
