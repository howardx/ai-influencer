# Codebase review — 2026-07-02

Full-repo critical review run with the security-review, code-review, and
typescript-lsp plugins over `src/`, `api/`, `lib/`, `vite.config.js` (not just
the working-tree diff). Method: security-review (multi-agent sweep + FP filter),
code-review at high effort (8 finder angles → 16 candidates → 16 independent
verifiers, **all 16 CONFIRMED**), and `tsc --checkJs` + LSP diagnostics.

Line numbers reflect the tree at commit `b9eb5b7`; re-verify before acting.

## Executive summary

Works in the happy path, fragile in persistence, concurrency, and the dev/prod
boundary. Three root causes drive most confirmed bugs:

1. **localStorage treated as a reliable database** — no multi-tab coordination,
   no quota handling, stores multi-MB base64 images. Causes silent data loss and
   an infinite reload loop.
2. **Copy-paste instead of shared functions** — the Higgsfield proxy exists
   twice, download logic 4×, the job-polling loop 4×, character-sheet generation
   3×. Fixes land in one copy; the others drift. The 429-retry fix protects OAuth
   but not generation traffic, and one of two proxy copies has no rate limiting.
3. **No type checking or linting** — `tsc --checkJs` flags implicit `any` on
   nearly every parameter; LSP found ~25 unused declarations. Nothing catches the
   positional-arg / wrong-shape bugs at author time.

Only **one security issue** survived verification (dev-server SSRF). Production
API functions are reasonably guarded: proper PKCE with state validation, host
allowlist, origin-checked postMessage, tokens in headers not URLs.

---

## P0 — Broken in production or destroys user data (fix first)

1. **Multi-tab edit wipes influencers** — `src/store.jsx:106`. Persist effect
   `removeItem`s every `hf_influencer_*` key not in *this tab's* in-memory list.
   Create in tab A, edit in tab B → A's influencer + media deleted on next write.
   Fix: write only the changed record; never blind-delete unknown keys; add a
   `storage`-event listener to reconcile tabs.

2. **Infinite reload loop when localStorage is full** — `src/store.jsx:516`.
   `writeIds`/`writeInfluencer` swallow `QuotaExceededError`, but the seed effect
   sets `didWrite = true` unconditionally and calls `window.location.reload()`
   with no once-guard. Full storage → seeds never persist → reload forever.
   Fix: reload only if writes succeeded; gate behind a `sessionStorage` one-shot.

3. **Downloading any generated media returns 403 in prod** — `api/img-proxy.js:2`.
   `ALLOWED_HOSTS` omits `*.cloudfront.net`, where Higgsfield serves results
   (`higgsfieldGenerate.js:596` extracts exactly those URLs). Masked in dev (no
   allowlist there). Fix: add the CloudFront host.

4. **img-proxy double-decodes the URL** — `api/img-proxy.js:39`. `req.query.url`
   is already decoded by Vercel, then `decodeURIComponent` is applied again.
   Breaks signed CDN URLs (`%2F`→`/`) and throws on any bare `%`. Fix: remove the
   redundant decode.

5. **Duplicate proxy leaves the expensive route unthrottled** —
   `api/hf/[...path].js` vs `api/hfproxy.js`. Two ~60-line near-copies; only
   `hfproxy.js` rate-limits. Vercel resolves filesystem routes before the
   `vercel.json` rewrite, so the un-rate-limited catch-all likely serves traffic —
   the PR #2 429 fix is effectively dead. Fix: delete one copy, extract the shared
   handler to `lib/`, update CLAUDE.md (documents the wrong file as canonical).

6. **Dev server is an open SSRF proxy** *(security, MEDIUM, confidence 8/10)* —
   `vite.config.js:52`. Dev `img-proxy` fetches a fully attacker-controlled URL
   with no protocol/host check and returns it with `Access-Control-Allow-Origin:
   *`. While a dev runs `npm run dev`, a malicious page in the same browser can
   `fetch('http://localhost:5173/api/img-proxy?url=http://169.254.169.254/…')` and
   read internal/localhost/cloud-metadata responses cross-origin. Fix: reuse the
   production `isSafeUrl` guard in the dev mirror (also fixes the CLAUDE.md
   "dev mirrors prod" claim).

---

## P1 — Correctness & UX bugs that lose work or mislead

7. **Concurrent generation force-logs-out the user** —
   `higgsfieldGenerate.js:1003`. Pose previews fan out 13 parallel MCP calls; on
   mid-batch token expiry each calls `refreshHFToken` (no shared in-flight lock),
   losers reuse a rotated refresh token, get 400, `disconnectHF()` wipes the
   session. Fix: module-level single-flight refresh promise; serialize the fan-out.

8. **One failed reference upload silently corrupts the prompt** —
   `higgsfieldGenerate.js:902`. `uploaded.filter(Boolean)` compacts the media
   array, but `@image1/@image2/…` tags were assigned positionally, so every tag
   after the failed slot points at the wrong image — wrong output, no error. Fix:
   keep slot positions stable, or fail the batch explicitly.

9. **Corrupted pending-job key permanently crashes generation** —
   `higgsfieldGenerate.js:29`. Five `JSON.parse(localStorage…)` helpers have no
   try/catch (the adjacent media cache does), and parse runs before any overwrite,
   so a bad value never self-heals. Fix: wrap all five, matching the media-cache
   pattern.

10–12. **Resume/cancel lifecycle inconsistent across flows** (video path careful,
   image paths not; a resumed video path re-breaks it):
   - `src/pages/Influencers.jsx:399` — character-sheet/close-up resume polls with
     no cancellation hook; Cancel + manual replace gets silently overwritten by a
     late `onSave`.
   - `higgsfieldGenerate.js:872` — `generateSingleImage` clears the pending record
     in `finally` even on CANCELLED (video code guards this); latent today.
   - `src/pages/Influencers.jsx:3967` — ContentStudio video resume clears the
     pending entry unconditionally; navigating away during a *resumed* poll
     permanently loses a finished (paid) video.
   - `src/pages/PhotoStudio.jsx:554` — resume polls without `initSession()`; after
     a reload every poll fails and the batch falsely reports "timed out".
   - `src/pages/PhotoStudio.jsx:752` — panel not keyed per influencer (sibling
     ContentStudio is); switching influencers mid-generation lets one `finally`
     clobber another's guard, spawning duplicate batches.
   Fix: one shared generation-lifecycle hook (start → persist pending →
   poll-with-cancel → resume → clear) parameterized per media type; add
   `key={influencer.id}` to `PhotoStudioPanel`.

13. **White-on-white button** — `src/pages/AuthCallback.jsx:57`. `background:
   var(--text-primary)` + `color: '#fff'` unreadable in the default dark theme
   (OAuth-error screen). Fix: use theme tokens per the CLAUDE.md rule.

---

## P2 — Architecture (the debt generating the bugs above)

- **Dead `staleTolerance` param** — `higgsfieldGenerate.js:664`: callers compute
  per-model timeouts that `pollAllJobs` ignores (bound `_staleTolerance`); slow
  Soul jobs time out at a hard 60-round cap. Symptom of **four copy-pasted polling
  loops** (`pollAllJobs`, `pollVideoJobs`, inline in `generateNImages`,
  `generatePosePreviews`) already diverged (soft-terminal CDN-lag retry in only
  one). Collapse to one poller parameterized by terminal-set / retry / extractor.
- **Per-model logic scattered across 5 files** (`modelBaseParams`,
  `MODELS`/`maxRefs`, `MODEL_EST_MS`, prompt forks, hardcoded `'seedance_2_0'`).
  Replace with a single `MODEL_CAPS` table.
- **429/5xx retry at the wrong layer** — `higgsfieldGenerate.js:125`: `mcpPost`
  throws hard and ignores the `Retry-After` the proxy sets. Move retry into the
  shared fetch layer.
- **Duplication to collapse:** `downloadImage` (4 copies — 3 lack the CORS-proxy
  fix), `Lightbox` (3 forks), `handleFiles`/file-ingestion (2 identical),
  character-sheet generation (3 copies), the ~200-line
  `CharacterSheetSlot`/`CloseUpSlot`/`MainImageSlot` triplet.
- **Config-per-field explosion:** ContentStudio parses the same localStorage key
  15× into 15 `useState` hooks (`Influencers.jsx:3777`); PhotoStudio repeats it.
  One settings object (or `useReducer`) removes four hand-synced parallel lists.
- **`annotateDialogue` takes 9 positional args** ending in three pronoun strings
  with a `his = 'her'` trap default (`Influencers.jsx:2888`) — transposing any two
  compiles silently. Convert to an options object.

## P2 — Performance

- **Every keystroke re-serializes the entire store** — `store.jsx:100` +
  `Influencers.jsx:6310`: text inputs write through the global context per
  character; the persist effect `JSON.stringify`s every influencer (base64 blobs
  included) and GC-scans all localStorage keys. Buffer inputs locally, commit on
  blur/debounce, write only the changed record.
- **No memoization** in a 6,391-line component: any state change re-renders the
  whole tree. Memoize heavy sections once inputs are debounced.
- **Polling ignores `poll_after_seconds`** and re-polls delivered jobs — hundreds
  of redundant serverless invocations per video batch. `img-proxy.js:47` buffers
  whole videos into memory and caches immutable CDN assets for only 1h; stream and
  set `immutable`.

## P3 — Tooling & hygiene (prevents recurrence)

- **No type safety:** add `@types/react`/`@types/react-dom`, a `jsconfig.json`
  with `checkJs`, wire `tsc --noEmit` into CI. Would have caught #4, #8, and the
  `annotateDialogue` risk at author time.
- **No linter:** add ESLint + `eslint-plugin-react-hooks` (exhaustive-deps /
  rules-of-hooks target the stale-closure/lifecycle bugs above). LSP already found
  ~25 unused declarations to delete (`ImageGrid`, `MasonryGrid`,
  `VIDEO_TEMPLATES`, `applyTemplate`, …).
- **`lib/rateLimit.js`** uses an in-process `Map` — each serverless instance gets
  its own budget, near-useless under concurrent load. Use Vercel KV / Upstash if
  rate limiting matters.

---

## Suggested sequencing

1. **P0 (findings 1–6):** small, surgical; each is active data loss or
   broken-in-prod. ~1 day total.
2. **P1:** the shared generation-lifecycle hook (fixes 10–12 at once) plus 7–9, 13.
3. **P2 refactors:** guarded by the new lint/type CI from P3. CLAUDE.md warns
   `Influencers.jsx` needs in-browser verification of every flow — do that in its
   own session.
4. **P3 tooling:** land anytime, ideally before the P2 refactors so they're
   type-checked.

## Method notes

- code-review: all 16 verified candidates were CONFIRMED (none refuted). Six were
  cut from the skill's top-10 cap but are captured above: img-proxy double-decode
  (#4), `mcpPost` missing 429 retry, per-keystroke store rewrite, dead
  `staleTolerance`, PhotoStudio cross-influencer race, white-on-white button.
- security-review: production functions well-guarded; only the dev SSRF (#6)
  survived the false-positive filter (confidence 8/10, MEDIUM — dev-only, needs
  social engineering).