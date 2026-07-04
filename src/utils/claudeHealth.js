// Claude-powered features (backstory analysis, Brand Deals product analysis)
// degrade silently to keyword fallbacks when the API key is rejected — seen
// live: one bad key 403'd across two features with only console evidence.
// Auth failures are reported once per session via a window event so the
// banner mounted in App.jsx can tell the user their key doesn't work.

export const CLAUDE_KEY_REJECTED_EVENT = 'claude-key-rejected'
const NOTIFIED_FLAG = 'claude_key_error_notified'

export function reportClaudeAuthFailure(status) {
  if (status !== 401 && status !== 403) return
  try {
    if (sessionStorage.getItem(NOTIFIED_FLAG)) return
    sessionStorage.setItem(NOTIFIED_FLAG, '1')
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(CLAUDE_KEY_REJECTED_EVENT, { detail: { status } }))
  } catch {}
}
