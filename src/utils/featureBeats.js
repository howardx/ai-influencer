// Product feature highlights — pure builders for gesture beats synced to
// dialogue.
//
// A feature is data on a brand deal: { id, name, description, gesture, when,
// detailImage? }. The user tags which dialogue sentence covers which feature;
// because distributeSentences already assigns sentences to timed shots, a
// tagged feature lands in a known shot, and its gesture is written into that
// shot's action prose tied to the exact quoted line ("as she says this, she
// taps ..."). Seedance times actions to quoted lines within a shot —
// sentence-level sync is the realistic granularity.
//
// Laws honored (docs/seedance-influencer-guide.md): one gesture verb per shot
// (first tagged feature in a shot wins), dialogue stays verbatim (the woven
// form quotes each sentence exactly once), and the depiction clause ("fully
// visible, in sharp focus") is what guarantees the feature is actually shown.

export const FEATURE_GESTURES = ['point', 'tap', 'trace', 'pinch']
export const FEATURE_WHEN = ['held', 'worn']

const GESTURE_VERBS = {
  point: name => `points at the ${name} with one index finger`,
  tap: name => `taps the ${name} once with one index fingertip`,
  trace: name => `traces the ${name} slowly with one fingertip`,
  pinch: name => `pinches the ${name} lightly between thumb and forefinger`,
}

// lineChunks: string[][] (sentences per shot, from distributeSentences).
// featureMap: { [globalSentenceIndex]: feature }.
// Returns per shot: { feature, idxInChunk, line } | null — first tagged
// sentence in a shot wins so a shot never carries two gestures.
export function assignFeaturesToShots(lineChunks, featureMap) {
  let offset = 0
  return lineChunks.map(chunk => {
    let hit = null
    for (let j = 0; j < chunk.length; j++) {
      const feature = featureMap[offset + j]
      if (feature) { hit = { feature, idxInChunk: j, line: chunk[j] }; break }
    }
    offset += chunk.length
    return hit
  })
}

// The gesture + full-depiction clause, phrased for "— as she says this, she …".
export function featureGesturePhrase(feature, { productTag, detailTag = null, she = 'she', her = 'her' } = {}) {
  const verb = (GESTURE_VERBS[feature.gesture] || GESTURE_VERBS.point)(feature.name)
  const desc = (feature.description || '').trim()
  const named = desc ? `${verb.replace(feature.name, `${feature.name} — ${desc} —`)}` : verb
  const match = detailTag ? `, matching ${detailTag} exactly` : ''
  if (feature.when === 'worn') {
    return `${named} on the worn ${productTag}, then angles that side toward the lens and holds still for a beat: the ${feature.name} fully visible, in sharp focus, the product's appearance unchanged${match}`
  }
  return `raises ${productTag} beside ${her} face, ${named}, then holds ${productTag} toward the lens for a beat: the ${feature.name} centered, fully visible, in sharp focus, the product's appearance unchanged${match}`
}

// Double quotes are stripped so a note can never break out of the protected-
// clause character class below (a quote would end the match early and leave
// the tail rewritable by the tuner).
const noteClause = note => note.trim().replace(/["“”]/g, '').replace(/[.。!！]?\s*$/, '.')

// Weave per-line annotations into a shot's sentence chunk — each sentence
// quoted exactly once, feature gestures and user direction notes attached to
// their lines. anns: { [idxInChunk]: { gesturePhrase?, note? } }. The fixed
// "— as she says this" / "— at this moment" grammar is what lets the tuner
// validator recognize and protect these clauses.
export function weaveLineAnnotations(sentences, anns, { she = 'she' } = {}) {
  const parts = []
  let plain = []
  const flush = () => { if (plain.length) { parts.push(`"${plain.join(' ').trim()}"`); plain = [] } }
  sentences.forEach((s, j) => {
    const a = anns[j]
    if (!a || (!a.gesturePhrase && !a.note)) { plain.push(s); return }
    flush()
    let seg = `"${s.trim()}"`
    if (a.gesturePhrase) seg += ` — as ${she} says this, ${she} ${a.gesturePhrase}.`
    if (a.note) seg += ` — at this moment, ${noteClause(a.note)}`
    parts.push(seg)
  })
  flush()
  return parts.join(' ')
}

// The tuner validator protects every clause these patterns match — they are
// defined HERE, next to the producer strings above, so a wording change and
// its protection can't drift apart across files. Gesture clauses end at their
// first period (they contain none internally); notes run to the next quote or
// line end so internal periods stay covered.
export const PROTECTED_CLAUSE_PATTERNS = [
  /— as s?he says this, s?he [^"\n]+?\./g,
  /— at this moment, [^"\n]+/g,
  /When s?he reaches the line about the [^"\n]+?\./g,
]

export function featureLogicRule(productTag, { she = 'she', her = 'her' } = {}) {
  return `When ${she} points at or touches a product feature, ${her} fingers never occlude it — the indicated detail stays fully visible to camera and matches ${productTag} exactly. Indicating a feature never alters the product: nothing is added, opened, or revealed that ${productTag} does not show.`
}

// Camera pairing for a feature shot, per the knowledge pack's commercial-beat
// table: a product reveal pairs with a slow zoom in. Only for handheld — a
// locked shot must never gain drift (hard rule), so it returns nothing there.
export function featureCameraLine({ isHandheld, productTag }) {
  if (!isHandheld) return ''
  return ` Slow zoom in — Movement: camera eases toward ${productTag} as the feature is indicated. Speed: gradual. End: tight on the feature, held steady.`
}

// ── Phase 2: AI auto-matching ────────────────────────────────────────────────

// Trust nothing from the model: keep only in-range sentence indices mapped to
// real feature ids, one sentence per feature (lowest index wins — a feature
// gestured twice would put two beats in the video).
export function sanitizeFeatureMapping(raw, sentenceCount, features) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const validIds = new Set(features.map(f => f.id))
  const bestByFeature = {}
  for (const [k, fid] of Object.entries(raw)) {
    const idx = Number(k)
    if (!Number.isInteger(idx) || idx < 0 || idx >= sentenceCount) continue
    if (typeof fid !== 'string' || !validIds.has(fid)) continue
    if (!(fid in bestByFeature) || idx < bestByFeature[fid]) bestByFeature[fid] = idx
  }
  return Object.fromEntries(Object.entries(bestByFeature).map(([fid, idx]) => [idx, fid]))
}

// Ask the active AI provider (Claude or GLM — same call either way) which
// dialogue sentence covers each feature. Cross-language on purpose: the script
// is often Chinese while features are named in English. Returns
// { ok, mapping, reason } — a failed call is never fatal, the user just keeps
// tagging manually.
export async function autoMatchFeatures({ features, sentences }) {
  const { aiComplete } = await import('./aiProvider')
  const result = await aiComplete({
    tier: 'light',
    maxTokens: 300,
    system: `You match product features to the dialogue sentence that covers them, for a video where the presenter gestures at each feature while saying its line. The dialogue may be in any language (often Chinese); features are named in English — match by meaning. Output ONLY a JSON object: {"matches": {"<sentenceIndex>": "<featureId>"}}. Map each feature to AT MOST ONE sentence — the one that most directly mentions or describes it. If no sentence covers a feature, omit that feature. No explanation, no markdown.`,
    user: JSON.stringify({
      features: features.map(f => ({ id: f.id, name: f.name })),
      sentences: sentences.map((text, index) => ({ index, text })),
    }),
  })
  if (!result.ok) return { ok: false, mapping: {}, reason: result.reason }
  try {
    const cleaned = result.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed = JSON.parse(cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned)
    return { ok: true, mapping: sanitizeFeatureMapping(parsed.matches || parsed, sentences.length, features) }
  } catch (e) {
    return { ok: false, mapping: {}, reason: `unparseable response: ${e.message}` }
  }
}
