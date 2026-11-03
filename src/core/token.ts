/**
 * The long-lived Instagram User access token: seeded from env or the OAuth flow, validated
 * against GET /me, refreshed weekly (Meta: refreshable once ≥ 24 h old, lasts 60 days),
 * and persisted in the DB so a refreshed token survives restarts.
 */
import { createHash } from 'node:crypto';
import type { Env } from '../config/env.ts';
import type { Repo } from '../db/repo.ts';
import type { Logger } from '../lib/log.ts';
import type { Clock } from '../lib/time.ts';
import { classify } from '../meta/errors.ts';
import { SUBSCRIBED_FIELDS, type MeInfo, type MetaClient } from '../meta/types.ts';
import type { Alert } from './context.ts';
import { DAY, normalizeUsername, type Me } from './rules.ts';

export type TokenSource = 'env' | 'oauth';
export type TokenHealth = 'ok' | 'invalid' | 'missing';

interface TokenRecord {
  value: string | null;
  source: TokenSource | null;
  state: TokenHealth;
  obtainedAt: number | null;
  expiresAt: number | null;
  lastRefreshAt: number | null;
  lastValidatedAt: number | null;
  lastError: string | null;
}

export interface TokenStatus {
  state: TokenHealth;
  source: TokenSource | null;
  expiresAt: number | null;
  daysLeft: number | null;
  lastRefreshAt: number | null;
  lastValidatedAt: number | null;
  lastError: string | null;
}

const EMPTY: TokenRecord = {
  value: null,
  source: null,
  state: 'missing',
  obtainedAt: null,
  expiresAt: null,
  lastRefreshAt: null,
  lastValidatedAt: null,
  lastError: null,
};
const DEFAULT_LIFETIME_S = 60 * 86_400;

export class WrongAccountError extends Error {
  constructor(got: string, expected: string) {
    super(`token belongs to @${got}, expected @${expected}`);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function createTokens(d: {
  repo: Repo;
  meta: Pick<MetaClient, 'getMe' | 'refresh' | 'subscribe'>;
  env: Pick<Env, 'IG_ACCESS_TOKEN' | 'EXPECTED_IG_USERNAME'>;
  clock: Clock;
  log: Logger;
  alert: Alert;
}) {
  const { repo, meta, env, clock, log } = d;
  const load = (): TokenRecord => ({ ...EMPTY, ...repo.kvGetJson<TokenRecord>('token') });
  const save = (r: TokenRecord) => repo.kvSetJson('token', r, clock.now());

  function toMe(m: MeInfo): Me {
    return { userId: m.userId, username: m.username, appScopedId: m.appScopedId, accountType: m.accountType };
  }

  function checkAccount(m: MeInfo) {
    const expected = env.EXPECTED_IG_USERNAME;
    if (expected && normalizeUsername(m.username) !== normalizeUsername(expected)) {
      throw new WrongAccountError(m.username, normalizeUsername(expected));
    }
  }

  async function subscribe() {
    try {
      await meta.subscribe(SUBSCRIBED_FIELDS);
      repo.kvSetJson('subscribed_fields', [...SUBSCRIBED_FIELDS], clock.now());
      log.info({ fields: SUBSCRIBED_FIELDS }, 'webhook fields subscribed for this account');
    } catch (e) {
      log.warn({ err: e }, 'could not subscribe webhook fields (retry with POST /admin/subscribe)');
    }
  }

  const api = {
    current(): string | null {
      const r = load();
      return r.state === 'ok' ? r.value : null;
    },
    isUsable(): boolean {
      return load().state === 'ok';
    },
    me(): Me | null {
      return repo.kvGetJson<Me>('me') ?? null;
    },

    /** Validates a token, checks it's the expected account, stores it and subscribes webhooks. */
    async adopt(token: string, source: TokenSource, expiresInS?: number): Promise<Me> {
      const info = await meta.getMe(token);
      checkAccount(info);
      const now = clock.now();
      save({
        value: token,
        source,
        state: 'ok',
        obtainedAt: now,
        expiresAt: expiresInS ? now + expiresInS * 1000 : null,
        lastRefreshAt: null,
        lastValidatedAt: now,
        lastError: null,
      });
      const me = toMe(info);
      repo.kvSetJson('me', me, now);
      log.info({ username: me.username, userId: me.userId, source }, 'Instagram token adopted');
      await subscribe();
      return me;
    },

    /** Boot: adopt IG_ACCESS_TOKEN if it changed since last boot, otherwise validate the stored one. */
    async bootstrap(): Promise<void> {
      const envToken = env.IG_ACCESS_TOKEN;
      if (envToken) {
        const hash = sha256(envToken);
        if (repo.kvGet('token_env_hash') !== hash) {
          try {
            await api.adopt(envToken, 'env');
            repo.kvSet('token_env_hash', hash, clock.now());
          } catch (e) {
            log.error({ err: e }, 'IG_ACCESS_TOKEN from env was rejected');
            if (!load().value) save({ ...EMPTY, state: 'invalid', lastError: (e as Error).message });
          }
          return;
        }
      }
      if (!load().value) {
        save({ ...load(), state: 'missing' });
        log.warn({}, 'no Instagram token yet — set IG_ACCESS_TOKEN or open /auth/login');
        return;
      }
      await api.validate();
    },

    async validate(): Promise<void> {
      const r = load();
      if (!r.value) return;
      try {
        const info = await meta.getMe(r.value);
        checkAccount(info);
        const now = clock.now();
        save({ ...load(), state: 'ok', lastValidatedAt: now, lastError: null });
        repo.kvSetJson('me', toMe(info), now);
      } catch (e) {
        if (e instanceof WrongAccountError || classify(e) === 'auth') api.markInvalid(e);
        else log.warn({ err: e }, 'token validation failed (network?) — keeping current state');
      }
    },

    /** Refresh weekly once ≥ 24 h old, or sooner when < 10 days remain. */
    async maybeRefresh(): Promise<boolean> {
      const r = load();
      if (r.state !== 'ok' || !r.value) return false;
      const now = clock.now();
      const age = now - (r.lastRefreshAt ?? r.obtainedAt ?? now);
      if (age < DAY) return false;
      const due =
        age >= 7 * DAY || r.expiresAt === null || r.expiresAt - now < 10 * DAY;
      if (!due) return false;
      try {
        const g = await meta.refresh(r.value);
        save({
          ...load(),
          value: g.accessToken,
          state: 'ok',
          expiresAt: now + (g.expiresInS ?? DEFAULT_LIFETIME_S) * 1000,
          lastRefreshAt: now,
          lastError: null,
        });
        log.info({ expiresInS: g.expiresInS }, 'Instagram token refreshed');
        return true;
      } catch (e) {
        if (classify(e) === 'auth') api.markInvalid(e);
        else log.warn({ err: e }, 'token refresh failed — will retry next hour');
        return false;
      }
    },

    markInvalid(e: unknown): void {
      const msg = e instanceof Error ? e.message : String(e);
      save({ ...load(), state: 'invalid', lastError: msg });
      log.error({ err: msg }, 'Instagram token is invalid — sending paused');
      d.alert('token_invalid', `Instagram token invalid (${msg}). Reconnect at /auth/login.`);
    },

    status(): TokenStatus {
      const r = load();
      const now = clock.now();
      return {
        state: r.state,
        source: r.source,
        expiresAt: r.expiresAt,
        daysLeft: r.expiresAt === null ? null : Math.floor((r.expiresAt - now) / DAY),
        lastRefreshAt: r.lastRefreshAt,
        lastValidatedAt: r.lastValidatedAt,
        lastError: r.lastError,
      };
    },
  };
  return api;
}

export type Tokens = ReturnType<typeof createTokens>;
