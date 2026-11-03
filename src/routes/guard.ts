import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Constant-time string comparison (hashes first so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Admin auth: `Authorization: Bearer <ADMIN_TOKEN>`, or HTTP Basic with ADMIN_TOKEN as the
 * password (any username) so /admin and /health open in a phone browser.
 */
export function adminGuard(adminToken: string | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!adminToken) return reply.code(503).send({ error: 'ADMIN_TOKEN is not configured' });
    const h = req.headers.authorization ?? '';
    let given = '';
    if (h.startsWith('Bearer ')) given = h.slice(7).trim();
    else if (h.startsWith('Basic ')) {
      const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
      given = decoded.slice(decoded.indexOf(':') + 1);
    }
    if (!given || !safeEqual(given, adminToken)) {
      return reply.code(401).header('WWW-Authenticate', 'Basic realm="ig-dm-bot", charset="UTF-8"').send({ error: 'unauthorized' });
    }
  };
}
