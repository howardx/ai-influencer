// PRODUCT section and LOGIC RULE sentences for the video prompt builder —
// extracted pure so the credit-critical prompt text is unit-testable.
//
// tagMap roles: product1..3 are INDEPENDENT products. productDetail1..2 are
// close-up detail references OF product1 (e.g. the hidden air vent on a face
// mask) — they must be declared as the SAME object, or the model renders each
// detail shot as an additional product in frame.

function detailTagsOf(tagMap) {
  return [tagMap.productDetail1, tagMap.productDetail2].filter(Boolean)
}

// detailNotes: { productDetail1: 'hidden air vent at the nose bridge', ... } —
// the user's own description of what each detail image depicts, blended into
// that detail's prompt line. hasProductVideo: a role-'video' reference of the
// product is attached to the generation (Seedance 2.0 accepts image/video/audio
// reference inputs).
export function buildProductSection(tagMap, { wearMode = false, she = 'she', detailNotes = {}, hasProductVideo = false } = {}) {
  const prodEntries = [
    tagMap.product1 && { tag: tagMap.product1, n: 1 },
    tagMap.product2 && { tag: tagMap.product2, n: 2 },
    tagMap.product3 && { tag: tagMap.product3, n: 3 },
  ].filter(Boolean)
  if (prodEntries.length === 0) return ''

  const detailTags = tagMap.product1 ? detailTagsOf(tagMap) : []
  const pLines = ['PRODUCT:']
  pLines.push('')
  prodEntries.forEach(({ tag, n }) => {
    pLines.push(`${tag} — product reference ${n}. Use as the exact source for this product's color, shape, label text and orientation, and proportions.`)
  })
  ;['productDetail1', 'productDetail2'].forEach(role => {
    const tag = tagMap[role]
    if (!tag || !tagMap.product1) return
    const note = (detailNotes[role] || '').trim()
    pLines.push(`${tag} — close-up detail of ${tagMap.product1}, the SAME product photographed closer${note ? `: it depicts ${note}` : ''}. Use for fine feature accuracy — texture, stitching, seams, hidden vents and openings. Never a separate product; never an extra object in frame.`)
  })
  pLines.push('')
  const allProdTags = prodEntries.map(e => e.tag).join(' and ')
  pLines.push(`The product must appear identical in every frame — same label text and orientation, same colors, same proportions throughout. Never substituted, recolored, or modified. ${allProdTags} ${prodEntries.length > 1 ? 'contribute' : 'contributes'} ONLY the product — never the face, identity, wardrobe, environment, or color grade.`)
  if (detailTags.length) {
    pLines.push(`Whenever the product is shown close, its details must match ${detailTags.join(' and ')} exactly.`)
  }
  if (hasProductVideo) {
    // Authority hierarchy, not "match the video exactly": the video may show a
    // different colorway or lighting-shifted colors — appearance stays owned by
    // the product image; the video contributes behavior/demonstration only.
    pLines.push(`A reference video of the product is attached. Use it ONLY for how the product behaves and is demonstrated — handling, motion, how its features are shown in use. For color, materials, and markings, ${tagMap.product1} remains the sole authority: where the video's product differs in color or lighting, follow ${tagMap.product1}. Never take people, environment, lighting, or color grade from the reference video.`)
  }
  if (wearMode) {
    pLines.push(`Exception: ${tagMap.product1} is WORN — ${she} interacts with it naturally once or twice — a brief touch or glance — without overdoing it.`)
  }
  return pLines.join('\n')
}

export function buildProductRules(tagMap, { wearMode = false, She = 'She' } = {}) {
  const rules = []
  if (tagMap.product1) rules.push(`${tagMap.product1} is always the same object — same color, label position, and size. Never substituted.${wearMode ? ` ${tagMap.product1} is WORN — never held. ${She} naturally interacts with it once or twice — a brief touch or glance — without overdoing it.` : ''}`)
  if (tagMap.product2) rules.push(`${tagMap.product2} is always the same object — never substituted.`)
  if (tagMap.product3) rules.push(`${tagMap.product3} is always the same object — never substituted.`)
  const detailTags = tagMap.product1 ? detailTagsOf(tagMap) : []
  if (detailTags.length) {
    rules.push(`${detailTags.join(' and ')} ${detailTags.length > 1 ? 'are' : 'is'} the same object as ${tagMap.product1} — close-up detail views, never separate products in frame.`)
  }
  return rules
}
