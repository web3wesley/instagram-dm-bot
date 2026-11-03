import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Env } from './config/env.ts';
import type { Ctx } from './core/context.ts';
import type { EventHandler, Mirror } from './core/events.ts';
import type { Limiter } from './core/limiter.ts';
import type { MirrorStatus, PollerStatus } from './core/status.ts';
import type { Tokens } from './core/token.ts';
import type { MetaClient } from './meta/types.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { healthRoutes } from './routes/health.ts';
import { pageRoutes } from './routes/pages.ts';
import { webhookRoutes } from './routes/webhook.ts';

export interface AppDeps {
  env: Env;
  ctx: Ctx;
  meta: MetaClient;
  tokens: Tokens;
  events: EventHandler;
  limiter: Limiter;
  worker: { lastTickAt(): number };
  poller?: { status(): PollerStatus; rescan(since: number): Promise<{ comments: number }> } | undefined;
  mirror?: (Mirror & { status(): MirrorStatus }) | undefined;
  startedAt: number;
  version: string;
  logger?: FastifyBaseLogger | undefined;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = deps.logger
    ? Fastify({ loggerInstance: deps.logger, trustProxy: true, bodyLimit: 1024 * 1024 })
    : Fastify({ logger: false, trustProxy: true, bodyLimit: 1024 * 1024 });

  // Each plugin is its own encapsulation context: the webhook's raw-body JSON parser
  // stays scoped to /webhook, and admin routes keep Fastify's normal JSON parsing.
  await app.register(async (i) => webhookRoutes(i, deps));
  await app.register(async (i) => healthRoutes(i, deps));
  await app.register(async (i) => pageRoutes(i, deps));
  await app.register(async (i) => authRoutes(i, deps));
  await app.register(async (i) => adminRoutes(i, deps));
  return app;
}
