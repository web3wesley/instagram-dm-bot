/** Shared helpers for the npm scripts (they talk to a running bot over HTTP). */

export function botUrl(override?: string): string {
  // `||`, not `??`: a blank `BOT_URL=` line in .env must fall through to the next option.
  const url = override || process.env.BOT_URL || process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return url.replace(/\/+$/, '');
}

export function adminHeaders(): Record<string, string> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) die('ADMIN_TOKEN is not set (put it in .env)');
  return { authorization: `Bearer ${token}` };
}

export async function adminFetch(path: string, init: RequestInit = {}, base?: string): Promise<Response> {
  const res = await fetch(`${botUrl(base)}${path}`, {
    ...init,
    headers: { ...adminHeaders(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  if (!res.ok) die(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res;
}

export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
