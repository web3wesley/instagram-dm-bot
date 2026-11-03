import type { Env } from '../config/env.ts';
import type { TriggerSet } from '../config/triggers.ts';
import type { Repo } from '../db/repo.ts';
import type { Logger } from '../lib/log.ts';
import type { Clock } from '../lib/time.ts';
import type { Me } from './rules.ts';

/** Shared dependencies for the core modules (ingest, worker, poller). */
export interface Ctx {
  env: Env;
  repo: Repo;
  clock: Clock;
  rng: () => number;
  log: Logger;
  triggers(): TriggerSet;
  /** Our account, once a token has been validated; null until then. */
  me(): Me | null;
}

/** Comments from before this instant never trigger (set once, at first boot). */
export function cutoff(ctx: Ctx): number {
  return ctx.repo.kvNum('go_live_at');
}

export type Alert = (key: string, message: string) => void;
