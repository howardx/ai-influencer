# Persona agent

Runs an AI influencer's X presence: plans her day, drafts posts in her voice
(Claude + critic pass), queue-gates anything reactive behind Telegram ✅/❌,
and publishes through the official X API v2. Design spec:
`../docs/superpowers/specs/2026-07-05-x-persona-agent-design.md`. Execution
tracker: Linear project "X Persona Agent".

## Quick start (no secrets)

```bash
npm install
npm run smoke        # validate soul sheet, open WAL DB, one dry-run publish
```

## Full setup

Copy the template and fill it in — `.env` is gitignored, secrets never enter
the repo or the browser app:

```bash
cp .env.example .env
```

### 1. Telegram bot (approval queue + remote control)

1. In Telegram, search **@BotFather** (blue checkmark), START, send `/newbot`.
   Pick a display name and a unique username ending in `bot`.
2. Copy the HTTP API token → `TELEGRAM_BOT_TOKEN=` in `.env`.
3. Open your new bot's chat (the `t.me/...` link BotFather printed), START,
   send it any message. Then:
   ```bash
   source <(grep TELEGRAM_BOT_TOKEN .env | sed 's/^/export /')
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | python3 -m json.tool
   ```
   Read `result[0].message.chat.id` → `TELEGRAM_CHAT_ID=` in `.env`.
   Empty result? Make sure the agent isn't running (it consumes updates),
   that you messaged *your bot* (not BotFather), and send a fresh message.

### 2. Claude (drafting + critic)

`ANTHROPIC_API_KEY=` from console.anthropic.com. Without it the agent still
runs, but scheduled slots drop instead of drafting (silence over slop).

**Geo-block note (dev Mac):** Anthropic 403s authenticated calls from some
egress IPs. The agent auto-detects the `us-on` SOCKS tunnel
(`127.0.0.1:10808`) at startup and routes Claude through it — run `us-on`
BEFORE starting the agent. `AGENT_SOCKS_PROXY=<url>` forces a proxy,
`AGENT_SOCKS_PROXY=direct` disables detection. Irrelevant on Hetzner.

### 3. X credentials (only for live posting)

- App-level (once ever): `X_CLIENT_ID=` / `X_CLIENT_SECRET=` from the
  developer portal (Web App confidential client, callback
  `http://localhost:8787/callback`, permissions "Read and write" — never DM).
- Per persona (once per account): in a browser logged in as the PERSONA
  (incognito recommended), run
  ```bash
  npx tsx --env-file=.env tools/x-oauth.ts
  ```
  and approve. Tokens save to `data/accounts.json` (mode 600); rotations
  persist themselves. Verify the `authorized as: @...` line is the persona.
  Headless server? SSH port-forward: `ssh -L 8787:localhost:8787 <box>`,
  run the tool there, open the URL in your local browser.

> ⚠️ `data/` holds BOTH disposable state (`*.db`) and credentials
> (`accounts.json`). To reset a persona, delete her `.db` file — never
> `rm -rf data/`, or you delete the OAuth tokens with it and every session
> after silently falls back to the demo adapter.

## Running

```bash
DEMO_MODE=1 npx tsx --env-file=.env src/index.ts   # dry-run rehearsal, zero X spend
npx tsx --env-file=.env src/index.ts               # live (needs X creds + persona)
npx tsx --env-file=.env src/index.ts --once        # single tick, then exit
```

Demo rehearsals: isolate the state so stage props never enter the persona's
real memory, and stop the live daemon first (one bot token = one poller):

```bash
AGENT_DATA_DIR=./data-demo DEMO_MODE=1 npx tsx --env-file=.env src/index.ts
```

On start you get a "🤖 agent up" Telegram message. New accounts run in
**warm-up mode** for 14 days: 1–2 posts/day, no replies.

### Telegram commands

| Command | Effect |
|---|---|
| `/status` | run state, warm-up, followers, pending queue |
| `/pause` | kill switch — halts ALL publishing instantly |
| `/resume` | resume |
| `/post <text>` | publish EXACTLY this text now — no Claude, you are the author (policy floor still applies: banned topics, links, length) |
| `/draft <hint>` | she drafts it in-voice from your hint (critic + policy) → approval card |
| ✅ / ❌ on cards | approve (publishes after a humanizing 2–20 min delay) / skip |
| 🗑 on mirrors | delete the published post |

Unapproved cards expire on their own (replies 4h, trend takes 8h) — ignoring
the queue is always safe.

### Manual posting without the daemon

```bash
npx tsx --env-file=.env tools/post.ts "tweet text" [photo.jpg] [--as handle]
```

## Development

```bash
npm test             # vitest (also run by the repo pre-commit hook)
npm run typecheck
```

Rules that keep future migrations cheap (spec §4): every table is keyed by
`persona_id + owner_id`; ALL SQL lives in `src/storage/db.ts` (plain SQL
types + JSON text columns); adapters take credentials as constructor data;
`shared/soul-sheet/schema.json` is the language-neutral source of truth.

## Deploy (Hetzner — HEX-35)

systemd unit + install steps: `deploy/persona-agent.service`. Secrets live in
`/etc/persona-agent/env` (mode 600). The machine running the agent owns the
live `data/accounts.json` — copies elsewhere go stale as tokens rotate.
