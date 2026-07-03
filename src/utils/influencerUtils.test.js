import { describe, it, expect } from 'vitest'
import { gColor, pLabel } from './influencerUtils.js'

describe('gColor', () => {
  it('maps genders to their accent colors', () => {
    expect(gColor('Female')).toBe('#EC4899')
    expect(gColor('Male')).toBe('#3B82F6')
  })

  it('falls back to purple for anything else', () => {
    expect(gColor('Non-binary')).toBe('#8B5CF6')
    expect(gColor(undefined)).toBe('#8B5CF6')
  })
})

describe('pLabel', () => {
  it.each([
    [0, 'Strongly Introverted'],
    [14, 'Strongly Introverted'],
    [15, 'Introverted'],
    [29, 'Introverted'],
    [30, 'Slightly Introverted'],
    [42, 'Slightly Introverted'],
    [43, 'Balanced'],
    [56, 'Balanced'],
    [57, 'Slightly Extroverted'],
    [69, 'Slightly Extroverted'],
    [70, 'Extroverted'],
    [84, 'Extroverted'],
    [85, 'Strongly Extroverted'],
    [100, 'Strongly Extroverted'],
  ])('labels %i as %s', (value, label) => {
    expect(pLabel(value)).toBe(label)
  })
})
