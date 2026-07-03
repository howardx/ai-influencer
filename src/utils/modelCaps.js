// Single source of truth for per-model behavior. UI display metadata (names,
// tags, descriptions) stays with the UI in Create.jsx; everything an API call
// or estimate depends on lives here.
//
// params: spread into the generation request after { model, aspect_ratio }.
// gpt_image_2 accepts BOTH quality and resolution — callers add resolution on
// top of these base params intentionally (see CLAUDE.md).
export const MODEL_CAPS = {
  soul_2:            { media: 'image', maxRefs: 1, estMs: 60000,  params: { quality: '2k' } },
  gpt_image_2:       { media: 'image', maxRefs: 2, estMs: 120000, params: { count: 1, quality: 'high' } },
  nano_banana_2:     { media: 'image', maxRefs: 2, estMs: 90000,  params: { count: 1, resolution: '2k' } },
  nano_banana_flash: { media: 'image', maxRefs: 2, estMs: 60000,  params: { count: 1, resolution: '2k' } },
  seedance_2_0:      { media: 'video', estMs: 480000, params: {} },
}

export const DEFAULT_IMAGE_MODEL = 'gpt_image_2'
export const DEFAULT_VIDEO_MODEL = 'seedance_2_0'

export function modelBaseParams(model, aspectRatio) {
  // Unknown models get the historical default branch: count 1 at 2k resolution.
  const params = MODEL_CAPS[model]?.params ?? { count: 1, resolution: '2k' }
  return { model, aspect_ratio: aspectRatio, ...params }
}

export function modelEstMs(model) {
  return MODEL_CAPS[model]?.estMs ?? 90000
}
