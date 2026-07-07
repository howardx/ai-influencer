import { describe, it, expect } from 'vitest'
import { validateSoulSheet } from '../../shared/soul-sheet/validate.js'
import kayla from '../../shared/soul-sheet/kayla.example.json'
import { buildDefaultSoulSheet, buildSeedPrompt, parseSeedResponse } from './soulSheetDraft'

const INF = {
  id: 'kayla-template',
  name: 'Kayla',
  age: '18',
  gender: 'Female',
  niche: 'Fashion',
  backstory: 'wanna be influencer',
  hobbies: 'gym, tacos',
  clothingStyle: 'Streetwear',
  physicalDesc: 'blonde, athletic build',
  voice: '',
  introExtrovert: 85,
}

describe('buildDefaultSoulSheet', () => {
  it('seeds from the influencer profile', () => {
    const sheet = buildDefaultSoulSheet(INF)
    expect(sheet.personaId).toBe('kayla-template')
    expect(sheet.identity.name).toBe('Kayla')
    expect(sheet.identity.age).toBe(18)
    expect(sheet.worldview.interests).toEqual(['gym', 'tacos'])
  })

  it('omits underage/blank ages instead of failing validation later', () => {
    const sheet = buildDefaultSoulSheet({ ...INF, age: '' })
    expect(sheet.identity.age).toBeUndefined()
  })

  it('is schema-valid except for the voice fields the user must fill', () => {
    const { valid, errors } = validateSoulSheet(buildDefaultSoulSheet(INF))
    expect(valid).toBe(false)
    expect(errors.join(' ')).toMatch(/examplePosts/)
    // every remaining problem is a to-fill voice field, nothing structural
    expect(errors.every(e => /examplePosts|style/.test(e))).toBe(true)
  })

  it('always includes the queue-gated trend pillar and weights summing to 1', () => {
    const sheet = buildDefaultSoulSheet(INF)
    const trend = sheet.contentPillars.find(p => p.name === 'trend opinion')
    expect(trend.queueGated).toBe(true)
    expect(sheet.contentPillars.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1)
  })
})

describe('buildSeedPrompt', () => {
  it('embeds the schema and the influencer profile', () => {
    const { system, user } = buildSeedPrompt(INF)
    expect(system).toMatch(/ONLY a JSON object/)
    expect(user).toContain('"trend opinion"')
    expect(user).toContain('Kayla')
    expect(user).toContain('personaId "kayla-template"')
  })
})

describe('parseSeedResponse', () => {
  it('accepts a valid sheet and forces identity keys', () => {
    const doctored = { ...kayla, personaId: 'model-invented-this', schemaVersion: 99 }
    const { sheet, errors } = parseSeedResponse(
      'Here you go:\n```json\n' + JSON.stringify(doctored) + '\n```',
      INF
    )
    expect(errors).toEqual([])
    expect(sheet.personaId).toBe('kayla-template')
    expect(sheet.schemaVersion).toBe(1)
  })

  it('rejects invalid sheets with readable errors', () => {
    const bad = { ...kayla, contentPillars: [{ name: 'commercial', weight: 1, media: 'always' }] }
    const { sheet, errors } = parseSeedResponse(JSON.stringify(bad), INF)
    expect(sheet).toBe(null)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('handles non-JSON responses without throwing', () => {
    expect(parseSeedResponse('sorry, I cannot', INF).sheet).toBe(null)
    expect(parseSeedResponse('{broken', INF).sheet).toBe(null)
  })
})
