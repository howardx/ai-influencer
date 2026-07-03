import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rateLimit, clientIp } from './rateLimit.js'

// The hits map inside rateLimit.js is module-level state shared across tests,
// so every test uses its own unique IP key.
let n = 0
const uniqueIp = () => `10.0.0.${++n}-${Math.random().toString(36).slice(2)}`

describe('rateLimit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('allows a normal request', () => {
    expect(rateLimit(uniqueIp())).toEqual({ ok: true })
  })

  it('allows 30 requests in a burst, then blocks the 31st with a 3s retry', () => {
    const ip = uniqueIp()
    for (let i = 0; i < 30; i++) {
      expect(rateLimit(ip).ok).toBe(true)
    }
    expect(rateLimit(ip)).toEqual({ ok: false, retryAfter: 3 })
  })

  it('lets a burst-blocked client through again once the 3s window passes', () => {
    const ip = uniqueIp()
    for (let i = 0; i < 30; i++) rateLimit(ip)
    expect(rateLimit(ip).ok).toBe(false)

    vi.advanceTimersByTime(3001)
    expect(rateLimit(ip).ok).toBe(true)
  })

  it('blocks sustained hammering (301st request inside 60s) with a 60s retry', () => {
    const ip = uniqueIp()
    // 150ms spacing keeps every 3s window at 20 requests (under the burst cap of
    // 30) while accumulating 300 requests well inside the 60s window.
    for (let i = 0; i < 300; i++) {
      expect(rateLimit(ip).ok).toBe(true)
      vi.advanceTimersByTime(150)
    }
    expect(rateLimit(ip)).toEqual({ ok: false, retryAfter: 60 })
  })

  it('tracks each IP independently', () => {
    const a = uniqueIp()
    const b = uniqueIp()
    for (let i = 0; i < 30; i++) rateLimit(a)
    expect(rateLimit(a).ok).toBe(false)
    expect(rateLimit(b).ok).toBe(true)
  })
})

describe('clientIp', () => {
  it('reads x-forwarded-for from an edge Headers object', () => {
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4' })
    expect(clientIp(headers)).toBe('1.2.3.4')
  })

  it('takes the first entry of a multi-hop x-forwarded-for list, trimmed', () => {
    const headers = new Headers({ 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' })
    expect(clientIp(headers)).toBe('1.2.3.4')
  })

  it('reads from a Node plain-object headers map', () => {
    expect(clientIp({ 'x-forwarded-for': '9.8.7.6' })).toBe('9.8.7.6')
  })

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    expect(clientIp({ 'x-real-ip': '4.4.4.4' })).toBe('4.4.4.4')
  })

  it('returns "unknown" when no IP headers exist', () => {
    expect(clientIp({})).toBe('unknown')
    expect(clientIp(new Headers())).toBe('unknown')
    expect(clientIp(undefined)).toBe('unknown')
  })
})
