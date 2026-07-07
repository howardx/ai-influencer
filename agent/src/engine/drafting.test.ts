import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDraftSystem, buildDraftUser, draftWithCritic } from './drafting'
import type { ClaudeClient } from './claude'
import type { SoulSheet } from './soul'

const kayla: SoulSheet = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../shared/soul-sheet/kayla.example.json', import.meta.url)), 'utf8'
))
const pillar = kayla.contentPillars.find(p => p.name === 'gym take')!
const emptyCtx = { recentPosts: [], arc: null, recentTextsForDedup: [] }

/** Scripted Claude double: returns responses in order, records prompts. */
function fakeClaude(responses: string[]): ClaudeClient & { prompts: { system?: string; user: string }[] } {
  const prompts: { system?: string; user: string }[] = []
  return {
    prompts,
    async complete(p) {
      prompts.push({ system: p.system, user: p.user })
      const next = responses.shift()
      if (next === undefined) throw new Error('fakeClaude ran out of responses')
      return next
    },
  }
}

describe('prompt builders', () => {
  it('system prompt carries the voice: examples, never_sounds_like, boundaries', () => {
    const system = buildDraftSystem(kayla)
    expect(system).toContain('You ARE Kayla')
    expect(system).toContain(kayla.voice.examplePosts[0])
    expect(system).toContain(kayla.voice.never_sounds_like)
    expect(system).toContain('politics')
  })

  it('user prompt injects arc, running bits and recent posts', () => {
    const user = buildDraftUser(pillar, {
      recentPosts: ['old post one'],
      arc: { currentArc: 'meet in eight weeks', runningBits: ['deadlift the cat'], updatedAt: '' },
      recentTextsForDedup: [],
    })
    expect(user).toContain('meet in eight weeks')
    expect(user).toContain('deadlift the cat')
    expect(user).toContain('old post one')
    expect(user).toContain('"gym take"')
  })
})

describe('draftWithCritic', () => {
  it('returns the draft when the critic passes', async () => {
    const claude = fakeClaude(['squat day. humbled, as is tradition', 'PASS'])
    const result = await draftWithCritic(claude, kayla, pillar, emptyCtx)
    expect(result.text).toBe('squat day. humbled, as is tradition')
    expect(result.attempts).toBe(1)
    // draft call got the persona system prompt; critic ran without it
    expect(claude.prompts[0].system).toContain('You ARE Kayla')
    expect(claude.prompts[1].system).toBeUndefined()
  })

  it('regenerates on critic rejection and feeds the reason back', async () => {
    const claude = fakeClaude([
      'crushing my fitness goals every single day!',
      'REJECT: motivational-poster energy',
      'leg day receipts: the stairs won again',
      'PASS',
    ])
    const result = await draftWithCritic(claude, kayla, pillar, emptyCtx)
    expect(result.text).toBe('leg day receipts: the stairs won again')
    expect(result.attempts).toBe(2)
    expect(claude.prompts[2].user).toContain('motivational-poster energy')
  })

  it('drops the slot after 2 regenerations — silence over slop', async () => {
    const claude = fakeClaude([
      'bad one', 'REJECT: sounds AI',
      'bad two', 'REJECT: sounds AI',
      'bad three', 'REJECT: still sounds AI',
    ])
    const result = await draftWithCritic(claude, kayla, pillar, emptyCtx)
    expect(result.text).toBe(null)
    expect(result.droppedBecause).toMatch(/sounds AI/)
    expect(result.attempts).toBe(3)
  })

  it('policy failures regenerate without spending a critic call', async () => {
    const claude = fakeClaude([
      'check my new program https://example.com',  // link in original → policy, no critic call
      'no links here, just leg day pain',
      'PASS',
    ])
    const result = await draftWithCritic(claude, kayla, pillar, emptyCtx)
    expect(result.text).toBe('no links here, just leg day pain')
    // 3 calls total: draft, draft, critic — the bad draft never reached the critic
    expect(claude.prompts).toHaveLength(3)
    expect(claude.prompts[1].user).toContain('link in original')
  })

  it('strips wrapping quotes from model output', async () => {
    const claude = fakeClaude(['"quoted post"', 'PASS'])
    const result = await draftWithCritic(claude, kayla, pillar, emptyCtx)
    expect(result.text).toBe('quoted post')
  })
})
