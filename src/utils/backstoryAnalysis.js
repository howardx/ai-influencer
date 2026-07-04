import { aiComplete, getAiKey, getActiveProvider } from './aiProvider'

const SYSTEM = `You are a visual prompt assistant for an AI influencer image generator.
Given a character's backstory and physical description, extract two things:

1. styleSignal — a comma-separated list of 2–4 wardrobe style tags from this fixed set ONLY: minimalist, editorial, street, bohemian, glam, sport, y2k, dark, clean, cottagecore, old-money, coastal, preppy, casual, earthy, natural, functional, polished, structured, bold. Pick tags that reflect the person's authentic daily life, not their aspirations.

2. sceneNiche — one word from: fashion, beauty, lifestyle, fitness, travel, tech, gaming, entertainment. Pick the one that best matches where this person actually spends their time.

Respond with a JSON object only — no explanation, no markdown:
{"styleSignal":"tag1, tag2","sceneNiche":"lifestyle"}`

export async function analyzeBackstory(backstory, physicalDesc) {
  const label = getActiveProvider().label
  if (!getAiKey()) { console.log(`[${label}] no API key in localStorage — skipping backstory analysis`); return null }
  if (!backstory?.trim()) { console.log(`[${label}] no backstory — skipping`); return null }

  console.log(`[${label}] analyzing backstory...`)
  const userMsg = `Backstory: ${backstory.trim()}\nPhysical description: ${physicalDesc?.trim() || 'not specified'}`

  try {
    const result = await aiComplete({
      tier: 'light',
      maxTokens: 150,
      system: SYSTEM,
      user: userMsg,
    })
    if (!result.ok) { console.error(`[${label}] failed:`, result.reason); return null }

    const text = result.text
    if (!text) { console.error(`[${label}] empty response`); return null }

    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const parsed = JSON.parse(jsonText)
    if (!parsed.sceneNiche) { console.error(`[${label}] missing sceneNiche in response:`, parsed); return null }

    console.log(`[${label}] success:`, parsed)
    return {
      sceneNiche: parsed.sceneNiche,
      tags: (parsed.styleSignal || '').split(',').map(s => s.trim()).filter(Boolean),
    }
  } catch (e) {
    console.error(`[${label}] exception:`, e)
    return null
  }
}
