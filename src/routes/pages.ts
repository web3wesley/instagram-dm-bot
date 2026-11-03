/**
 * Public pages Meta requires before the app can go Live (privacy policy, data-deletion
 * instructions) plus the landing page with the login button App Review wants to see, and
 * the deauthorize / data-deletion callbacks from Business Login settings.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.ts';
import { esc, page } from '../lib/html.ts';
import { parseSignedRequest } from '../webhook/signedRequest.ts';

const COMMENT_RETENTION_DAYS = 14;
const SEND_LOG_RETENTION_DAYS = 90;

export async function pageRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { env, ctx, tokens } = deps;
  const handle = () => ctx.me()?.username ?? env.EXPECTED_IG_USERNAME ?? 'the account owner';
  const contact = () =>
    env.PRIVACY_CONTACT
      ? esc(env.PRIVACY_CONTACT)
      : `a direct message to <strong>@${esc(handle())}</strong> on Instagram`;

  // Meta posts these callbacks as application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get('/', async (_req, reply) => {
    const h = esc(handle());
    return reply.type('text/html').send(
      page(
        'IG DM Bot',
        `<h1>IG DM Bot</h1>
<p>A private tool for the Instagram account <strong>@${h}</strong>. When someone comments a keyword on one of
@${h}'s posts or reels, it sends that person the link they asked for — once, as a private reply — and only
if they commented the keyword.</p>
<p><a class="btn" href="/auth/login">Log in with Instagram</a></p>
<p class="muted">Only @${h} can connect this app. <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a> · <a href="/data-deletion">Data deletion</a></p>`,
      ),
    );
  });

  app.get('/terms', async (_req, reply) => {
    const h = esc(handle());
    return reply.type('text/html').send(
      page(
        'Terms of service — IG DM Bot',
        `<h1>Terms of service</h1>
<p class="muted">IG DM Bot is a private tool operated by the owner of the Instagram account @${h}.</p>

<h2>What it is</h2>
<p>When you comment a keyword on one of @${h}'s Instagram posts or reels, the tool sends you one automated
private message, and the link you asked for if you reply. It is free, provided as-is, and may be changed or
switched off at any time.</p>

<h2>Using it</h2>
<ul>
<li>Commenting a keyword is how you ask for the message. Reply <strong>STOP</strong> at any time and it will
never message you again.</li>
<li>Links lead to third-party sites (for example Skool) that have their own terms and prices.</li>
<li>Do not use the tool to send abusive content or to try to disrupt it.</li>
</ul>

<h2>Your data</h2>
<p>See the <a href="/privacy">privacy policy</a> and the <a href="/data-deletion">data deletion</a> page.</p>

<h2>Instagram</h2>
<p>This tool uses Meta's official Instagram API. It is not endorsed by or affiliated with Instagram or Meta,
and your use of Instagram stays subject to Instagram's own terms.</p>

<h2>Contact</h2>
<p>Questions: ${contact()}.</p>`,
      ),
    );
  });

  app.get('/privacy', async (_req, reply) => {
    const h = esc(handle());
    const notion = !!env.NOTION_TOKEN;
    return reply.type('text/html').send(
      page(
        'Privacy policy — IG DM Bot',
        `<h1>Privacy policy</h1>
<p class="muted">IG DM Bot is operated by the owner of the Instagram account @${h} ("we").</p>

<h2>What this app does</h2>
<p>When you comment a keyword (for example "SKILL") on one of @${h}'s Instagram posts or reels, this app sends you
one private message about it. If you reply to that message, it sends you the link for that keyword. It never
messages anyone who did not comment a keyword, and it never messages you first in any other way.</p>

<h2>What we collect</h2>
<ul>
<li>Your Instagram username and the Instagram-scoped ID Meta gives us for you.</li>
<li>The comment you left (its text, time and which post it was on).</li>
<li>Delivery details: when our messages were sent, when you replied and the first reply you sent.</li>
</ul>
<p>We receive this data from Meta's Instagram API only because you commented on or messaged @${h}. We do not
receive your password, email address, phone number or anything from your own profile beyond your username.</p>

<h2>Why</h2>
<p>Only to send you the link you asked for, to avoid messaging you twice, and to see which posts people found
useful. We do not sell, rent or trade this data, use it for advertising, or combine it with other data about you.</p>

<h2>Where it is stored and who processes it</h2>
<ul>
<li><strong>Railway</strong> (railway.com) hosts the app and its database.</li>
${notion ? '<li><strong>Notion</strong> (notion.so) holds a copy of the lead list so @' + h + ' can review it.</li>' : ''}
<li><strong>Meta</strong> delivers the messages through the Instagram API.</li>
</ul>

<h2>How long we keep it</h2>
<ul>
<li>Comments that did not include a keyword: ${COMMENT_RETENTION_DAYS} days.</li>
<li>Technical delivery logs: ${SEND_LOG_RETENTION_DAYS} days.</li>
<li>Records of people who asked for a link: ${esc(env.LEAD_RETENTION_DAYS)} days.</li>
</ul>

<h2>Your choices</h2>
<ul>
<li>Reply <strong>STOP</strong> to any message from this app and it will never message you again.</li>
<li>Send <strong>delete my data</strong> in a direct message to @${h} and everything we hold about you is deleted
automatically. See <a href="/data-deletion">data deletion</a>.</li>
</ul>

<h2>Contact</h2>
<p>Questions or requests: ${contact()}.</p>
<p class="muted">Messages you receive from this app are automated.</p>`,
      ),
    );
  });

  app.get('/data-deletion', async (req, reply) => {
    const code = (req.query as Record<string, string | undefined>).code;
    const h = esc(handle());
    return reply.type('text/html').send(
      page(
        'Data deletion — IG DM Bot',
        `<h1>Delete your data</h1>
${code ? `<div class="card"><strong>Request received.</strong> Confirmation code: <code>${esc(code)}</code>. The data has been deleted.</div>` : ''}
<p>To delete everything IG DM Bot holds about you (your username, Instagram-scoped ID, comments and message
history with this app):</p>
<ol>
<li>Open Instagram and send a direct message to <strong>@${h}</strong> containing the words <strong>delete my data</strong>.</li>
<li>The app deletes your records immediately, including copies in its lead list.</li>
</ol>
<p>You can also ask through ${contact()}. To stop all messages without deleting anything, reply <strong>STOP</strong>.</p>`,
      ),
    );
  });

  const secrets = [env.IG_APP_SECRET, env.META_APP_SECRET];
  const signed = (body: unknown) => {
    const sr = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).signed_request : undefined;
    return typeof sr === 'string' ? parseSignedRequest(sr, secrets) : null;
  };

  /** Business Login "Deauthorize callback URL": the account owner removed the app. */
  app.post('/meta/deauthorize', async (req, reply) => {
    const p = signed(req.body);
    if (!p) return reply.code(400).send({ error: 'invalid signed_request' });
    tokens.markInvalid(new Error('app deauthorized by the account owner'));
    req.log.warn({ userId: p.user_id }, 'app deauthorized');
    return { ok: true };
  });

  /** Business Login "Data deletion request URL": the account owner asked Meta to delete app data. */
  app.post('/meta/data-deletion', async (req, reply) => {
    const p = signed(req.body);
    if (!p) return reply.code(400).send({ error: 'invalid signed_request' });
    ctx.repo.kvDel('token');
    ctx.repo.kvDel('me');
    const code = randomBytes(8).toString('hex');
    req.log.warn({ userId: p.user_id, code }, 'owner data-deletion request: token and profile removed');
    const base = env.PUBLIC_BASE_URL ?? '';
    return { url: `${base}/data-deletion?code=${code}`, confirmation_code: code };
  });
}
