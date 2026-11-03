/**
 * Hourly send caps, counted over the persisted `send_attempts` log so they survive restarts.
 * - dm:     intro private replies + link DMs (default 190/h — Meta publishes 750/h for private
 *           replies; the "200/h" folklore is unverified, so stay under it anyway)
 * - public: public comment replies (default 30/h — the spam-flag risk)
 */
import type { JobKind, Repo } from '../db/repo.ts';
import type { Clock } from '../lib/time.ts';
import { HOUR } from './rules.ts';

export type Bucket = 'dm' | 'public';
export const BUCKET_KINDS: Record<Bucket, readonly JobKind[]> = {
  dm: ['private_reply', 'link'],
  public: ['public_reply'],
};
export const bucketOf = (kind: JobKind): Bucket => (kind === 'public_reply' ? 'public' : 'dm');

/** Meta's published limit for private replies to post/reel comments. */
export const META_PRIVATE_REPLY_LIMIT = 750;

export interface BucketUsage {
  used: number;
  cap: number;
  util: number;
  /** When the next send fits under the cap (null = now). */
  nextSlotAt: number | null;
}

export function createLimiter(repo: Repo, caps: Record<Bucket, number>, clock: Clock) {
  function usage(b: Bucket): BucketUsage {
    const now = clock.now();
    const since = now - HOUR;
    const used = repo.countAttempts(BUCKET_KINDS[b], since);
    const cap = caps[b];
    let nextSlotAt: number | null = null;
    if (used >= cap) {
      const at = repo.attemptAtOffset(BUCKET_KINDS[b], since, used - cap);
      nextSlotAt = at === undefined ? now : at + HOUR;
    }
    return { used, cap, util: round(used / cap), nextSlotAt };
  }
  return {
    usage,
    hasCapacity: (b: Bucket) => usage(b).nextSlotAt === null,
    metaPrivateReplies() {
      const used = repo.countAttempts(['private_reply'], clock.now() - HOUR);
      return { used, limit: META_PRIVATE_REPLY_LIMIT, util: round(used / META_PRIVATE_REPLY_LIMIT) };
    },
  };
}

export type Limiter = ReturnType<typeof createLimiter>;

const round = (x: number) => Math.round(x * 1000) / 1000;
