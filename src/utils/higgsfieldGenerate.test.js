import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  savePendingGen, clearPendingGen, getPendingGens,
  savePendingVideo, clearPendingVideo, getPendingVideo,
  savePendingPhoto, clearPendingPhoto, getPendingPhoto,
  pollAllJobs, initSession,
} from './higgsfieldGenerate.js'

function makeLocalStorage(init = {}) {
  const store = new Map(Object.entries(init))
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }
}

// A corrupted pending-job value must never crash generation permanently —
// every helper should treat it as an empty list and heal on the next write.
describe('pending-job persistence resilience', () => {
  beforeEach(() => vi.stubGlobal('localStorage', makeLocalStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips a pending generation normally', () => {
    savePendingGen('inf-1', 'characterSheetImage', ['job-1'])
    expect(getPendingGens()).toHaveLength(1)
    expect(getPendingGens()[0]).toMatchObject({ influencerId: 'inf-1', slot: 'characterSheetImage', jobIds: ['job-1'] })
    clearPendingGen('inf-1', 'characterSheetImage')
    expect(getPendingGens()).toEqual([])
  })

  it('readers return empty results instead of throwing on unparseable JSON', () => {
    localStorage.setItem('hf_pending_gens', '{corrupted')
    localStorage.setItem('hf_pending_videos', '{corrupted')
    localStorage.setItem('hf_pending_photos_v2', '{corrupted')
    expect(getPendingGens()).toEqual([])
    expect(getPendingVideo('inf-1')).toBeNull()
    expect(getPendingPhoto('inf-1')).toBeNull()
  })

  it('readers tolerate valid JSON of the wrong shape', () => {
    localStorage.setItem('hf_pending_gens', '"a string"')
    localStorage.setItem('hf_pending_videos', '{"an":"object"}')
    expect(getPendingGens()).toEqual([])
    expect(getPendingVideo('inf-1')).toBeNull()
  })

  it('writers overwrite a corrupted value instead of crashing (self-heal)', () => {
    localStorage.setItem('hf_pending_gens', '{corrupted')
    savePendingGen('inf-1', 'slot-a', ['job-1'])
    expect(getPendingGens()).toHaveLength(1)

    localStorage.setItem('hf_pending_videos', '{corrupted')
    savePendingVideo('inf-2', ['job-2'], 1)
    expect(getPendingVideo('inf-2')).toMatchObject({ jobIds: ['job-2'], count: 1 })

    localStorage.setItem('hf_pending_photos_v2', '{corrupted')
    savePendingPhoto('inf-3', ['job-3'])
    expect(getPendingPhoto('inf-3')).toMatchObject({ jobIds: ['job-3'] })
  })

  it('clearers tolerate a corrupted value', () => {
    localStorage.setItem('hf_pending_videos', '{corrupted')
    expect(() => clearPendingVideo('inf-1')).not.toThrow()
    localStorage.setItem('hf_pending_photos_v2', '{corrupted')
    expect(() => clearPendingPhoto('inf-1')).not.toThrow()
  })
})

// ── Polling engine ────────────────────────────────────────────────

// Wrap a job_status payload the way the MCP endpoint returns it:
// JSON-RPC envelope → result.content[0].text → JSON job data.
const rpcResponse = (payload) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({
    jsonrpc: '2.0',
    result: { content: [{ text: JSON.stringify(payload) }] },
  }),
})

// fetch stub scripted per jobId: successive polls walk the sequence, the last
// entry repeats forever. Steps: {status, url?, pollAfter?}
function makeJobStatusFetch(script) {
  const counts = new Map()
  const fetchMock = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body)
    const jobId = body?.params?.arguments?.jobId
    if (!jobId) return rpcResponse({ ok: true }) // initialize / other calls
    const seq = script[jobId]
    const n = counts.get(jobId) ?? 0
    counts.set(jobId, n + 1)
    const step = seq[Math.min(n, seq.length - 1)]
    return rpcResponse({
      id: jobId,
      status: step.status,
      results: step.url ? { rawUrl: step.url } : {},
      ...(step.pollAfter ? { poll_after_seconds: step.pollAfter } : {}),
    })
  })
  fetchMock.callsFor = jobId => fetchMock.mock.calls
    .filter(([, init]) => JSON.parse(init.body)?.params?.arguments?.jobId === jobId).length
  return fetchMock
}

describe('pollAllJobs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', {
      getItem: k => (k === 'hf_access_token' ? 'tok' : null),
      setItem: () => {}, removeItem: () => {},
    })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  async function run(promise, ms = 400_000) {
    let settled = false
    const guarded = promise.then(
      v => { settled = true; return v },
      e => { settled = true; throw e },
    )
    while (!settled && ms > 0) { await vi.advanceTimersByTimeAsync(1000); ms -= 1000 }
    return guarded
  }

  it('delivers URLs and never re-polls a delivered job', async () => {
    const fetchMock = makeJobStatusFetch({
      'job-a': [{ status: 'processing' }, { status: 'completed', url: 'https://cdn/a.jpg' }],
      'job-b': [{ status: 'completed', url: 'https://cdn/b.jpg' }],
    })
    vi.stubGlobal('fetch', fetchMock)
    const urls = await run(pollAllJobs(['job-a', 'job-b'], 2, null, 8))
    expect(urls.sort()).toEqual(['https://cdn/a.jpg', 'https://cdn/b.jpg'])
    expect(fetchMock.callsFor('job-b')).toBe(1) // delivered in round 0 — never re-polled
    expect(fetchMock.callsFor('job-a')).toBe(2)
  })

  it('retries a soft-terminal job (completed, URL not yet propagated) instead of dropping it', async () => {
    const fetchMock = makeJobStatusFetch({
      'job-a': [
        { status: 'completed' },              // CDN lag — no URL yet
        { status: 'completed' },
        { status: 'completed', url: 'https://cdn/late.jpg' },
      ],
    })
    vi.stubGlobal('fetch', fetchMock)
    const urls = await run(pollAllJobs(['job-a'], 1, null, 8))
    expect(urls).toEqual(['https://cdn/late.jpg'])
  })

  it('returns partial results after the stale window instead of burning the full round cap', async () => {
    const staleTolerance = 3
    const fetchMock = makeJobStatusFetch({
      'job-a': [{ status: 'completed', url: 'https://cdn/a.jpg' }],
      'job-b': [{ status: 'processing' }], // never terminal, never delivers
    })
    vi.stubGlobal('fetch', fetchMock)
    const urls = await run(pollAllJobs(['job-a', 'job-b'], 2, null, staleTolerance))
    expect(urls).toEqual(['https://cdn/a.jpg'])
    // Old behavior polled the straggler for all 60 rounds; the stale window stops early.
    expect(fetchMock.callsFor('job-b')).toBeLessThanOrEqual(staleTolerance + 2)
  })

  it('honors poll_after_seconds guidance for the next round delay', async () => {
    const fetchMock = makeJobStatusFetch({
      'job-a': [{ status: 'processing', pollAfter: 8 }, { status: 'completed', url: 'https://cdn/a.jpg' }],
    })
    vi.stubGlobal('fetch', fetchMock)
    let resolved = false
    const promise = pollAllJobs(['job-a'], 1, null, 8).then(v => { resolved = true; return v })
    await vi.advanceTimersByTimeAsync(4000) // default interval is 3s — too soon for the 8s guidance
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(6000) // total 10s > 8s guidance
    expect(resolved).toBe(true)
    expect(await promise).toEqual(['https://cdn/a.jpg'])
  })
})

describe('mcpPost retry on transient statuses', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', {
      getItem: k => (k === 'hf_access_token' ? 'tok' : null),
      setItem: () => {}, removeItem: () => {},
    })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('does NOT retry a 5xx on a generate call — the job may already be accepted upstream', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.method === 'initialize') return rpcResponse({ ok: true })
      // generate_image: transient-looking 502 that may have landed AFTER the
      // upstream accepted the job — a retry would double-submit and burn credits
      return { ok: false, status: 502, headers: { get: () => null }, text: async () => 'bad gateway' }
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    const { generateSingleImage } = await import('./higgsfieldGenerate.js')
    let settled = false
    const promise = generateSingleImage({ prompt: 'p' }).then(
      () => { settled = true; throw new Error('should have rejected') },
      e => { settled = true; return e },
    )
    let budget = 60_000
    while (!settled && budget > 0) { await vi.advanceTimersByTimeAsync(500); budget -= 500 }
    const err = await promise
    expect(err.message).toMatch(/502/)
    const generateCalls = fetchMock.mock.calls
      .filter(([, init]) => JSON.parse(init.body)?.params?.name === 'generate_image').length
    expect(generateCalls).toBe(1) // exactly one submission — no blind retry
  })

  it('retries a 429 honoring Retry-After instead of failing the call', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      if (++calls === 1) {
        return { ok: false, status: 429, headers: { get: h => (h === 'retry-after' ? '1' : null) }, text: async () => 'rate limited' }
      }
      return rpcResponse({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    let settled = false
    const promise = initSession().then(() => { settled = true }, () => { settled = true })
    let budget = 20_000
    while (!settled && budget > 0) { await vi.advanceTimersByTimeAsync(500); budget -= 500 }
    await expect(promise).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
