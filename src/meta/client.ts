/**
 * Instagram Platform API client (Instagram API with Instagram Login, host graph.instagram.com).
 *
 * Endpoints confirmed against Meta's docs on 2026-09-29:
 * - private reply   POST /<IG_ID>/messages  {recipient:{comment_id}, message:{text}} → {recipient_id, message_id}
 * - send API        POST /<IG_ID>/messages  {recipient:{id: IGSID}, message:{text}}
 * - public reply    POST /<COMMENT_ID>/replies  {message}
 * - comments        GET  /<MEDIA_ID>/comments  (reverse-chronological, ≤ 50 per page)
 * - subscriptions   POST /me/subscribed_apps?subscribed_fields=…
 * - Business Login  POST https://api.instagram.com/oauth/access_token (form) → short-lived token
 *                   GET  https://graph.instagram.com/access_token?grant_type=ig_exchange_token → 60 days
 *                   GET  https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 * The access token travels in the Authorization header everywhere except the two token
 * endpoints above, which only accept it as a query parameter.
 */
import { MetaApiError, parseUsageHeaders, type Usage } from './errors.ts';
import type { ApiComment, ApiMedia, MeInfo, MetaClient, Page, SendResult, TokenGrant } from './types.ts';

export interface ClientOptions {
  /** e.g. "v26.0". */
  version: string;
  getToken: () => string | null;
  /** The IG professional account id (for /<IG_ID>/messages); falls back to /me. */
  getUserId?: () => string | null | undefined;
  appId?: string | undefined;
  appSecret?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUsage?: (u: Usage) => void;
}

const MEDIA_FIELDS = 'id,timestamp,comments_count,shortcode,permalink,media_product_type';
const COMMENT_FIELDS = 'id,text,timestamp,from,username,parent_id';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);

/** Some Instagram endpoints wrap the payload as {data: [ … ]}; unwrap either shape. */
function unwrap(v: unknown): Obj {
  if (isObj(v) && Array.isArray(v.data) && isObj(v.data[0])) return v.data[0];
  return isObj(v) ? v : {};
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

/** Classifies fetch failures: never-sent (safe to retry) vs. outcome unknown. */
function networkError(e: unknown): MetaApiError {
  const err = e as { name?: string; message?: string; cause?: { code?: string; name?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new MetaApiError({ message: 'request timed out', phase: 'timeout' });
  }
  const code = err?.cause?.code ?? '';
  if (CONNECT_CODES.has(code) || err?.cause?.name === 'ConnectTimeoutError') {
    return new MetaApiError({ message: `connection failed (${code || 'connect'})`, phase: 'connect' });
  }
  return new MetaApiError({ message: `network error (${code || err?.message || 'unknown'})`, phase: 'reset' });
}

export function createMetaClient(o: ClientOptions): MetaClient {
  const graph = `https://graph.instagram.com/${o.version}`;
  const doFetch = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 15_000;

  async function call<T = Obj>(
    method: 'GET' | 'POST',
    url: string,
    opts: { token?: string | null; json?: unknown; form?: FormData; query?: Record<string, string>; bearer?: boolean } = {},
  ): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.query ?? {})) u.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (opts.bearer !== false) {
      const token = opts.token ?? o.getToken();
      if (!token) throw new MetaApiError({ message: 'no Instagram access token available', phase: 'response', code: 190 });
      headers.authorization = `Bearer ${token}`;
    }
    let body: string | FormData | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }

    let res: Response;
    let text: string;
    try {
      res = await doFetch(u, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (e) {
      throw networkError(e);
    }
    const usage = parseUsageHeaders((n) => res.headers.get(n));
    if (usage) o.onUsage?.(usage);

    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok || (isObj(data) && ('error' in data || 'error_message' in data))) {
      const err =
        isObj(data) && typeof data.error_message === 'string'
          ? new MetaApiError({
              // api.instagram.com (OAuth) reports errors in this older flat shape.
              message: data.error_message,
              phase: 'response',
              status: res.status,
              code: typeof data.code === 'number' ? data.code : undefined,
              type: str(data.error_type),
              body: data,
            })
          : MetaApiError.fromResponse(res.status, data);
      err.usage = usage;
      throw err;
    }
    return data as T;
  }

  const messagesUrl = () => `${graph}/${o.getUserId?.() || 'me'}/messages`;

  function toSendResult(r: Obj): SendResult {
    return { recipientId: str(r.recipient_id) ?? '', messageId: str(r.message_id) ?? '' };
  }

  function toGrant(r: Obj): TokenGrant {
    const perms = r.permissions;
    return {
      accessToken: str(r.access_token) ?? '',
      expiresInS: typeof r.expires_in === 'number' ? r.expires_in : undefined,
      userId: str(r.user_id),
      permissions: Array.isArray(perms) ? perms.map(String) : typeof perms === 'string' ? perms.split(',').map((p) => p.trim()) : undefined,
    };
  }

  function requireToken(g: TokenGrant): TokenGrant {
    if (!g.accessToken) throw new MetaApiError({ message: 'token response had no access_token', phase: 'response' });
    return g;
  }

  return {
    async getMe(token?: string): Promise<MeInfo> {
      const r = unwrap(await call('GET', `${graph}/me`, { token, query: { fields: 'user_id,username,account_type,id' } }));
      const userId = str(r.user_id) ?? str(r.id);
      if (!userId || !str(r.username)) {
        throw new MetaApiError({ message: 'GET /me returned no user_id/username', phase: 'response', body: r });
      }
      return { userId, username: str(r.username)!, appScopedId: str(r.id), accountType: str(r.account_type) };
    },

    async getMedia(id: string): Promise<ApiMedia> {
      return (await call<ApiMedia>('GET', `${graph}/${encodeURIComponent(id)}`, { query: { fields: MEDIA_FIELDS } })) as ApiMedia;
    },

    async listMedia(limit: number): Promise<ApiMedia[]> {
      const r = await call<{ data?: ApiMedia[] }>('GET', `${graph}/me/media`, { query: { fields: MEDIA_FIELDS, limit: String(limit) } });
      return r.data ?? [];
    },

    async listComments(mediaId, opts): Promise<Page<ApiComment>> {
      const fields = opts.replies ? `${COMMENT_FIELDS},replies{${COMMENT_FIELDS}}` : COMMENT_FIELDS;
      const query: Record<string, string> = { fields, limit: '50' };
      if (opts.after) query.after = opts.after;
      const r = await call<{ data?: ApiComment[]; paging?: { next?: string; cursors?: { after?: string } } }>(
        'GET',
        `${graph}/${encodeURIComponent(mediaId)}/comments`,
        { query },
      );
      return { data: r.data ?? [], next: r.paging?.next ? r.paging.cursors?.after : undefined };
    },

    async sendPrivateReply(commentId, text) {
      return toSendResult(
        await call('POST', messagesUrl(), { json: { recipient: { comment_id: commentId }, message: { text } } }),
      );
    },

    async sendText(igsid, text) {
      return toSendResult(await call('POST', messagesUrl(), { json: { recipient: { id: igsid }, message: { text } } }));
    },

    async replyToComment(commentId, text) {
      const r = await call('POST', `${graph}/${encodeURIComponent(commentId)}/replies`, { json: { message: text } });
      return { id: str(r.id) ?? '' };
    },

    async subscribe(fields) {
      const r = await call('POST', `${graph}/me/subscribed_apps`, { query: { subscribed_fields: fields.join(',') } });
      return r.success === true;
    },

    async subscribedFields() {
      const r = await call('GET', `${graph}/me/subscribed_apps`);
      const rows = Array.isArray(r.data) ? r.data : [];
      return rows.flatMap((row) => (isObj(row) && Array.isArray(row.subscribed_fields) ? row.subscribed_fields.map(String) : []));
    },

    async exchangeCode(code, redirectUri) {
      if (!o.appId || !o.appSecret) throw new MetaApiError({ message: 'IG_APP_ID / IG_APP_SECRET not configured', phase: 'response' });
      const form = new FormData();
      form.set('client_id', o.appId);
      form.set('client_secret', o.appSecret);
      form.set('grant_type', 'authorization_code');
      form.set('redirect_uri', redirectUri);
      form.set('code', code);
      return requireToken(toGrant(unwrap(await call('POST', 'https://api.instagram.com/oauth/access_token', { form, bearer: false }))));
    },

    async toLongLived(shortToken) {
      if (!o.appSecret) throw new MetaApiError({ message: 'IG_APP_SECRET not configured', phase: 'response' });
      const r = await call('GET', 'https://graph.instagram.com/access_token', {
        bearer: false,
        query: { grant_type: 'ig_exchange_token', client_secret: o.appSecret, access_token: shortToken },
      });
      return requireToken(toGrant(r));
    },

    async refresh(token) {
      const r = await call('GET', 'https://graph.instagram.com/refresh_access_token', {
        bearer: false,
        query: { grant_type: 'ig_refresh_token', access_token: token },
      });
      return requireToken(toGrant(r));
    },
  };
}
