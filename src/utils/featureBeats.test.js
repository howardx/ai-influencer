import { describe, it, expect } from 'vitest'
import { assignFeaturesToShots, featureGesturePhrase, weaveLineAnnotations, featureLogicRule, sanitizeFeatureMapping, featureCameraLine } from './featureBeats.js'

const VENT = { id: 'f1', name: 'hidden air vent', description: 'the concealed vent slit under the front panel', gesture: 'tap', when: 'held' }
const CORNER = { id: 'f2', name: 'high cheekbone corner', description: '', gesture: 'trace', when: 'worn' }

describe('assignFeaturesToShots', () => {
  // 5 sentences chunked across 3 shots: [s0] [s1 s2] [s3 s4]
  const chunks = [['s0'], ['s1', 's2'], ['s3', 's4']]

  it('routes a feature to the shot holding its sentence, with in-chunk position', () => {
    const out = assignFeaturesToShots(chunks, { 2: VENT, 4: CORNER })
    expect(out[0]).toBe(null)
    expect(out[1]).toEqual({ feature: VENT, idxInChunk: 1, line: 's2' })
    expect(out[2]).toEqual({ feature: CORNER, idxInChunk: 1, line: 's4' })
  })

  it('keeps only the first feature per shot (one-action law)', () => {
    const out = assignFeaturesToShots(chunks, { 1: VENT, 2: CORNER })
    expect(out[1].feature).toBe(VENT)
  })

  it('returns all null with no mapping, and ignores out-of-range indices', () => {
    expect(assignFeaturesToShots(chunks, {})).toEqual([null, null, null])
    expect(assignFeaturesToShots(chunks, { 99: VENT })).toEqual([null, null, null])
  })
})

describe('featureGesturePhrase', () => {
  it('held feature: raises the product, gestures, and holds it to lens fully visible', () => {
    const p = featureGesturePhrase(VENT, { productTag: '@image_5', detailTag: '@image_6', she: 'she', her: 'her' })
    expect(p).toContain('raises @image_5')
    expect(p).toContain('taps the hidden air vent')
    expect(p).toContain('the concealed vent slit under the front panel')
    expect(p).toContain('fully visible')
    expect(p).toContain('sharp focus')
    expect(p).toContain('matching @image_6 exactly')
  })

  it('worn feature: gestures on the worn product and angles it to lens', () => {
    const p = featureGesturePhrase(CORNER, { productTag: '@image_5', she: 'she', her: 'her' })
    expect(p).toContain('worn @image_5')
    expect(p).toContain('traces the high cheekbone corner')
    expect(p).toContain('angles that side toward the lens')
    expect(p).toContain('fully visible')
    expect(p).not.toContain('matching') // no detail tag given
  })

  it('respects pronouns', () => {
    const p = featureGesturePhrase(VENT, { productTag: '@image_5', she: 'he', her: 'his' })
    expect(p).toContain('he ')
    expect(p).not.toContain('her ')
  })
})

describe('weaveLineAnnotations', () => {
  const phrase = 'raises it and taps the vent'

  it('quotes surrounding sentences separately and attaches the gesture to the feature line', () => {
    const out = weaveLineAnnotations(['s1.', 's2.', 's3.'], { 1: { gesturePhrase: phrase } }, { she: 'she' })
    expect(out).toBe('"s1." "s2." — as she says this, she raises it and taps the vent. "s3."')
  })

  it('handles the annotated line first or alone', () => {
    expect(weaveLineAnnotations(['only.'], { 0: { gesturePhrase: phrase } }, { she: 'she' }))
      .toBe('"only." — as she says this, she raises it and taps the vent.')
    expect(weaveLineAnnotations(['f.', 'rest.'], { 0: { gesturePhrase: phrase } }, { she: 'she' }))
      .toBe('"f." — as she says this, she raises it and taps the vent. "rest."')
  })

  it('attaches a user note to its line, normalized to end with a period', () => {
    const out = weaveLineAnnotations(['s1.', 's2.'], { 1: { note: 'she steps into the shade' } }, { she: 'she' })
    expect(out).toBe('"s1." "s2." — at this moment, she steps into the shade.')
  })

  it('a line can carry both a gesture and a note, and multiple lines can carry notes', () => {
    const out = weaveLineAnnotations(
      ['a.', 'b.', 'c.'],
      { 0: { note: 'wind lifts her hair。' }, 1: { gesturePhrase: phrase, note: 'sunlight catches the fabric' } },
      { she: 'she' },
    )
    expect(out).toBe('"a." — at this moment, wind lifts her hair. "b." — as she says this, she raises it and taps the vent. — at this moment, sunlight catches the fabric. "c."')
  })
})

describe('featureLogicRule', () => {
  it('forbids occlusion and pins the detail to the product tag', () => {
    const r = featureLogicRule('@image_5', { she: 'she', her: 'her' })
    expect(r).toContain('never occlude')
    expect(r).toContain('@image_5')
    expect(r).toContain('fully visible')
  })
})

describe('featureCameraLine', () => {
  it('handheld feature shot pairs with a slow zoom toward the product', () => {
    const line = featureCameraLine({ isHandheld: true, productTag: '@image_5' })
    expect(line).toContain('Slow zoom in')
    expect(line).toContain('@image_5')
    expect(line).toContain('End:')
  })

  it('locked shots stay locked — no movement is added', () => {
    expect(featureCameraLine({ isHandheld: false, productTag: '@image_5' })).toBe('')
  })
})

describe('sanitizeFeatureMapping', () => {
  const FEATURES = [VENT, CORNER]

  it('keeps valid sentence→feature entries', () => {
    expect(sanitizeFeatureMapping({ 1: 'f1', 3: 'f2' }, 5, FEATURES)).toEqual({ 1: 'f1', 3: 'f2' })
    expect(sanitizeFeatureMapping({ '2': 'f1' }, 5, FEATURES)).toEqual({ 2: 'f1' }) // string keys ok
  })

  it('drops out-of-range indices and unknown feature ids', () => {
    expect(sanitizeFeatureMapping({ 9: 'f1', 1: 'nope', '-1': 'f2', 'x': 'f1' }, 3, FEATURES)).toEqual({})
  })

  it('keeps only one sentence per feature (lowest index wins)', () => {
    expect(sanitizeFeatureMapping({ 3: 'f1', 1: 'f1' }, 5, FEATURES)).toEqual({ 1: 'f1' })
  })

  it('returns {} for junk input', () => {
    expect(sanitizeFeatureMapping(null, 5, FEATURES)).toEqual({})
    expect(sanitizeFeatureMapping('not an object', 5, FEATURES)).toEqual({})
    expect(sanitizeFeatureMapping([1, 2], 5, FEATURES)).toEqual({})
  })
})
