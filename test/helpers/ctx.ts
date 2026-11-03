import { loadEnv, type Env } from '../../src/config/env.ts';
import type { TriggerSet } from '../../src/config/triggers.ts';
import type { Ctx } from '../../src/core/context.ts';
import { DAY, MINUTE, type Me } from '../../src/core/rules.ts';
import { openDb } from '../../src/db/db.ts';
import { createRepo, type Repo } from '../../src/db/repo.ts';
import { silentLogger, type Logger } from '../../src/lib/log.ts';
import { ME, T0 } from './fixtures.ts';
import { makeTriggers } from './triggers.ts';

/** Deterministic PRNG so jitter and spintax are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TestClock {
  t: number;
  now(): number;
  advance(ms: number): void;
}

export function makeClock(start = T0 + MINUTE): TestClock {
  return {
    t: start,
    now() {
      return this.t;
    },
    advance(ms: number) {
      this.t += ms;
    },
  };
}

export interface TestCtx {
  ctx: Ctx;
  env: Env;
  repo: Repo;
  clock: TestClock;
  logs: Array<{ level: string; obj: object; msg?: string | undefined }>;
  setTriggers(t: TriggerSet): void;
}

export function makeCtx(opts: {
  env?: Record<string, string>;
  triggers?: TriggerSet;
  now?: number;
  me?: Me | null;
  cutoff?: number;
  token?: boolean;
} = {}): TestCtx {
  const env = loadEnv({ DRY_RUN: 'false', ...opts.env });
  const repo = createRepo(openDb(':memory:', env.mode));
  const clock = makeClock(opts.now);
  let triggers = opts.triggers ?? makeTriggers([{ keyword: 'SKILL', publicReply: true }, { keyword: 'LOOP' }]);
  repo.kvSet('go_live_at', opts.cutoff ?? T0 - DAY);
  const me = opts.me === undefined ? ME : opts.me;
  if (me) repo.kvSetJson('me', me);
  if (opts.token !== false) {
    repo.kvSetJson('token', {
      value: 'test-token',
      source: 'env',
      state: 'ok',
      obtainedAt: clock.now(),
      expiresAt: clock.now() + 60 * DAY,
      lastRefreshAt: null,
      lastValidatedAt: clock.now(),
      lastError: null,
    });
  }
  const logs: TestCtx['logs'] = [];
  const log: Logger = {
    debug: (obj, msg) => logs.push({ level: 'debug', obj, msg }),
    info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
  };
  const ctx: Ctx = {
    env,
    repo,
    clock,
    rng: mulberry32(42),
    log,
    triggers: () => triggers,
    me: () => repo.kvGetJson<Me>('me') ?? null,
  };
  return { ctx, env, repo, clock, logs, setTriggers: (t) => (triggers = t) };
}

export { silentLogger };
