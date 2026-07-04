import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { AI_KEY_REJECTED_EVENT } from '../utils/aiHealth'

// Shows once per session when an AI call fails auth — the features that use
// the AI provider fall back to basic keyword analysis, and without this the
// user never learns their key is being rejected.
export default function AiKeyBanner() {
  const [rejected, setRejected] = useState(null) // { status, providerLabel, keyHint }

  useEffect(() => {
    const onRejected = e => setRejected({
      status: e.detail?.status ?? 403,
      providerLabel: e.detail?.providerLabel || 'AI',
      keyHint: e.detail?.keyHint,
    })
    window.addEventListener(AI_KEY_REJECTED_EVENT, onRejected)
    return () => window.removeEventListener(AI_KEY_REJECTED_EVENT, onRejected)
  }, [])

  if (!rejected) return null
  return (
    <div style={{
      position: 'fixed', top: 'calc(var(--nav-h) + 10px)', left: '50%', transform: 'translateX(-50%)',
      zIndex: 900, maxWidth: 560, width: 'calc(100% - 32px)',
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '11px 14px', borderRadius: 'var(--radius-md)',
      background: 'var(--surface)', border: '1.5px solid rgba(255,149,0,0.45)',
      boxShadow: 'var(--shadow-md)', fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5,
    }}>
      <span style={{ fontSize: 15 }}>⚠️</span>
      <span style={{ flex: 1 }}>
        Your {rejected.providerLabel} API key was rejected ({rejected.status}) — AI analysis is using a basic fallback.{' '}
        <Link to="/settings" style={{ color: 'var(--accent)', fontWeight: 600 }}>Check Settings</Link>
        {rejected.keyHint ? ` — it must be an API key from ${rejected.keyHint}.` : '.'}
      </span>
      <button onClick={() => setRejected(null)} aria-label="Dismiss" style={{
        border: 'none', background: 'transparent', color: 'var(--text-secondary)',
        fontSize: 15, cursor: 'pointer', padding: 2, lineHeight: 1,
      }}>×</button>
    </div>
  )
}
