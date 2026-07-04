import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PROVIDERS, getProvider, getActiveProvider, getAiKey,
  connectProvider, disconnectProvider,
  toProviderRequest, parseProviderText,
} from './aiProvider.js'

function stubStorage() {
  const store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  })
}

describe('provider registry and key management', () => {
  beforeEach(stubStorage)
  afterEach(() => vi.unstubAllGlobals())

  it('knows claude and glm, each with the tiered models a feature needs', () => {
    for (const id of ['claude', 'glm']) {
      const p = getProvider(id)
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.keyStorage).toContain('api_key')
      expect(p.proxy).toMatch(/^\/api\//)
      expect(typeof p.lightModel).toBe('string')
      expect(typeof p.visionModel).toBe('string')
      expect(p.tunerModels.length).toBeGreaterThan(0)
    }
  })

  it('defaults to claude for display when nothing is connected, with no key', () => {
    expect(getActiveProvider().id).toBe('claude')
    expect(getAiKey()).toBe(null)
  })

  it('activates whichever provider has a key', () => {
    localStorage.setItem('glm_api_key', 'glm-secret')
    expect(getActiveProvider().id).toBe('glm')
    expect(getAiKey()).toBe('glm-secret')
  })

  it('connecting one provider disconnects the others', () => {
    connectProvider('claude', 'sk-ant-123')
    expect(getActiveProvider().id).toBe('claude')
    connectProvider('glm', 'glm-456')
    expect(localStorage.getItem('claude_api_key')).toBe(null)
    expect(getActiveProvider().id).toBe('glm')
    expect(getAiKey()).toBe('glm-456')
    connectProvider('claude', 'sk-ant-789')
    expect(localStorage.getItem('glm_api_key')).toBe(null)
    expect(getActiveProvider().id).toBe('claude')
  })

  it('disconnecting the active provider reverts to the no-key state', () => {
    connectProvider('glm', 'glm-456')
    disconnectProvider('glm')
    expect(getAiKey()).toBe(null)
    expect(getActiveProvider().id).toBe('claude')
  })
})

describe('wire-format translation', () => {
  const claude = () => PROVIDERS.find(p => p.id === 'claude')
  const glm = () => PROVIDERS.find(p => p.id === 'glm')

  it('builds an Anthropic-shaped request for claude', () => {
    const req = toProviderRequest(claude(), { model: 'claude-opus-4-8', maxTokens: 100, system: 'sys', user: 'hello' })
    expect(req).toEqual({
      model: 'claude-opus-4-8',
      max_tokens: 100,
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('builds an OpenAI-shaped request for glm, folding system into messages', () => {
    const req = toProviderRequest(glm(), { model: 'glm-5.2', maxTokens: 100, system: 'sys', user: 'hello' })
    expect(req).toEqual({
      model: 'glm-5.2',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
    })
  })

  it('omits the system message when none is given', () => {
    const req = toProviderRequest(glm(), { model: 'glm-5.2', maxTokens: 50, user: 'hi' })
    expect(req.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('translates neutral image+text parts to each provider dialect', () => {
    const user = [
      { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
      { type: 'text', text: 'describe' },
    ]
    const c = toProviderRequest(claude(), { model: 'm', maxTokens: 10, user })
    expect(c.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'describe' },
    ])
    const g = toProviderRequest(glm(), { model: 'm', maxTokens: 10, user })
    expect(g.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'describe' },
    ])
  })

  it('parses response text per provider', () => {
    expect(parseProviderText(claude(), { content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(parseProviderText(glm(), { choices: [{ message: { content: ' glm says hi ' } }] })).toBe('glm says hi')
    expect(parseProviderText(glm(), {})).toBe('')
  })
})
