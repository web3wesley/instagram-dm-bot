/**
 * Optional push alerts (ALERT_WEBHOOK_URL): Discord or Slack webhooks get JSON, anything else
 * (e.g. an ntfy.sh topic URL) gets plain text. Each alert key fires at most once per 6 hours.
 */
import type { Repo } from '../db/repo.ts';
import type { Logger } from './log.ts';
import type { Clock } from './time.ts';

const REPEAT_AFTER_MS = 6 * 60 * 60 * 1000;

export function createAlerter(d: { url: string | undefined; repo: Repo; clock: Clock; log: Logger; fetchImpl?: typeof fetch }) {
  const doFetch = d.fetchImpl ?? fetch;
  return (key: string, message: string): void => {
    d.log.warn({ alert: key }, message);
    if (!d.url) return;
    const now = d.clock.now();
    const last = d.repo.kvNum(`alert:${key}`);
    if (now - last < REPEAT_AFTER_MS) return;
    d.repo.kvSet(`alert:${key}`, now, now);

    const host = new URL(d.url).hostname;
    const text = `IG DM Bot: ${message}`;
    const init: RequestInit =
      host.endsWith('discord.com') || host.endsWith('discordapp.com')
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) }
        : host === 'hooks.slack.com'
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }
          : { method: 'POST', headers: { title: 'IG DM Bot', 'content-type': 'text/plain' }, body: message };
    doFetch(d.url, { ...init, signal: AbortSignal.timeout(10_000) }).catch((e: unknown) =>
      d.log.error({ err: (e as Error).message }, 'alert delivery failed'),
    );
  };
}
