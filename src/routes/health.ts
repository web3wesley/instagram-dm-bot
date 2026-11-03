import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.ts';
import { buildHealth } from '../core/status.ts';
import { adminGuard } from './guard.ts';

export async function healthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const report = () =>
    buildHealth({
      ctx: deps.ctx,
      tokens: deps.tokens,
      limiter: deps.limiter,
      worker: deps.worker,
      poller: deps.poller,
      mirror: deps.mirror,
      startedAt: deps.startedAt,
      version: deps.version,
    });

  /**
   * Public liveness for Railway / uptime monitors. Always 200 while the DB answers — the
   * status word is in the body, so a token problem never triggers a restart loop.
   */
  app.get('/healthz', async (_req, reply) => {
    try {
      const r = report();
      return { status: r.status, version: deps.version, uptime_s: r.uptime_s };
    } catch (e) {
      _req.log.error({ err: e }, 'healthz failed');
      return reply.code(503).send({ status: 'down', version: deps.version });
    }
  });

  /** Full operational status (admin only). */
  app.get('/health', { preHandler: adminGuard(deps.env.ADMIN_TOKEN) }, async () => report());
}
