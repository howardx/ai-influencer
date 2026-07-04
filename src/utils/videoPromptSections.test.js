import { describe, it, expect } from 'vitest'
import { buildProductSection, buildProductRules } from './videoPromptSections.js'

describe('buildProductSection', () => {
  it('returns empty string with no products', () => {
    expect(buildProductSection({})).toBe('')
    expect(buildProductSection({ productDetail1: '@image_6' })).toBe('')
  })

  it('keeps the existing single-product wording', () => {
    const out = buildProductSection({ product1: '@image_5' }, { wearMode: false, she: 'she' })
    expect(out).toContain('@image_5 — product reference 1.')
    expect(out).toContain('contributes ONLY the product')
    expect(out).not.toContain('WORN')
  })

  it('keeps the wear-mode exception', () => {
    const out = buildProductSection({ product1: '@image_5' }, { wearMode: true, she: 'she' })
    expect(out).toContain('@image_5 is WORN')
  })

  it('declares detail refs as the SAME product, not extra products', () => {
    const out = buildProductSection({ product1: '@image_5', productDetail1: '@image_6', productDetail2: '@image_7' })
    expect(out).toContain('@image_6 — close-up detail of @image_5, the SAME product')
    expect(out).toContain('@image_7 — close-up detail of @image_5, the SAME product')
    expect(out).toContain('details must match @image_6 and @image_7 exactly')
    // detail refs must never be listed as independent product references
    expect(out).not.toContain('@image_6 — product reference')
  })

  it("blends the user's description of what each detail image depicts", () => {
    const out = buildProductSection(
      { product1: '@image_5', productDetail1: '@image_6' },
      { detailNotes: { productDetail1: 'the hidden air vent at the nose bridge' } },
    )
    expect(out).toContain('@image_6 — close-up detail of @image_5, the SAME product photographed closer: it depicts the hidden air vent at the nose bridge.')
  })

  it('scopes an attached product reference video to behavior, with the image as appearance authority', () => {
    const out = buildProductSection({ product1: '@image_5' }, { hasProductVideo: true })
    expect(out).toContain('reference video of the product is attached')
    // behavior only — never a second authority on appearance (the video may show
    // a different colorway or lighting-shifted colors)
    expect(out).toContain('ONLY for how the product behaves')
    expect(out).toContain('@image_5 remains the sole authority')
    expect(out).toContain('differs in color or lighting, follow @image_5')
    // and absent otherwise
    expect(buildProductSection({ product1: '@image_5' })).not.toContain('reference video')
  })

  it('pluralizes contribute for multiple independent products', () => {
    const out = buildProductSection({ product1: '@image_5', product2: '@image_6' })
    expect(out).toContain('@image_5 and @image_6 contribute ONLY the product')
  })
})

describe('buildProductRules', () => {
  it('keeps existing per-product rules including wear mode', () => {
    const rules = buildProductRules({ product1: '@image_5', product2: '@image_6' }, { wearMode: true, She: 'She' })
    expect(rules[0]).toContain('@image_5 is always the same object')
    expect(rules[0]).toContain('@image_5 is WORN — never held')
    expect(rules[1]).toBe('@image_6 is always the same object — never substituted.')
  })

  it('adds a same-object rule binding detail refs to product 1', () => {
    const rules = buildProductRules({ product1: '@image_5', productDetail1: '@image_6', productDetail2: '@image_7' })
    expect(rules.some(r => r.includes('@image_6 and @image_7 are the same object as @image_5'))).toBe(true)
  })

  it('returns no rules without products', () => {
    expect(buildProductRules({})).toEqual([])
  })
})
