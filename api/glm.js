import { rateLimit, clientIp } from '../lib/rateLimit.js'

// GLM (Zhipu) proxy — mirrors api/claude.js. The browser sends its own GLM
// key as x-api-key plus x-ai-platform naming which platform issued it; both
// platforms speak the same OpenAI-compatible chat/completions protocol.
const GLM_UPSTREAMS = {
  zai: 'https://api.z.ai/api/paas/v4/chat/completions',
  // Coding Plan subscriptions authenticate the same key but only on the
  // dedicated coding endpoint — the general endpoint answers 429 code 1113
  // ("Insufficient balance") for them.
  'zai-coding': 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  bigmodel: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-ai-platform')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).send('Method not allowed')

  const rl = rateLimit(clientIp(req.headers))
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    return res.status(429).json({ error: { message: 'Too many requests — slow down a moment and try again.' } })
  }

  const apiKey = req.headers['x-api-key']
  if (!apiKey) return res.status(400).json({ error: { message: 'Missing x-api-key header' } })

  const upstream_url = GLM_UPSTREAMS[req.headers['x-ai-platform']] || GLM_UPSTREAMS.zai

  try {
    const upstream = await fetch(upstream_url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(req.body),
    })
    const data = await upstream.json()
    return res.status(upstream.status).json(data)
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } })
  }
}
