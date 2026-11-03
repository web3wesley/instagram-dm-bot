import type { ApiComment, ApiMedia, MetaClient, Page } from '../../src/meta/types.ts';
import { ME, REEL } from './fixtures.ts';

type Method = keyof MetaClient;
type Scripted = unknown | Error;

/**
 * A scriptable MetaClient: records every call; `queue(method, ...results)` makes the next
 * calls return (or throw, for Error values) those results before falling back to defaults.
 */
export function createFakeMeta() {
  const calls: Array<{ method: Method; args: unknown[] }> = [];
  const queues = new Map<Method, Scripted[]>();
  let n = 0;
  const media: ApiMedia[] = [];
  const comments = new Map<string, Page<ApiComment>[]>();
  /** comment id → the IGSID Meta would report as recipient_id for a private reply. */
  const recipients = new Map<string, string>();

  function next<T>(method: Method, args: unknown[], fallback: () => T): Promise<T> {
    calls.push({ method, args });
    const q = queues.get(method);
    if (q && q.length) {
      const v = q.shift();
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(v as T);
    }
    return Promise.resolve(fallback());
  }

  const client: MetaClient = {
    getMe: (token) =>
      next('getMe', [token], () => ({ userId: ME.userId, username: ME.username, appScopedId: ME.appScopedId, accountType: 'MEDIA_CREATOR' })),
    getMedia: (id) =>
      next('getMedia', [id], () => media.find((m) => m.id === id) ?? { id, shortcode: REEL.shortcode, permalink: `https://www.instagram.com/reel/${REEL.shortcode}/` }),
    listMedia: (limit) => next('listMedia', [limit], () => media.slice(0, limit)),
    listComments: (mediaId, o) =>
      next('listComments', [mediaId, o], () => {
        const pages = comments.get(mediaId) ?? [];
        const idx = o.after ? Number(o.after) : 0;
        return pages[idx] ?? { data: [] };
      }),
    sendPrivateReply: (commentId, text) =>
      next('sendPrivateReply', [commentId, text], () => ({ recipientId: recipients.get(commentId) ?? `igsid_${commentId}`, messageId: `mid_${++n}` })),
    sendText: (igsid, text) => next('sendText', [igsid, text], () => ({ recipientId: igsid, messageId: `mid_${++n}` })),
    replyToComment: (commentId, text) => next('replyToComment', [commentId, text], () => ({ id: `reply_${++n}` })),
    subscribe: (fields) => next('subscribe', [fields], () => true),
    subscribedFields: () => next('subscribedFields', [], () => ['comments', 'messages', 'messaging_postbacks']),
    exchangeCode: (code, redirect) => next('exchangeCode', [code, redirect], () => ({ accessToken: 'short-token', userId: ME.userId, permissions: [] })),
    toLongLived: (t) => next('toLongLived', [t], () => ({ accessToken: 'long-token', expiresInS: 5_184_000 })),
    refresh: (t) => next('refresh', [t], () => ({ accessToken: `${t}-refreshed`, expiresInS: 5_184_000 })),
  };

  return {
    client,
    calls,
    callsTo: (method: Method) => calls.filter((c) => c.method === method),
    queue(method: Method, ...results: Scripted[]) {
      queues.set(method, [...(queues.get(method) ?? []), ...results]);
    },
    setMedia(list: ApiMedia[]) {
      media.splice(0, media.length, ...list);
    },
    /** Pages of comments for a media id; page i is returned for cursor String(i). */
    setComments(mediaId: string, pages: Page<ApiComment>[]) {
      comments.set(mediaId, pages);
    },
    setRecipient(commentId: string, igsid: string) {
      recipients.set(commentId, igsid);
    },
  };
}

export type FakeMeta = ReturnType<typeof createFakeMeta>;
