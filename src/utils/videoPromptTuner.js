// AI video-prompt tuner.
//
// The deterministic prompt builder in ContentStudio knows two camera words
// ("handheld moving" / "locked"). This optional pass has the active AI
// provider (Claude or GLM — see aiProvider.js) rewrite each shot's camera
// language using a real movement vocabulary (see cameraKnowledge.js, distilled
// from aicameramovements.com + Kling guidance) while an invariant validator
// guarantees it can only improve the prompt, never corrupt it: if the tune
// touches anything load-bearing — @image_N tags, the user's dialogue, the
// no-music rule, FORMAT, LOGIC RULE — the original deterministic prompt ships
// instead.

import { BAKED_CAMERA_KNOWLEDGE, KNOWLEDGE_SOURCES } from './cameraKnowledge'
import { reportAiAuthFailure } from './aiHealth'
import { getActiveProvider, aiComplete } from './aiProvider'
import { PROTECTED_CLAUSE_PATTERNS } from './featureBeats'

const KNOWLEDGE_CACHE_KEY = 'hf_camera_knowledge_v1'
const KNOWLEDGE_TTL_MS = 7 * 24 * 3600 * 1000
const TUNER_MODEL_KEY = 'hf_tuner_model'

// The active provider's tuner lineup — first entry is that provider's most
// powerful model and its default.
export function getTunerModels() {
  return getActiveProvider().tunerModels
}

export function getTunerModel() {
  const models = getTunerModels()
  try {
    const saved = localStorage.getItem(TUNER_MODEL_KEY)
    if (saved && models.some(m => m.id === saved)) return saved
  } catch {}
  return models[0].id
}

export function setTunerModel(id) {
  if (!getTunerModels().some(m => m.id === id)) return
  try { localStorage.setItem(TUNER_MODEL_KEY, id) } catch {}
}

// Fable 5's safety classifiers can (rarely) decline a benign request with
// stop_reason "refusal". Opting into the server-side fallback re-serves the
// same call on Opus 4.8 instead of wasting it; other models ignore this.
function fableExtras(model) {
  if (model !== 'claude-fable-5') return {}
  return {
    headers: { 'anthropic-beta': 'server-side-fallback-2026-06-01' },
    bodyExtra: { fallbacks: [{ model: 'claude-opus-4-8' }] },
  }
}

export function getCameraKnowledge() {
  try {
    const cached = JSON.parse(localStorage.getItem(KNOWLEDGE_CACHE_KEY) || 'null')
    if (cached?.text && Date.now() - cached.fetchedAt < KNOWLEDGE_TTL_MS) return cached.text
  } catch {}
  return BAKED_CAMERA_KNOWLEDGE
}

// Re-distill the knowledge pack from the live sources using Claude's server-side
// web tools (kling.ai blocks plain fetchers, so this runs through Anthropic's
// fetch infrastructure). Claude-only: GLM has no equivalent server-side web
// tools, and the baked pack remains the reliable floor for every provider.
export async function refreshCameraKnowledge(apiKey) {
  if (getActiveProvider().id !== 'claude') {
    throw new Error('Knowledge refresh needs Claude web tools — the baked camera reference is used instead')
  }
  const model = getTunerModel()
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-beta': 'web-fetch-2025-09-10',
  }
  // Thinking-always-on models spend part of max_tokens reasoning before the
  // reference text, so leave generous headroom.
  const body = {
    model,
    max_tokens: 6000,
    tools: [
      { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
    ],
    system: `You maintain a camera-movement cheat sheet for an AI-video prompt tuner (Seedance 2.0 / Kling family). Study these sources: ${KNOWLEDGE_SOURCES.join(' and ')} (fetch them; fall back to web search for their content if a fetch is blocked). Produce an UPDATED version of the reference text below — same structure and length discipline (under 600 words): movement vocabulary by category, the Movement/Speed/Framing/End grammar, speed words, pairings of movements to commercial beats (hook, product reveal, walking pitch, CTA), and hard rules. Output ONLY the reference text, no preamble.\n\nCURRENT REFERENCE:\n${BAKED_CAMERA_KNOWLEDGE}`,
    messages: [{ role: 'user', content: 'Refresh the camera-movement reference from the live sources.' }],
  }
  const fable = fableExtras(model)
  if (fable.headers) headers['anthropic-beta'] += `,${fable.headers['anthropic-beta']}`
  Object.assign(body, fable.bodyExtra)
  const res = await fetch('/api/claude', { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    reportAiAuthFailure(res.status, getActiveProvider())
    throw new Error(`Knowledge refresh failed (${res.status})`)
  }
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || 'Knowledge refresh failed')
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
  if (text.length < 400) throw new Error('Refresh returned too little content — keeping current knowledge')
  try { localStorage.setItem(KNOWLEDGE_CACHE_KEY, JSON.stringify({ text, fetchedAt: Date.now() })) } catch {}
  return text
}

const tagSet = s => new Set((s.match(/@image_\d+/g) || []))

// Pure and paranoid: every load-bearing element of the deterministic prompt
// must survive the tune verbatim, or the tune is rejected.
export function validateTunedPrompt(original, tuned, { dialogueLines = [] } = {}) {
  if (typeof tuned !== 'string' || tuned.trim().length < 300) return { ok: false, reason: 'output too short' }
  const a = tagSet(original), b = tagSet(tuned)
  if (a.size !== b.size || [...a].some(t => !b.has(t))) return { ok: false, reason: 'image tags changed' }
  // Only enforce lines the original actually contains verbatim: annotateDialogue
  // splits comma-pivot sentences (and oner mode weaves beats between clauses),
  // so a raw sentence may legitimately never appear contiguously in the prompt.
  for (const line of dialogueLines) {
    const t = line.trim()
    if (t && original.includes(t) && !tuned.includes(t)) return { ok: false, reason: 'dialogue was rewritten' }
  }
  if (original.includes('No music. No captions. No text overlays.') && !tuned.includes('No music. No captions. No text overlays.')) {
    return { ok: false, reason: 'no-music rule lost' }
  }
  // The ENTIRE LOGIC RULE line must survive verbatim, not just its marker —
  // it carries the same-object, occlusion, and never-invent-features rules,
  // and the system prompt already demands it byte-identical.
  const logicRuleLine = original.split('\n').find(l => l.startsWith('LOGIC RULE:'))
  if (logicRuleLine && !tuned.includes(logicRuleLine)) return { ok: false, reason: 'LOGIC RULE altered' }
  const formatLine = original.split('\n')[0]
  if (formatLine.startsWith('FORMAT:') && !tuned.includes(formatLine)) return { ok: false, reason: 'FORMAT header changed' }
  // Feature gesture beats, user direction notes, and oner anchors are the
  // deterministic audio-sync layer — camera language around them is fair game,
  // the clauses themselves are not. Patterns live in featureBeats.js next to
  // the strings that produce them.
  for (const re of PROTECTED_CLAUSE_PATTERNS) {
    for (const clause of original.match(re) || []) {
      if (!tuned.includes(clause)) return { ok: false, reason: 'feature gesture beat altered' }
    }
  }
  return { ok: true }
}

// Returns { prompt, tuned, reason } — `prompt` is always safe to submit.
export async function tuneVideoPrompt({ prompt, dialogueLines = [], context = {} }) {
  const model = getTunerModel()
  // max_tokens covers thinking + output on thinking-always-on models
  // (Fable 5, Sonnet 5, GLM-5.x), so it needs far more headroom than the
  // prompt itself.
  const result = await aiComplete({
    model,
    maxTokens: 8000,
    system: `You are a camera-language tuner for Seedance 2.0 video prompts. You receive a working prompt and return the SAME prompt with ONLY the camera movement, framing, and motion language improved per shot, using this reference:\n\n${getCameraKnowledge()}\n\nInviolable rules:\n- Change ONLY camera/movement/framing wording inside shot headers and shot action prose.\n- Every @image_N tag, all dialogue in quotes (any language), the FORMAT line, WARDROBE/PRODUCT/LOGIC RULE sections, timings, and "No music. No captions. No text overlays." stay byte-for-byte identical.\n- One movement per shot, one speed word, no alternatives, no "cinematic" on locked shots.\n- Respect the shot's existing register (handheld self-filmed stays handheld arm's-length; locked stays locked).\n- Feature gesture clauses ("— as she says this, …", "When she reaches the line about …"), user direction notes ("— at this moment, …"), and the LOGIC RULE occlusion sentence stay byte-for-byte identical — they synchronize actions with the audio.\n- Output ONLY the full tuned prompt. No preamble, no code fences, no commentary.`,
    user: `Context: ${JSON.stringify(context)}\n\nPROMPT TO TUNE:\n${prompt}`,
    ...fableExtras(model),
  })
  if (!result.ok) return { prompt, tuned: false, reason: result.reason }
  const text = result.text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim()
  const check = validateTunedPrompt(prompt, text, { dialogueLines })
  if (!check.ok) {
    console.warn('[Tuner] rejected AI tune:', check.reason)
    return { prompt, tuned: false, reason: check.reason }
  }
  return { prompt: text, tuned: true }
}
