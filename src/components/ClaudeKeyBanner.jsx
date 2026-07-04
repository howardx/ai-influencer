import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { CLAUDE_KEY_REJECTED_EVENT } from '../utils/claudeHealth'

// Shows once per session when a Claude call fails auth — the features that use
// Claude fall back to basic keyword analysis, and without this the user never
// learns their key is being rejected.
export default function ClaudeKeyBanner() {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    const onRejected = e => setStatus(e.detail?.status ?? 403)
    window.addEventListener(CLAUDE_KEY_REJECTED_EVENT, onRejected)
    return () => window.removeEventListener(CLAUDE_KEY_REJECTED_EVENT, onRejected)
  }, [])

  if (!status) return null
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
        Your Claude API key was rejected ({status}) — AI analysis is using a basic fallback.{' '}
        <Link to="/settings" style={{ color: 'var(--accent)', fontWeight: 600 }}>Check Settings</Link>
        {' '}— it must be an API key from console.anthropic.com.
      </span>
      <button onClick={() => setStatus(null)} aria-label="Dismiss" style={{
        border: 'none', background: 'transparent', color: 'var(--text-secondary)',
        fontSize: 15, cursor: 'pointer', padding: 2, lineHeight: 1,
      }}>×</button>
    </div>
  )
}
