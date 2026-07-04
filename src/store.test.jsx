import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeChangedInfluencers } from './store.jsx'

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: vi.fn(k => (store.has(k) ? store.get(k) : null)),
    setItem: vi.fn((k, v) => store.set(k, String(v))),
    removeItem: vi.fn(k => store.delete(k)),
  }
}

// The persist effect must not re-serialize every influencer (multi-MB base64
// blobs included) on every state change — only records that actually changed.
describe('writeChangedInfluencers', () => {
  let ls
  beforeEach(() => {
    ls = makeLocalStorage()
    vi.stubGlobal('localStorage', ls)
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  const a1 = { id: 'a', name: 'A', bio: 'v1' }
  const b1 = { id: 'b', name: 'B', bio: 'v1' }

  it('first run (no previous map) writes every record', () => {
    const map = writeChangedInfluencers([a1, b1], null)
    expect(ls.setItem).toHaveBeenCalledTimes(2)
    expect(map.get('a')).toBe(a1)
    expect(map.get('b')).toBe(b1)
  })

  it('unchanged references write nothing', () => {
    const map = writeChangedInfluencers([a1, b1], null)
    ls.setItem.mockClear()
    writeChangedInfluencers([a1, b1], map)
    expect(ls.setItem).not.toHaveBeenCalled()
  })

  it('writes only the record whose identity changed', () => {
    const map = writeChangedInfluencers([a1, b1], null)
    ls.setItem.mockClear()
    const a2 = { ...a1, bio: 'v2' }
    writeChangedInfluencers([a2, b1], map)
    expect(ls.setItem).toHaveBeenCalledTimes(1)
    expect(ls.setItem).toHaveBeenCalledWith('hf_influencer_a', JSON.stringify(a2))
  })

  it('a brand-new record is written even with a previous map', () => {
    const map = writeChangedInfluencers([a1], null)
    ls.setItem.mockClear()
    const c1 = { id: 'c', name: 'C' }
    writeChangedInfluencers([a1, c1], map)
    expect(ls.setItem).toHaveBeenCalledTimes(1)
    expect(ls.setItem).toHaveBeenCalledWith('hf_influencer_c', JSON.stringify(c1))
  })
})
