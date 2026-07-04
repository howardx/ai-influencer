# Case Study: Face-Mask Commercial Iterations (2026-07-04)

*Reference data for `video-productization-plan.md`. These three iterations are
the seed corpus for the failure→rule loop (plan §3.5): every future
pack rule should be recorded in this format — **Failure / Evidence / Root
cause / Fix / Where encoded** — with the evidence quoted, not paraphrased.*

Product: 100% mulberry-silk sun-protection face mask (百分百桑蚕丝防晒口罩).
Notable physics: worn on the face or held; concealed air vent; raised
eye-corner guard; features demonstrated by fingertip gestures at MCU framing.
Scripts in Chinese; commercial format 15s / 4 shots / handheld self-filmed.

---

## Iteration 1 — Features not highlighted in sync with the audio

**Failure.** The influencer was supposed to emphasize two features (the hidden
air vent; the raised corner covering the eye/cheekbone area) while the
corresponding dialogue line was spoken. Generated videos showed generic
product handling with no feature emphasis, and no coordination between what
was said and what was shown.

**Evidence.** Pre-fix shot bodies carried only a generic gesture regardless of
content:

> `she touches @image_5 and angles toward camera to show it. "这个口罩上脸很舒服。"`

Nothing bound a specific gesture to a specific line, and nothing named the
features at all.

**Root cause.** The prompt builder had no concept of product features or of
which dialogue sentence covers which feature. Seedance can time an action to
a quoted line within a shot ("as she says X, she does Y") — but only if the
prompt says so. Sentence-level sync is the realistic granularity; the builder
already knew which sentence lands in which timed shot (`distributeSentences`),
so the missing piece was purely a feature→sentence→gesture mapping.

**Fix.** Three layers, all riding the existing sentence-to-shot assignment:

1. `features[]` on the brand deal (name + gesture verb), edited on the deal
   card, reusable across every commercial for that product.
2. Per-sentence tagging in the Script step (manual chips + AI auto-match via
   the light tier, sanitized), plus free-text per-line direction notes.
3. Gesture beats woven into the owning shot with fixed grammar:

   > `"加高护眼角，眼角也能防护到位。" — as she says this, she raises @image_5
   > beside her face, traces the raised corner… then holds @image_5 toward the
   > lens for a beat: … centered, fully visible, in sharp focus.`

   One feature per shot (one-action law); each sentence quoted exactly once
   (anti-double-speech); the fixed connectors (`— as she says this`,
   `— at this moment`) double as the tuner validator's protection grammar.

**Where encoded.** `src/utils/featureBeats.js` (+17 tests),
`buildPrompt()` weaving in `Influencers.jsx`, validator protected-clause
patterns colocated in `featureBeats.js`, Seedance guide Law 6/8 unchanged.

**Pack-relevance.** The gesture vocabulary (point/tap/trace/pinch), the
depiction templates ("raises beside her face…"), and the held/worn split are
the parts that are face-mask physics — exactly what becomes Category Pack
data. The sync machinery itself is category-agnostic.

---

## Iteration 2 — Seedance altered the product (painted an air hole)

**Failure.** Generated commercial showed the mask with a visible extra air
hole. The real product's vent is concealed; the product sheet shows no
visible openings.

**Evidence.** The prompt never asked for a visible vent, but it *named vents
twice* with no image showing one:

> detail-ref note: `it depicts hidden air vent at the nose bridge`
> template boilerplate: `Use for fine feature accuracy — texture, stitching,
> seams, hidden vents and openings.`

The generation in question didn't even gesture at the vent — the user's
features that round were about the silk material. The mentions alone were
sufficient.

**Root cause.** Naming a feature type is an invitation to render it. The
template's own wording ("hidden vents and openings") planted the idea, the
user's note reinforced it, and no rule forbade invention. The existing
constraints ("details must match @image_6 exactly", "never modified") were
not strong enough against a *named-but-not-shown* feature.

**Fix.**
1. Template went feature-neutral: `Use for fine feature accuracy.` — the
   boilerplate never names feature types again.
2. Explicit anti-invention rule in the PRODUCT section: *"Never invent
   features: no added holes, vents, openings, seams, stitching, logos, or
   markings that are not visible in the references. Concealed features stay
   concealed."*
3. Gesture beats append "the product's appearance unchanged"; the occlusion
   rule gained *"Indicating a feature never alters the product: nothing is
   added, opened, or revealed that @image_5 does not show."*
4. Promoted to Seedance guide **Law 13**: never name product features the
   references don't show.

**Where encoded.** `src/utils/videoPromptSections.js` (+ pinning test),
`featureBeats.js` phrases, `docs/seedance-influencer-guide.md` Law 13. The
LOGIC RULE line is validator-protected verbatim, so the AI tuner cannot
weaken any of it.

**Pack-relevance.** The universal never-invent rule stays in the spine.
Category-specific negatives (keycap legends for keyboards, badge text for
cars, quilting/embroidery lines for bedding, print continuity for clothing)
belong in each pack's `antiInvention` list — few, surgical, each citing a
failure like this one (Guide Law 7).

---

## Iteration 3 — "Street" silently became "indoors"

**Failure.** Location was set to Street via the environment chip; the
generated commercial was indoors. The prompt read:

> `ENVIRONMENT: indoors, morning`

while the same prompt's `COLOR LOGIC` carried Street's palette — proof the
chip was selected at build time.

**Root cause.** The builder derived the location only from the free-text
`environment` field, falling back to the literal `'indoors'` when empty; it
never consulted the selected chip (`envKey`). The state combination (chip set,
text empty) was introduced by restored history entries that carried an empty
environment text — including verification scaffolding entries written during
development. Any old or quota-slimmed history entry could reproduce it.

**Fix.** Location resolution became *text → chip preset → generic fallback*
in `buildPrompt()`, and `restoreHistory()` reconstructs the preset text from
the chip when an entry lacks it. Either fix alone closes the user-visible
bug; both together make the invariant structural.

**Where encoded.** `Influencers.jsx` (`envText` resolution + restore).

**Pack-relevance.** None — this is a state/assembly failure class. Recorded
here because the failure loop must distinguish prompt-law failures (1, 2)
from app-state failures (3): failure chips route them differently (pack rule
vs. bug fix).

---

## Meta-lessons for the productized loop

1. **Evidence must be quoted.** Every diagnosis above worked because the
   exact generated prompt was saved in history. The failure loop should
   always attach the prompt + settings to a report (already free — history
   entries store both).
2. **Fix at the level that generalizes.** Iteration 2 was fixed in the
   template AND as a rule AND as a guide law — one failure, three encodings,
   each protecting a different future path (new code, AI tuner, human prompt
   authors).
3. **Guard the guards.** Each fix gained a test that pins the exact wording
   (161-test suite), and the tuner validator was extended so the AI pass
   cannot undo what a failure taught us.
4. **AI verification caught nothing here; humans caught everything.** All
   three failures were spotted by eye. This is the argument for the vision QA
   loop (plan §3.4): iteration 2's class is mechanically detectable by
   comparing frames to the product sheet.
