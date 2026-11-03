import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.ts';
import { NoAccountError } from '../core/ingest.ts';
import { DAY } from '../core/rules.ts';
import { parseWebhook } from '../webhook/parse.ts';
import { verifySignature } from '../webhook/signature.ts';
import { safeEqual } from './guard.ts';

export async function webhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { env, ctx, events } = deps;
  const { repo } = ctx;

  // Keep the exact bytes: the signature is an HMAC over the raw body, not the parsed JSON.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => {
    done(null, body);
  });

  /** Meta's subscription handshake (App Dashboard → Webhooks → Verify and save). */
  app.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const expected = env.WEBHOOK_VERIFY_TOKEN;
    if (q['hub.mode'] === 'subscribe' && expected && safeEqual(q['hub.verify_token'] ?? '', expected)) {
      req.log.info({}, 'webhook verification succeeded');
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    req.log.warn({ mode: q['hub.mode'], configured: !!expected }, 'webhook verification rejected');
    return reply.code(403).send({ error: 'verification failed' });
  });

  app.post('/webhook', async (req, reply) => {
    const now = ctx.clock.now();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = req.headers['x-hub-signature-256'];
    const sig = verifySignature(raw, Array.isArray(header) ? header[0] : header, [
      { name: 'instagram', value: env.IG_APP_SECRET },
      { name: 'meta', value: env.META_APP_SECRET },
    ]);
    if (!sig.ok) {
      const recent = (repo.kvGetJson<number[]>('sig_failures') ?? []).filter((t) => t > now - DAY);
      repo.kvSetJson('sig_failures', [...recent, now].slice(-200), now);
      req.log.warn({ reason: sig.reason, bytes: raw.length }, 'webhook signature rejected');
      return reply.code(403).send({ error: 'invalid signature' });
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid JSON' });
    }

    try {
      const summary = await events.handle(parseWebhook(body, now), 'webhook');
      repo.kvSet('last_webhook_at', now, now);
      repo.kvSet('sig_secret_used', sig.secret, now);
      req.log.info(
        {
          comments: summary.comments.map((c) => c.decision),
          inbound: summary.inbound.map((i) => i.action),
          ignored: summary.ignored,
        },
        'webhook processed',
      );
      return reply.code(200).type('text/plain').send('EVENT_RECEIVED');
    } catch (e) {
      if (e instanceof NoAccountError) {
        // Meta retries for up to 36 h, so nothing is lost while the token is being fixed.
        req.log.warn({}, 'webhook deferred: no validated Instagram account yet');
        return reply.code(503).send({ error: 'not connected yet' });
      }
      req.log.error({ err: e }, 'webhook processing failed');
      return reply.code(500).send({ error: 'processing failed' });
    }
  });
}
