import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openDb, insertQueueItem, transitionQueueItem, getQueueItem, listQueueItems,
  expireOverdueQueueItems, insertPost, listRecentPosts, getArcState,
  setArcState, recordActionCost, type Db, type QueueItem,
} from './db'

const KAYLA = { personaId: 'kayla-v1', ownerId: 'howard' }
const OTHER = { personaId: 'zoe-v1', ownerId: 'someone-else' }

function draftItem(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    ...KAYLA,
    kind: 'reply',
    status: 'pending_approval',
    draftText: 'sounds like a you problem, dumbbell rack',
    contextJson: null,
    createdAt: '2026-07-07T10:00:00.000Z',
    expiresAt: '2026-07-07T14:00:00.000Z',
    decidedAt: null,
    decisionReason: null,
    publishedRef: null,
    ...overrides,
  }
}

describe('storage', () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'persona-agent-test-'))
    db = openDb(join(dir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens in WAL mode', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('round-trips a queue item', () => {
    insertQueueItem(db, draftItem('q1'))
    expect(getQueueItem(db, KAYLA, 'q1')).toEqual(draftItem('q1'))
  })

  it('applies legal transitions and records the decision', () => {
    insertQueueItem(db, draftItem('q1'))
    const ok = transitionQueueItem(db, KAYLA, 'q1', 'pending_approval', 'approved', {
      decidedAt: '2026-07-07T11:00:00.000Z',
    })
    expect(ok).toBe(true)
    const item = getQueueItem(db, KAYLA, 'q1')
    expect(item?.status).toBe('approved')
    expect(item?.decidedAt).toBe('2026-07-07T11:00:00.000Z')
  })

  it('refuses illegal transitions', () => {
    insertQueueItem(db, draftItem('q1'))
    // pending → published skips approval
    expect(transitionQueueItem(db, KAYLA, 'q1', 'pending_approval', 'published')).toBe(false)
    expect(getQueueItem(db, KAYLA, 'q1')?.status).toBe('pending_approval')
  })

  it('refuses a stale transition (double-decide race)', () => {
    insertQueueItem(db, draftItem('q1'))
    expect(transitionQueueItem(db, KAYLA, 'q1', 'pending_approval', 'approved')).toBe(true)
    // second decider still thinks it is pending
    expect(transitionQueueItem(db, KAYLA, 'q1', 'pending_approval', 'rejected')).toBe(false)
    expect(getQueueItem(db, KAYLA, 'q1')?.status).toBe('approved')
  })

  it('expires overdue pending items and leaves the rest alone', () => {
    insertQueueItem(db, draftItem('overdue'))
    insertQueueItem(db, draftItem('fresh', { expiresAt: '2026-07-07T18:00:00.000Z' }))
    insertQueueItem(db, draftItem('decided', { status: 'approved' }))
    const expired = expireOverdueQueueItems(db, '2026-07-07T15:00:00.000Z')
    expect(expired).toBe(1)
    expect(getQueueItem(db, KAYLA, 'overdue')?.status).toBe('expired')
    expect(getQueueItem(db, KAYLA, 'fresh')?.status).toBe('pending_approval')
    expect(getQueueItem(db, KAYLA, 'decided')?.status).toBe('approved')
    // expired is terminal: it can never publish
    expect(transitionQueueItem(db, KAYLA, 'overdue', 'expired', 'published')).toBe(false)
  })

  it('scopes every query by persona_id + owner_id (tenancy rule)', () => {
    insertQueueItem(db, draftItem('q1'))
    insertQueueItem(db, draftItem('q2', { ...OTHER }))
    expect(listQueueItems(db, KAYLA).map(i => i.id)).toEqual(['q1'])
    expect(listQueueItems(db, OTHER).map(i => i.id)).toEqual(['q2'])
    // cross-tenant reads and writes miss
    expect(getQueueItem(db, OTHER, 'q1')).toBe(null)
    expect(transitionQueueItem(db, OTHER, 'q1', 'pending_approval', 'approved')).toBe(false)
  })

  it('stores and lists posts with JSON media column', () => {
    insertPost(db, {
      id: 'p1', ...KAYLA, platform: 'demo', platformRef: 'demo-1',
      pillar: 'gym take', isCommercial: false,
      text: 'leg day was a humbling experience',
      mediaJson: JSON.stringify(['media/legday.jpg']),
      postedAt: '2026-07-07T09:00:00.000Z',
    })
    const posts = listRecentPosts(db, KAYLA, 15)
    expect(posts).toHaveLength(1)
    expect(posts[0].isCommercial).toBe(false)
    expect(JSON.parse(posts[0].mediaJson ?? '[]')).toEqual(['media/legday.jpg'])
    expect(listRecentPosts(db, OTHER, 15)).toHaveLength(0)
  })

  it('upserts arc state per tenant', () => {
    expect(getArcState(db, KAYLA)).toBe(null)
    setArcState(db, KAYLA, {
      currentArc: 'eight weeks out from the meet',
      runningBits: ['deadlift the cat'],
      updatedAt: '2026-07-07T09:00:00.000Z',
    })
    setArcState(db, KAYLA, {
      currentArc: 'seven weeks out, first heavy single',
      runningBits: ['deadlift the cat', 'parking spot hierarchy'],
      updatedAt: '2026-07-08T09:00:00.000Z',
    })
    expect(getArcState(db, KAYLA)?.currentArc).toBe('seven weeks out, first heavy single')
    expect(getArcState(db, KAYLA)?.runningBits).toHaveLength(2)
    expect(getArcState(db, OTHER)).toBe(null)
  })

  it('records action costs (the billing meter)', () => {
    recordActionCost(db, KAYLA, 'x.publishPost', 0.015, '2026-07-07T09:00:00.000Z')
    const row = db.prepare('SELECT * FROM action_costs').get() as Record<string, unknown>
    expect(row.action).toBe('x.publishPost')
    expect(row.cost_usd).toBe(0.015)
    expect(row.persona_id).toBe(KAYLA.personaId)
  })
})
