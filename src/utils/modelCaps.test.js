import { describe, it, expect } from 'vitest'
import { modelBaseParams, modelEstMs, MODEL_CAPS, DEFAULT_VIDEO_MODEL } from './modelCaps.js'

describe('modelBaseParams', () => {
  it('gives soul_2 its 2k quality with no count', () => {
    expect(modelBaseParams('soul_2', '9:16')).toEqual({ model: 'soul_2', aspect_ratio: '9:16', quality: '2k' })
  })

  it('gives gpt_image_2 quality=high (callers add resolution on top — both are accepted)', () => {
    expect(modelBaseParams('gpt_image_2', '9:16')).toEqual({ model: 'gpt_image_2', aspect_ratio: '9:16', count: 1, quality: 'high' })
  })

  it('falls back to count 1 at 2k resolution for other/unknown models', () => {
    expect(modelBaseParams('nano_banana_2', '1:1')).toEqual({ model: 'nano_banana_2', aspect_ratio: '1:1', count: 1, resolution: '2k' })
    expect(modelBaseParams('future_model', '1:1')).toEqual({ model: 'future_model', aspect_ratio: '1:1', count: 1, resolution: '2k' })
  })
})

describe('model caps table', () => {
  it('keeps the historical time estimates with a 90s default', () => {
    expect(modelEstMs('soul_2')).toBe(60000)
    expect(modelEstMs('gpt_image_2')).toBe(120000)
    expect(modelEstMs('unknown')).toBe(90000)
  })

  it('covers every supported model from CLAUDE.md', () => {
    for (const id of ['soul_2', 'gpt_image_2', 'nano_banana_2', 'nano_banana_flash', 'seedance_2_0']) {
      expect(MODEL_CAPS[id], id).toBeDefined()
    }
    expect(MODEL_CAPS[DEFAULT_VIDEO_MODEL].media).toBe('video')
  })
})
