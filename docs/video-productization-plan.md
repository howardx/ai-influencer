# Commercial Video Generation — Productization Plan

*Drafted 2026-07-04, after the face-mask commercial iterations. Companion docs:
`case-study-face-mask-2026-07-04.md` (the reference iterations this plan is
built on — the seed corpus for the failure→rule loop),
`seedance-influencer-guide.md` (prompt laws), `gpt-image-2-engine.md`,
`photo-studio-influencer-guide.md`.*

## 1. Why this plan exists

The face-mask work surfaced a repeatable pattern. Every iteration was the same
loop run by hand:

1. **Generate** a commercial.
2. **Spot a failure** — the influencer didn't highlight the intended features;
   Seedance painted an air hole onto a mask whose vent is concealed; the
   street location silently became "indoors".
3. **Diagnose** it back to the prompt or the state that produced it.
4. **Encode the fix** as a deterministic template rule, a validator guard, or
   a guide law (Laws 1–13 in the Seedance guide all came from this loop).

All three iterations are written up with quoted evidence in
`case-study-face-mask-2026-07-04.md` — in the exact Failure / Evidence /
Root cause / Fix / Where-encoded format the productized loop should emit.

Everything encoded so far is **face-mask physics**: a product that is worn or
held, traced with a fingertip, framed in MCU beside a face. A car cannot be
raised beside anyone's face. A keyboard's failure mode is mangled keycap
legends, not invented vents. Scaling to arbitrary products means
systematizing *how the app learns and encodes product physics per category* —
not building a bespoke pipeline per category.

### Design principles

- **One spine.** The pipeline (script → CJK-aware sentence split → feature
  matching → gesture beats → timed shots → invariant validator → optional AI
  camera tune) stays single and category-agnostic. Improvements land once.
- **Category knowledge is data, not code.** The repo already uses this
  pattern twice: `POSES_SOUL` vs `POSES` (model-specific pose sets) and
  `BAKED_CAMERA_KNOWLEDGE` (baked pack + optional AI refresh). Category packs
  are the third instance.
- **The failure→rule loop is the product.** Packs are only as good as the
  failures they've absorbed. The loop we ran manually must become a feature.
- **AI proposes, determinism disposes.** Every AI-assisted step (classification,
  feature matching, rule drafting, camera tuning) pre-fills; a deterministic
  floor plus human override always remains. This is the app's existing
  contract (tuner validator, auto-match sanitizer) and it extends unchanged.
- **Local-first stays.** User data and keys stay in the browser. Anything
  that needs a backend (cross-user learning, pack distribution) is isolated
  behind a fetch-a-JSON boundary so it can ship later without rework.

## 2. Current architecture (what exists, 2026-07-04)

| Module | Responsibility | Category-coupled? |
|---|---|---|
| `src/pages/Influencers.jsx` → `buildPrompt()` | Assembles the full Seedance prompt: shots, timings, framing, env, wardrobe, product refs | **Yes** — framing table, `wearMode`, generic gestures assume a handheld/wearable |
| `src/utils/featureBeats.js` | Feature gesture beats, per-line direction notes, weaving, protected-clause grammar, AI auto-match | **Yes** — `FEATURE_GESTURES` (point/tap/trace/pinch), `when: held\|worn`, "raises beside her face" phrasing |
| `src/utils/videoPromptSections.js` | PRODUCT section + product logic rules (same-object, anti-invention, detail refs, video-ref authority) | Mostly generic; anti-invention list is universal |
| `src/utils/videoPromptTuner.js` | Optional AI camera-language pass; invariant validator (tags, dialogue, LOGIC RULE verbatim, protected clauses) | No — protections are structural |
| `src/utils/cameraKnowledge.js` | Baked 46-movement vocabulary + commercial-beat pairings; AI-refreshable | Pairings are beat-generic but tuned for handheld UGC |
| `src/utils/dialogueSplit.js` | CJK-aware sentence split + duration-weighted shot distribution | No |
| `src/utils/aiProvider.js` | Provider registry (Claude/GLM), wire translation, tiers (light/vision/tuner), single-active-key invariant | No |
| `src/utils/charSheetPrompt.js` | Product character-sheet prompts (already product-generic: "choose the 6 most informative angles for this product type") | No |
| Brand deal data (`deal.*` in `influencer.brandDeals`) | Product images, gallery, `imageNotes`, `features[]` | `features[].gesture` limited to handheld verbs |

Three failure classes observed, and where their fixes live today:

1. **Sync failures** (feature not highlighted at the right moment) → feature
   highlights + line notes + gesture beats, tuner-protected. *Generic already.*
2. **Fidelity failures** (product altered — the painted vent) → feature-neutral
   templates + never-invent rule + Guide Law 13. *Universal rule exists;
   category-specific negatives have no home yet.*
3. **State/assembly failures** (Street → indoors) → chip-authoritative env
   resolution. *Generic; no category dimension.*

## 3. Target architecture

### 3.1 Category Pack — the new unit of knowledge

New module `src/utils/categoryPacks.js`. A pack is a plain, JSON-serializable,
versioned object — no functions, so packs can later be fetched/updated like
the camera-knowledge cache.

What a pack has to capture — the product physics that vary by category
(clothing and bedding are the next two product types on the roadmap, per
user priority; cars and keyboards illustrate the harder cases behind them):

| Varies per category | Face mask (today) | Clothing | Bedding | Car | Keyboard |
|---|---|---|---|---|---|
| **Interaction modes** | worn / held | worn full-body, held up on hanger, put on | staged on bed, lain/sat on, demonstrated by hand | approached, door-opened, driven, walked-around | typed on, held up, rotated |
| **Gesture vocabulary** | tap, trace, point, pinch | tug the hem, pinch the fabric, turn to show the back, smooth a sleeve | smooth a palm across the surface, lift/flip a corner, press to show loft | pat the hood, swing the door, trail a hand along the body line | press a key, run fingers across the deck |
| **Framing/scale** | fits in MCU beside the face | full-body / MS for silhouette — MCU loses the garment | wide establishing of the bed + close texture inserts; presenter moves to the product | WS + establishing; presenter beside it, never holding it | macro top-down; product fills frame without the face |
| **Camera pairing (reveal)** | slow zoom in | reverse tracking on the walk, slow tilt down the silhouette | slow push in to texture; overhead for the full spread | arc / orbit | crash zoom to keycap close-up |
| **Known failure modes** | invented vents | print/pattern drift between shots, silhouette morphing, invented seams/buttons | pattern-repeat drift, invented quilting/embroidery lines (the painted-vent analogue), pillow count changing | wrong wheels, mangled badge text, grille drift | wrong keycap legends, layout drift |

The pack schema:

```js
{
  id: 'wearables',                 // stable key stored on deals
  version: 1,
  label: 'Wearables & accessories',
  matches: 'clothing, masks, hats, glasses, jewelry, bags worn on body',

  // How a presenter can relate to the product. First entry is the default.
  // Replaces the boolean worn/held pair.
  interactions: [
    { id: 'worn',  label: 'worn',  promptNoun: 'the worn {tag}' },
    { id: 'held',  label: 'held',  promptNoun: '{tag} held in hand' },
  ],

  // Gesture verbs available in the feature editor. Template placeholders:
  // {name} feature name, {tag} product tag, {her}/{she} pronouns.
  gestures: {
    point: 'points at the {name} with one index finger',
    tap:   'taps the {name} once with one index fingertip',
    trace: 'traces the {name} slowly with one fingertip',
    pinch: 'pinches the {name} lightly between thumb and forefinger',
  },

  // How a feature is brought to full depiction, per interaction.
  depiction: {
    worn: '{gesture} on the worn {tag}, then angles that side toward the lens…',
    held: 'raises {tag} beside {her} face, {gesture}, then holds {tag} toward the lens…',
  },

  // Framing & scale rules injected into shot headers / STYLE.
  framing: {
    productShot: 'MCU',            // vehicles: 'WS'; desk tech: 'top-down CU'
    presenterHoldsCamera: true,    // vehicles: false — camera operator implied
    scaleHint: null,               // vehicles: 'the presenter stands beside it; it is never lifted'
  },

  // Camera pairing for the feature/reveal beat (featureCameraLine source).
  cameraPairings: {
    featureReveal: 'Slow zoom in — Movement: camera eases toward {tag}…',
    // vehicles: arc/orbit; desk tech: crash zoom to macro
  },

  // Category-specific anti-invention negatives — few and surgical
  // (Guide Law 7: stacked negatives cause inverse priming). Each entry
  // MUST cite the failure that earned it.
  antiInvention: [
    // wearables: none yet — the universal rule covers the painted-vent case
  ],
}
```

Starter packs, in build order (user priority: clothing and bedding first):
`wearables` + `handhelds` (Phase A — today's behavior, extracted), `apparel`
(Phase B — clothing as the *product*, full-body physics) and `home-textiles`
(Phase B — bedding, pillows, throws), then `labeled-goods` (keyboards,
packaged products — text-fidelity emphasis) and `large-objects` (vehicles,
furniture, appliances) as demand dictates. `digital` (apps/sites) is
explicitly **out of scope** (§6).

**Apparel needs one extra architecture note.** The app already has clothing
machinery — wardrobe slots, and the hard-won exclusion rule that identity
refs never contribute clothing (an earlier real failure: 3 worn-on-body
photos outvoted one wardrobe card). When the *product is the garment*, the
wardrobe ref and the product ref are the same object: the `apparel` pack must
unify them — the product image drives BOTH the WARDROBE section (silhouette,
fabric, styling authority) and the PRODUCT section (same-object,
never-substituted, anti-invention), and the exclusion list still names every
identity ref. Getting this wrong recreates the outvoting bug with money on
the line — which is why apparel is scheduled as the first new pack, while the
mask lessons are fresh.

**Home-textiles is the soft-goods twin of the painted-vent lesson.** Bedding
prompts must describe texture only through the references (pattern-repeat
drift and invented quilting lines are the expected failure modes), the
presenter walks INTO frame with the product staged (`presenterHoldsCamera`
varies per shot), and depiction templates are hand-led ("smooths a palm
across…", "lifts the corner to show the fill") rather than raise-to-lens.

### 3.2 Classification & override

- `classifyProduct(deal)` — one `aiComplete({ tier: 'light' })` call with the
  product image(s) + brand/category text → `{ packId, interactionId }`,
  sanitized against the registry exactly like `sanitizeFeatureMapping`.
- Stored on the deal: `deal.packId`, `deal.interaction` (editable chips on the
  deal card; classification only pre-fills, never overwrites a user's choice).
- Fallback when unclassified: `handhelds` (current default behavior).
- The Video tab's `productWorn` toggle generalizes into an **interaction
  selector** driven by the active pack (a two-entry pack renders exactly like
  today's toggle — no UX regression for masks).

### 3.3 Module changes

| Module | Change |
|---|---|
| `categoryPacks.js` *(new)* | Registry, `getPack(id)`, `classifyProduct`, pack-version cache slot (fetchable later) |
| `featureBeats.js` | `featureGesturePhrase(feature, { pack, interaction, … })` renders from pack templates; `FEATURE_GESTURES` becomes `Object.keys(pack.gestures)`; protected-clause grammar (`— as she says this` / `— at this moment`) is **frozen as the cross-pack contract** — packs fill the phrase, never the connector, so tuner protection holds for every category |
| `Influencers.jsx buildPrompt()` | Framing/lens/`presenterHoldsCamera` consult the pack; generic per-shot gesture fallbacks come from the pack; `wearMode` derived from `deal.interaction` |
| `videoPromptSections.js` | `buildProductSection(…, { pack })` appends `pack.antiInvention` entries after the universal never-invent rule |
| `videoPromptTuner.js` | **No change** — validator protections are structural and already colocated with the grammar |
| Feature editor (deal card) | Gesture dropdown reads the pack's verbs; pack + interaction chips on the card |
| `cameraKnowledge.js` | Beat-pairing table gains per-pack rows (or packs carry their own pairing strings — start with the latter, simpler) |

Migration: existing deals without `packId` behave exactly as today
(`handhelds`/`wearables` semantics via the `productWorn` toggle). No data
migration required; classification back-fills lazily when a deal is next used.

### 3.4 Vision QA loop (fidelity failures → automated)

New `src/utils/visionQA.js`:

- After a video lands, extract 2–3 frames (canvas capture from the `<video>`
  element — no new dependencies).
- `aiComplete({ tier: 'vision' })` with frames + product refs (+ detail refs):
  *"Does the product in these frames match the reference exactly? List any
  deviation: added/removed features, color, markings, proportions."* Strict
  JSON verdict, sanitized.
- UI: a per-result badge — ✓ match / ⚠ deviations listed ("extra opening on
  the front panel") with a one-click regenerate.
- Opt-in toggle next to the tuning toggle; uses the active provider
  (`glm-4.6v` or Claude vision) so it inherits the provider swap for free.
- Cost note: fractions of a cent per check vs. Seedance credits per retry —
  the check pays for itself if it prevents one blind retry in ~50.

### 3.5 Failure→rule loop (the moat)

Phase C, after packs and QA exist:

1. **Capture**: after each generation, optional failure chips — *product looks
   wrong · wrong action/timing · wrong location · face drifted · invented
   details · other*. Stored locally with the generation's history entry
   (settings + prompt already saved there — the diagnosis context is free).
2. **Draft**: "Suggest a fix" runs the provider over {failure chip, prompt,
   pack} → a candidate pack rule (an `antiInvention` entry, a depiction-template
   tweak) with a required *failure citation* — mirroring how every rule in
   this codebase carries its war story.
3. **Approve**: the user accepts → the rule lands in a **local pack overlay**
   (`hf_pack_overlays`), merged over the shipped pack at build time. Rejected
   drafts vanish.
4. **Share (decision point)**: aggregating overlays across users requires a
   minimal backend (anonymized failure reports up, versioned pack JSON down —
   same shape as the camera-knowledge refresh). Defer the backend; the overlay
   + versioned-pack design means adding it later is additive.

### 3.6 Data flow after the change

```
product image ─► classifyProduct ─► deal.packId + interaction (user-editable)
                                        │
script ─► splitDialogueSentences ─► feature auto-match / line notes
                                        │
buildPrompt(spine) ◄── pack: framing, gestures, depiction, pairings, negatives
        │
validator-protected prompt ─► optional AI camera tune (validator: unchanged)
        │
Seedance generate ─► vision QA (optional) ─► ✓ / ⚠ + regenerate
        │
failure chips ─► AI-drafted rule ─► user approves ─► pack overlay
```

## 4. Execution roadmap

### Phase A — Extract the abstraction (no new capability, ~1 session)
- [ ] `categoryPacks.js` with `wearables` + `handhelds` packs that reproduce
      today's behavior **byte-identically** (snapshot-test the built prompt
      before/after refactor — this is the acceptance criterion).
- [ ] `featureBeats`/`buildPrompt`/`videoPromptSections` read from the pack.
- [ ] Pack + interaction chips on the deal card; `productWorn` becomes the
      pack-driven interaction selector.
- [ ] `classifyProduct` with manual override.
- Risk: `buildPrompt()` lives in the 6k-line `Influencers.jsx` — per CLAUDE.md
  this needs careful in-browser verification of every flow, not casual
  refactoring. Budget a dedicated session; snapshot tests are the safety net.

### Phase B — First new physics: `apparel` + `home-textiles` (~2 sessions)
*(User priority: clothing and bedding are the first product types after the
mask.)*
- [ ] `apparel` pack: full-body/MS framing, garment gestures (hem tug, fabric
      pinch, turn-to-show-back), `antiInvention` seeded with print-drift and
      invented-seam negatives.
- [ ] Wardrobe↔product unification for apparel (§3.1 note): the product image
      drives WARDROBE and PRODUCT sections together; identity-ref exclusion
      list unchanged. This is the phase's main risk — verify against the
      historical outvoting failure.
- [ ] `home-textiles` pack: staged-product + presenter-enters-frame beats,
      hand-led depiction templates, wide-establishing + texture-insert
      framing, pattern/quilting anti-invention negatives.
- [ ] Per-shot `presenterHoldsCamera` handling in the STYLE/shot builder (the
      bedding presenter can self-film walking to the bed, then set the camera
      down for in-use shots).
- [ ] Validation: one real clothing commercial and one real bedding commercial
      end-to-end; the mask flow unchanged as the regression check.
- Acceptance: both generate with zero spine changes — only pack data. If the
  spine needed edits, the abstraction is wrong; fix it *now*.

### Phase C — Text-critical pack + the learning loop (~2 sessions)
- [ ] `labeled-goods` pack (keyboards, packaged products): label/legend
      fidelity emphasis (Seedance's weakest area), macro framing,
      `antiInvention` seeded with text-drift negatives.
- [ ] Failure chips on generation results (stored with history).
- [ ] AI-drafted rules → local pack overlays with approval UI.
- [ ] Overlay merge + versioned-pack cache slot (fetch-ready, backend-less).

### Phase D — Vision QA, `large-objects`, distribution (~2 sessions)
- [ ] `visionQA.js` + result badges + one-click regenerate.
- [ ] `large-objects` pack (vehicles, furniture, appliances): `beside` /
      `inside` / `in-use` interactions, WS framing, arc/orbit reveal
      pairings, the full `presenterHoldsCamera: false` register.
- [ ] Pack update channel: packs fetched as versioned JSON with the baked set
      as the offline floor (identical to camera-knowledge refresh semantics).
- [ ] Decide the backend question with real usage data in hand.

Each phase ships independently; the app is fully usable after every one.
Existing test discipline continues: pure logic TDD'd (`categoryPacks`,
pack-driven `featureBeats`, `visionQA` sanitizers), prompt output pinned by
snapshot tests, live in-browser verification for `Influencers.jsx` touches.

## 5. What stays true across all phases

- The tuner validator's protections (tags, dialogue verbatim, LOGIC RULE
  line verbatim, protected clauses) are the **cross-category contract**. Packs
  change what goes *inside* the clauses, never the clause grammar.
- Guide Law 7 (few, surgical negatives) governs `antiInvention` growth: every
  entry cites a real failure, and the draft-rule flow enforces the citation.
- Provider-agnostic by construction: every AI step goes through `aiProvider`
  tiers, so Claude/GLM (and a future OpenAI entry) work everywhere including
  classification and vision QA.

## 6. Non-goals

- **Digital products (apps, websites, games).** A commercial for software is
  screen capture composited with a presenter — different references, laws, and
  pipeline. Scoping it in would distort the pack abstraction. Revisit as its
  own feature after Phase D.
- **Hand-authoring every conceivable pack.** Ship packs where users generate;
  let failure-chip data choose the next pack.
- **A full backend now.** Local overlays + fetchable versioned packs give 80%
  of the value; the backend becomes a distribution optimization, not a
  prerequisite.

## 7. Open decisions

| Decision | When | Leaning |
|---|---|---|
| Backend for cross-user pack learning | After Phase C usage data | Minimal: anonymized failure counts up, pack JSON down |
| Packs bundled vs. fetched at runtime | Phase D | Bundled + fetch-refresh (camera-knowledge pattern) |
| Per-pack tuner knowledge (camera vocabulary per category) | Phase B, if car tunes look wrong | Extend `cameraKnowledge` pairing table per pack |
| Community-contributed packs | Post-Phase D | Only with the citation discipline enforced |
