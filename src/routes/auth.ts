/**
 * Business Login for Instagram — the "Log in with Instagram" flow App Review needs to see,
 * and the way to reconnect if the token ever dies. Only EXPECTED_IG_USERNAME is accepted.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.ts';
import { MINUTE } from '../core/rules.ts';
import { WrongAccountError } from '../core/token.ts';
import { esc, page } from '../lib/html.ts';
import { MetaApiError } from '../meta/errors.ts';
import { OAUTH_SCOPES } from '../meta/types.ts';

const STATE_TTL = 15 * MINUTE;

export async function authRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { env, ctx, meta, tokens } = deps;
  const { repo } = ctx;
  const redirectUri = () => `${env.PUBLIC_BASE_URL}/auth/callback`;
  const missing = () =>
    [
      !env.IG_APP_ID && 'IG_APP_ID',
      !env.IG_APP_SECRET && 'IG_APP_SECRET',
      !env.PUBLIC_BASE_URL && 'PUBLIC_BASE_URL',
      !env.EXPECTED_IG_USERNAME && 'EXPECTED_IG_USERNAME',
    ].filter(Boolean);

  app.get('/auth/login', async (_req, reply) => {
    const gaps = missing();
    if (gaps.length) {
      return reply.code(503).type('text/html').send(page('Not configured', `<h1>Not configured</h1><p>Set ${esc(gaps.join(', '))} first.</p>`));
    }
    const now = ctx.clock.now();
    repo.kvDelPrefixOlderThan('oauth_state:', now - STATE_TTL);
    const state = randomBytes(18).toString('base64url');
    repo.kvSet(`oauth_state:${state}`, now, now);
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.searchParams.set('client_id', env.IG_APP_ID!);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', OAUTH_SCOPES.join(','));
    url.searchParams.set('state', state);
    return reply.redirect(url.toString(), 302);
  });

  app.get('/auth/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const html = (status: number, title: string, body: string) =>
      reply.code(status).type('text/html').send(page(title, `<h1>${esc(title)}</h1>${body}<p><a href="/">Back</a></p>`));

    if (q.error) {
      return html(400, 'Not connected', `<p>Instagram returned: ${esc(q.error_description ?? q.error_reason ?? q.error)}</p>`);
    }
    const now = ctx.clock.now();
    const stateKey = `oauth_state:${q.state ?? ''}`;
    const issued = Number(repo.kvGet(stateKey) ?? 0);
    repo.kvDel(stateKey);
    if (!q.state || !issued || now - issued > STATE_TTL) {
      return html(400, 'Link expired', '<p>That login link expired or was already used. Start again from the home page.</p>');
    }
    if (!q.code) return html(400, 'Not connected', '<p>No authorization code was returned.</p>');

    try {
      // Instagram appends "#_" to the redirect; browsers normally drop fragments, but be safe.
      const code = q.code.replace(/#_$/, '');
      const short = await meta.exchangeCode(code, redirectUri());
      const long = await meta.toLongLived(short.accessToken);
      const me = await tokens.adopt(long.accessToken, 'oauth', long.expiresInS);
      req.log.info({ username: me.username, permissions: short.permissions }, 'connected via Business Login');
      return html(
        200,
        'Connected',
        `<p>Connected as <strong>@${esc(me.username)}</strong>. The token is stored and refreshes automatically; webhooks are subscribed.</p>`,
      );
    } catch (e) {
      if (e instanceof WrongAccountError) {
        return html(403, 'Wrong account', `<p>${esc(e.message)}. Log out of Instagram in this browser and try again with the right account.</p>`);
      }
      req.log.error({ err: e instanceof MetaApiError ? e.toJSON() : e }, 'OAuth callback failed');
      return html(502, 'Instagram error', `<p>${esc(e instanceof Error ? e.message : 'unknown error')}</p>`);
    }
  });
}
