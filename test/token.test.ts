import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/core/rules.ts';
import { WrongAccountError, createTokens } from '../src/core/token.ts';
import { MetaApiError } from '../src/meta/errors.ts';
import { makeCtx, silentLogger } from './helpers/ctx.ts';
import { createFakeMeta } from './helpers/fakeMeta.ts';

const err190 = () => MetaApiError.fromResponse(400, { error: { message: 'Invalid OAuth access token', code: 190 } });

function setup(env: Record<string, string> = {}) {
  const t = makeCtx({ token: false, me: null, env });
  const fake = createFakeMeta();
  const alerts: string[] = [];
  const tokens = createTokens({ repo: t.repo, meta: fake.client, env: t.env, clock: t.clock, log: silentLogger, alert: (k) => alerts.push(k) });
  return { ...t, fake, tokens, alerts };
}

describe('token bootstrap', () => {
  it('adopts IG_ACCESS_TOKEN once, validates it and subscribes the webhook fields', async () => {
    const s = setup({ IG_ACCESS_TOKEN: 'env-token', EXPECTED_IG_USERNAME: 'your.account' });
    await s.tokens.bootstrap();
    expect(s.tokens.current()).toBe('env-token');
    expect(s.tokens.me()?.username).toBe('your.account');
    expect(s.fake.callsTo('getMe')[0]?.args[0]).toBe('env-token');
    expect(s.fake.callsTo('subscribe')).toHaveLength(1);
    expect(s.tokens.status()).toMatchObject({ state: 'ok', source: 'env', expiresAt: null });
  });

  it('does not overwrite a refreshed token with the same env token on the next boot', async () => {
    const s = setup({ IG_ACCESS_TOKEN: 'env-token' });
    await s.tokens.bootstrap();
    s.clock.advance(DAY);
    await s.tokens.maybeRefresh();
    expect(s.tokens.current()).toBe('env-token-refreshed');
    await s.tokens.bootstrap(); // restart with the unchanged env var
    expect(s.tokens.current()).toBe('env-token-refreshed');
  });

  it('rejects a token for a different Instagram account', async () => {
    const s = setup({ IG_ACCESS_TOKEN: 'other', EXPECTED_IG_USERNAME: 'someone.else' });
    await expect(s.tokens.adopt('other', 'env')).rejects.toBeInstanceOf(WrongAccountError);
    await s.tokens.bootstrap();
    expect(s.tokens.isUsable()).toBe(false);
    expect(s.tokens.current()).toBeNull();
  });

  it('reports "missing" with no token at all', async () => {
    const s = setup();
    await s.tokens.bootstrap();
    expect(s.tokens.status().state).toBe('missing');
  });
});

describe('token refresh', () => {
  it('waits 24 h, refreshes once to learn the expiry, then weekly', async () => {
    const s = setup({ IG_ACCESS_TOKEN: 'env-token' });
    await s.tokens.bootstrap();
    s.clock.advance(23 * HOUR);
    expect(await s.tokens.maybeRefresh()).toBe(false);
    s.clock.advance(HOUR);
    expect(await s.tokens.maybeRefresh()).toBe(true);
    expect(s.tokens.status().daysLeft).toBe(60);
    s.clock.advance(6 * DAY);
    expect(await s.tokens.maybeRefresh()).toBe(false);
    s.clock.advance(DAY);
    expect(await s.tokens.maybeRefresh()).toBe(true);
    expect(s.fake.callsTo('refresh')).toHaveLength(2);
  });

  it('marks the token invalid when Meta rejects it', async () => {
    const s = setup({ IG_ACCESS_TOKEN: 'env-token' });
    await s.tokens.bootstrap();
    s.clock.advance(DAY);
    s.fake.queue('refresh', err190());
    await s.tokens.maybeRefresh();
    expect(s.tokens.status()).toMatchObject({ state: 'invalid' });
    expect(s.alerts).toContain('token_invalid');
  });

  it('keeps the token on a network error during validation', async () => {
    const s = setup({ IG_ACCESS_TOKEN: 'env-token' });
    await s.tokens.bootstrap();
    s.fake.queue('getMe', new MetaApiError({ message: 'ECONNRESET', phase: 'connect' }));
    await s.tokens.validate();
    expect(s.tokens.isUsable()).toBe(true);
    s.fake.queue('getMe', err190());
    await s.tokens.validate();
    expect(s.tokens.isUsable()).toBe(false);
  });

  it('an OAuth adoption restores a dead token', async () => {
    const s = setup({ EXPECTED_IG_USERNAME: 'your.account' });
    await s.tokens.bootstrap();
    await s.tokens.adopt('long-token', 'oauth', 5_184_000);
    expect(s.tokens.status()).toMatchObject({ state: 'ok', source: 'oauth', daysLeft: 60 });
  });
});
