// Integration test: the whole MVP demo arc on DemoAdapter with a fake clock
// and a scripted Claude — plan → draft → auto-publish originals; mention →
// reply draft → Telegram card → ✅ → humanized delay → publish; /pause halts
// everything; expiry keeps silence safe.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, listQueueItems, listRecentPosts, setSetting, type Db } from '../storage/db'
import { AgentLoop } from './loop'
import { DemoAdapter } from '../adapters/demo'
import type { ClaudeClient } from './claude'
import type { SoulSheet } from './soul'
import { TelegramBot } from '../telegram/bot'

const kayla: SoulSheet = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../shared/soul-sheet/kayla.example.json', import.meta.url)), 'utf8'
))
const T = { personaId: kayla.personaId, ownerId: kayla.ownerId }

// Claude double: every draft passes the critic
const agreeableClaude: ClaudeClient = {
  async complete({ user }) {
    if (user.includes('Candidate post')) return 'PASS'
    if (user.includes('wrote to you')) return 'anytime. we go again'
    return 'leg day receipts: the stairs won again'
  },
}

// Deterministic PRNG — a constant rng would make every slot sample identical
// and starve the scheduler's rejection sampling
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeHarness(dir: string, opts: { claude?: ClaudeClient | null; telegramUpdates?: unknown[] } = {}) {
  const db = openDb(join(dir, 't.db'))
  const demo = new DemoAdapter({ log: () => {} })
  let nowMs = Date.parse('2026-07-08T05:00:00.000Z') // ~midnight in Kayla's Chicago tz
  const clock = {
    now: () => nowMs,
    advance: (ms: number) => { nowMs += ms },
  }
  const loop = new AgentLoop({
    db, sheet: kayla, adapter: demo,
    claude: opts.claude === undefined ? agreeableClaude : opts.claude,
    rng: mulberry32(42),
    now: clock.now,
    log: () => {},
  })

  const tgSent: { method: string; params: Record<string, unknown> }[] = []
  const updates = opts.telegramUpdates ?? []
  const tgFetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()!
    tgSent.push({ method, params: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? updates.splice(0) : {} }))
  }) as typeof fetch
  let offset = 0
  const bot = new TelegramBot({
    token: 't', chatId: '42', handlers: loop.handlers, fetchImpl: tgFetch,
    offsetStore: { get: () => offset, set: n => { offset = n } },
  })
  loop.attachTelegram(bot)

  // fast-forward past warm-up so replies are live (warm-up behavior tested separately)
  setSetting(db, T, 'warmup_until', '2026-07-01T00:00:00.000Z', new Date(nowMs).toISOString())
  return { db, demo, loop, clock, tgSent, pushUpdate: (u: unknown) => updates.push(u) }
}

describe('AgentLoop end-to-end (DemoAdapter)', () => {
  let dir: string
  let db: Db

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loop-test-')) })
  afterEach(() => { db?.close(); rmSync(dir, { recursive: true, force: true }) })

  it('plans once per day, drafts due slots, auto-publishes originals with a mirror', async () => {
    const h = makeHarness(dir); db = h.db
    await h.loop.tick()
    const planned = listQueueItems(db, T)
    expect(planned.length).toBeGreaterThanOrEqual(2) // postsPerDay [2,5]
    expect(planned.every(i => i.kind === 'original' && i.status === 'draft')).toBe(true)

    // second tick same day: no duplicate planning
    await h.loop.tick()
    expect(listQueueItems(db, T)).toHaveLength(planned.length)

    // jump past the last slot + max jitter: drafts fill in, auto-approve, publish
    const lastSlot = Math.max(...planned.map(i => Date.parse(i.scheduledAt!)))
    h.clock.advance(lastSlot - h.clock.now() + 120_000)
    await h.loop.tick() // drafts + schedules publish (≤90s jitter)
    h.clock.advance(120_000)
    await h.loop.tick() // publish sweep
    expect(h.demo.published.length).toBe(planned.length)
    expect(h.demo.published[0].text).toBe('leg day receipts: the stairs won again')
    expect(listRecentPosts(db, T, 10)).toHaveLength(planned.length)
    // auto-published originals mirrored to the log channel with 🗑
    const mirrors = h.tgSent.filter(s => String(s.params.text ?? '').startsWith('📤 published'))
    expect(mirrors.length).toBe(planned.length)
  })

  it('mention → queued reply card → ✅ → humanized delay → published reply', async () => {
    const h = makeHarness(dir); db = h.db
    h.demo.simulateMention({
      id: 'm-1', authorHandle: 'gymrat', text: 'form check?', createdAt: '2026-07-08T04:00:00.000Z',
    })
    await h.loop.tick()
    const reply = listQueueItems(db, T, 'pending_approval').find(i => i.kind === 'reply')!
    expect(reply.draftText).toBe('anytime. we go again')
    const card = h.tgSent.find(s => String(s.params.text ?? '').includes('💬 reply'))!
    expect(String(card.params.text)).toContain('@gymrat')

    // owner taps ✅
    h.pushUpdate({ update_id: 1, callback_query: { id: 'cb', data: `approve:${reply.id}` } })
    await h.loop.tick()
    expect(listQueueItems(db, T, 'approved')).toHaveLength(1)
    expect(h.demo.published).toHaveLength(0) // humanizing delay not elapsed

    h.clock.advance(21 * 60_000)
    await h.loop.tick()
    expect(h.demo.published).toHaveLength(1)
    expect(h.demo.published[0].inReplyTo).toBe('m-1')
  })

  it('/pause halts ALL publishing instantly; /resume restores it', async () => {
    const h = makeHarness(dir); db = h.db
    h.pushUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/pause' } })
    await h.loop.tick() // processes pause, then skips planning entirely
    h.clock.advance(12 * 3_600_000)
    await h.loop.tick()
    expect(listQueueItems(db, T)).toHaveLength(0) // nothing planned
    expect(h.demo.published).toHaveLength(0)

    h.pushUpdate({ update_id: 2, message: { chat: { id: 42 }, text: '/resume' } })
    await h.loop.tick()
    expect(listQueueItems(db, T).length).toBeGreaterThan(0) // planning resumed
  })

  it('unapproved replies expire and can never publish', async () => {
    const h = makeHarness(dir); db = h.db
    h.demo.simulateMention({ id: 'm-2', authorHandle: 'x', text: 'hey', createdAt: '' })
    await h.loop.tick()
    expect(listQueueItems(db, T, 'pending_approval')).toHaveLength(1)
    h.clock.advance(5 * 3_600_000) // past the 4h reply expiry
    await h.loop.tick()
    expect(listQueueItems(db, T, 'expired').filter(i => i.kind === 'reply')).toHaveLength(1)
    expect(h.demo.published.filter(p => p.inReplyTo)).toHaveLength(0)
  })

  it('without a Claude client, due slots drop silently — silence over slop', async () => {
    const h = makeHarness(dir, { claude: null }); db = h.db
    await h.loop.tick()
    const planned = listQueueItems(db, T).length
    expect(planned).toBeGreaterThan(0)
    h.clock.advance(24 * 3_600_000)
    await h.loop.tick()
    expect(h.demo.published).toHaveLength(0)
    expect(listQueueItems(db, T, 'expired')).toHaveLength(planned)
  })

  it('warm-up mode: no replies drafted even when mentions arrive', async () => {
    const h = makeHarness(dir); db = h.db
    setSetting(db, T, 'warmup_until', '2026-08-01T00:00:00.000Z', new Date(h.clock.now()).toISOString())
    h.demo.simulateMention({ id: 'm-3', authorHandle: 'early', text: 'hi!', createdAt: '' })
    await h.loop.tick()
    expect(listQueueItems(db, T).filter(i => i.kind === 'reply')).toHaveLength(0)
  })
})
