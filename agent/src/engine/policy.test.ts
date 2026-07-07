import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkPolicy, similarity } from './policy'
import type { SoulSheet } from './soul'

const kayla: SoulSheet = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../shared/soul-sheet/kayla.example.json', import.meta.url)), 'utf8'
))

const noHistory = { kind: 'original' as const, recentTexts: [] }

describe('checkPolicy', () => {
  it('passes a normal in-voice post', () => {
    const v = checkPolicy('leg day again. the stairs won', kayla, noHistory)
    expect(v).toEqual({ ok: true, violations: [] })
  })

  it('rejects banned topics wherever they appear', () => {
    const v = checkPolicy('my hot take on politics today', kayla, noHistory)
    expect(v.ok).toBe(false)
    expect(v.violations[0]).toMatch(/banned topic: politics/)
  })

  it('rejects links and @-mentions in originals but allows them in replies', () => {
    expect(checkPolicy('new vid https://youtu.be/x', kayla, noHistory).violations).toContain('link in original')
    expect(checkPolicy('shoutout @someone', kayla, noHistory).violations).toContain('@-mention in original')
    const reply = { kind: 'reply' as const, recentTexts: [] }
    expect(checkPolicy('@someone so real', kayla, reply).ok).toBe(true)
  })

  it('rejects over-length and empty drafts', () => {
    expect(checkPolicy('x'.repeat(281), kayla, noHistory).violations[0]).toMatch(/too long/)
    expect(checkPolicy('   ', kayla, noHistory).violations).toContain('empty draft')
  })

  it('rejects near-duplicates of recent posts (X "substantially similar" rule)', () => {
    const prior = 'gym at 6am: empty. gym at 6pm: a nightclub without music'
    const v = checkPolicy('gym at 6am: empty. gym at 6pm: a nightclub with music', kayla, {
      kind: 'original', recentTexts: [prior],
    })
    expect(v.ok).toBe(false)
    expect(v.violations[0]).toMatch(/near-duplicate/)
    // genuinely different post passes against the same history
    expect(checkPolicy('deadlift the cat knocked over my meal prep again', kayla, {
      kind: 'original', recentTexts: [prior],
    }).ok).toBe(true)
  })
})

describe('similarity', () => {
  it('is 1 for identical texts and low for unrelated ones', () => {
    expect(similarity('leg day was humbling', 'leg day was humbling')).toBe(1)
    expect(similarity('leg day was humbling', 'thinking about tacos tonight')).toBeLessThan(0.2)
    expect(similarity('', 'anything')).toBe(0)
  })
})
