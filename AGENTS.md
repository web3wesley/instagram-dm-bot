# AGENTS.md

Self-hosted Instagram comment-to-DM bot for one Instagram professional account (the owner's own). It uses
Meta's Instagram API with Instagram Login and runs on Railway. Start with README.md: "What you need to sign
up for", then §2 to §6 in order.

## Commands

```
npm test            # vitest — must pass before any deploy
npm run typecheck   # tsc 7 --noEmit (TS runs natively on Node 24, no build step)
npm run status      # plain-language report from the LIVE bot (counts since go-live + health)
npm run report      # funnel per keyword and reel from the live bot
npm run dev         # local server with .env, pretty logs (keep DRY_RUN=true locally so it never sends)
npm run simulate -- "LINK please" --user tester_one   # signed fake webhook → local bot
npx -y @railway/cli@latest up --service <your-service> --ci   # deploy this folder
```

## Setting it up for a new owner

- `.env` comes from `.env.example`, `triggers.json` from `triggers.example.json`. Both are the owner's to
  fill in: walk them through it, but let them type secrets (app secret, tokens) into `.env` themselves.
  Never put secrets in `.env.example`, `triggers.example.json` or git.
- Follow README §5 for the Meta dashboard and §6 for the rollout, in order. The app must be **Live**
  before any comment shows up (§6), and the rollout starts with `DRY_RUN=true` and an `ALLOWLIST`.
- Record what the owner actually saw in the Meta dashboard in README §11 when a label differs.

## Hard rules

- **Nothing may ever DM someone who didn't comment a trigger keyword.** The only send paths are:
  - the intro private reply to a matching comment (worker `private_reply`);
  - the link to someone who replied (worker `link`);
  - the optional public reply.

  Never add a generic "send a DM" endpoint or script.
- **Ask the owner before writing or changing `.env` or Railway variables.** Never invent credentials or
  placeholders; generate random tokens only when they say so.
- **Meta limits are encoded in `src/core/rules.ts` and the worker.** They are: one private reply per comment
  within 7 days (166 h cutoff), a link only within 24 h of their message, and hourly caps. Don't relax them.
- **Public replies** need at least 2 variants, may never contain links, and pause on error 368.
- **Keep the brief-mandated tests green:** keyword matching (`test/match.test.ts`), dedupe
  (`test/ingest.test.ts`), the 7-day rule (`test/rules.test.ts`) and signature validation
  (`test/signature.test.ts`).
- **`triggers.json` is data.** Change it, run `npm test` (which validates the file), then deploy. If a reel
  was already live before its keyword existed, follow with `POST /admin/rescan`.
- **Verify before changing `src/meta/client.ts`.** Re-fetch the current Meta docs (Private Replies, Business
  Login, the Graph changelog) and don't trust memory for endpoint paths or versions.
- **Never put Markdown backticks inside a double-quoted shell string.** Bash runs them as commands. Edit
  files with your file-editing tool, not `node -e "..."`.
- **A deploy changes the live bot.** Deploy when the owner asked for the change (a new keyword, "make it
  live"). For a fix they didn't ask for, say what it is and why, and get their OK before `railway up`.
  Before any deploy: `npm test`, and `/health` → `queue.queued` is 0.

## Layout

- `src/core`: the pure rules (`match`, `template`, `rules`), plus `ingest` (idempotent intake),
  `worker` (send outbox), `limiter`, `poller`, `token`, `status`, `housekeeping`.
- `src/meta`: the Graph API client, error classification and the DRY_RUN wrapper.
- `src/webhook`: signature check, payload normalization, `signed_request`.
- `src/routes`: webhook, health, admin, auth (Business Login), public pages.
- `src/notion/mirror.ts`: the best-effort Notion "IG Leads" mirror.
- `src/db`: `node:sqlite` schema, migrations (append-only) and the repository. Dry-run and live use separate DB files.
- `scripts/`: `status-report.ts`, `report.ts`, `export-leads.ts`, `subscribe.ts`, `simulate.ts`, `make-icon.mjs`.
  They talk to the running bot over HTTP using `BOT_URL` and `ADMIN_TOKEN` from `.env`.

`assets/app-icon-1024.png` is a Meta app icon you can use (regenerate with `node scripts/make-icon.mjs`).
Live findings are recorded in README §11.
