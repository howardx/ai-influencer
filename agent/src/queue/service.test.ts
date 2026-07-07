import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, getQueueItem, listRecentPosts, type Db } from '../storage/db'
import {
  enqueueForApproval, enqueuePlannedOriginal, approveItem, rejectItem,
  publishDueApproved, isPaused, setPaused,
} from './service'
import { DemoAdapter } from '../adapters/demo'

const T = { personaId: 'kayla-v1', ownerId: 'howard' }
const NOW = '2026-07-08T10:00:00.000Z'

describe('queue service', () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'service-test-'))
    db = openDb(join(dir, 't.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('enqueues a reply pending approval with the 4h expiry', () => {
    const item = enqueueForApproval(db, T, { kind: 'reply', draftText: 'so real', nowIso: NOW })
    expect(getQueueItem(db, T, item.id)).toMatchObject({
      status: 'pending_approval',
      expiresAt: '2026-07-08T14:00:00.000Z',
    })
  })

  it('approve schedules publish 2–20 min out; the item then publishes when due', async () => {
    const item = enqueueForApproval(db, T, {
      kind: 'reply', draftText: 'so real',
      contextJson: JSON.stringify({ inReplyTo: 'x-99' }), nowIso: NOW,
    })
    expect(approveItem(db, T, item.id, NOW, () => 0.5).ok).toBe(true)
    const scheduled = getQueueItem(db, T, item.id)!
    expect(scheduled.status).toBe('approved')
    const delayMs = Date.parse(scheduled.scheduledAt!) - Date.parse(NOW)
    expect(delayMs).toBeGreaterThanOrEqual(2 * 60_000)
    expect(delayMs).toBeLessThanOrEqual(20 * 60_000)

    const demo = new DemoAdapter({ log: () => {} })
    // before the delay elapses: nothing
    expect(await publishDueApproved(db, T, demo, NOW)).toHaveLength(0)
    // after: publishes as a REPLY, records the post, transitions to published
    const later = new Date(Date.parse(NOW) + 21 * 60_000).toISOString()
    const published = await publishDueApproved(db, T, demo, later)
    expect(published).toHaveLength(1)
    expect(demo.published[0].inReplyTo).toBe('x-99')
    expect(getQueueItem(db, T, item.id)!.status).toBe('published')
    expect(listRecentPosts(db, T, 10)).toHaveLength(1)
  })

  it('cannot approve an expired item', () => {
    const item = enqueueForApproval(db, T, { kind: 'reply', draftText: 'stale', nowIso: NOW })
    const afterExpiry = '2026-07-08T15:00:00.000Z'
    const res = approveItem(db, T, item.id, afterExpiry, () => 0.5)
    expect(res).toEqual({ ok: false, reason: 'expired' })
  })

  it('reject stores the reason as a voice lesson and is final', () => {
    const item = enqueueForApproval(db, T, { kind: 'trend_take', draftText: 'meh', nowIso: NOW })
    expect(rejectItem(db, T, item.id, NOW, 'too spicy').ok).toBe(true)
    expect(getQueueItem(db, T, item.id)).toMatchObject({ status: 'rejected', decisionReason: 'too spicy' })
    expect(approveItem(db, T, item.id, NOW, () => 0.5).ok).toBe(false)
  })

  it('planned originals wait as drafts at their slot time', () => {
    const item = enqueuePlannedOriginal(db, T, {
      pillar: 'gym take', scheduledAtIso: '2026-07-08T17:23:11.000Z', nowIso: NOW,
    })
    expect(getQueueItem(db, T, item.id)).toMatchObject({
      status: 'draft', kind: 'original', scheduledAt: '2026-07-08T17:23:11.000Z',
    })
  })

  it('publish is idempotent across a crash between publish and status write', async () => {
    const item = enqueueForApproval(db, T, { kind: 'reply', draftText: 'once only', nowIso: NOW })
    approveItem(db, T, item.id, NOW, () => 0)
    const demo = new DemoAdapter({ log: () => {} })
    const later = new Date(Date.parse(NOW) + 30 * 60_000).toISOString()
    await publishDueApproved(db, T, demo, later)
    // simulate replay: force status back as if the transition write was lost
    db.prepare(`UPDATE queue_items SET status = 'approved' WHERE id = ?`).run(item.id)
    await publishDueApproved(db, T, demo, later)
    expect(demo.published).toHaveLength(1) // idempotency key = item id
  })

  it('pause flag round-trips per tenant', () => {
    expect(isPaused(db, T)).toBe(false)
    setPaused(db, T, true, NOW)
    expect(isPaused(db, T)).toBe(true)
    expect(isPaused(db, { personaId: 'other', ownerId: 'x' })).toBe(false)
    setPaused(db, T, false, NOW)
    expect(isPaused(db, T)).toBe(false)
  })
})
