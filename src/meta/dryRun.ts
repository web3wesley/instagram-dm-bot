/**
 * DRY_RUN: everything runs for real (reads, token refresh, webhook subscription, ingest, queue,
 * rate limits, lead states) except the three calls that would put something in front of a person.
 */
import type { Logger } from '../lib/log.ts';
import type { MetaClient } from './types.ts';

export function withDryRun(meta: MetaClient, log: Logger): MetaClient {
  let n = 0;
  const fakeId = (kind: string) => `dry_${kind}_${Date.now().toString(36)}_${(++n).toString(36)}`;
  return {
    ...meta,
    async sendPrivateReply(commentId, text) {
      log.info({ dryRun: true, kind: 'private_reply', commentId, text }, 'DRY_RUN: would send private reply');
      // No real recipient id — the worker falls back to the commenter id for reply matching.
      return { recipientId: '', messageId: fakeId('pr') };
    },
    async sendText(igsid, text) {
      log.info({ dryRun: true, kind: 'link', igsid, text }, 'DRY_RUN: would send DM');
      return { recipientId: igsid, messageId: fakeId('dm') };
    },
    async replyToComment(commentId, text) {
      log.info({ dryRun: true, kind: 'public_reply', commentId, text }, 'DRY_RUN: would reply publicly');
      return { id: fakeId('reply') };
    },
  };
}
