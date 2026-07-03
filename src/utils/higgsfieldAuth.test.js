import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { refreshHFToken } from './higgsfieldAuth.js'

function makeLocalStorage(init = {}) {
  const store = new Map(Object.entries(init))
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }
}

const tokenResponse = (n) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 }),
})

describe('refreshHFToken single-flight', () => {
  let fetchMock

  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage({
      hf_refresh_token: 'refresh-0',
      hf_client_id: 'client-1',
    }))
    let calls = 0
    fetchMock = vi.fn(async () => {
      const n = ++calls
      // Resolve on a later macrotask so concurrent callers genuinely overlap
      await new Promise(r => setTimeout(r, 10))
      return tokenResponse(n)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('coalesces concurrent refresh calls into a single token request', async () => {
    const [a, b, c] = await Promise.all([refreshHFToken(), refreshHFToken(), refreshHFToken()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // All callers get the same fresh access token
    expect(a).toBe('access-1')
    expect(b).toBe('access-1')
    expect(c).toBe('access-1')
    // The rotated refresh token was persisted once, not overwritten by a loser
    expect(localStorage.getItem('hf_refresh_token')).toBe('refresh-1')
  })

  it('makes a fresh request once the previous refresh has settled', async () => {
    await refreshHFToken()
    await refreshHFToken()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reuses a token refreshed by another tab instead of rotating again', async () => {
    // Simulate the cross-tab race: by the time the Web Lock is granted, another
    // tab has already refreshed and written a new access token to localStorage.
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name, cb) => {
          localStorage.setItem('hf_access_token', 'access-from-other-tab')
          return cb()
        },
      },
    })
    const token = await refreshHFToken()
    expect(token).toBe('access-from-other-tab')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears the in-flight slot after a failure so the next call starts fresh', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({}) }))
    await expect(refreshHFToken()).rejects.toThrow(/session expired/i)
    // The 400 disconnected the session; a NEW attempt (not the cached rejection)
    // must see the cleared refresh token, proving the in-flight slot was released.
    await expect(refreshHFToken()).rejects.toThrow(/no refresh token/i)
  })
})
