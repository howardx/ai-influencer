import { describe, it, expect } from 'vitest'
import { validateSoulSheet, parseSoulSheet } from './validate.js'
import kayla from './kayla.example.json'

// Deep-clone helper so each test mutates its own copy
const sheet = () => JSON.parse(JSON.stringify(kayla))

describe('validateSoulSheet', () => {
  it('accepts the Kayla example sheet', () => {
    const { valid, errors } = validateSoulSheet(kayla)
    expect(errors).toEqual([])
    expect(valid).toBe(true)
  })

  it('rejects a non-object', () => {
    expect(validateSoulSheet(null).valid).toBe(false)
    expect(validateSoulSheet('kayla').valid).toBe(false)
  })

  it('requires the AI disclosure (compliance is non-negotiable)', () => {
    const s = sheet()
    delete s.boundaries.disclosure
    const { valid, errors } = validateSoulSheet(s)
    expect(valid).toBe(false)
    expect(errors.join(' ')).toMatch(/disclosure/)
  })

  it('structurally rejects a commercial/promo pillar (closed enum)', () => {
    const s = sheet()
    s.contentPillars[1] = { name: 'commercial', weight: 0.3, media: 'always' }
    expect(validateSoulSheet(s).valid).toBe(false)
  })

  it('requires trend opinion to be queue-gated', () => {
    const s = sheet()
    delete s.contentPillars[3].queueGated
    expect(validateSoulSheet(s).valid).toBe(false)
    s.contentPillars[3].queueGated = false
    expect(validateSoulSheet(s).valid).toBe(false)
  })

  it('requires pillar weights to sum to 1', () => {
    const s = sheet()
    s.contentPillars[0].weight = 0.9
    const { valid, errors } = validateSoulSheet(s)
    expect(valid).toBe(false)
    expect(errors.join(' ')).toMatch(/sum to 1/)
  })

  it('rejects duplicate pillars', () => {
    const s = sheet()
    s.contentPillars = [
      { name: 'gym take', weight: 0.5, media: 'sometimes' },
      { name: 'gym take', weight: 0.5, media: 'never' },
    ]
    const { valid, errors } = validateSoulSheet(s)
    expect(valid).toBe(false)
    expect(errors.join(' ')).toMatch(/unique/)
  })

  it('requires 5–10 example posts (they carry the voice)', () => {
    const s = sheet()
    s.voice.examplePosts = s.voice.examplePosts.slice(0, 3)
    expect(validateSoulSheet(s).valid).toBe(false)
  })

  it('caps example posts at tweet length', () => {
    const s = sheet()
    s.voice.examplePosts[0] = 'x'.repeat(281)
    expect(validateSoulSheet(s).valid).toBe(false)
  })

  it('rejects inverted postsPerDay range', () => {
    const s = sheet()
    s.rhythm.postsPerDay = [5, 2]
    const { valid, errors } = validateSoulSheet(s)
    expect(valid).toBe(false)
    expect(errors.join(' ')).toMatch(/postsPerDay/)
  })

  it('rejects unknown top-level keys (catches typos before the agent sees them)', () => {
    const s = sheet()
    s.contentPilars = s.contentPillars
    expect(validateSoulSheet(s).valid).toBe(false)
  })

  it('rejects underage personas', () => {
    const s = sheet()
    s.identity.age = 16
    expect(validateSoulSheet(s).valid).toBe(false)
  })
})

describe('parseSoulSheet', () => {
  it('round-trips a valid sheet from JSON text', () => {
    const { valid, sheet: parsed, errors } = parseSoulSheet(JSON.stringify(kayla))
    expect(errors).toEqual([])
    expect(valid).toBe(true)
    expect(parsed.identity.name).toBe('Kayla')
  })

  it('reports malformed JSON without throwing', () => {
    const { valid, sheet: parsed, errors } = parseSoulSheet('{not json')
    expect(valid).toBe(false)
    expect(parsed).toBe(null)
    expect(errors[0]).toMatch(/not valid JSON/)
  })
})
