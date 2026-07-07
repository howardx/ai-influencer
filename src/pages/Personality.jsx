// Personality editor — the persona's soul sheet (spec §5), edited here and
// consumed by the persona agent. Deliberately its own page/file, NOT part of
// Influencers.jsx. This is future SaaS product surface: the sheet a user
// shapes here is exactly what the agent posts from.
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useInfluencers } from '../store'
import { validateSoulSheet } from '../../shared/soul-sheet/validate.js'
import {
  buildDefaultSoulSheet, buildSeedPrompt, parseSeedResponse, downloadSoulSheet,
} from '../utils/soulSheetDraft'
import { aiComplete, getActiveProvider, getAiKey } from '../utils/aiProvider'

const PAGE = { maxWidth: 880, margin: '0 auto', padding: 'calc(var(--nav-h) + 32px) 24px 80px' }
const CARD = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 16, padding: 24, marginBottom: 20,
}
/** @type {import('react').CSSProperties} */
const LABEL = {
  fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
  textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, display: 'block',
}
/** @type {import('react').CSSProperties} */
const INPUT = {
  width: '100%', padding: '9px 12px', borderRadius: 10, fontSize: 14,
  border: '1.5px solid var(--border)', background: 'var(--bg)',
  color: 'var(--text-primary)', fontFamily: 'inherit', boxSizing: 'border-box',
}
const HINT = { fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }

function Field({ label, hint = '', children, style = undefined }) {
  return (
    <div style={{ marginBottom: 14, ...style }}>
      <label style={LABEL}>{label}</label>
      {children}
      {hint && <div style={HINT}>{hint}</div>}
    </div>
  )
}

function TextField({ label, hint = '', value, onChange, placeholder = '', multiline = false, rows = 3 }) {
  return (
    <Field label={label} hint={hint}>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          rows={rows} style={{ ...INPUT, resize: 'vertical' }} />
      ) : (
        <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={INPUT} />
      )}
    </Field>
  )
}

// String-array editor: one entry per line — lean and unambiguous
function ListField({ label, hint = '', value, onChange, placeholder = '', rows = 0 }) {
  const [text, setText] = useState(value.join('\n'))
  return (
    <Field label={label} hint={hint}>
      <textarea
        value={text}
        placeholder={placeholder}
        rows={rows || Math.max(3, value.length + 1)}
        onChange={e => {
          setText(e.target.value)
          onChange(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))
        }}
        style={{ ...INPUT, resize: 'vertical' }}
      />
    </Field>
  )
}

const MEDIA_OPTIONS = ['always', 'sometimes', 'rarely', 'never']

export default function Personality() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [influencers, setInfluencers] = useInfluencers()
  const influencer = influencers.find(i => i.id === id)

  const [seeding, setSeeding] = useState(false)
  const [seedError, setSeedError] = useState(null)
  // Remount key: ListField keeps local text state, so a Claude seed must rebuild them
  const [revision, setRevision] = useState(0)

  const sheet = influencer?.soulSheet || (influencer ? buildDefaultSoulSheet(influencer) : null)
  const { valid, errors } = useMemo(
    () => (sheet ? validateSoulSheet(sheet) : { valid: false, errors: [] }),
    [sheet]
  )

  if (!influencer) {
    return (
      <div style={PAGE}>
        <p style={{ color: 'var(--text-secondary)' }}>Influencer not found.</p>
        <button onClick={() => navigate('/influencers')} style={{ ...INPUT, width: 'auto', cursor: 'pointer' }}>
          ← Back to influencers
        </button>
      </div>
    )
  }

  const save = next =>
    setInfluencers(list => list.map(i => (i.id === id ? { ...i, soulSheet: next } : i)))
  // Patch helpers write through to the store on every change (autosave)
  const patch = updates => save({ ...sheet, ...updates })
  const patchSection = (section, updates) => patch({ [section]: { ...sheet[section], ...updates } })

  async function seedWithClaude() {
    setSeeding(true)
    setSeedError(null)
    try {
      const { system, user } = buildSeedPrompt(influencer)
      const provider = getActiveProvider()
      const result = await aiComplete({
        model: provider.tunerModels?.[0]?.id, // persona quality is worth the top model
        tier: null, system, user, maxTokens: 4000,
      })
      if (!result.ok) {
        setSeedError(result.noKey
          ? `No ${provider.label} API key connected — add one in Settings first.`
          : `Draft failed: ${result.reason}`)
        return
      }
      const { sheet: drafted, errors: draftErrors } = parseSeedResponse(result.text, influencer)
      if (!drafted) {
        setSeedError(`Claude's draft didn't validate: ${draftErrors[0]}`)
        return
      }
      save(drafted)
      setRevision(r => r + 1)
    } finally {
      setSeeding(false)
    }
  }

  const weightSum = sheet.contentPillars.reduce((s, p) => s + p.weight, 0)

  return (
    <div style={PAGE} key={revision}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
        <button onClick={() => navigate('/influencers')} title="Back to influencers" style={{
          width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)',
          background: 'var(--surface)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 16,
        }}>←</button>
        {influencer.mainImage && (
          <img src={influencer.mainImage} alt="" style={{ width: 40, height: 40, borderRadius: 12, objectFit: 'cover' }} />
        )}
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.5px', margin: 0, color: 'var(--text-primary)' }}>
            {influencer.name}&apos;s personality
          </h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            The soul sheet her X persona agent posts from
          </div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '18px 0 22px' }}>
        <button onClick={seedWithClaude} disabled={seeding} style={{
          padding: '10px 20px', borderRadius: 12, fontSize: 14, fontWeight: 700, border: 'none',
          cursor: seeding ? 'wait' : 'pointer', color: '#fff',
          background: 'linear-gradient(135deg,#EC4899,#8B5CF6)', opacity: seeding ? 0.7 : 1,
        }}>
          {seeding ? 'Drafting…' : sheet === influencer.soulSheet ? '✦ Redraft with Claude' : '✦ Draft with Claude'}
        </button>
        <button onClick={() => downloadSoulSheet(sheet)} disabled={!valid}
          title={valid ? 'Download the agent-ready soul sheet' : 'Fix the issues below first'}
          style={{
            padding: '10px 20px', borderRadius: 12, fontSize: 14, fontWeight: 700,
            border: '1.5px solid var(--border)', cursor: valid ? 'pointer' : 'not-allowed',
            background: 'var(--surface)', color: valid ? 'var(--text-primary)' : 'var(--text-tertiary)',
          }}>
          ⬇ Export JSON
        </button>
        {!getAiKey() && (
          <span style={{ ...HINT, alignSelf: 'center' }}>
            Connect an AI key in Settings to enable drafting
          </span>
        )}
      </div>

      {seedError && (
        <div style={{ ...CARD, borderColor: 'rgba(255,59,48,0.4)', color: '#FF3B30', fontSize: 14 }}>
          {seedError}
        </div>
      )}

      {/* Validation status */}
      <div style={{
        ...CARD, padding: '14px 20px', display: 'flex', gap: 10, alignItems: 'flex-start',
        borderColor: valid ? 'rgba(52,199,89,0.45)' : 'var(--border)',
      }}>
        <span style={{ fontSize: 16 }}>{valid ? '✅' : '📝'}</span>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {valid
            ? 'Valid soul sheet — the agent can load this as-is.'
            : (<>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                  Still needed before the agent can use it:
                </div>
                {errors.slice(0, 5).map((e, i) => <div key={i}>• {e}</div>)}
                {errors.length > 5 && <div>…and {errors.length - 5} more</div>}
              </>)}
        </div>
      </div>

      {/* Identity */}
      <div style={CARD}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', color: 'var(--text-primary)' }}>Identity</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <TextField label="Name" value={sheet.identity.name} onChange={v => patchSection('identity', { name: v })} />
          <Field label="Age (18+)">
            <input type="number" min={18} max={99} value={sheet.identity.age ?? ''} style={INPUT}
              onChange={e => patchSection('identity', { age: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </Field>
          <TextField label="City" value={sheet.identity.city || ''} onChange={v => patchSection('identity', { city: v })} placeholder="Austin, TX" />
          <TextField label="Occupation" value={sheet.identity.occupation || ''} onChange={v => patchSection('identity', { occupation: v })} placeholder="personal trainer" />
        </div>
        <TextField label="Backstory" hint="3–5 sentences max — texture, not a résumé" multiline
          value={sheet.identity.backstory || ''} onChange={v => patchSection('identity', { backstory: v })} />
        <TextField label="Timezone (IANA)" hint="Drives her posting schedule"
          value={sheet.identity.timezone} onChange={v => patchSection('identity', { timezone: v })} placeholder="America/Chicago" />
      </div>

      {/* Voice */}
      <div style={CARD}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Voice</h2>
        <div style={{ ...HINT, marginBottom: 16 }}>
          The example posts and “never sounds like” carry the voice — tone adjectives alone regress to AI-speak.
        </div>
        <TextField label="Style" value={sheet.voice.style} onChange={v => patchSection('voice', { style: v })}
          placeholder="short sentences, lowercase, rare emoji, no hashtags" />
        <ListField label="Tone (one per line)" value={sheet.voice.tone || []}
          onChange={v => patchSection('voice', { tone: v })} placeholder={'warm\ndeadpan'} rows={3} />
        <ListField label="Catchphrases (one per line)" value={sheet.voice.catchphrases || []}
          onChange={v => patchSection('voice', { catchphrases: v })} rows={3} />
        <TextField label="Never sounds like" multiline rows={2}
          hint="The clichés she must never produce — corporate, hashtag soup, motivational-poster…"
          value={sheet.voice.never_sounds_like} onChange={v => patchSection('voice', { never_sounds_like: v })} />
        <ListField label={`Example posts — ${sheet.voice.examplePosts.length}/5–10`} rows={8}
          hint="5–10 posts in her exact voice, ≤280 chars each. This is the few-shot core the agent drafts from."
          value={sheet.voice.examplePosts} onChange={v => patchSection('voice', { examplePosts: v })}
          placeholder={'leg day was a humbling experience…\ngym at 6am: empty. gym at 6pm: a nightclub without music'} />
      </div>

      {/* Worldview */}
      <div style={CARD}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', color: 'var(--text-primary)' }}>Worldview</h2>
        <Field label="Opinions" hint="Stances she'll actually voice in trend takes — with conviction 0–1">
          {(sheet.worldview.opinions || []).map((op, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input value={op.topic} placeholder="topic" style={{ ...INPUT, flex: 2 }}
                onChange={e => {
                  const opinions = sheet.worldview.opinions.map((o, j) => j === i ? { ...o, topic: e.target.value } : o)
                  patchSection('worldview', { opinions })
                }} />
              <input value={op.stance} placeholder="stance" style={{ ...INPUT, flex: 3 }}
                onChange={e => {
                  const opinions = sheet.worldview.opinions.map((o, j) => j === i ? { ...o, stance: e.target.value } : o)
                  patchSection('worldview', { opinions })
                }} />
              <input type="number" step={0.1} min={0} max={1} value={op.strength ?? 0.5} title="conviction 0–1"
                style={{ ...INPUT, width: 68 }}
                onChange={e => {
                  const opinions = sheet.worldview.opinions.map((o, j) => j === i ? { ...o, strength: Number(e.target.value) } : o)
                  patchSection('worldview', { opinions })
                }} />
              <button title="Remove" style={{
                width: 34, borderRadius: 10, border: 'none', cursor: 'pointer',
                background: 'rgba(255,59,48,0.08)', color: '#FF3B30', fontSize: 14,
              }}
                onClick={() => patchSection('worldview', { opinions: sheet.worldview.opinions.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button style={{
            padding: '7px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            border: '1.5px dashed var(--border)', background: 'transparent', color: 'var(--text-secondary)',
          }}
            onClick={() => patchSection('worldview', {
              opinions: [...(sheet.worldview.opinions || []), { topic: '', stance: '', strength: 0.5 }],
            })}>+ Add opinion</button>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <ListField label="Interests (one per line)" value={sheet.worldview.interests || []}
            onChange={v => patchSection('worldview', { interests: v })} rows={4} />
          <ListField label="Dislikes (one per line)" value={sheet.worldview.dislikes || []}
            onChange={v => patchSection('worldview', { dislikes: v })} rows={4} />
        </div>
      </div>

      {/* Content pillars */}
      <div style={CARD}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Content pillars</h2>
        <div style={{ ...HINT, marginBottom: 16 }}>
          The strategy dial. Fixed set by design — there is no commercial pillar, so the agent structurally can’t schedule promos.
        </div>
        {sheet.contentPillars.map((p, i) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <div style={{ flex: '0 0 150px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {p.name}{p.queueGated && <span title="Queue-gated: every take needs your ✅" style={{ marginLeft: 6 }}>🔒</span>}
            </div>
            <input type="range" min={0} max={1} step={0.05} value={p.weight} style={{ flex: 1 }}
              onChange={e => {
                const pillars = sheet.contentPillars.map((q, j) => j === i ? { ...q, weight: Number(e.target.value) } : q)
                patch({ contentPillars: pillars })
              }} />
            <div style={{ width: 42, fontSize: 13, color: 'var(--text-secondary)', textAlign: 'right' }}>
              {Math.round(p.weight * 100)}%
            </div>
            <select value={p.media} title="How often this pillar carries a photo" style={{ ...INPUT, width: 120 }}
              onChange={e => {
                const pillars = sheet.contentPillars.map((q, j) => j === i ? { ...q, media: e.target.value } : q)
                patch({ contentPillars: pillars })
              }}>
              {MEDIA_OPTIONS.map(m => <option key={m} value={m}>photo: {m}</option>)}
            </select>
          </div>
        ))}
        <div style={{
          fontSize: 13, marginTop: 6,
          color: Math.abs(weightSum - 1) <= 0.001 ? 'var(--text-secondary)' : '#FF9500',
        }}>
          Weights sum to {Math.round(weightSum * 100)}% {Math.abs(weightSum - 1) > 0.001 && '— must be 100%'}
        </div>
      </div>

      {/* Boundaries */}
      <div style={CARD}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', color: 'var(--text-primary)' }}>Boundaries</h2>
        <ListField label="Banned topics (one per line)" value={sheet.boundaries.bannedTopics}
          onChange={v => patchSection('boundaries', { bannedTopics: v })} rows={4} />
        <ListField label="Never do (one per line)" value={sheet.boundaries.neverDo}
          onChange={v => patchSection('boundaries', { neverDo: v })} rows={3} />
        <TextField label="AI disclosure" hint="Required — she runs as a labeled automated account. Non-negotiable."
          value={sheet.boundaries.disclosure} onChange={v => patchSection('boundaries', { disclosure: v })} />
      </div>

      {/* Rhythm */}
      <div style={CARD}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', color: 'var(--text-primary)' }}>Rhythm</h2>
        <TextField label="Active hours" value={sheet.rhythm.activeHours}
          onChange={v => patchSection('rhythm', { activeHours: v })}
          hint="Free-form; the scheduler jitters inside this window" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 16px' }}>
          <Field label="Posts/day min">
            <input type="number" min={0} max={10} value={sheet.rhythm.postsPerDay[0]} style={INPUT}
              onChange={e => patchSection('rhythm', { postsPerDay: [Number(e.target.value), sheet.rhythm.postsPerDay[1]] })} />
          </Field>
          <Field label="Posts/day max">
            <input type="number" min={0} max={10} value={sheet.rhythm.postsPerDay[1]} style={INPUT}
              onChange={e => patchSection('rhythm', { postsPerDay: [sheet.rhythm.postsPerDay[0], Number(e.target.value)] })} />
          </Field>
          <Field label="Reply budget/day">
            <input type="number" min={0} max={25} value={sheet.rhythm.replyBudgetPerDay} style={INPUT}
              onChange={e => patchSection('rhythm', { replyBudgetPerDay: Number(e.target.value) })} />
          </Field>
        </div>
      </div>

      {/* Seed arc */}
      <div style={CARD}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Life right now</h2>
        <div style={{ ...HINT, marginBottom: 16 }}>
          Seeds the agent’s memory once — after that she lives her own arc.
        </div>
        <TextField label="Current arc" multiline rows={2} value={sheet.seedArc?.currentArc || ''}
          onChange={v => patch({ seedArc: { ...sheet.seedArc, currentArc: v } })}
          placeholder="eight weeks out from her first powerlifting meet — equal parts excited and terrified" />
        <ListField label="Running bits (one per line)" value={sheet.seedArc?.runningBits || []}
          onChange={v => patch({ seedArc: { ...sheet.seedArc, runningBits: v } })} rows={3}
          hint="Recurring in-jokes that make her feel continuous" />
      </div>
    </div>
  )
}
