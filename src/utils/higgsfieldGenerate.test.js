import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  savePendingGen, clearPendingGen, getPendingGens,
  savePendingVideo, clearPendingVideo, getPendingVideo,
  savePendingPhoto, clearPendingPhoto, getPendingPhoto,
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
