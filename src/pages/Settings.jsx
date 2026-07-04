import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { startHiggsfieldOAuthPopup, disconnectHF, isHFConnected } from '../utils/higgsfieldAuth'
import { PROVIDERS, connectProvider, disconnectProvider, testProviderKey } from '../utils/aiProvider'
import { useTheme } from '../context/theme'

function Section({ title, children }) {
  return (
    <div style={{ background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border-subtle)', overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{title}</div>
      </div>
      <div style={{ padding: '20px 24px' }}>{children}</div>
    </div>
  )
}

// One provider section per PROVIDERS entry — connecting one disconnects the
// others (exactly one model family optimizes prompts at a time).
function AiProviderSection({ provider, activeKey, onChange }) {
  const connected = !!activeKey
  const others = PROVIDERS.filter(p => p.id !== provider.id).map(p => p.label).join(' / ')
  const [input, setInput] = useState('')
  const [showInput, setShowInput] = useState(false)
  const [keyTest, setKeyTest] = useState(null) // null | 'testing' | { verdict: 'ok'|'rejected'|'error', message? }
  const [platform, setPlatform] = useState(() => {
    try { return (provider.platformStorage && localStorage.getItem(provider.platformStorage)) || provider.platforms?.[0]?.id } catch { return provider.platforms?.[0]?.id }
  })

  function save() {
    const k = input.trim()
    if (!k) return
    connectProvider(provider.id, k)
    setInput('')
    setShowInput(false)
    setKeyTest(null)
    onChange()
  }

  // One tiny real API call — a rejected key otherwise fails silently deep
  // inside generation flows where the user never sees it.
  async function runKeyTest() {
    setKeyTest('testing')
    setKeyTest(await testProviderKey(provider.id, activeKey))
  }

  return (
    <Section title={`${provider.label} AI`}>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
        Add your {provider.label} API key ({provider.keyHint}) to let {provider.label} analyze images and tune prompts across the app.
        {' '}Only one AI provider is active at a time — connecting {provider.label} disconnects {others}.
      </p>
      {provider.platforms && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Key issued by</span>
          <select
            value={platform}
            onChange={e => {
              setPlatform(e.target.value)
              setKeyTest(null) // a verdict from the previous platform is meaningless here
              try { localStorage.setItem(provider.platformStorage, e.target.value) } catch {}
            }}
            style={{ padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1.5px solid var(--border)', outline: 'none' }}
          >
            {provider.platforms.map(pl => <option key={pl.id} value={pl.id}>{pl.label}</option>)}
          </select>
        </div>
      )}
      {connected ? (() => {
        // One coherent status line: the dot and label reflect the last test
        // result instead of showing "connected" green next to a failure.
        const verdict = typeof keyTest === 'object' ? keyTest?.verdict : null
        const dot = verdict === 'rejected' ? '#FF3B30' : verdict === 'error' ? '#FF9500' : '#34C759'
        const statusText =
          verdict === 'ok' ? `${provider.label} connected — key verified ✓`
          : verdict === 'rejected' ? `${provider.label} key rejected`
          : verdict === 'error' ? `${provider.label} key saved, but not working`
          : `${provider.label} connected`
        const detail =
          verdict === 'rejected' ? (keyTest.message || `use an API key from ${provider.keyHint}`)
          : verdict === 'error' ? (keyTest.message || "couldn't verify — try again")
          : null
        return (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: dot }}>{statusText}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>···{activeKey.slice(-4)}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  onClick={runKeyTest}
                  disabled={keyTest === 'testing'}
                  style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', fontWeight: 500, cursor: 'pointer' }}
                >
                  {keyTest === 'testing' ? 'Testing…' : 'Test key'}
                </button>
                <button
                  onClick={() => { disconnectProvider(provider.id); setInput(''); setShowInput(false); setKeyTest(null); onChange() }}
                  style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, color: '#FF3B30', background: 'rgba(255,59,48,0.08)', border: '1px solid rgba(255,59,48,0.18)', fontWeight: 500 }}
                >
                  Remove
                </button>
              </div>
            </div>
            {detail && (
              <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5, color: dot }}>
                {detail}
                {provider.platforms && verdict === 'error' && (
                  <span style={{ color: 'var(--text-secondary)' }}> — if this key comes from a subscription plan, switch “Key issued by” above and test again.</span>
                )}
              </div>
            )}
          </div>
        )
      })() : showInput ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            autoFocus
            type="password"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={provider.keyPlaceholder}
            onKeyDown={e => { if (e.key === 'Enter') save() }}
            style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg)', fontSize: 14, color: 'var(--text-primary)', fontFamily: 'monospace' }}
          />
          <button
            onClick={save}
            style={{ padding: '10px 18px', borderRadius: 8, fontSize: 14, fontWeight: 600, background: '#1D1D1F', color: '#fff', border: 'none', cursor: 'pointer' }}
          >
            Save
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowInput(true)}
          style={{ padding: '10px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600, background: '#1D1D1F', color: '#fff', border: 'none', cursor: 'pointer' }}
        >
          Add API Key
        </button>
      )}
    </Section>
  )
}

export default function Settings() {
  const location = useLocation()
  const { theme, toggle } = useTheme()
  const [hfConnected, setHfConnected] = useState(isHFConnected)
  const [hfLoading, setHfLoading] = useState(false)
  // Bump to re-read provider keys after connect/disconnect (they live in localStorage)
  const [, setAiVersion] = useState(0)
  const bumpAi = () => setAiVersion(v => v + 1)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('connected') === '1') {
      setHfConnected(true)
    }
  }, [location.search])

  async function connectHiggsfield() {
    setHfLoading(true)
    try {
      await startHiggsfieldOAuthPopup()
      setHfConnected(true)
    } catch (e) {
      if (e.message !== 'cancelled') alert('Failed to connect Higgsfield: ' + e.message)
    } finally {
      setHfLoading(false)
    }
  }

  function disconnectHighgsfield() {
    if (!confirm('Disconnect your Higgsfield account?')) return
    disconnectHF()
    setHfConnected(false)
  }

  return (
    <div style={{ paddingTop: 'var(--nav-h)', minHeight: '100vh', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 24px' }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.5px', marginBottom: 28 }}>Settings</h1>

        <Section title="Appearance">
          <div style={{ display: 'flex', gap: 10 }}>
            {(['light', 'dark']).map(val => {
              const on = theme === val
              return (
                <button key={val} onClick={e => { if (!on) toggle(e.clientX, e.clientY) }} style={{
                  flex: 1, padding: '14px 12px', borderRadius: 12, cursor: on ? 'default' : 'pointer',
                  border: `1.5px solid ${on ? '#8B5CF6' : 'var(--border)'}`,
                  background: on ? 'rgba(139,92,246,0.09)' : 'var(--bg)',
                  color: on ? '#8B5CF6' : 'var(--text-secondary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                  fontWeight: 600, fontSize: 14, fontFamily: 'inherit',
                  transition: 'all 0.15s',
                  boxShadow: on ? '0 0 0 1px #8B5CF655' : 'none',
                }}>
                  {val === 'light' ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <circle cx="12" cy="12" r="5"/>
                      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                    </svg>
                  )}
                  {val.charAt(0).toUpperCase() + val.slice(1)}
                </button>
              )
            })}
          </div>
        </Section>

        <Section title="Higgsfield">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
            Connect your Higgsfield account to generate influencer images directly in the app. Images use your own Higgsfield credits.
          </p>
          {hfConnected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#34C759' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#34C759' }}>Higgsfield connected</span>
              </div>
              <button onClick={disconnectHighgsfield} style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, color: '#FF3B30', background: 'rgba(255,59,48,0.08)', border: '1px solid rgba(255,59,48,0.18)', fontWeight: 500 }}>
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={connectHiggsfield}
              disabled={hfLoading}
              style={{ padding: '10px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600, background: '#1D1D1F', color: '#fff', display: 'flex', alignItems: 'center', gap: 8, opacity: hfLoading ? 0.6 : 1 }}
            >
              {hfLoading ? (
                <>
                  <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
                  Connecting…
                </>
              ) : (
                'Connect Higgsfield'
              )}
              <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
            </button>
          )}
        </Section>

        {PROVIDERS.map(provider => (
          <AiProviderSection
            key={provider.id}
            provider={provider}
            activeKey={(() => { try { return localStorage.getItem(provider.keyStorage) } catch { return null } })()}
            onChange={bumpAi}
          />
        ))}
      </div>
    </div>
  )
}
