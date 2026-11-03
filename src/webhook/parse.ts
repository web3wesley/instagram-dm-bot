/**
 * Normalizes every Instagram webhook payload shape into flat events.
 *
 * Shapes handled:
 * - `entry[].changes[] {field, value}` — what Meta actually sends for comments
 * - `entry[].field / entry[].value`   — the shape shown in the Instagram-Login docs
 * - Facebook-Login comment values     — `comment_id`, `media.original_media_id`, `media.ad_id`
 * - `entry[].messaging[]`              — messages, quick replies, postbacks, echoes, reads, reactions
 * - a top-level array of payloads (the docs wrap one in `[...]`)
 */
import { toMs } from '../core/rules.ts';

export interface CommentEvent {
  t: 'comment';
  accountId: string;
  commentId: string;
  mediaId: string;
  adId?: string | undefined;
  parentId?: string | undefined;
  fromId?: string | undefined;
  username?: string | undefined;
  text: string;
  /** ms. For webhooks this is `entry.time` (≈ comment time); the poller supplies the exact timestamp. */
  at: number;
  atExact: boolean;
  productType?: string | undefined;
}

export type InboundKind = 'text' | 'quick_reply' | 'postback' | 'attachment';

export interface InboundEvent {
  t: 'inbound';
  accountId: string;
  senderId: string;
  recipientId: string;
  mid?: string | undefined;
  at: number;
  kind: InboundKind;
  text?: string | undefined;
  payload?: string | undefined;
}

export type IgnoreReason =
  | 'wrong_object'
  | 'malformed'
  | 'echo'
  | 'self'
  | 'deleted'
  | 'edit'
  | 'read'
  | 'reaction'
  | 'referral'
  | 'optin'
  | 'standby'
  | 'live_comment'
  | 'unsupported_field';

export interface IgnoredEvent {
  t: 'ignored';
  reason: IgnoreReason;
  accountId?: string | undefined;
}

export type WebhookEvent = CommentEvent | InboundEvent | IgnoredEvent;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

export function parseWebhook(body: unknown, receivedAt: number): WebhookEvent[] {
  const payloads = Array.isArray(body) ? body : [body];
  return payloads.flatMap((p) => parsePayload(p, receivedAt));
}

function parsePayload(p: unknown, receivedAt: number): WebhookEvent[] {
  if (!isObj(p)) return [{ t: 'ignored', reason: 'malformed' }];
  if (p.object !== 'instagram') return [{ t: 'ignored', reason: 'wrong_object' }];
  if (!Array.isArray(p.entry)) return [{ t: 'ignored', reason: 'malformed' }];

  const events: WebhookEvent[] = [];
  for (const e of p.entry) {
    if (!isObj(e)) {
      events.push({ t: 'ignored', reason: 'malformed' });
      continue;
    }
    const accountId = str(e.id) ?? '';
    const entryTime = num(e.time) !== undefined ? toMs(num(e.time)!) : receivedAt;

    const changes: unknown[] = Array.isArray(e.changes)
      ? e.changes
      : e.field !== undefined
        ? [{ field: e.field, value: e.value }]
        : [];
    for (const c of changes) events.push(parseChange(c, accountId, entryTime));

    if (Array.isArray(e.messaging)) {
      for (const m of e.messaging) events.push(parseMessaging(m, accountId, entryTime));
    }
    if (Array.isArray(e.standby)) {
      for (const _ of e.standby) events.push({ t: 'ignored', reason: 'standby', accountId });
    }
  }
  return events;
}

function parseChange(c: unknown, accountId: string, entryTime: number): WebhookEvent {
  if (!isObj(c)) return { t: 'ignored', reason: 'malformed', accountId };
  if (c.field === 'live_comments') return { t: 'ignored', reason: 'live_comment', accountId };
  if (c.field !== 'comments') return { t: 'ignored', reason: 'unsupported_field', accountId };

  const v = obj(c.value);
  const media = obj(v.media);
  const from = obj(v.from);
  const commentId = str(v.id) ?? str(v.comment_id);
  const mediaId = str(media.original_media_id) ?? str(media.id);
  if (!commentId || !mediaId) return { t: 'ignored', reason: 'malformed', accountId };

  const exact = num(v.timestamp) ?? (typeof v.timestamp === 'string' ? Date.parse(v.timestamp) : NaN);
  return {
    t: 'comment',
    accountId,
    commentId,
    mediaId,
    adId: str(media.ad_id),
    parentId: str(v.parent_id),
    fromId: str(from.id),
    username: str(from.username),
    text: typeof v.text === 'string' ? v.text : '',
    at: Number.isFinite(exact) ? toMs(exact) : entryTime,
    atExact: Number.isFinite(exact),
    productType: str(media.media_product_type),
  };
}

function parseMessaging(m: unknown, accountId: string, entryTime: number): WebhookEvent {
  if (!isObj(m)) return { t: 'ignored', reason: 'malformed', accountId };
  const senderId = str(obj(m.sender).id);
  const recipientId = str(obj(m.recipient).id) ?? accountId;
  const at = num(m.timestamp) !== undefined ? toMs(num(m.timestamp)!) : entryTime;

  if (isObj(m.message)) {
    const msg = m.message;
    if (msg.is_echo === true) return { t: 'ignored', reason: 'echo', accountId };
    if (msg.is_deleted === true) return { t: 'ignored', reason: 'deleted', accountId };
    if (msg.is_self === true) return { t: 'ignored', reason: 'self', accountId };
    if (!senderId) return { t: 'ignored', reason: 'malformed', accountId };
    const base = { t: 'inbound' as const, accountId, senderId, recipientId, mid: str(msg.mid), at };
    const text = typeof msg.text === 'string' ? msg.text : undefined;
    if (isObj(msg.quick_reply)) {
      return { ...base, kind: 'quick_reply', text, payload: str(msg.quick_reply.payload) };
    }
    if (text !== undefined) return { ...base, kind: 'text', text };
    if (Array.isArray(msg.attachments)) return { ...base, kind: 'attachment' };
    return { ...base, kind: 'text', text: '' };
  }
  if (isObj(m.postback)) {
    if (!senderId) return { t: 'ignored', reason: 'malformed', accountId };
    const pb = m.postback;
    return {
      t: 'inbound',
      accountId,
      senderId,
      recipientId,
      mid: str(pb.mid),
      at,
      kind: 'postback',
      text: str(pb.title),
      payload: str(pb.payload),
    };
  }
  if (isObj(m.message_edit)) return { t: 'ignored', reason: 'edit', accountId };
  if (isObj(m.read)) return { t: 'ignored', reason: 'read', accountId };
  if (isObj(m.reaction)) return { t: 'ignored', reason: 'reaction', accountId };
  if (isObj(m.referral)) return { t: 'ignored', reason: 'referral', accountId };
  if (isObj(m.optin)) return { t: 'ignored', reason: 'optin', accountId };
  return { t: 'ignored', reason: 'unsupported_field', accountId };
}
