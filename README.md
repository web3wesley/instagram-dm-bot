# Instagram DM Bot

The bot from the [Web3Wesley](https://www.youtube.com/@Web3Wesley) video "Claude Code Built My Instagram
DM Bot for $5 a Month (Don't Pay ManyChat)". <!-- video link added once it's live -->

A self-hosted comment-to-DM bot for **one** Instagram account (your own), built on Meta's official
**Instagram API with Instagram Login** (`graph.instagram.com`, Graph API v26.0). It replaced ManyChat
on my account: someone comments a keyword on a reel, gets a DM, replies, and gets your link.

It's for one account only, yours. It is not a ManyChat clone you can sell to clients: that would
need Meta's App Review, which this setup skips on purpose.

## What you need to sign up for

| What | Cost | What it's for |
|---|---|---|
| **Claude Code** (a paid Claude plan that includes it) | your Claude plan | Sets this up, changes it and deploys it for you. Open it in this folder and it reads `AGENTS.md`. |
| **An Instagram professional account** (Creator or Business), **public** | free | The account the bot answers for. Meta sends nothing about comments on private accounts. |
| **A Facebook account** | free | Meta makes you log in with Facebook to register as a developer, even for an Instagram-only bot. You don't need a Facebook Page or to link it to Instagram. |
| **A Meta developer account** at [developers.facebook.com](https://developers.facebook.com/) | free | Holds the Meta app: the permission that lets the bot read your comments and send DMs through Meta's API. The API itself is free. |
| **Railway**, Hobby plan, at [railway.com](https://railway.com/) | $5/month (includes $5 of usage; this bot runs inside it) | The always-on server the bot lives on. |
| **A second Instagram account** | free | Plays the person commenting while you test. If Meta refuses it as a tester, switch it to a free Creator account. |
| **Notion** (optional) | free | A copy of your lead list in a Notion database (§8). |

On your computer: **Node.js 24.14 or newer** and the **Railway CLI** (§4). No GitHub account is needed
to deploy; Railway deploys straight from this folder.

Plan on two to three hours the first time. Most of that is Meta's dashboard, not the bot. With Claude
Code: open this folder, ask it to read `README.md` and `AGENTS.md`, and walk through §2 to §6 with it.

```
someone comments "SKILL" on a reel
  → bot sends ONE private-reply DM (the intro — the only message Meta allows before they reply)
  → lead logged (SQLite + Notion mirror)
  → they reply to the DM (any text, a quick reply or a button tap)
  → bot sends the keyword's link (within Meta's 24 h window)
```

Nothing else ever sends a DM. There is no "send a message" endpoint, and DMs from anyone without an open
lead are ignored and left for you to answer yourself.

> **Meta access — read this first.**
>
> 1. **The app must be Live.** In Development mode the API returns no comments at all (verified 2026-10-01).
> 2. **Once Live, Standard Access was enough for everything tested so far** (2026-10-05, no App Review):
>    reading the public's comments, receiving `comments` and `messages` webhooks, and the full loop with an
>    Instagram Tester account. The dashboard itself says a developer building only for their own account
>    can skip App Review.
> 3. **A DM to a non-tester works too.** On 2026-10-05 an ordinary account (no role on the app)
>    commented, got the intro, replied and got the link. So for this single-account bot **App Review
>    and Business Verification are not needed**. §7 stays as a fallback in case Meta changes that.

---

## 1. How it works

| Piece | What it does |
|---|---|
| **Comment intake** | Meta `comments` webhooks (after App Review) **and** a poller (always on), both feeding one idempotent pipeline keyed on the comment id. |
| **Matching** | Case-insensitive whole-word match. `SKILL` / `skill please` / `𝐒𝐊𝐈𝐋𝐋` / `#skill` match; `unskilled` / `skills` / `@skill.guy` / `skill-based` don't (add `skills` as an alias if you want it). Optional `notPhrases` (e.g. "skill issue") and per-reel scoping. |
| **Rules** | One DM per person per reel. Your own comments are ignored. Never DMs anyone who commented before go-live. The private reply must go out within 7 days of the comment (the bot stops at 166 h). The link goes out only inside the 24 h window after their reply. STOP / START / "delete my data" are handled. |
| **Send worker** | A persistent queue with one send at a time, 2–6 s between sends, and a 190/h DM cap (Meta's published cap is 750/h). If Meta rate-limits, it waits exactly as long as Meta says to. Intros are safe to retry; links and public replies are sent at most once. |
| **Public replies** | Optional, off by default. Uses varied text, is posted 30–180 s after a successful DM, is capped at 30/h and never contains links. Pauses for 24 h if Instagram blocks one (error 368). |
| **Lead log** | SQLite (the source of truth). Plus a CSV export, per-keyword and per-reel funnel stats, and an optional Notion "IG Leads" mirror. |
| **Ops** | `/healthz` (public liveness) and `/health` (full status, admin). A phone-friendly `/admin` page. pino JSON logs, with every send attempt logged together with the exact Meta error payload. `DRY_RUN`, a kill switch, daily backups, token auto-refresh, optional push alerts. |

Stack: Node ≥ 24.14 running TypeScript directly (no build step), Fastify 5, built-in `node:sqlite`, zod,
Vitest. Runtime dependencies: `fastify`, `pino`, `zod`.

## 2. Local quick start

```bash
npm install
```

```bash
copy .env.example .env
```

```bash
copy triggers.example.json triggers.json
```

Fill in `.env` and `triggers.json` (§3), then:

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

To send a fake signed comment and reply to a local bot running in `DRY_RUN`:

```bash
npm run simulate -- "SKILL please" --user tester_one
```

```bash
npm run simulate -- --reply "yes" --user-id <id printed by the previous command>
```

## 3. Configuration

### triggers.json (keywords → links)

```json
{
  "defaults": {
    "intro": "Hey {username}! 👋 Thanks for commenting {keyword}. Reply to this message (anything works) and I'll send you the link. (automated reply)",
    "linkMessage": "Here you go {username} 👉 {link}",
    "publicReplies": ["{Sent|Just sent} you a DM {username} 📩", "Check your DMs {username} {👀|🙌}"]
  },
  "triggers": [
    { "keyword": "SKILL", "aliases": ["skills"], "link": "https://www.skool.com/…", "notPhrases": ["skill issue"] },
    { "keyword": "LOOP", "link": "https://…", "media": ["https://www.instagram.com/reel/YOUR_REEL_ID/"], "publicReply": true }
  ]
}
```

| Field | Meaning |
|---|---|
| `keyword`, `aliases` | Whole-word, case-insensitive. Multi-word phrases work. Must be unique across triggers. |
| `link` | https only. Sent after the person replies. Optional when `defaults.link` is set: every reel's keyword can share one link (the Skool community), so a new reel only needs `{ "keyword": "…" }`. |
| `intro` / `linkMessage` / `publicReplies` | Per-trigger overrides of `defaults`. Placeholders: `{username}`, `{keyword}`, `{link}` (link message only). Spintax `{a|b|c}` picks one option at random. |
| `media` | Optional reel/post shortcodes or URLs. Empty means every post. |
| `notPhrases` | Phrases that must not trigger, e.g. "skill issue". |
| `publicReply` | Adds a public reply under the comment. Set it per trigger, or once in `defaults.publicReply` for every keyword. Also requires `PUBLIC_REPLIES_ENABLED=true`, and needs at least 2 variants. |
| `enabled` | `false` keeps the trigger defined but inactive. |

The bot refuses to start with a bad file, and `npm test` validates the committed `triggers.json`. The file
rejects: an intro containing `{link}`, a link message missing `{link}`, URLs in public replies, and messages
over Instagram's 1000-byte limit (checked against a 30-character username). **To change keywords:** edit,
run `npm test`, then `railway up`. If a reel was already live before its keyword existed, run `POST /admin/rescan`
afterwards. It picks up comments from the last 7 days.

### Environment

See [.env.example](.env.example) for every variable, with comments. The important ones:

| Variable | Default | Notes |
|---|---|---|
| `DRY_RUN` | `true` | Runs everything except the 3 send calls. Uses its own DB file (`dry_run.sqlite`). |
| `ALLOWLIST` | empty | When set, only these usernames get DMs. |
| `IG_APP_ID`, `IG_APP_SECRET` | — | The **Instagram** app ID/secret. They sign webhooks and are used for Business Login. |
| `WEBHOOK_VERIFY_TOKEN`, `ADMIN_TOKEN` | — | Random strings; admin must be ≥ 24 characters. |
| `EXPECTED_IG_USERNAME` | — | Tokens for any other account are rejected. |
| `PUBLIC_BASE_URL` | — | The Railway URL (for OAuth and the pages). |
| `POLL_PROFILE` | `primary` | Switch to `backup` once comment webhooks arrive after App Review. |
| `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID` | — | Turns on the Notion mirror (§8). |

## 4. Deploy on Railway

One service, one volume, one replica. Deploys straight from this folder, so no GitHub repo is needed.

```bash
npm install -g @railway/cli
```

```bash
railway login
```

```bash
railway init
```

```bash
railway up
```

Then in the Railway dashboard:
1. **Volume:** right-click the project canvas → *Volume* → attach it to the service, mount path **`/data`**.
2. **Variables:** set everything from `.env` except `PORT` and `DATA_DIR`. Railway injects `PORT`, and the
   Dockerfile sets `DATA_DIR=/data`.
3. **Networking:** *Generate Domain* gives you `https://<name>.up.railway.app`. Set it as `PUBLIC_BASE_URL`.
4. **Settings:** keep **Serverless / app sleeping OFF**, since webhooks need an always-on server.
   `railway.json` already sets the health check to `/healthz`.

Redeploy after any change with `railway up`. A redeploy causes a few seconds of downtime, which is harmless:
Meta retries webhooks for 36 h, and the poller catches up any comment from the last 7 days.

## 5. Meta developer portal setup (exact steps)

Dashboard labels drift occasionally. If a label below doesn't match, record what you actually saw in the
Findings log (§11).

**A. Create the app**
1. <https://developers.facebook.com/apps> → **Create app**.
2. App details: name "IG DM Bot" plus your contact email.
3. Use cases: **Manage messaging & content on Instagram**.
4. Business: connect your **business portfolio** if you have one. Business Verification (needed for App
   Review, §7) is done on the portfolio.
5. Finish → **Create app**.

**B. App settings → Basic**
- Privacy policy URL: `https://<your-app>.up.railway.app/privacy`
- Terms of Service URL: `https://<your-app>.up.railway.app/terms`
- User data deletion → *Data deletion instructions URL*: `https://<your-app>.up.railway.app/data-deletion`
- App icon (1024×1024) and category.
- Note the **App secret** here. This is the *Meta* app secret: optional, and goes in `META_APP_SECRET`.

**C. Use cases → Customize "Manage messaging & content on Instagram" → API setup with Instagram login**
1. Click **Add required messaging permissions**, and make sure `instagram_business_basic`,
   `instagram_business_manage_messages` and `instagram_business_manage_comments` are all listed.
2. Copy the **Instagram app ID** and **Instagram app secret** into `IG_APP_ID` / `IG_APP_SECRET`. These are
   *not* the Meta app ID and secret.
3. **3. Set up Instagram business login → Business login settings:**
   - OAuth redirect URI: `https://<your-app>.up.railway.app/auth/callback`
   - Deauthorize callback URL: `https://<your-app>.up.railway.app/meta/deauthorize`
   - Data deletion request URL: `https://<your-app>.up.railway.app/meta/data-deletion`

**D. App roles → Roles → Add People → Instagram Tester**
- Add **your own account** and a **second test account**. The test account plays the commenter while you're on
  Standard Access; switch it to a free professional account if the invite refuses a personal one.
- Each account accepts the invite in the Instagram app: **Settings → Apps and websites → Tester invites**.
  Until it's accepted, login bounces with an error.

**E. Get the long-lived token.** Pick one:
- In **1. Generate access tokens** → *Add account* → log in as your account → **Generate token**. This gives
  a 60-day token; put it in `IG_ACCESS_TOKEN`.
- Or open `https://<your-app>.up.railway.app/` → **Log in with Instagram**. This is the Business Login flow;
  the bot stores the token itself. It's also the way to reconnect if the token ever dies.

Either way, the bot refreshes the token weekly (Meta allows a refresh once the token is ≥ 24 h old) and
subscribes the account to webhooks.

**F. 2. Configure webhooks**
1. Callback URL: `https://<your-app>.up.railway.app/webhook`; Verify token: your `WEBHOOK_VERIFY_TOKEN`.
   Click **Verify and save**.
2. Subscribe to the fields **`comments`**, **`messages`** and **`messaging_postbacks`**.
3. Run `npm run subscribe` (this calls `POST /me/subscribed_apps`). The bot also does this automatically
   whenever it adopts a token.
4. The dashboard **Test** button should get a 200. `/health` → `webhooks.sig_secret_used` then shows which
   secret signed it.

**G. On the phone (Instagram app, as your account)**
- Settings → Messages and story replies → Message controls → **Connected tools → Allow access to messages: ON**.
- The account must stay **public**; Meta sends no comment webhooks for private accounts.

**H. Go Live**
- Complete **Data Use Checkup** (App Dashboard → the prompt, or *Requirements*). It's required before Live
  mode, and then yearly.
- Switch the app mode to **Live**. Meta only sends webhooks to Live apps; `messages` webhooks work for
  testers even before App Review.

## 6. Rollout (never skip a step)

**The app must be Live before anything works.** In Development mode the comments API returns empty pages
for everyone. Checked 2026-10-01: a reel with 489 comments returned 0, and a comment from an accepted
Instagram Tester was hidden too. So do §5 H (go Live) before step 1.

Whether a Live app on Standard Access can see the public's comments and DM non-testers is still open.
One developer report says DMs to non-testers fail until App Review. The tester loop below answers it;
record the result in §11.

| Step | Settings | What to check |
|---|---|---|
| 1. Tester loop (app Live, Standard Access) | `DRY_RUN=false`, `ALLOWLIST=<test account>`, `POLL_PROFILE=primary` | The test account comments the keyword → the DM arrives (usually in Requests) → reply → the link arrives. A second comment on the same reel gets no second DM, STOP works, and your own comments are ignored. Also note in §11 whether the public's comments show up in `/admin` as `not_allowlisted`. |
| 2. Canary with a non-tester | add one ordinary account to `ALLOWLIST` | Passed on 2026-10-05, so App Review (§7) is **not needed**. It would only be needed if DMs to non-testers started failing with error 100/2534001. |
| 3. Dry run on real traffic | `DRY_RUN=true`, `ALLOWLIST=` empty | Run this as soon as public comments are visible. For 1–2 days, `/admin` shows who *would* be DMed while ManyChat keeps answering. Compare the two. The dry run uses its own database, so it never blocks live sends later. |
| 4. Cutover | `DRY_RUN=false` | ① turn off ManyChat's comment automations **and** its default DM reply · ② set `BACKFILL_SINCE` to the current time (so comments ManyChat already answered aren't re-processed) and `ALLOWLIST=<one real follower>` as a canary · ③ once the canary works, clear `ALLOWLIST` · ④ `POLL_PROFILE=backup` · ⑤ optionally `PUBLIC_REPLIES_ENABLED=true` · ⑥ after 48 h with no problems, disconnect ManyChat |

## 7. App Review + Business Verification

**What to request:** Advanced Access for `instagram_business_basic`, `instagram_business_manage_comments` and
`instagram_business_manage_messages`. Meta wants at least one successful API call per permission first,
and the tester loop in step 2 provides that.

**Business Verification:** Meta's permissions reference says Advanced Access requires it. Verify your
business portfolio (Business settings → Security center → *Start verification*). A sole proprietorship
works; you'll need a registration or tax document or a utility bill in the business name. Start it early,
because it's the slowest step.

**Screencast script** (English UI, one continuous recording per permission is fine, with narration or captions):
1. Open `https://<your-app>.up.railway.app/`, click **Log in with Instagram**, show the consent screen
   listing the permissions, then show the "Connected as @your_account" page (`instagram_business_basic`).
2. On a phone logged in as the test account, comment **SKILL** on a reel.
3. Show `/admin` listing the new lead, which is the comment being read (`instagram_business_manage_comments`).
4. Show the private-reply DM arriving in the test account's inbox or Requests (`manage_comments` + `manage_messages`).
5. The test account replies; show the link DM arriving (`instagram_business_manage_messages`).
6. If enabled, show the public reply under the comment (`instagram_business_manage_comments`).

**Reviewer notes to paste:** *"Single-business tool for our own Instagram account (@your_account). When a
person comments a keyword on our post, we send one private reply via the Private Replies API. Only if the
person responds do we send the requested link, inside the 24-hour window. We never message anyone who did
not comment a keyword. Test: log in at <URL> with the provided tester credentials, comment SKILL on
<reel URL>, reply to the DM."*

Review can take days to weeks, and a first rejection is common. Fix whatever the reviewer names and resubmit.

## 8. Notion lead mirror (optional)

1. Create an internal integration at <https://www.notion.so/profile/integrations> and copy its token into
   `NOTION_TOKEN`.
2. Create a database named **IG Leads** with exactly these properties:

   | Property | Type |
   |---|---|
   | Name | Title |
   | Status | Select |
   | Keyword | Select |
   | Mode | Select |
   | Reel | URL |
   | Profile | URL |
   | Comment | Text |
   | Commented | Date |
   | DM sent | Date |
   | Replied | Date |
   | Link sent | Date |
   | Error | Text |

3. In the database, go to **••• → Connections** and add the integration. Put the data source id in
   `NOTION_DATA_SOURCE_ID`.

Each lead gets one page, updated as its state changes. The IGSID is never copied to Notion. A
"delete my data" request moves the person's pages to trash. The privacy page names Notion as a service
provider whenever the mirror is on.

The Status column uses plain labels: Queued, Intro sent, Replied, Link sent, Intro failed, Link failed,
Intro unconfirmed, Link unconfirmed, Expired after 7 days, Missed 24h window, Skipped, Opted out
(`STATUS_LABELS` in `src/notion/mirror.ts`). New keywords appear as new Keyword options automatically.

## 9. Operations

| Endpoint | Auth | Use |
|---|---|---|
| `GET /healthz` | public | Liveness: `{status, version, uptime_s}`. Always 200 while the DB answers. |
| `GET /health` | admin | Full status (see below). |
| `GET /admin` | admin | Phone-friendly status plus the last 50 leads. In a browser, use HTTP Basic with any username and `ADMIN_TOKEN` as the password. |
| `GET /admin/leads.csv`, `/admin/stats` | admin | Lead export (formula-safe), and funnel JSON. `npm run leads:export`, `npm run report`. |
| `POST /admin/pause`, `/admin/resume` | admin | Kill switch for all sending and polling. |
| `POST /admin/rescan` `{"since": ISO}` or `{"hours": 24}` | admin | Re-reads comments and re-decides ones whose keyword didn't exist yet (max 7 days back). |
| `POST /admin/delete-user` `{"username"}` | admin | Deletes everything about a person, including their Notion rows. |
| `POST /admin/unsuppress` `{"username"}` | admin | Undo a STOP. |
| `POST /admin/subscribe` | admin | Re-subscribe the webhook fields. |

**`/health`** reports:
- `status` (ok / degraded / down) with `reasons`
- token state and days left
- last webhook received (all / comments / inbound), signature failures, which secret matched
- poller activity and `missed_by_webhook_24h`
- queue depth and throttling
- **today (JST)**: matched, intros, links, public replies, failed, and `comment_deleted` (public replies
  skipped because the person deleted their comment after the DM; these are not failures)
- **rate-limit utilization**: DM bucket vs. its cap, public bucket, Meta's 750/h private-reply limit, and
  Meta's last usage header
- the 7-day funnel per keyword and reel, and the Notion backlog

**Logs:**
- pino JSON on stdout (Railway → Deployments → Logs).
- Every send logs `"<kind> sent"` or `"<kind> failed"` with the exact request and the exact Meta error
  payload (`code`, `error_subcode`, `fbtrace_id`). The same data is stored in `send_attempts` (kept 90 days).
- Tokens, secrets, auth headers and query strings are redacted.

**Automatic chores:**
- Token refresh every week (alerts if the token dies or has under 7 days left).
- Retention: non-lead comments 14 days, send log 90 days, leads `LEAD_RETENTION_DAYS`.
- A daily SQLite backup to `/data/backups` (7 kept).

## 10. Troubleshooting

| Meta error | Meaning | Bot does |
|---|---|---|
| 100 / 2534001, or 200 | Recipient isn't a tester and the app has no Advanced Access | Marks the lead `dm_failed` (not_approved) and alerts. → App Review (§7) |
| 10 / 2534022, 2018278 | Outside the messaging window | Lead becomes `expired` / `window_expired` |
| 10900, 100 / 2534025 | Comment already got its one private reply (e.g. from ManyChat) | Lead becomes `dm_unknown`; a reply still releases the link |
| 551, 100 / 2534014 | Person unavailable / blocked | Lead becomes `dm_failed` |
| 4, 17, 32, 613, 80002 | Rate limited | Pauses until Meta's ETA, without burning a retry |
| 368 | Temporarily blocked (spam signal) | Public replies off for 24 h, or DMs paused 1 h; alerts |
| 190 | Token invalid | Pauses everything and alerts. Reconnect at `/auth/login` |
| 100 / 33 ("Object with ID … does not exist") | The comment is gone, usually because the person deleted it | **Public reply:** skipped quietly (`public_state: comment_gone`, counted as `comment_deleted`, not as a failure). **Intro:** the lead becomes `dm_failed`, because no DM was delivered. If most public replies end this way, `/health` goes `degraded` with `public_replies_comment_gone`: that pattern means Meta is refusing the replies (check the token's comment permission), not people deleting |

- **No comments arriving?** Before App Review that's expected: the poller (`/health` → `poller`) is the
  source. After approval, check the app is **Live**, the account is **public**, and `npm run subscribe`
  succeeded.
- **403 on every webhook?** `IG_APP_SECRET` is wrong or missing. Also set `META_APP_SECRET` if Meta signs
  with the Meta app secret for your app (`/health` → `sig_secret_used`).

## 11. Findings log (fill in during the tester phase)

| Question | Answer |
|---|---|
| Does the private reply's `recipient_id` equal the comment's `from.id`? | Yes. Both were the same id for the tester (2026-10-05). |
| Does the private reply's `recipient_id` equal the DM `sender.id`? | The Conversations API lists the tester under the same id, so all three ids match (2026-10-05). |
| Do `comments` webhooks arrive on Standard Access once Live? | Yes: a comment webhook was processed at 09:16:46Z on 2026-10-05, minutes after publishing, with no Advanced Access. Message, echo and read webhooks arrive too. |
| Error code for a second private reply to the same comment | |
| Is a button template accepted inside a private reply? (If so, consider an intro button.) | |
| Which secret signs the webhooks (`sig_secret_used`)? | The **Instagram app secret** (`sig_secret_used: "instagram"`, 2026-10-05). `META_APP_SECRET` isn't needed. |
| Does v26.0 behave (`GRAPH_VERSION`)? | Yes. `GET /me`, `/me/media` and `/<media>/comments` all answer on v26.0 (2026-09-29). `/me` reports `account_type: MEDIA_CREATOR`. |
| In **Development mode**, what does the comments API return? | Nothing: empty pages with a next cursor, on v24–v26, whatever fields are requested. 0 of 489 public comments, and a tester's comment was hidden too (2026-10-01). `/me/conversations` behaves the same way. The poller stops at an empty page. |
| What does the dashboard say about App Review? | Step "5. Complete app review" on the API setup page carries this note (2026-10-05): "You can skip this step if you're a direct developer who only builds for your own Instagram businesses and don't plan to create solutions for clients." So App Review may not be needed for this single-account bot. Confirm with a DM to a non-tester once Live. |
| Once **Live** on Standard Access, are public comments visible? Do they include `from`/`username`? | Yes to both, with no App Review (2026-10-05): full pages of 50, every comment with `from.id` and a username. `/me/conversations` returns data too. A private reply to the **tester** worked on v26.0. |
| Does the full loop work in production with a tester? | Yes (2026-10-05, Railway, Standard Access). Intro sent 09:16:51Z; the tester replied "Yep!" at 09:21:19Z; the Skool link went out at 09:21:25Z, 6 s later. |
| Once Live on Standard Access, does a private reply to a **non-tester** work? | Yes (2026-10-05). An ordinary account (allowlisted, not a tester) commented SKILL. The lead arrived by **webhook** at 09:31:14Z, the intro went out at 09:31:27Z, the reply came at 09:31:41Z and the link went out at 09:31:46Z. No App Review. |
| Does the public reply work? | Yes (2026-10-05). Comment at 09:45:52Z, intro at 09:45:59Z, and "Check your DMs, it's in there" posted under the comment at 09:46:39Z, 40 s after the DM. Public replies are on for every keyword by default (`defaults.publicReply`). |
| Does the Notion mirror work? | Yes (2026-10-13). After `NOTION_TOKEN` was set and deployed, the three existing leads appeared in IG Leads within about 15 s, with the right statuses ("Intro sent", "Link sent"), keyword, reel link and timestamps. |
| Does the token refresh itself? | Yes. Seeded on 2026-10-01 and refreshed automatically 24 h later; `/health` showed 57 days left on 2026-10-05. |
| What happens when the commenter deletes their comment after the DM? | The public reply fails with **100 / 33** (`IGApiException`, "Object with ID … does not exist, cannot be loaded due to missing permissions, or does not support this operation"). Seen on the first real lead (2026-10-13, SONNET): comment 03:53:51Z, intro 03:54:03Z, their reply 03:54:21Z, link 03:54:27Z, public reply refused at 03:55:16Z. A `GET` of that comment id returned the same error, while a top-level comment and a threaded reply on the same reel both loaded, and the id was missing from the reel's newest 500 comments. So the comment was gone, not unsupported. The DM and the link were unaffected. Being a reply inside a thread doesn't explain it either, since those load fine. (Whether a public reply can be posted under a threaded reply is still untested.) |
| Dashboard labels that differed from §5 | |

## 12. Policy notes

- **Private replies:** one per comment, text only, within 7 days. **Follow-ups:** only after the person
  replies, within 24 h. Promotional links are allowed inside that window.
  ([Private Replies](https://developers.facebook.com/docs/instagram-platform/private-replies/))
- **No follow-gating.** Meta's spam policy names it. Always deliver exactly what the caption promises.
- **Opt-out** (STOP) and **deletion** ("delete my data") work automatically. Every message says it's
  automated, as some jurisdictions require.
- **Data:** kept only as long as needed (retention above) and never sold or shared beyond Railway, Notion
  and Meta. Complete the **Data Use Checkup** every year or the app loses access.
- **Rate:** Meta publishes 750 private replies/h. The bot caps itself at 190/h with jitter, and public
  replies at 30/h.
