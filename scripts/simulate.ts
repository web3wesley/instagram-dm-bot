/**
 * Posts a signed, realistic Instagram webhook to a running bot — for local testing.
 *
 *   npm run simulate -- "SKILL please" --user tester_one
 *   npm run simulate -- --reply "yes" --user-id 2031528510825908
 *
 * Flags: --user <name>  --user-id <igsid>  --media <id>  --account <ig user id>  --url <bot url>
 */
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { signBody } from '../src/webhook/signature.ts';
import { adminFetch, botUrl, die } from './lib.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: 'string', default: 'sim.tester' },
    'user-id': { type: 'string' },
    media: { type: 'string', default: '17900000000000099' },
    account: { type: 'string' },
    reply: { type: 'string' },
    url: { type: 'string' },
  },
});

const secret = process.env.IG_APP_SECRET ?? process.env.META_APP_SECRET;
if (!secret) die('IG_APP_SECRET is not set — the bot rejects unsigned webhooks.');

const base = botUrl(values.url);
const userId = values['user-id'] ?? `20315285108${randomInt(10000, 99999)}`;

async function accountId(): Promise<string> {
  if (values.account) return values.account;
  if (process.env.IG_USER_ID) return process.env.IG_USER_ID;
  const health = (await (await adminFetch('/health', {}, base)).json()) as { account?: { user_id?: string } };
  return health.account?.user_id ?? die('Bot has no connected account yet; pass --account <ig user id>.');
}

async function post(payload: unknown): Promise<void> {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(raw, secret!) },
    body: raw,
  });
  console.log(`POST /webhook → ${res.status} ${await res.text()}`);
}

const account = await accountId();
const now = Date.now();

if (values.reply !== undefined) {
  await post({
    object: 'instagram',
    entry: [
      {
        id: account,
        time: now,
        messaging: [
          {
            sender: { id: userId },
            recipient: { id: account },
            timestamp: now,
            message: { mid: `sim_${now}`, text: values.reply },
          },
        ],
      },
    ],
  });
} else {
  const text = positionals.join(' ') || 'SKILL please';
  await post({
    object: 'instagram',
    entry: [
      {
        id: account,
        time: Math.floor(now / 1000),
        changes: [
          {
            field: 'comments',
            value: {
              from: { id: userId, username: values.user },
              media: { id: values.media, media_product_type: 'REELS' },
              id: `17${now}${randomInt(100, 999)}`,
              text,
            },
          },
        ],
      },
    ],
  });
  console.log(`commenter id: ${userId} (reply with: npm run simulate -- --reply "yes" --user-id ${userId})`);
}
