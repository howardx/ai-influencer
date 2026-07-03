import { describe, it, expect } from 'vitest'
import {
  getBackstoryContext,
  buildPromptInput,
  buildDirectPrompt,
  buildThreeVariationPrompts,
} from './systemPrompt.js'

const kayla = {
  name: 'Kayla',
  gender: 'Female',
  age: 24,
  physicalDesc: 'long dark hair, warm olive skin, brown eyes',
  vibeWords: ['Minimalist'],
  personality: 40,
  backstory: 'Works as a yoga instructor in Lisbon, quiet mornings, loves matcha.',
}

describe('getBackstoryContext', () => {
  it('returns empty context when there is nothing to match', () => {
    expect(getBackstoryContext('', '')).toEqual({
      tags: [],
      sceneNiche: null,
      buildHint: null,
      physicalDetail: null,
      lockedScene: null,
    })
    expect(getBackstoryContext(undefined, undefined).tags).toEqual([])
  })

  it('detects a profession with its niche, build hint, and locked scene', () => {
    const ctx = getBackstoryContext('', 'She is a yoga instructor in Lisbon')
    expect(ctx.sceneNiche).toBe('fitness')
    expect(ctx.tags).toContain('sport')
    expect(ctx.buildHint).toBe('lean, flexible, long-limbed')
    expect(ctx.lockedScene).toContain('yoga studio')
  })

  it('matches case-insensitively across both physical description and backstory', () => {
    expect(getBackstoryContext('YOGA TEACHER', '').sceneNiche).toBe('fitness')
    expect(getBackstoryContext('', 'Bohemian free spirit').tags).toContain('bohemian')
  })

  it('detects aesthetic signals without forcing a scene niche', () => {
    const ctx = getBackstoryContext('', 'minimalist wardrobe, quiet aesthetic')
    expect(ctx.tags).toContain('minimalist')
    expect(ctx.sceneNiche).toBeNull()
  })

  it('deduplicates tags when multiple archetypes contribute the same tag', () => {
    // 'downtown' (street archetype) and 'grunge' (dark archetype) both add 'urban'
    const ctx = getBackstoryContext('', 'downtown grunge scene')
    const urbanCount = ctx.tags.filter(t => t === 'urban').length
    expect(urbanCount).toBe(1)
  })

  it('keeps the first matching archetype for single-value fields', () => {
    // yoga instructor appears before gym in the archetype list
    const ctx = getBackstoryContext('', 'yoga instructor who also lifts at the gym')
    expect(ctx.lockedScene).toContain('yoga studio')
    expect(ctx.buildHint).toBe('lean, flexible, long-limbed')
  })
})

describe('buildPromptInput', () => {
  it('threads every influencer field into the prompt', () => {
    const out = buildPromptInput(kayla)
    expect(out).toContain('Name: Kayla')
    expect(out).toContain('Gender: Female')
    expect(out).toContain('Age: 24')
    expect(out).toContain('long dark hair')
    expect(out).toContain('Minimalist')
    expect(out).toContain('yoga instructor')
  })

  it('describes personality bands from the numeric score', () => {
    expect(buildPromptInput({ personality: 10 })).toContain('deeply introverted')
    expect(buildPromptInput({ personality: 60 })).toContain('balanced')
    expect(buildPromptInput({ personality: 95 })).toContain('highly extroverted')
  })

  it('falls back to sane defaults when fields are missing', () => {
    const out = buildPromptInput({})
    expect(out).toContain('Name: unnamed')
    expect(out).toContain('Gender: unspecified')
    expect(out).toContain('50/100')
    expect(out).toContain('Backstory: not given')
  })
})

describe('buildDirectPrompt', () => {
  it('produces a full prompt containing the subject and core constraints', () => {
    const out = buildDirectPrompt(kayla)
    expect(out).toContain('iPhone 16 Pro snapshot')
    expect(out).toContain('long dark hair, warm olive skin, brown eyes')
    expect(out).toContain('no people in the background')
  })

  it('frames 9:16 as a tight vertical crop by default', () => {
    expect(buildDirectPrompt(kayla)).toContain('60–70% of the 9:16 frame')
  })

  it('switches to landscape framing for 16:9', () => {
    const out = buildDirectPrompt(kayla, null, {}, '16:9')
    expect(out).toContain('Horizontal landscape frame')
    expect(out).not.toContain('9:16 frame')
  })

  it('uses the profession locked scene when backstory-locked', () => {
    const out = buildDirectPrompt(kayla, null, { backstoryLocked: true })
    expect(out).toContain('yoga studio')
  })
})

describe('buildThreeVariationPrompts', () => {
  it('returns three prompts for the default model', () => {
    const prompts = buildThreeVariationPrompts(kayla)
    expect(prompts).toHaveLength(3)
    for (const p of prompts) {
      expect(typeof p).toBe('string')
      expect(p).toContain('iPhone 16 Pro snapshot')
    }
  })

  it('returns three prompts for soul_2 using the simplified pose set', () => {
    const prompts = buildThreeVariationPrompts(kayla, '9:16', 'soul_2')
    expect(prompts).toHaveLength(3)
  })

  it('locks the third variation to the profession scene when one is detected', () => {
    const prompts = buildThreeVariationPrompts(kayla)
    expect(prompts[2]).toContain('yoga studio')
  })

  it('allows at most one drink prop across the three variations', () => {
    // Drinks are dominant props; the builder caps them at one per session.
    // These are the exact drink entries from the UNIVERSAL_PROPS pool.
    const drinkProps = ['iced matcha latte', 'iced coffee in a clear coffee shop cup', 'iced latte in a clear cup']
    for (let run = 0; run < 20; run++) {
      const prompts = buildThreeVariationPrompts({ ...kayla, backstory: '' })
      const drinks = prompts.filter(p => drinkProps.some(d => p.includes(d))).length
      expect(drinks).toBeLessThanOrEqual(1)
    }
  })
})
