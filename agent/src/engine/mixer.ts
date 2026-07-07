// Content mixer + scheduler (spec §6): decides how many posts today, which
// pillars, and when — with deliberate variance, because regularity is the
// loudest bot tell. Pure functions over an injectable RNG so every behavior
// is testable deterministically.
import type { SoulSheet, ContentPillar } from './soul'

export type Rng = () => number // [0,1), Math.random-compatible

export interface DaySlot {
  pillar: ContentPillar
  /** ISO timestamp inside activeHours, jittered, never on the :00/:30 grid */
  at: string
}

export interface DayPlan {
  slots: DaySlot[]
  /** photo drop was scheduled but the media library is empty (Telegram alert) */
  outOfPhotos: boolean
}

interface Window { start: number; end: number } // minutes since local midnight

export interface ActiveHours {
  active: Window
  quiet: Window[]
}

const DEFAULT_HOURS: ActiveHours = { active: { start: 8 * 60, end: 22 * 60 }, quiet: [] }

/**
 * Parse the free-form rhythm string, e.g. "07:00–23:30 local, quiet 13:00–15:00".
 * First HH:MM–HH:MM range = active window; every later range = quiet window.
 * Unparseable input falls back to 08:00–22:00 — never crash over prose.
 */
export function parseActiveHours(text: string): ActiveHours {
  const ranges = [...text.matchAll(/(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/g)].map(m => ({
    start: Number(m[1]) * 60 + Number(m[2]),
    end: Number(m[3]) * 60 + Number(m[4]),
  }))
  const valid = ranges.filter(r => r.start < r.end && r.end <= 24 * 60)
  if (valid.length === 0) return DEFAULT_HOURS
  return { active: valid[0], quiet: valid.slice(1) }
}

/** Daily post count: warm-up pins to 1–2 (new-account trust ramp), else postsPerDay range. */
export function sampleDailyCount(sheet: SoulSheet, rng: Rng, warmUp: boolean): number {
  const [min, max] = warmUp ? [1, 2] : sheet.rhythm.postsPerDay
  return min + Math.floor(rng() * (max - min + 1))
}

/**
 * Pick pillars for the day's slots: weight-proportional, never the same
 * pillar twice in a row, queue-gated pillars excluded (trend takes enter via
 * trend sourcing with a topic attached — the mixer can't schedule an opinion
 * about nothing). Photo pillars downgrade to the heaviest text pillar when
 * the library is empty — a missed photo is invisible, a broken one isn't.
 */
export function pickPillars(
  sheet: SoulSheet, count: number, rng: Rng, photoAvailable: boolean
): { pillars: ContentPillar[]; outOfPhotos: boolean } {
  const eligible = sheet.contentPillars.filter(p => !p.queueGated)
  const pillars: ContentPillar[] = []
  let outOfPhotos = false
  let previous: string | null = null

  for (let i = 0; i < count; i++) {
    const pool = eligible.filter(p => p.name !== previous)
    const total = pool.reduce((s, p) => s + p.weight, 0)
    let roll = rng() * total
    let picked = pool[pool.length - 1]
    for (const p of pool) {
      roll -= p.weight
      if (roll <= 0) { picked = p; break }
    }
    if (picked.media === 'always' && !photoAvailable) {
      outOfPhotos = true
      // heaviest text pillar that keeps the no-repeat rule intact
      const fallback = eligible
        .filter(p => p.media !== 'always' && p.name !== previous)
        .sort((a, b) => b.weight - a.weight)[0]
      if (fallback) picked = fallback
    }
    pillars.push(picked)
    previous = picked.name
  }
  return { pillars, outOfPhotos }
}

const MIN_GAP_MINUTES = 45

/**
 * Slot times inside the active window, quiet hours excluded, minimum gap
 * enforced, and never on :00/:30 (grid times read as scheduled-bot posts).
 * Returns minute-of-day values with second-level jitter applied by callers.
 */
export function sampleSlotMinutes(count: number, hours: ActiveHours, rng: Rng): number[] {
  const inQuiet = (m: number) => hours.quiet.some(q => m >= q.start && m < q.end)
  const minutes: number[] = []
  let guard = 0
  while (minutes.length < count && guard++ < 500) {
    let m = hours.active.start + Math.floor(rng() * (hours.active.end - hours.active.start))
    if (m % 30 === 0) m += 1 + Math.floor(rng() * 7) // step off the grid
    if (inQuiet(m)) continue
    if (minutes.some(x => Math.abs(x - m) < MIN_GAP_MINUTES)) continue
    minutes.push(m)
  }
  return minutes.sort((a, b) => a - b)
}

/**
 * Plan a day. `dayStartMs` is local midnight for the persona's day being
 * planned. Slots already in the past (planning mid-day) are dropped rather
 * than bunched into the remaining hours.
 */
export function planDay(
  sheet: SoulSheet,
  opts: { rng: Rng; dayStartMs: number; nowMs: number; warmUp: boolean; photoAvailable: boolean }
): DayPlan {
  const hours = parseActiveHours(sheet.rhythm.activeHours)
  const count = sampleDailyCount(sheet, opts.rng, opts.warmUp)
  const { pillars, outOfPhotos } = pickPillars(sheet, count, opts.rng, opts.photoAvailable)
  const minutes = sampleSlotMinutes(pillars.length, hours, opts.rng)

  const slots = minutes
    .map((m, i) => ({
      pillar: pillars[i],
      at: new Date(opts.dayStartMs + m * 60_000 + Math.floor(opts.rng() * 60_000)).toISOString(),
    }))
    .filter(s => Date.parse(s.at) > opts.nowMs)

  return { slots, outOfPhotos }
}
