import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createEventHandler } from '../src/core/events.ts';
import { createLimiter } from '../src/core/limiter.ts';
import { MINUTE, SECOND } from '../src/core/rules.ts';
import { createTokens } from '../src/core/token.ts';
import { createWorker } from '../src/core/worker.ts';
import { withDryRun } from '../src/meta/dryRun.ts';
import { signBody } from '../src/webhook/signature.ts';
import { makeSignedRequest } from '../src/webhook/signedRequest.ts';
import { makeCtx, silentLogger } from './helpers/ctx.ts';
import { createFakeMeta } from './helpers/fakeMeta.ts';
import { T0, fixtureRaw } from './helpers/fixtures.ts';

const SECRET = 'ig-app-secret-for-tests';
const VERIFY = 'verify-token-for-tests';
const ADMIN = 'admin-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${ADMIN}` };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(opts: { dryRun: boolean; connected?: boolean }) {
  const t = makeCtx({
    now: T0 + 30 * SECOND,
    me: opts.connected === false ? null : undefined,
    token: opts.connected !== false,
    env: {
      DRY_RUN: String(opts.dryRun),
      IG_APP_SECRET: SECRET,
      WEBHOOK_VERIFY_TOKEN: VERIFY,
      ADMIN_TOKEN: ADMIN,
      EXPECTED_IG_USERNAME: 'your.account',
      PUBLIC_BASE_URL: 'https://bot.example.com',
      IG_APP_ID: '1234567890',
    },
  });
  const fake = createFakeMeta();
  fake.setRecipient('17865799348089039', '2031528510825908');
  const meta = opts.dryRun ? withDryRun(fake.client, silentLogger) : fake.client;
  const alert = () => {};
  const tokens = createTokens({ repo: t.repo, meta, env: t.env, clock: t.clock, log: silentLogger, alert });
  const limiter = createLimiter(t.repo, { dm: 190, public: 30 }, t.clock);
  const worker = createWorker({ ctx: t.ctx, meta, limiter, tokens, alert, sendGapMs: [0, 0] });
  const events = createEventHandler({ ctx: t.ctx, meta });
  app = await buildApp({ env: t.env, ctx: t.ctx, meta, tokens, events, limiter, worker, startedAt: t.clock.now(), version: 'test' });
  const post = (fixture: string, sign = SECRET) => {
    const raw = fixtureRaw(`webhook/${fixture}`);
    return app!.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(raw, sign) },
      payload: raw,
    });
  };
  const count = (table: string) => (t.repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { ...t, fake, worker, app, post, count };
}

describe('webhook verification handshake', () => {
  it('echoes hub.challenge for the right verify token and rejects anything else', async () => {
    const s = await setup({ dryRun: true });
    const ok = await s.app.inject({ url: `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    const bad = await s.app.inject({ url: '/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });
});

describe('end to end in DRY_RUN', () => {
  it('comment → intro → reply → link, with zero real sends', async () => {
    const s = await setup({ dryRun: true });

    const res = await s.post('comment.changes.json');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('EVENT_RECEIVED');
    expect(s.count('leads')).toBe(1);

    s.clock.advance(13 * SECOND);
    expect(await s.worker.runOnce()).toBe('sent');
    const lead = s.repo.getLead(1)!;
    expect(lead).toMatchObject({ state: 'dm_sent', username: 'jess.builds', keyword: 'SKILL' });

    s.clock.t = T0 + 2 * MINUTE + 10 * SECOND; // message.text.json was sent at T0 + 2 min
    expect((await s.post('message.text.json')).statusCode).toBe(200);
    expect(s.repo.getLead(1)?.state).toBe('replied');
    s.clock.advance(4 * SECOND);
    expect(await s.worker.runOnce()).toBe('sent');
    expect(s.repo.getLead(1)?.state).toBe('link_sent');

    expect(s.fake.callsTo('sendPrivateReply')).toHaveLength(0);
    expect(s.fake.callsTo('sendText')).toHaveLength(0);
    const attempts = s.repo.db.prepare('SELECT kind, dry_run, ok FROM send_attempts ORDER BY id').all();
    expect(attempts).toEqual([
      { kind: 'private_reply', dry_run: 1, ok: 1 },
      { kind: 'link', dry_run: 1, ok: 1 },
    ]);

    const health = await s.app.inject({ url: '/health', headers: auth });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      mode: { dry_run: true },
      account: { username: 'your.account' },
      today: { tz: 'Asia/Tokyo', matched: 1, intros: 1, links: 1, dms_sent: 2 },
      funnel_7d: { matched: 1, dm_sent: 1, replied: 1, link_sent: 1, reply_rate: 1 },
      rate_limits: { dm: { used: 2, cap: 190 } },
    });
  });

  it('replayed webhooks create nothing new; bad signatures are rejected before anything is stored', async () => {
    const s = await setup({ dryRun: true });
    await s.post('comment.changes.json');
    await s.post('comment.changes.json');
    expect(s.count('comments')).toBe(1);
    expect(s.count('leads')).toBe(1);

    const bad = await s.post('comment.nomatch.json', 'wrong-secret');
    expect(bad.statusCode).toBe(403);
    expect(s.count('comments')).toBe(1);

    const unsigned = await s.app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/json' },
      payload: fixtureRaw('webhook/comment.nomatch.json'),
    });
    expect(unsigned.statusCode).toBe(403);
    const h = (await s.app.inject({ url: '/health', headers: auth })).json();
    expect(h.webhooks.sig_failures_24h).toBe(2);
  });

  it('own comments, non-matching comments, echoes and reads never create leads', async () => {
    const s = await setup({ dryRun: true });
    for (const f of ['comment.self.json', 'comment.nomatch.json', 'message.echo.json', 'read_reaction.json', 'standby.json']) {
      expect((await s.post(f)).statusCode).toBe(200);
    }
    expect(s.count('leads')).toBe(0);
    expect(s.count('jobs')).toBe(0);
  });

  it('answers 503 (so Meta retries) until an account is connected', async () => {
    const s = await setup({ dryRun: true, connected: false });
    expect((await s.post('comment.changes.json')).statusCode).toBe(503);
    expect(s.count('comments')).toBe(0);
  });
});

describe('live mode request bodies', () => {
  it('sends exactly the documented private-reply and send-API payloads', async () => {
    const s = await setup({ dryRun: false });
    await s.post('comment.changes.json');
    s.clock.advance(13 * SECOND);
    await s.worker.runOnce();
    const [intro] = s.fake.callsTo('sendPrivateReply');
    expect(intro?.args[0]).toBe('17865799348089039');
    const stored = s.repo.db.prepare(`SELECT request, response FROM send_attempts WHERE kind = 'private_reply'`).get() as {
      request: string;
      response: string;
    };
    expect(JSON.parse(stored.request)).toEqual({
      recipient: { comment_id: '17865799348089039' },
      message: { text: intro?.args[1] },
    });
    expect(s.repo.getLead(1)?.igsid).toBe('2031528510825908');

    s.clock.t = T0 + 2 * MINUTE + 10 * SECOND;
    await s.post('message.text.json');
    s.clock.advance(4 * SECOND);
    await s.worker.runOnce();
    const [link] = s.fake.callsTo('sendText');
    expect(link?.args[0]).toBe('2031528510825908');
    expect(String(link?.args[1])).toContain('https://www.skool.com/test-community');
  });
});

describe('admin and public pages', () => {
  it('protects admin routes and exports formula-safe CSV', async () => {
    const s = await setup({ dryRun: true });
    await s.post('comment.changes.json');
    s.repo.db.prepare(`UPDATE leads SET comment_text = '=HYPERLINK("http://evil")'`).run();

    expect((await s.app.inject({ url: '/admin/leads.csv' })).statusCode).toBe(401);
    expect((await s.app.inject({ url: '/health' })).statusCode).toBe(401);
    const basic = `Basic ${Buffer.from(`admin:${ADMIN}`).toString('base64')}`;
    const csv = await s.app.inject({ url: '/admin/leads.csv', headers: { authorization: basic } });
    expect(csv.statusCode).toBe(200);
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain('"username"');
    expect(lines[1]).toContain('"jess.builds"');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('serves liveness publicly without details', async () => {
    const s = await setup({ dryRun: true });
    const r = await s.app.inject({ url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(['status', 'uptime_s', 'version']);
  });

  it('serves the privacy, terms, data-deletion and landing pages Meta requires', async () => {
    const s = await setup({ dryRun: true });
    for (const url of ['/', '/privacy', '/terms', '/data-deletion']) {
      const r = await s.app.inject({ url });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.body).toContain('your.account');
    }
    expect((await s.app.inject({ url: '/' })).body).toContain('/auth/login');
  });

  it('starts Business Login with a state nonce', async () => {
    const s = await setup({ dryRun: true });
    const r = await s.app.inject({ url: '/auth/login' });
    expect(r.statusCode).toBe(302);
    const loc = new URL(r.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://bot.example.com/auth/callback');
    expect(loc.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments');
    const state = loc.searchParams.get('state');
    expect(s.repo.kvGet(`oauth_state:${state}`)).toBeDefined();

    const cb = await s.app.inject({ url: `/auth/callback?code=abc%23_&state=${state}` });
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('Connected as <strong>@your.account</strong>');
    expect(s.fake.callsTo('exchangeCode')[0]?.args).toEqual(['abc', 'https://bot.example.com/auth/callback']);
    expect((await s.app.inject({ url: `/auth/callback?code=abc&state=${state}` })).statusCode).toBe(400); // single use
  });

  it('verifies signed_request on the deauthorize callback', async () => {
    const s = await setup({ dryRun: true });
    const good = makeSignedRequest({ user_id: '17841400000000001' }, SECRET);
    const r = await s.app.inject({
      method: 'POST',
      url: '/meta/deauthorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `signed_request=${encodeURIComponent(good)}`,
    });
    expect(r.statusCode).toBe(200);
    const bad = await s.app.inject({
      method: 'POST',
      url: '/meta/deauthorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `signed_request=${encodeURIComponent(makeSignedRequest({ user_id: '1' }, 'wrong'))}`,
    });
    expect(bad.statusCode).toBe(400);
  });
});
