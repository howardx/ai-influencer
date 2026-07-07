import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseActiveHours, sampleDailyCount, pickPillars, sampleSlotMinutes, planDay } from './mixer'
import type { SoulSheet } from './soul'

const kayla: SoulSheet = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../shared/soul-sheet/kayla.example.json', import.meta.url)), 'utf8'
))

// Deterministic rng from a fixed sequence (cycles)
const seqRng = (values: number[]) => {
  let i = 0
  return () => values[i++ % values.length]
}

describe('parseActiveHours', () => {
  it('parses active + quiet windows from the free-form string', () => {
    const h = parseActiveHours('06:30–22:30 local, quiet 13:00–15:00')
    expect(h.active).toEqual({ start: 390, end: 1350 })
    expect(h.quiet).toEqual([{ start: 780, end: 900 }])
  })

  it('falls back to 08:00–22:00 on prose it cannot parse', () => {
    expect(parseActiveHours('whenever she feels like it').active).toEqual({ start: 480, end: 1320 })
  })
})

describe('sampleDailyCount', () => {
  it('stays in the sheet range normally and pins to 1–2 in warm-up', () => {
    for (const roll of [0, 0.5, 0.99]) {
      const normal = sampleDailyCount(kayla, () => roll, false)
      expect(normal).toBeGreaterThanOrEqual(2)
      expect(normal).toBeLessThanOrEqual(5)
      const warm = sampleDailyCount(kayla, () => roll, true)
      expect(warm).toBeGreaterThanOrEqual(1)
      expect(warm).toBeLessThanOrEqual(2)
    }
  })
})

describe('pickPillars', () => {
  it('never schedules a queue-gated pillar (trend takes need a topic)', () => {
    const { pillars } = pickPillars(kayla, 50, seqRng([0.1, 0.5, 0.9, 0.3]), true)
    expect(pillars.some(p => p.name === 'trend opinion')).toBe(false)
  })

  it('never repeats a pillar twice in a row', () => {
    const { pillars } = pickPillars(kayla, 50, seqRng([0.01, 0.02, 0.03]), true)
    for (let i = 1; i < pillars.length; i++) {
      expect(pillars[i].name).not.toBe(pillars[i - 1].name)
    }
  })

  it('downgrades photo drop to a text pillar when the library is empty', () => {
    // rng 0 always lands on the first / heaviest pillar (photo drop)
    const { pillars, outOfPhotos } = pickPillars(kayla, 3, seqRng([0]), false)
    expect(outOfPhotos).toBe(true)
    expect(pillars.every(p => p.media !== 'always')).toBe(true)
  })
})

describe('sampleSlotMinutes', () => {
  it('respects active window, quiet hours, min gap, and avoids the :00/:30 grid', () => {
    const hours = parseActiveHours('06:30–22:30, quiet 13:00–15:00')
    const rng = seqRng([0.1, 0.15, 0.4, 0.45, 0.7, 0.75, 0.9, 0.95, 0.2, 0.5])
    const minutes = sampleSlotMinutes(4, hours, rng)
    expect(minutes).toHaveLength(4)
    for (let i = 0; i < minutes.length; i++) {
      const m = minutes[i]
      expect(m).toBeGreaterThanOrEqual(390)
      expect(m).toBeLessThan(1350)
      expect(m < 780 || m >= 900).toBe(true) // not in quiet hours
      expect(m % 30).not.toBe(0)             // off the grid
      if (i > 0) expect(m - minutes[i - 1]).toBeGreaterThanOrEqual(45)
    }
  })
})

describe('planDay', () => {
  const dayStartMs = Date.parse('2026-07-08T00:00:00.000Z')

  it('produces future slots with pillars and jittered ISO times', () => {
    const plan = planDay(kayla, {
      rng: seqRng([0.5, 0.2, 0.6, 0.35, 0.8, 0.55, 0.1, 0.9]),
      dayStartMs,
      nowMs: dayStartMs, // planning at midnight — all slots future
      warmUp: false,
      photoAvailable: true,
    })
    expect(plan.slots.length).toBeGreaterThanOrEqual(2)
    for (const slot of plan.slots) {
      expect(Date.parse(slot.at)).toBeGreaterThan(dayStartMs)
      expect(slot.pillar.queueGated).not.toBe(true)
    }
    // slots are ordered
    const times = plan.slots.map(s => Date.parse(s.at))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('drops slots already in the past when planning mid-day', () => {
    const noon = dayStartMs + 12 * 3_600_000
    const plan = planDay(kayla, {
      rng: seqRng([0.9, 0.2, 0.6, 0.1, 0.3, 0.5]),
      dayStartMs,
      nowMs: noon,
      warmUp: true,
      photoAvailable: true,
    })
    for (const slot of plan.slots) {
      expect(Date.parse(slot.at)).toBeGreaterThan(noon)
    }
  })
})
