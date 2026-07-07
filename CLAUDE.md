# Project context for Claude Code

This file gives a new Claude Code session enough context to be useful
immediately. Read this first before making changes.

## What this app is

A React+Vite single-page app for designing and generating AI influencers.
Local-first: every user's data lives in their own browser localStorage.
Image and video generation happens through the user's own Higgsfield
account (OAuth, PKCE).

## Tech stack

- **React 18** + **Vite 5** + **React Router 6**
- **No build-time API keys** — Higgsfield is OAuthed per-user; the optional
  Claude features call through a serverless proxy that expects an
  `x-api-key` header from the browser.
- **Vercel** is the intended host: `api/*.js` are Vercel serverless
  functions, and `vite.config.js` mirrors them as local dev proxies so
  the dev server behaves the same as production.

## Key files to know

| Path | What it does |
|---|---|
| `src/App.jsx` | Routes + `<ThemeProvider>` + `<StoreProvider>` |
| `src/store.jsx` | localStorage-backed contexts (`useInfluencers`, etc.) and the `Kayla` seed |
| `src/utils/higgsfieldAuth.js` | OAuth PKCE flow against `mcp.higgsfield.ai` |
| `src/utils/higgsfieldGenerate.js` | MCP-style image/video generation, polling, media uploads |
| `src/utils/systemPrompt.js` | Prompt templates — poses, wardrobe library, vibe palettes, Soul vs GPT Image 2 variants |
| `src/pages/Create.jsx` | Multi-step influencer creation wizard |
| `src/pages/Influencers.jsx` | Influencer profile + Content Studio + Video Studio (very large — known structural debt) |
| `api/hfproxy.js` | Edge function that proxies all Higgsfield MCP traffic and forwards SSE streams. `/api/hf/*` is routed here by the `vercel.json` rewrite (sub-path passed as `__hfpath`); it enforces the path allowlist and rate limiting |
| `api/claude.js` | Anthropic API proxy — caller supplies their own `x-api-key` |

## Persona agent (`agent/`) and `shared/`

`agent/` is the X persona agent — a separate Node/TypeScript workspace in
this monorepo (own `package.json`, own vitest suite; the pre-commit hook
runs it when `agent/node_modules` exists). It runs personas' X presence:
drafting via Claude, Telegram approval queue, posting through the X API.
Design spec: `docs/superpowers/specs/2026-07-05-x-persona-agent-design.md`.
Execution is tracked in Linear (project "X Persona Agent", HEX-18..34).

- **Deploy target is Hetzner via systemd** (`agent/deploy/persona-agent.service`),
  never Vercel — `.vercelignore` excludes it.
- **Local dev needs no secrets:** `cd agent && npm install && npm run smoke`
  loads the Kayla example soul sheet, opens a WAL SQLite DB under
  `agent/data/`, and dry-runs a publish through DemoAdapter.
- **Full runbook is `agent/README.md`** — Telegram bot setup, X OAuth
  (`tools/x-oauth.ts` → `data/accounts.json`), daemon modes
  (`DEMO_MODE=1`, `--once`), Telegram commands (`/status /pause /resume`,
  `/post <exact text>`, `/draft <hint>` → approval card), headless-server
  OAuth via SSH port forward. Never `rm -rf agent/data/` — the OAuth
  tokens live there next to the disposable `.db` files.
- `shared/soul-sheet/schema.json` is the language-neutral source of truth
  for soul sheets; app editor and agent loader both validate through
  `shared/soul-sheet/validate.js`. Schema changes must keep it valid JSON
  Schema (a future Go agent generates types from it).
- **DB discipline:** all SQL lives in `agent/src/storage/db.ts` only — plain
  SQL types + JSON text columns, every table keyed by `persona_id` +
  `owner_id` (makes SQLite→Postgres and multi-tenant SaaS mechanical).
- **Compliance is structural:** `PlatformAdapter` has no like/follow/DM
  methods and the pillar enum has no commercial pillar. Don't add them.
- Secrets (X tokens, Claude key, Telegram token) live only in
  `/etc/persona-agent/env` on the server or a local gitignored `agent/.env`
  (see `agent/.env.example`) — never in the browser app or the repo.

## Deeper docs (read when relevant, not preloaded)

- `docs/gpt-image-2-engine.md` — prompt engine for photorealistic
  influencer images on GPT Image 2: skin-realism block,
  anti-beauty-filter framing, sectioned prompt format.
- `docs/photo-studio-influencer-guide.md` — reference-driven editing
  with GPT Image 2 (`@image1` identity, `@image2` outfit); prompts stay
  short and directive, never re-describe the refs.
- `docs/seedance-influencer-guide.md` — Seedance 2.0 video prompt rules
  (talking, movement, pauses, realism), distilled from real failures.

Agent skills for Higgsfield workflows live in `.agents/skills/`
(cross-tool location, pinned by `skills-lock.json`) and are symlinked at
`.claude/skills` so Claude Code discovers them.

## Conventions

- Inline styles with CSS variables (`var(--bg)`, `var(--text-primary)`).
  Theme tokens are set on `<html data-theme="dark|light">` from
  `src/context/theme.jsx`.
- IDs use `generateId()` from `store.jsx` (`Date.now() + random`).
- Higgsfield models supported: `soul_2`, `gpt_image_2`, `nano_banana_2`,
  `nano_banana_flash`, `seedance_2_0`. Soul has its own simplified
  pose set (`POSES_SOUL`) because it struggles with detailed spatial pose
  instructions.

## Things not to do

- **Never kill the Vite dev server** (port 5173). The owner wants it
  running at all times.
- Don't trust the comment in `modelBaseParams` saying resolution and
  quality conflict for `gpt_image_2` — they don't, the working code
  intentionally passes both.
- Don't refactor `Influencers.jsx` casually. It's 4,700+ lines and the
  state is tangled; any split needs its own dedicated session with
  in-browser verification of every flow.
- **Never bypass local history or the pre-commit hook.** Commits go
  through local git so `.githooks/pre-commit` runs the test suite —
  no `--no-verify`, and no GitHub MCP file-push APIs (`push_files`,
  `create_or_update_file`) that write to the remote directly. Use the
  MCP for PRs, issues, reviews, and verification; use local git to
  commit and push.
- **Never commit without asking the user first.** If you think a commit
  should happen, ask — the user will review the changes and approve the
  commit. This applies to checkpoint/incremental commits during multi-step
  work too, not just final ones.

## Dev workflow

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production build
npm run preview      # preview the production build locally
```

To diagnose Higgsfield issues, flip `HF_DEBUG = true` at the top of
`src/utils/higgsfieldGenerate.js` for verbose request/response logs.
