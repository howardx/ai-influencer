import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateTunedPrompt, getCameraKnowledge, getTunerModel, setTunerModel, TUNER_MODELS, DEFAULT_TUNER_MODEL } from './videoPromptTuner.js'
import { BAKED_CAMERA_KNOWLEDGE } from './cameraKnowledge.js'

const ORIGINAL = `FORMAT: 15s / 4 SHOTS / direct address

SUBJECT: @image_1 is the identity. @image_3 for close-up facial detail.

PRODUCT:

@image_5 — product reference 1.

LOGIC RULE: @image_1 face is fixed. No music. No captions. No text overlays.

SHOT 1 — 0:00 to 0:02, MCU, 24mm, handheld moving.
One breath before she speaks. "果然物理防晒，才是防晒界的神。" [beat.]

SHOT 2 — 0:02 to 0:05, MCU, 24mm, handheld moving.
she touches @image_5 and angles toward camera. "这个口罩上脸很舒服。" Voice unhurried.`

const DIALOGUE = ['果然物理防晒，才是防晒界的神。', '这个口罩上脸很舒服。']

// A legitimate tune: only camera language changed
const GOOD_TUNE = ORIGINAL
  .replace('MCU, 24mm, handheld moving.\nOne breath', 'MCU, 24mm, slow push in — Movement: camera eases toward her face. Speed: gradual. End: tight MCU held.\nOne breath')
  .replace('handheld moving.\nshe touches', 'arc right — Movement: quarter-circle around her as she demonstrates. Speed: smooth.\nshe touches')

describe('validateTunedPrompt', () => {
  it('accepts a tune that only changes camera language', () => {
    expect(validateTunedPrompt(ORIGINAL, GOOD_TUNE, { dialogueLines: DIALOGUE }).ok).toBe(true)
  })

  it('rejects a tune that drops or invents @image_N tags', () => {
    expect(validateTunedPrompt(ORIGINAL, GOOD_TUNE.replace('@image_5 — product', '@image_9 — product'), { dialogueLines: DIALOGUE }).ok).toBe(false)
    expect(validateTunedPrompt(ORIGINAL, GOOD_TUNE.replaceAll('@image_3', '@image_1'), { dialogueLines: DIALOGUE }).ok).toBe(false)
  })

  it('rejects a tune that rewrites the dialogue', () => {
    const reworded = GOOD_TUNE.replace('这个口罩上脸很舒服。', '这个口罩戴起来很舒服。')
    expect(validateTunedPrompt(ORIGINAL, reworded, { dialogueLines: DIALOGUE }).ok).toBe(false)
  })

  it('rejects a tune that loses the no-music rule or LOGIC RULE', () => {
    expect(validateTunedPrompt(ORIGINAL, GOOD_TUNE.replace('No music. No captions. No text overlays.', ''), { dialogueLines: DIALOGUE }).ok).toBe(false)
    expect(validateTunedPrompt(ORIGINAL, GOOD_TUNE.replace('LOGIC RULE:', 'RULES:'), { dialogueLines: DIALOGUE }).ok).toBe(false)
  })

  it('rejects empty, non-string, or truncated output', () => {
    expect(validateTunedPrompt(ORIGINAL, '', { dialogueLines: DIALOGUE }).ok).toBe(false)
    expect(validateTunedPrompt(ORIGINAL, null, { dialogueLines: DIALOGUE }).ok).toBe(false)
    expect(validateTunedPrompt(ORIGINAL, 'SHOT 1 — nice video', { dialogueLines: DIALOGUE }).ok).toBe(false)
  })

  it('requires the FORMAT header to survive verbatim', () => {
    const changedFormat = GOOD_TUNE.replace('FORMAT: 15s / 4 SHOTS', 'FORMAT: 20s / 5 SHOTS')
    expect(validateTunedPrompt(ORIGINAL, changedFormat, { dialogueLines: DIALOGUE }).ok).toBe(false)
  })

  it('only enforces dialogue lines the original contains verbatim (annotated lines are exempt)', () => {
    // annotateDialogue splits comma-pivot sentences, so the raw sentence never
    // appears contiguously in the prompt — a faithful tune must still pass.
    const pivotLine = 'I loved the color, but the fit is what sold me.'
    const original = ORIGINAL.replace(
      '"果然物理防晒，才是防晒界的神。"',
      '"I loved the color," [half-beat] "but the fit is what sold me."'
    )
    const tuned = GOOD_TUNE.replace(
      '"果然物理防晒，才是防晒界的神。"',
      '"I loved the color," [half-beat] "but the fit is what sold me."'
    )
    const lines = [pivotLine, '这个口罩上脸很舒服。']
    expect(validateTunedPrompt(original, tuned, { dialogueLines: lines }).ok).toBe(true)
    // but a verbatim-present line that the tune drops still rejects
    const dropped = tuned.replace('这个口罩上脸很舒服。', '这个口罩戴着很舒服。')
    expect(validateTunedPrompt(original, dropped, { dialogueLines: lines }).ok).toBe(false)
  })
})

describe('getCameraKnowledge', () => {
  beforeEach(() => {
    const store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('falls back to the baked pack with no cache', () => {
    expect(getCameraKnowledge()).toBe(BAKED_CAMERA_KNOWLEDGE)
  })

  it('uses a fresh cached pack and ignores an expired one', () => {
    localStorage.setItem('hf_camera_knowledge_v1', JSON.stringify({ text: 'FRESH', fetchedAt: Date.now() }))
    expect(getCameraKnowledge()).toBe('FRESH')
    localStorage.setItem('hf_camera_knowledge_v1', JSON.stringify({ text: 'STALE', fetchedAt: Date.now() - 8 * 24 * 3600 * 1000 }))
    expect(getCameraKnowledge()).toBe(BAKED_CAMERA_KNOWLEDGE)
  })

  it('survives corrupted cache values', () => {
    localStorage.setItem('hf_camera_knowledge_v1', '{corrupt')
    expect(getCameraKnowledge()).toBe(BAKED_CAMERA_KNOWLEDGE)
  })
})

describe('tuner model preference', () => {
  beforeEach(() => {
    const store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to the most powerful model (Fable 5)', () => {
    expect(DEFAULT_TUNER_MODEL).toBe('claude-fable-5')
    expect(getTunerModel()).toBe('claude-fable-5')
  })

  it('offers the default first and every option has an id and label', () => {
    expect(TUNER_MODELS[0].id).toBe(DEFAULT_TUNER_MODEL)
    for (const m of TUNER_MODELS) {
      expect(typeof m.id).toBe('string')
      expect(m.label.length).toBeGreaterThan(0)
    }
  })

  it('persists a valid choice and returns it', () => {
    setTunerModel('claude-haiku-4-5')
    expect(getTunerModel()).toBe('claude-haiku-4-5')
    expect(localStorage.getItem('hf_tuner_model')).toBe('claude-haiku-4-5')
  })

  it('ignores an unknown persisted model and falls back to the default', () => {
    localStorage.setItem('hf_tuner_model', 'claude-sonnet-4-6')
    expect(getTunerModel()).toBe(DEFAULT_TUNER_MODEL)
  })

  it('setTunerModel rejects unknown ids without touching storage', () => {
    setTunerModel('gpt-5')
    expect(localStorage.getItem('hf_tuner_model')).toBe(null)
    expect(getTunerModel()).toBe(DEFAULT_TUNER_MODEL)
  })
})
