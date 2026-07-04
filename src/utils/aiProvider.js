// One registry for every LLM provider the app can use for prompt optimization
// (backstory analysis, product character sheets, video prompt tuning).
//
// Exactly ONE provider is active at a time: connecting a provider stores its
// key and removes every other provider's key, so all features route to the
// same model family. Adding a future provider (OpenAI, …) should only take a
// new PROVIDERS entry, a serverless proxy under api/, and a matching dev
// middleware in vite.config.js — call sites go through aiComplete() and never
// see provider wire formats.

import { reportAiAuthFailure, clearAiAuthNotice } from './aiHealth'

export const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude',
    keyStorage: 'claude_api_key',
    proxy: '/api/claude',
    keyPlaceholder: 'sk-ant-...',
    keyHint: 'console.anthropic.com',
    testModel: 'claude-haiku-4-5-20251001',
    testMaxTokens: 1,
    lightModel: 'claude-haiku-4-5-20251001',
    visionModel: 'claude-sonnet-4-6',
    // First entry is the default: the most powerful model on the provider.
    tunerModels: [
      { id: 'claude-fable-5', label: 'Fable 5 — most powerful', pricing: '$10 / $50 per MTok' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', pricing: '$5 / $25 per MTok' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', pricing: '$3 / $15 per MTok' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest', pricing: '$1 / $5 per MTok' },
    ],
  },
  {
    id: 'glm',
    label: 'GLM',
    keyStorage: 'glm_api_key',
    proxy: '/api/glm',
    keyPlaceholder: 'GLM API key…',
    keyHint: 'z.ai or open.bigmodel.cn',
    // Which platform issued the key — the proxy maps this to the upstream host.
    platformStorage: 'glm_platform',
    platforms: [
      { id: 'zai', label: 'z.ai API (pay-as-you-go)' },
      { id: 'zai-coding', label: 'z.ai GLM Coding Plan' },
      { id: 'bigmodel', label: 'China (bigmodel.cn)' },
    ],
    testModel: 'glm-4.7',
    testMaxTokens: 16,
    lightModel: 'glm-4.7',
    visionModel: 'glm-4.6v',
    tunerModels: [
      { id: 'glm-5.2', label: 'GLM-5.2 — most powerful', pricing: '≈$1 / $3 per MTok' },
      { id: 'glm-4.7', label: 'GLM-4.7 — fastest', pricing: 'lower cost' },
    ],
  },
]

export function getProvider(id) {
  return PROVIDERS.find(p => p.id === id) || null
}

function readKey(provider) {
  try { return localStorage.getItem(provider.keyStorage) || null } catch { return null }
}

// The provider whose key is stored. With no key at all, claude is the display
// default (nudges, picker) — features that need a key still see getAiKey() null.
export function getActiveProvider() {
  return PROVIDERS.find(p => readKey(p)) || PROVIDERS[0]
}

export function getAiKey() {
  return readKey(getActiveProvider())
}

// Connecting a provider disconnects every other one — a single model family
// optimizes all prompts.
export function connectProvider(id, key) {
  const provider = getProvider(id)
  if (!provider || !key) return
  try {
    for (const p of PROVIDERS) {
      if (p.id !== id) localStorage.removeItem(p.keyStorage)
    }
    localStorage.setItem(provider.keyStorage, key)
  } catch {}
  clearAiAuthNotice() // a fresh key deserves a fresh rejected-key notice
}

export function disconnectProvider(id) {
  const provider = getProvider(id)
  if (!provider) return
  try { localStorage.removeItem(provider.keyStorage) } catch {}
}

const dataUrlParts = dataUrl => {
  const [header, base64] = dataUrl.split(',')
  return { mediaType: header.match(/:(.*?);/)?.[1] || 'image/jpeg', base64 }
}

// `user` is either a plain string or neutral parts:
//   { type: 'text', text }  |  { type: 'image', dataUrl }
export function toProviderRequest(provider, { model, maxTokens, system, user }) {
  const parts = Array.isArray(user) ? user : null
  if (provider.id === 'claude') {
    const content = parts
      ? parts.map(p => p.type === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: dataUrlParts(p.dataUrl).mediaType, data: dataUrlParts(p.dataUrl).base64 } }
          : { type: 'text', text: p.text })
      : user
    const req = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }
    if (system) req.system = system
    return req
  }
  // OpenAI-compatible dialect (GLM today; a future OpenAI provider too)
  const content = parts
    ? parts.map(p => p.type === 'image'
        ? { type: 'image_url', image_url: { url: p.dataUrl } }
        : { type: 'text', text: p.text })
    : user
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content })
  return { model, max_tokens: maxTokens, messages }
}

export function parseProviderText(provider, data) {
  if (provider.id === 'claude') {
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
  }
  return (data.choices?.[0]?.message?.content || '').trim()
}

// Unified completion call. Returns { ok, text, status, reason, data } and never
// throws — call sites decide whether a failure is fatal. Auth failures are
// reported once per session so the banner can surface them.
export async function aiComplete({ model, tier, system, user, maxTokens, headers = {}, bodyExtra = {} }) {
  const provider = getActiveProvider()
  const key = readKey(provider)
  if (!key) return { ok: false, reason: 'no API key', noKey: true, provider }

  const reqHeaders = { 'Content-Type': 'application/json', 'x-api-key': key, ...headers }
  if (provider.platformStorage) {
    try { reqHeaders['x-ai-platform'] = localStorage.getItem(provider.platformStorage) || provider.platforms[0].id } catch {}
  }
  const body = { ...toProviderRequest(provider, { model: model || provider[`${tier || 'light'}Model`], maxTokens, system, user }), ...bodyExtra }

  try {
    const res = await fetch(provider.proxy, { method: 'POST', headers: reqHeaders, body: JSON.stringify(body) })
    if (!res.ok) {
      reportAiAuthFailure(res.status, provider)
      return { ok: false, status: res.status, reason: `${provider.label} ${res.status}`, provider }
    }
    const data = await res.json()
    if (data.error) return { ok: false, reason: data.error.message || `${provider.label} error`, data, provider }
    return { ok: true, text: parseProviderText(provider, data), data, provider }
  } catch (e) {
    return { ok: false, reason: e.message, provider }
  }
}

// One tiny real API call to verify a key before the user relies on it.
// Returns { verdict: 'ok' | 'rejected' | 'error', message? } — message carries
// the upstream's own words (e.g. "Insufficient balance"), which is the
// difference between a diagnosable failure and a shrug.
export async function testProviderKey(id, key) {
  const provider = getProvider(id)
  if (!provider || !key) return { verdict: 'error' }
  const reqHeaders = { 'Content-Type': 'application/json', 'x-api-key': key }
  if (provider.platformStorage) {
    try { reqHeaders['x-ai-platform'] = localStorage.getItem(provider.platformStorage) || provider.platforms[0].id } catch {}
  }
  try {
    const res = await fetch(provider.proxy, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(toProviderRequest(provider, { model: provider.testModel, maxTokens: provider.testMaxTokens, user: 'ping' })),
    })
    const data = await res.json().catch(() => ({}))
    const message = data?.error?.message
    if (res.status === 401 || res.status === 403 || data?.error?.type === 'authentication_error' || data?.error?.type === 'permission_error') {
      return { verdict: 'rejected', message }
    }
    if (res.ok && !data.error) {
      clearAiAuthNotice() // key proven good — re-arm the banner for future failures
      return { verdict: 'ok' }
    }
    return { verdict: 'error', message: message || `HTTP ${res.status}` }
  } catch (e) {
    return { verdict: 'error', message: e.message }
  }
}
