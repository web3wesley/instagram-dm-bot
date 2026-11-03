import { describe, expect, it, vi } from 'vitest';
import { createMetaClient } from '../src/meta/client.ts';
import { MetaApiError, classify } from '../src/meta/errors.ts';

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = init?.body;
    if (typeof body === 'string') body = JSON.parse(body);
    else if (body instanceof FormData) body = Object.fromEntries(body.entries());
    seen.push({ method: init?.method ?? 'GET', url, headers, body });
    const next = responses.shift() ?? { body: {} };
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  });
  return { impl: impl as unknown as typeof fetch, seen };
}

function client(responses: Parameters<typeof fakeFetch>[0], extra: Partial<Parameters<typeof createMetaClient>[0]> = {}) {
  const f = fakeFetch(responses);
  const c = createMetaClient({
    version: 'v26.0',
    getToken: () => 'TOKEN',
    getUserId: () => '17841400000000001',
    appId: '990602627938098',
    appSecret: 'app-secret',
    fetchImpl: f.impl,
    ...extra,
  });
  return { c, seen: f.seen };
}

describe('Instagram Platform requests', () => {
  it('sends a private reply exactly as documented', async () => {
    const { c, seen } = client([{ body: { recipient_id: '526123', message_id: 'aWdfZ123' } }]);
    await expect(c.sendPrivateReply('17865799348089039', 'Hey!')).resolves.toEqual({ recipientId: '526123', messageId: 'aWdfZ123' });
    const [req] = seen;
    expect(req?.method).toBe('POST');
    expect(req?.url.href).toBe('https://graph.instagram.com/v26.0/17841400000000001/messages');
    expect(req?.headers.authorization).toBe('Bearer TOKEN');
    expect(req?.url.searchParams.has('access_token')).toBe(false); // token never in the URL
    expect(req?.body).toEqual({ recipient: { comment_id: '17865799348089039' }, message: { text: 'Hey!' } });
  });

  it('sends a follow-up DM to an IGSID', async () => {
    const { c, seen } = client([{ body: { recipient_id: '526123', message_id: 'm2' } }]);
    await c.sendText('526123', 'Here you go');
    expect(seen[0]?.body).toEqual({ recipient: { id: '526123' }, message: { text: 'Here you go' } });
  });

  it('falls back to /me/messages before the account id is known', async () => {
    const { c, seen } = client([{ body: { recipient_id: '1', message_id: 'm' } }], { getUserId: () => undefined });
    await c.sendText('1', 'x');
    expect(seen[0]?.url.pathname).toBe('/v26.0/me/messages');
  });

  it('replies publicly with a JSON {message} body', async () => {
    const { c, seen } = client([{ body: { id: '17873440459141029' } }]);
    await expect(c.replyToComment('17865799348089039', 'Sent you a DM 📩')).resolves.toEqual({ id: '17873440459141029' });
    expect(seen[0]?.url.pathname).toBe('/v26.0/17865799348089039/replies');
    expect(seen[0]?.body).toEqual({ message: 'Sent you a DM 📩' });
  });

  it('reads /me and tolerates the {data: [...]} wrapper', async () => {
    const { c, seen } = client([
      { body: { user_id: '17841400000000001', username: 'your.account', account_type: 'MEDIA_CREATOR', id: '9000' } },
      { body: { data: [{ user_id: '17841400000000001', username: 'your.account' }] } },
    ]);
    await expect(c.getMe()).resolves.toEqual({ userId: '17841400000000001', username: 'your.account', appScopedId: '9000', accountType: 'MEDIA_CREATOR' });
    expect(seen[0]?.url.searchParams.get('fields')).toBe('user_id,username,account_type,id');
    await expect(c.getMe('OTHER')).resolves.toMatchObject({ userId: '17841400000000001' });
    expect(seen[1]?.headers.authorization).toBe('Bearer OTHER');
  });

  it('pages comments newest-first with replies expanded', async () => {
    const { c, seen } = client([
      { body: { data: [{ id: '1', text: 'SKILL', timestamp: '2026-09-28T12:00:00+0000' }], paging: { cursors: { after: 'CUR1' }, next: 'https://graph.instagram.com/next' } } },
      { body: { data: [], paging: { cursors: { after: 'CUR2' } } } },
    ]);
    const p1 = await c.listComments('17900000000000099', { replies: true });
    expect(p1.next).toBe('CUR1');
    expect(seen[0]?.url.searchParams.get('fields')).toBe(
      'id,text,timestamp,from,username,parent_id,replies{id,text,timestamp,from,username,parent_id}',
    );
    expect(seen[0]?.url.searchParams.get('limit')).toBe('50');
    const p2 = await c.listComments('17900000000000099', { replies: false, after: 'CUR1' });
    expect(seen[1]?.url.searchParams.get('after')).toBe('CUR1');
    expect(p2.next).toBeUndefined(); // no paging.next → last page
  });

  it('subscribes the account to webhook fields', async () => {
    const { c, seen } = client([{ body: { success: true } }]);
    await expect(c.subscribe(['comments', 'messages', 'messaging_postbacks'])).resolves.toBe(true);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url.pathname).toBe('/v26.0/me/subscribed_apps');
    expect(seen[0]?.url.searchParams.get('subscribed_fields')).toBe('comments,messages,messaging_postbacks');
  });
});

describe('Business Login token endpoints', () => {
  it('exchanges the code with form fields and no bearer header', async () => {
    const { c, seen } = client([
      { body: { data: [{ access_token: 'SHORT', user_id: '1020', permissions: 'instagram_business_basic,instagram_business_manage_messages' }] } },
    ]);
    await expect(c.exchangeCode('AQBx', 'https://bot.example.com/auth/callback')).resolves.toEqual({
      accessToken: 'SHORT',
      userId: '1020',
      expiresInS: undefined,
      permissions: ['instagram_business_basic', 'instagram_business_manage_messages'],
    });
    expect(seen[0]?.url.href).toBe('https://api.instagram.com/oauth/access_token');
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.body).toEqual({
      client_id: '990602627938098',
      client_secret: 'app-secret',
      grant_type: 'authorization_code',
      redirect_uri: 'https://bot.example.com/auth/callback',
      code: 'AQBx',
    });
  });

  it('trades for a 60-day token and refreshes it (unversioned endpoints)', async () => {
    const { c, seen } = client([
      { body: { access_token: 'LONG', token_type: 'bearer', expires_in: 5183944 } },
      { body: { access_token: 'LONG2', token_type: 'bearer', expires_in: 5183944 } },
    ]);
    await expect(c.toLongLived('SHORT')).resolves.toMatchObject({ accessToken: 'LONG', expiresInS: 5183944 });
    expect(seen[0]?.url.origin + seen[0]!.url.pathname).toBe('https://graph.instagram.com/access_token');
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({ grant_type: 'ig_exchange_token', client_secret: 'app-secret', access_token: 'SHORT' });
    await expect(c.refresh('LONG')).resolves.toMatchObject({ accessToken: 'LONG2' });
    expect(seen[1]?.url.pathname).toBe('/refresh_access_token');
    expect(seen[1]?.url.searchParams.get('grant_type')).toBe('ig_refresh_token');
  });

  it('surfaces the flat OAuth error shape', async () => {
    const { c } = client([{ status: 400, body: { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' } }]);
    await expect(c.exchangeCode('bad', 'https://x')).rejects.toMatchObject({ message: 'Invalid authorization code', type: 'OAuthException' });
  });
});

describe('errors', () => {
  it('turns Graph errors into MetaApiError with the exact payload and the usage header', async () => {
    const onUsage = vi.fn();
    const body = { error: { message: 'Outside of allowed window', type: 'OAuthException', code: 10, error_subcode: 2534022, fbtrace_id: 'Abc' } };
    const { c } = client(
      [{ status: 400, body, headers: { 'x-business-use-case-usage': JSON.stringify({ '1784': [{ type: 'instagram', call_count: 4, total_cputime: 1, total_time: 2, estimated_time_to_regain_access: 0 }] }) } }],
      { onUsage },
    );
    const err = await c.sendText('1', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).body).toEqual(body);
    expect((err as MetaApiError).usage).toMatchObject({ callCount: 4 });
    expect(classify(err)).toBe('window_closed');
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it('classifies network failures by whether the request could have been sent', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { c } = client([refused, reset, timeout]);
    await expect(c.sendText('1', 'x')).rejects.toMatchObject({ phase: 'connect' });
    await expect(c.sendText('1', 'x')).rejects.toMatchObject({ phase: 'reset' });
    await expect(c.sendText('1', 'x')).rejects.toMatchObject({ phase: 'timeout' });
  });

  it('refuses to call Meta without a token', async () => {
    const { c, seen } = client([], { getToken: () => null });
    await expect(c.listMedia(5)).rejects.toMatchObject({ code: 190 });
    expect(seen).toHaveLength(0);
  });
});
