// AI-powered features (backstory analysis, product analysis, prompt tuning)
// degrade silently to keyword fallbacks when the API key is rejected — seen
// live: one bad key 403'd across two features with only console evidence.
// Auth failures are reported once per session via a window event so the
// banner mounted in App.jsx can tell the user their key doesn't work.

export const AI_KEY_REJECTED_EVENT = 'ai-key-rejected'
const NOTIFIED_FLAG = 'ai_key_error_notified'

// Re-arm the once-per-session notice — called when a key verifies or a new
// key is connected, so a key that breaks LATER in the same session still
// notifies instead of being swallowed by the old flag.
export function clearAiAuthNotice() {
  try { sessionStorage.removeItem(NOTIFIED_FLAG) } catch {}
}

export function reportAiAuthFailure(status, provider) {
  if (status !== 401 && status !== 403) return
  try {
    if (sessionStorage.getItem(NOTIFIED_FLAG)) return
    sessionStorage.setItem(NOTIFIED_FLAG, '1')
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(AI_KEY_REJECTED_EVENT, {
      detail: { status, providerId: provider?.id || 'claude', providerLabel: provider?.label || 'Claude', keyHint: provider?.keyHint },
    }))
  } catch {}
}
