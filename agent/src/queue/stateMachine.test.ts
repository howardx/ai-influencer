import { describe, it, expect } from 'vitest'
import { TRANSITIONS, canTransition, isTerminal, expiresAt } from './stateMachine'
import type { QueueStatus } from './stateMachine'

describe('queue state machine', () => {
  it('follows the happy path draft → pending_approval → approved → published', () => {
    expect(canTransition('draft', 'pending_approval')).toBe(true)
    expect(canTransition('pending_approval', 'approved')).toBe(true)
    expect(canTransition('approved', 'published')).toBe(true)
  })

  it('never publishes from rejected or expired (terminal states)', () => {
    for (const from of ['rejected', 'expired', 'published'] as QueueStatus[]) {
      expect(isTerminal(from)).toBe(true)
      for (const to of Object.keys(TRANSITIONS) as QueueStatus[]) {
        expect(canTransition(from, to)).toBe(false)
      }
    }
  })

  it('cannot skip approval', () => {
    expect(canTransition('draft', 'approved')).toBe(false)
    expect(canTransition('draft', 'published')).toBe(false)
    expect(canTransition('pending_approval', 'published')).toBe(false)
  })

  it('expires replies after 4h and trend takes after 8h', () => {
    const created = '2026-07-07T10:00:00.000Z'
    expect(expiresAt('reply', created)).toBe('2026-07-07T14:00:00.000Z')
    expect(expiresAt('trend_take', created)).toBe('2026-07-07T18:00:00.000Z')
    expect(expiresAt('original', created)).toBe('2026-07-08T10:00:00.000Z')
  })
})
