# X Persona Agent — Design Spec

**Date:** 2026-07-05
**Status:** Approved design, pre-implementation
**Owner:** Howard

## 1. Summary

Give each AI influencer a "soul": an operated X (Twitter) presence that posts
in-character content, interacts with fans, and grows an audience — so that
when commercials are posted, they reach real followers. Built as a standalone
agent on Hetzner (Approach C: staged, shared core), with the app gaining a
Personality editor. Me-first: Howard operates one persona to prove the growth
loop; the architecture is tenancy-clean so productization is a frontend +
billing project, not a rewrite.

**Strategy in one line:** the persona is the proof, the pipeline is the product.

## 2. Goals and non-goals

Goals:

- An X persona that feels alive: consistent voice, memory, arcs, fan
  recognition — while staying inside X's automation rules.
- Hybrid autonomy: original pillar posts auto-publish; anything reactive
  (replies, quote-tweets, trend takes) is queue-gated via Telegram.
- A metrics dataset that proves (or disproves) the core hypothesis:
  **commercial reach grows with follower count** — within a 90-day window.
- Every component built product-shaped: keyed by `persona_id`/`owner_id`,
  platforms behind adapters, credentials as data.

Non-goals (explicitly out of scope):

- No auto-like, auto-follow, auto-repost, or DMs — ever. These are the
  behaviors X's 2026 ban wave targeted; they are structurally excluded
  (OAuth scopes don't include them).
- No AI-posted videos. The agent posts text and photos only. Videos =
  commercials = manual, user-triggered.
- No commercial/promo pillar in the content mixer. Commercials are a
  controlled user action via the `/commercial` command.
- No pretending to be human. The persona is a labeled, disclosed AI character.
- No multi-tenant backend, billing, or in-app queue in phase 1.

## 3. Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Operator | Me-first, then productize | Prove loop, generate case study; at scale users operate their own accounts via OAuth |
| Autonomy | Hybrid dial | Originals auto (policy-checked); replies/trend takes queue-gated |
| End goal | Prove it, then productize | The SaaS is the business; persona income is a bonus |
| Approach | C — standalone agent, shared core | First tweet in ~2 weeks, nothing important thrown away |
| Trend takes | Queue-gated initially | Highest-risk post type; flip to auto only after the safety filter earns trust |
| Commercials | Through the agent (manual command) | Lands in persona memory + metrics; replies get priority triage |
| Media | Photos only for agent posts | No TTS/voice problem; videos are commercials only |
| X integration | Direct X API v2 | ~$25/mo at our volume; aggregator webhook tier is $299/mo; we keep ban-safety dials |
| IG/TikTok later | Aggregator-backed adapters (Ayrshare Launch leading candidate) | They've passed Meta/TikTok app review; webhooks enable interactive loops there too |
| Dev account | One X developer app, many user tokens | Buffer/Hootsuite model; per-persona dev accounts = spam fingerprint + N bills |
| Scale flips | Trigger-based, not user-count-based | See §12 flip triggers (SQLite→Postgres, Telegram→in-app) |

## 4. Architecture

```
ai-influencer (existing repo, browser, local-first — unchanged philosophy)
│
│  1. "Personality" page: src/pages/Personality.jsx, route
│     /influencers/:id/personality — soul sheet editor, Claude-seeded
│     from the influencer's visual profile via api/claude.js.
│     Deliberately NOT inside Influencers.jsx.
│  2. Export soul sheet (JSON download), manual, once per revision.
│  3. "Send to persona library" on generated media → POST to agent
│     ingest endpoint (single bearer token, HTTPS).
│
▼
persona-agent (new repo, Node/TypeScript, Hetzner CX22, SQLite WAL)
│
├─ engine/      soul-sheet loader · memory · content mixer · Claude
│               drafting + critic · scheduler with jitter · policy check
├─ adapters/    PlatformAdapter interface; XAdapter now; Instagram/TikTok
│               adapters later (aggregator-backed); DemoAdapter (dry-run)
├─ queue/       queue_items table + state machine
├─ telegram/    approval cards, log channel, command surface
├─ media/       photo/video library + captions, ingest endpoint
└─ metrics/     daily_snapshot · post_metrics · action_costs · queue_stats
```

Trust boundary: the agent holds X tokens, Claude key, Telegram token in
env/secret files on Hetzner. The browser app never sees them. App→agent
media upload authenticates with a single bearer token.

Tenancy rule: every table keyed by `persona_id` and `owner_id`; adapters
take credentials as constructor data, never global env.

## 5. Soul sheet (schema v1)

Versioned JSON, edited in the app, consumed by the agent. Stable identity →
slow-changing worldview → mutable "life lately" (seeded here, then owned by
agent memory).

```jsonc
{
  "schemaVersion": 1,
  "personaId": "…", "ownerId": "…",
  "identity":  { "name": "…", "age": 24, "city": "…", "occupation": "…",
                 "backstory": "3–5 sentences max", "timezone": "…" },
  "voice":     { "tone": ["warm", "deadpan"],
                 "style": "short sentences, lowercase, rare emoji",
                 "catchphrases": ["…"],
                 "never_sounds_like": "corporate, hashtag soup, motivational-poster",
                 "examplePosts": ["5–10 in-voice anchors — the few-shot core"] },
  "worldview": { "opinions": [{ "topic": "…", "stance": "…", "strength": 0.9 }],
                 "interests": ["…"], "dislikes": ["…"] },
  "contentPillars": [
    { "name": "photo drop",         "weight": 0.35, "media": "always" },
    { "name": "gym take",           "weight": 0.30, "media": "sometimes" },
    { "name": "daily-life texture", "weight": 0.20, "media": "rarely" },
    { "name": "trend opinion",      "weight": 0.15, "media": "never", "queueGated": true }
  ],
  "boundaries": { "bannedTopics": ["politics", "religion", "health claims", "financial advice"],
                  "disclosure": "AI character — bio label + X automated-account flag",
                  "neverDo": ["DMs", "engage apparent minors", "dogpiles/drama"] },
  "rhythm":    { "activeHours": "07:00–23:30 local, quiet 13:00–15:00",
                 "postsPerDay": [2, 5], "replyBudgetPerDay": 10 },
  "seedArc":   { "currentArc": "…", "runningBits": ["…"] }
}
```

Design notes:

- `never_sounds_like` + `examplePosts` carry the voice; positive tone
  adjectives alone regress to AI-flavored engagement-speak.
- No commercial pillar exists in the schema. The mixer cannot schedule promos.
- Pillar weights are the strategy dial; audience-building content is 100%
  of automated output.

## 6. Engine

**Content mixer.** Daily post count sampled from `postsPerDay` (variance
deliberate; occasional near-silent days). Weighted pillar pick; never the
same pillar twice consecutively; photo drop requires non-empty media library,
else substitute a text pillar and Telegram-alert ("out of photos").

**Drafting.** One Claude call per post: soul sheet + example posts + memory
context (last ~15 posts verbatim, current arc, running bits) + pillar
directive. Then a **critic pass**: reject drafts that sound AI/corporate or
are boundary-adjacent; max 2 regenerations, else drop the slot. Principle:
**silence over slop** — a missed post is invisible, a bad post isn't.

**Policy check (mechanical, all posts incl. auto):** banned topics; no links
in originals ($0.20/post tier + algorithmic throttling); no @-mentions in
originals; near-duplicate similarity vs last 50 posts (X "substantially
similar" rule); length.

**Memory (SQLite, per persona):**

- `posts` — everything published incl. commercials, tagged by pillar, with
  engagement snapshots at +1h/+24h/+7d.
- `arc_state` — mutable `currentArc` + `runningBits`; a weekly "life update"
  job advances the arc; owner can nudge via `/arc`.
- `fan_notes` — per-handle notes on repeat interactors; in-context when
  drafting replies to known fans. Recognizing regulars is the cheapest
  parasocial-bond builder in existence.

**Scheduler / humanization.** Times sampled inside `activeHours` with heavy
jitter; never fixed intervals or :00/:30 grid; second-level randomness.
Approved replies publish after a further randomized 2–20 min delay.
**Warm-up mode** for new accounts: weeks 1–2 at 1–2 posts/day, no replies,
complete profile first (new-account trust ramp).

**Trend sourcing (cost-aware).** Niche RSS + Google Trends produce a free
daily shortlist; Claude picks 1–2 topics fitting her worldview; only then
spend a handful of X reads for context. Trend takes are queue-gated with
topic + draft + one-line safety note.

**Mentions & replies.** Poll own mentions every ~20 min (owned reads,
$0.001). Claude triage: skip trolls/bait per `neverDo`; draft up to
`replyBudgetPerDay`, all queue-gated. Commercial commenters get priority.

**Manual commercial path.** `/commercial` on Telegram: video + caption →
post or schedule → memory-tagged `commercial` → priority reply watching.

## 7. Approval queue and Telegram UX

State machine (per item, keyed by persona/owner):

```
draft → pending_approval → approved → published
                        ↘ rejected (reason optional, stored as voice lesson)
                        ↘ expired  (never published)
```

- **Expiry is a feature:** replies ~4h, trend takes ~8h. Stale reactions read
  as bot behavior. Zero pressure to clear the queue; silence is always safe.
- **Card:** context (target tweet, trend rationale, fan notes), draft, safety
  note, countdown; buttons `✅ Post · ✏️ Edit · 🔄 Redraft · ❌ Skip`.
- **✏️ Edit is the training loop:** `(draft, correction)` pairs accumulate as
  few-shot voice-correction examples in the drafting prompt.
- **Batching:** digests ~10:00/15:00/20:00 owner-time; immediate push only
  for trend takes and `hot`-flagged items (big-account mention, commercial
  replies lighting up).
- **Commands:** `/pause` `/resume` (kill switch — halts ALL publishing
  instantly), `/status`, `/arc <text>`, `/commercial`, `/photo`.
- **Log channel:** auto-published originals post to a muted channel with a
  🗑 fast-delete button (deletes tweet, records correction).

## 8. X adapter, compliance, costs

**Adapter.** Official X API v2 only — no scraping, no unofficial clients.
OAuth 2.0 user-context + `offline.access`; scopes limited to `tweet.read`,
`tweet.write`, `users.read` — cannot like/follow/DM even if a bug tried.

```ts
interface PlatformAdapter {
  publishPost(p: { text: string; mediaPaths?: string[] }): Promise<PostRef>;
  publishReply(p: { text: string; inReplyTo: string }): Promise<PostRef>;
  deletePost(ref: PostRef): Promise<void>;
  getMentions(since: Cursor): Promise<Mention[]>;
  getPostMetrics(refs: PostRef[]): Promise<Metrics[]>;
  getFollowerCount(): Promise<number>;
}
```

Every publish carries an idempotency key (no double-posts on retry). Chunked
media upload for commercial videos. Backoff + queue-pause on rate limits.

**Account structure.** One X developer app (Howard's, billing attached);
each persona is its own X account that OAuths the app (Buffer/Hootsuite
model — also the SaaS architecture). Persona account gets: complete profile,
AI-character bio disclosure, X automated-account label ("automated by
@howard" — strongest legitimacy signal), X Premium (~$8/mo; reply visibility
+ future monetization eligibility). Known trade-off: the shared dev app is a
single point of failure for the posting pipe (accounts/followers survive);
app-level compliance is therefore sacred.

**Compliance posture — transparency as strategy.** Labeled bot = X's
explicitly allowed category (vs. the impersonation clause that kills
human-pretending personas); EU AI Act Art. 50 disclosure satisfied; market
data shows openly-AI personas (Aitana López et al.) monetize fine. Sponsored
posts later need #ad (FTC).

**Monthly run-rate, one persona:**

| Item | Basis | ~Cost/mo |
|---|---|---|
| X: original posts | ~100 × $0.015 | $1.50 |
| X: approved replies | ~150 × $0.015 | $2.25 |
| X: commercials (link posts) | 4 × $0.20 | $0.80 |
| X: trend-context reads | ~1,800 × $0.005 | $9 |
| X: mentions + metrics (owned reads) | ~10k × $0.001 | $10 |
| X Premium (persona account) | | $8 |
| Claude drafting + critic | ~12 calls/day, Sonnet-class | $5–15 |
| Hetzner CX22 | | $5 |
| **Total** | | **~$42–52** |

## 9. Multi-platform expansion

Platforms are adapter implementations, not architecture forks.

- **X: direct API** (current). Reasons: ~$25/mo direct vs $299/mo for the
  aggregator webhook tier; and depth — mentions-from-anywhere, thread reads,
  trend context, jitter/warm-up/read-budget dials that ARE our ban-safety
  controls.
- **Instagram/TikTok: aggregator-backed adapters** when expansion starts.
  Correction recorded from design review: **Ayrshare is not publish-only** —
  comments/DM moderation on all tiers, webhooks from Launch ($299/mo,
  10 profiles), so `comment.received` → draft → queue → reply is a real
  interactive loop there. Leading candidate: Ayrshare Launch; budget option
  for first experiments: Post Bridge (~$15–20/mo, publish-focused). Value:
  they've already passed Meta Graph API and TikTok Content Posting API app
  review — weeks of bureaucracy skipped.
- **Decision point (recorded, to be re-costed at expansion time):** at SaaS
  scale, Ayrshare Business ($599/mo, 30 profiles) amortized across users
  likely beats building three first-party integrations. Risk to hold: an
  aggregator is a shared dependency we don't control; the adapter interface
  keeps direct-API implementations as the escape hatch.

## 10. Metrics — the case-study dataset is a first-class deliverable

Tables: `daily_snapshot` (followers, spend by category, queue stats),
`post_metrics` (impressions/likes/replies/reposts/bookmarks at +1h/+24h/+7d,
tagged by pillar/hour/media), `action_costs` (every billable call, with
`owner_id` — this is also the SaaS billing meter), `queue_stats` (approval /
edit / expiry rates per type).

Outputs:

- **Weekly Telegram digest:** follower delta, best/worst post, engagement by
  pillar, spend, behavioral nudges ("you edited 40% of trend takes —
  tighten the worldview?").
- **Monthly report** with the headline chart the whole thesis rides on:
  **commercial impressions vs. follower count over time.** If commercial
  reach doesn't grow with audience, the premise fails — we want to know by
  month 2, not month 9.
- Secondary: cost per follower, engagement rate vs. AI-influencer
  benchmarks, honest minutes/day spent in the queue (target ≤10).

## 11. Failure handling

Ranked by blast radius:

1. **Suspension signals** (account-level 401/403): auto-`/pause` everything,
   loud alert. Never retry into a suspension.
2. **Rate limits:** exponential backoff; persistent → pause that action type
   for the day. A skipped post is always acceptable.
3. **Claude down:** skip the slot. No fallback template-posting, structurally.
4. **Telegram down:** queue holds; expiry guarantees nothing stale publishes.
5. **Crash/restart:** systemd auto-restart; SQLite WAL; idempotency keys.
6. **Watchdog:** dead-man's-switch ping (healthchecks.io-class); alert after
   30 min silence. A silently-dead bot looks like an abandoned account.
7. **Backups:** Litestream streaming SQLite to object storage. The memory DB
   IS the persona — losing it is amnesia about arcs, fans, voice corrections.

## 12. Monetization and scaling (SaaS phase)

Sustainable because **we control the meter**: every X action is initiated by
our scheduler under our caps (`postsPerDay`, `replyBudgetPerDay`, trend
reads). A user cannot run up the X bill; cost per persona is bounded by
design.

- **Tiers (indicative):** Starter ~$49/mo (1 persona, ≤3 posts/day, ≤10
  replies/day, 1 trend take/day; marginal COGS ~$25–30). Growth ~$99/mo
  (3 personas, higher caps; marginal COGS ~$60–75). Marginal COGS = X usage
  + Claude only; it is lower than §8's ~$42–52 solo run-rate because Hetzner
  amortizes across tenants and X Premium is the user's own account expense,
  not ours.
- **Prepaid, not arrears:** Stripe charges day 1; X bills month-end —
  permanent positive float.
- **Payment failure → `/pause`:** the kill switch doubles as billing
  enforcement; marginal cost of a delinquent user ≈ 0.
- **Free tier = draft mode:** full soul sheet, a week of drafted tweets,
  user copy-pastes manually. Zero X spend; natural upsell.
- **Overage = throttle + upgrade nudge**, never surprise bills.
- **Scale checkpoint:** X pay-per-use app-level cap of 2M reads/mo ≈ ~150
  active personas at our read budget → known trigger for the X Enterprise
  conversation.
- **Pricing pressure (from §13):** Glambase anchors the category at ~$15/mo.
  Our $49 is defensible only on "real X operation + you own the account and
  audience" — marketing must lead with ownership and operation, not
  generation features.

**Flip triggers — think critically before infrastructure swaps (owner
directive).** The SQLite→Postgres and Telegram→in-app-queue migrations
happen when a *measured limit* is hit, never because a user count sounds
big:

- SQLite → Postgres only on: multi-process writer contention observed, or
  replication needs beyond Litestream. SQLite WAL at a few writes/minute
  handles 100+ personas.
- Telegram → in-app queue only on: real onboarding refusal data ("users
  won't install Telegram"), not aesthetics. Telegram bots support per-user
  chats; 100 users can each approve their own persona through one bot.

## 13. Competitive landscape — ⟳ PERIODIC, not one-time

**⚠️ Standing directive (owner-mandated): competitive research is a
recurring task, not a section frozen at design time.** The snapshot below
was taken 2026-07-05 and MUST be refreshed:

- **Cadence: every 6 weeks** during the proof phase (aligns with digest
  reviews at day ~45 and ~90), **quarterly** after.
- **Event-triggered re-scans** regardless of cadence: before the
  productization go/no-go, before setting/changing prices, when Higgsfield
  ships anything persona/social-shaped, and on any X API pricing/policy
  change.
- **Each scan answers four questions:** (1) Has anyone new combined our four
  differentiators? (2) Have Glambase/ReelMoney-class tools made their
  "autonomy" real? (3) Did platform policy shift the compliance calculus?
  (4) Does our price/positioning still hold against the field?
- **Output:** dated addendum appended to this section (do not overwrite the
  snapshot — the diff over time is itself market intelligence).
- **Suggested mechanization:** a scheduled Claude Code research run
  (deep-research skill) every 6 weeks producing the addendum draft.

**Snapshot 2026-07-05:**

| Player | What they do | Gap we exploit |
|---|---|---|
| Glambase (~$15/mo) | Persona creation, claimed autonomous posting/replies | Persona lives in their walled monetization — audience isn't the user's; generic visual quality; autonomy is scheduler-grade |
| MakeInfluencer.ai ($28–79 + rev share) | Autonomous personalities monetized via fan chat | OnlyFans-adjacent chat, not organic social growth; no real X operation |
| ReelMoney | Real auto-posting to TikTok/IG/YouTube | Content farm: no persona, no memory, no interaction — distribution without a soul |
| Virtuals/Luna/aixbt (crypto agents) | Fully autonomous X personas; Luna 50k X + 942k TikTok | Existence proof autonomy grows audiences — but growth is token-fueled and doesn't transfer; X's tolerance of flagship agents ≠ unknown bots |
| Higgsfield (supplier) | Generation stack + AI-influencer landing page + Marketing Studio | ⚠️ Supplier climbing our stack. Mitigation: model-agnostic engine; their credit-consumption incentive aligns with our success. Watch item every scan |
| The Clueless (agency, Aitana) | The proven money playbook (€3–10k/mo/persona) | Service business — our case-study template, not a competitor |

**The open slot (as of snapshot):** nobody combines (1) owned accounts,
(2) consistent visual identity + video pipeline, (3) persistent interactive
soul with memory/fan recognition, (4) compliance-first autonomy. Every
player above has at most two.

**Known headwind (the honest one):** crypto personas grow via token
incentives, NSFW personas via that gravity. A wholesome commercial persona
has neither. Organic X growth for an unknown character is THE unproven
assumption in this plan — it is exactly what the 90-day proof phase and the
§10 metrics exist to test. Treat weak day-45 growth as a signal to revisit
content strategy (niche-community depth) before questioning the thesis.

## 14. Rollout

1. **Week 1 — plumbing:** agent repo scaffold; soul-sheet schema;
   `Personality.jsx` + export in app; X developer account; persona account
   (profile, disclosure bio, automated label, Premium); adapter posts one
   tweet end-to-end.
2. **Week 2 — voice + minimal loop:** mixer (2 pillars), drafting + critic,
   scheduler + jitter, log channel, warm-up mode, minimal Telegram queue
   (✅/❌ only), **DemoAdapter** (dry-run mock timeline).

   **🏁 MVP DEMO CHECKPOINT (end of week 2).** Demoable arc, ~4 minutes:
   open app → Kayla's Personality page (Claude-seeded soul sheet) → her live
   X timeline posting in-voice with her generated photos → a reply draft
   arrives on the phone → tap ✅ on stage → it publishes. DemoAdapter is the
   insurance: full rehearsal + fallback with zero dependency on X uptime,
   account trust score, or venue Wi-Fi.

3. **Week 3 — full soul:** mentions polling + triage, full queue (edit /
   redraft / skip + feedback loop), fan notes, trend sourcing.
4. **Week 4 — business layer:** metrics + digests, `/commercial`, kill-switch
   drill (test `/pause` under fire), Litestream + watchdog.
5. **Days 30–120 — proof phase:** full cadence; weekly digest reviews;
   commercial ~monthly; competitive scan at day ~45 and ~90 (§13).

**Exit criteria for "proven → productize":** sustained follower growth with
real engagement (reply/impression ratios in benchmark range, not vanity
counts); commercial-reach curve bending upward; all-in cost within §8
envelope; queue time honestly ≤10 min/day.

## 15. Risks

| Risk | Mitigation |
|---|---|
| X policy shift / enforcement wave | Labeled-bot posture; no banned verbs (scope-limited OAuth); kill switch; §13 event-triggered scans |
| Organic growth doesn't materialize | The 90-day proof exists to learn this cheaply; day-45 checkpoint; content strategy iteration before thesis rejection |
| Shared dev app suspension | Accounts/followers survive; app-level compliance sacred; aggregator as emergency posting fallback |
| Higgsfield becomes competitor | Model-agnostic engine; adapters isolate generation supplier |
| 3am bad take | Hybrid dial: reactive content queue-gated; critic pass; log channel + fast delete; expiry |
| Persona memory loss | Litestream continuous backup |
| Voice drift / AI-slop regression | `never_sounds_like` + example anchors; critic pass; ✏️-edit training loop; edit-rate metric |
| Cost creep | Hard caps in engine; `action_costs` metering; read budgets; RSS-first trend sourcing |

## 16. Open questions (deferred, not blocking)

- Server-side media generation (Higgsfield OAuth is browser PKCE): revisit
  after MVP; until then the app fills the media library.
- Instagram/TikTok timing: after X proof phase; re-run §9 cost comparison
  and §13 scan first.
- ~~Persona choice and niche for the first account~~ — **confirmed
  2026-07-05: Kayla / fitness.**
- X Enterprise conversation trigger at ~150 personas (§12).

---

## Addendum 2026-07-05 — design-grilling outcomes

Appended per the §13 convention (never overwrite; the diff is the record).
A full grilling session was run against this spec pre-implementation. Every
decision below was challenged, defended or amended, and accepted by the
owner. Where an item amends a numbered section, the section is cited; the
original text above stands as the historical snapshot.

**Standing design principle (owner directive):** keep it lean. Prefer
reusing existing machinery (Telegram cards, ingest routes, queue states,
config values) over new surfaces; recommendations must state their cost in
new-machinery terms. Two candidate items were dropped under this rule: a
dedicated eval harness for the critic pass (the edit-rate metric already
measures it) and the $49-vs-Glambase positioning analysis (deferred to the
productization go/no-go).

### A1. Discovery mechanism — hit-tweet reply lane (amends §6, closes the spec's biggest gap)

The original design had no inbound edge: a zero-follower account replying
only to its own mentions is never discovered. New mechanism:

- **Watchlist replies:** the agent monitors a curated watchlist of
  high-velocity accounts and drafts fast replies under fresh viral tweets
  (Premium reply-boost is the visibility lever).
- **Watchlist rules:** niche-adjacent and mass-appeal apolitical accounts
  only (MrBeast archetype). Every watchlist entry must pass the same
  `bannedTopics` filter as the persona's own posts — political accounts
  *and political parody accounts* are excluded; a Trump parody is still
  politics in a costume.
- **Routing:** hit-tweet replies always ride the existing §7 hot-flag
  immediate-push path (no new machinery). Two type-specific overrides: the
  2–20 min post-approval delay is skipped (speed is the point; a fast reply
  to a fresh tweet is inherently human-looking), and expiry is **30
  minutes** — untapped drafts die silently.
- **Cap: 3/day** — keeps the persona out of reply-guy statistical
  territory.
- **Costing:** watchlist polling reads are NOT in the §8 table and may
  dominate API spend; size the watchlist and poll cadence against the
  verified rate card (A10.4) before Week 1 adapter work.

### A2. Client commercial — day-30 embargo, biweekly cadence (amends §10, §14)

A real client exists at design time (silk facemask). Framing: **pilot
partnership** — the client buys the first slot on a growth curve plus the
case-study data, not reach that doesn't exist yet.

- **No commercials before ~day 30.** Warm-up and early growth run clean;
  link posts are throttled and teach the algorithm (and early followers)
  that the account is an ad channel.
- **We control cadence: biweekly, day 30 → 120** (~6–7 posts). This is the
  experiment's control variable and gives §10's headline chart real data
  points instead of 3–4 anecdotes.
- **#ad is a mechanical policy-check rule** on `commercial`-tagged posts
  from post one (FTC material-connection disclosure), stacking with the AI
  disclosure. "Later" (§8) arrived with the client.

### A3. Kill numbers — exit criteria made falsifiable (amends §14)

Pre-committed before the account exists; day-90 Howard doesn't get a vote.
**Day 45 is the iterate gate** (miss it → change content strategy per §13).
**Day 90 kill numbers fire regardless** — no "one more iteration."

| Flywheel leg | Metric | Day-45 gate | Day-90 pass | Day-90 kill |
|---|---|---|---|---|
| Tweets → strangers | Median impressions per original | trending up week-over-week | ≥ 1,000 | < 200 |
| Strangers → followers | Real follower count | ≥ 100 | ≥ 500 | < 150 |
| Followers → commercial | Commercial post impressions vs. persona median | first data point exists | ≥ 2× median, rising across posts | ≤ 1× median or flat |

Plus the existing §14 criteria: engagement ratios in benchmark range, queue
time honestly ≤ 10 min/day. These numbers are the "proven" in "proven →
productize."

### A4. Demo runs on DemoAdapter; DemoAdapter is built first (amends §14)

The Week-2 demo as originally scripted published a live reply during the
no-reply warm-up window — the demo's money moment violated the spec's own
safety ramp. Resolution: the demo bends, not the ramp.

- The **live portion is the timeline itself** (~14–20 real warm-up posts,
  scrolled on stage).
- The **✅-tap moment runs on DemoAdapter** — real card, real tap, real
  pipeline, mock timeline — presented honestly as the pipeline in dry-run
  while the real account is in warm-up.
- **Build order: DemoAdapter first, Week 1**, before XAdapter. The engine
  is developed against it with zero ban exposure and zero API spend.

### A5. Media ingest is gated by Telegram ack (amends §4, §6)

The browser holds the ingest bearer token, so the token is extractable;
photo-drop auto-publishes; the policy check inspects text only. As
originally specced, whoever lifts the token chooses what the bot posts.

- **New media lands `pending`, not postable.** Ingest triggers a Telegram
  card (thumbnail + ✅/❌); only acked media enters the postable pool. The
  ack doubles as curation (continuity with the current arc).
- The bearer token is retained but **demoted from security boundary to
  nuisance filter** in the trust-boundary description.

### A6. Soul sheet delivery is push-based with validation (amends §4, §5)

"Manual JSON download" specified no delivery path for the persona's brain.

- App gains **"Push to agent"**: POST to a second ingest route, same bearer
  token. The download button remains as local backup only.
- **Agent validates at the door** (schemaVersion, required fields, pillar
  weights sum to 1.0, sane `postsPerDay`) and rejects with a readable error
  at push time, in the browser — not at drafting time on the server.
- **Telegram acks the swap** with a version diff; previous version retained
  for one-tap rollback (`/soulsheet rollback`).
- **Schema ownership:** the agent repo owns the schema (consumer +
  validator); the app vendors a copy of the JSON Schema and validates on
  export. Drift surfaces as a push-time rejection.

### A7. Reply expiry is digest-aware; drafting is lazy and batched (amends §6, §7)

The 4h wall-clock reply expiry vs. 10:00/15:00/20:00 digests meant every
reply drafted after ~16:00 — including all overnight mentions, peak time
for a fitness persona — expired unseen, burning Claude spend and
`replyBudgetPerDay` on structurally unapprovable drafts.

- **Reply expiry = next digest + 90 min** (floor 4h): every draft gets
  exactly one guaranteed digest appearance, then dies. A next-morning fan
  reply is the human pattern — humans sleep.
- **Trend takes keep hard wall-clock expiry (~8h)** — those genuinely rot.
- **Lazy drafting:** triage on poll (cheap, time-sensitive), draft in a
  batch ~30 min before the next digest. Batching lets the drafter see all
  of a window's mentions at once and vary near-duplicate replies.

### A8. fan_notes data rules (amends §6)

fan_notes is a store of dossiers on real, identifiable people, replicated
off-site. Rules, cheap now and impossible to retrofit at 5,000 rows:

- **Whitelisted schema:** handle, first/last interaction dates, interaction
  count, facts from the person's public interactions with the persona only.
  **Banned:** inferred age, location, health, relationships,
  emotional-state characterization. Enforced in the note-writing prompt;
  spot-checked in the weekly digest.
- **Apparent-minor rule extends to storage:** triage-skip for a suspected
  minor means no row is created or retained. Skip means invisible, not
  catalogued.
- **Retention:** rows with no interaction in 180 days are deleted.
- **Deletion on request** (or on block): row deleted; Litestream backup
  retention kept at **30 days** so the true purge date is bounded.

### A9. Generative memory — beats, bit-mining, staleness (amends §5, §6)

Local anti-repetition (last-50 dup check, last-15 context) cannot carry
~300 posts from a static soul sheet; month-three repetition reads as
"generated" to exactly the long-tenured followers fan_notes exists to keep.

- **Arc beats:** the weekly arc job emits 3–5 concrete postable beats into
  a beat pool the mixer draws from alongside pillars. Life events let the
  same opinions be expressed newly.
- **Bit-mining:** monthly job scans `post_metrics` for outperforming
  formats and proposes promoting/retiring `runningBits` as one-tap
  suggestions in the weekly digest. This is what "mutable layer owned by
  agent memory" (§5) operationally means.
- **Staleness metric:** mean similarity of the last 20 posts vs. the full
  90-day corpus, plotted in the weekly digest next to edit-rate — the
  day-45 iterate gate's most actionable input.

### A10. Housekeeping corrections

1. **Repost claim (§2) is overstated:** `tweet.write` also authorizes
   retweets, so auto-repost is NOT scope-excluded (likes/follows/DMs are).
   Reposts are excluded by construction instead: the adapter exposes no
   repost method and the policy layer rejects repost intents.
2. **Idempotency (§8):** X's tweet-create endpoint has no idempotency-key
   parameter. Actual design: persist a publish-intent row before the API
   call; on crash-recovery, reconcile against the account's recent timeline
   before retrying.
3. **Telegram command authority is pinned to the owner's chat ID** (§7) —
   guard clause on every command.
4. **§8 pricing table is assumed, unverified as of 2026-07-05.** Verify the
   real X rate card during Week 1 *before* adapter read-budget design.
   Enterprise-cliff fallback recorded for §12: if Enterprise quotes five
   figures at the ~150-persona cap, the options are re-costing an
   Ayrshare-class aggregator for X operation or capping persona count —
   decide at the trigger.
5. **Verify X Premium / monetization eligibility for automated-labeled
   accounts during Week 1 setup.** If incompatible, keep or drop Premium on
   reply-visibility grounds alone and delete the monetization rationale
   from §8.
6. **Warm-up state lives agent-side** (account-age tracking in the agent
   DB), not in the soul sheet — the soul sheet describes who she is, not
   how old the account is.
