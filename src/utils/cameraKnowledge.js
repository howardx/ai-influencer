// Camera-movement knowledge for the Claude video-prompt tuner.
//
// BAKED_CAMERA_KNOWLEDGE is distilled from aicameramovements.com (46 movements,
// 7 categories, and its Movement/Speed/Framing/End prompt grammar) blended with
// the Seedance guide's laws. It ships with the app so tuning works offline.
// refreshCameraKnowledge() in videoPromptTuner.js can replace it at runtime by
// having Claude re-read the live sources (KNOWLEDGE_SOURCES) via web tools —
// kling.ai blocks plain fetchers (HTTP 446), so the refresh must always be
// optional and this baked pack is the reliable floor.

export const KNOWLEDGE_SOURCES = [
  'https://aicameramovements.com/',
  'https://kling.ai/blog',
]

export const BAKED_CAMERA_KNOWLEDGE = `CAMERA MOVEMENT VOCABULARY (for AI video prompts — Seedance/Kling compatible)

Grammar per shot: name the movement, then qualify with up to four short clauses:
Movement (direction/path), Speed (one qualitative word), Framing (subject position),
End (what the final frame holds). Example: "slow push in — Movement: camera eases
toward her face. Speed: gradual. Framing: face centered, upper-third eyes. End:
tight MCU held still." Keep it to 1–2 sentences per shot; never stack movements.

CATEGORIES & MOVEMENTS
- Pan/Tilt: static shot · pan left/right · whip pan left/right · tilt up/down.
  Rotation from a fixed point; horizon stays level. Whip pan = fast, snappy, for
  energy transitions between beats (multi-shot only, at a cut).
- Zoom/Lens: slow zoom in/out · fast zoom in/out · crash zoom in/out.
  Focal-length change, camera does not move. Crash zoom = punchy emphasis on a
  reveal (product close-up, reaction).
- Dolly/Track: dolly in/out · tracking shot · follow shot · reverse tracking ·
  side tracking · low tracking · chase shot. Physical movement; keeps subject
  readable. Dolly in = building intimacy on a talking head; reverse tracking =
  walking-and-talking selfie energy.
- Physical: truck left/right · pedestal up/down · slider left/right · push past ·
  arc left/right · orbit clockwise/counterclockwise. Lateral or curved paths with
  parallax. Arc = premium product-demo feel (quarter-circle around the subject
  while she demonstrates); orbit = full circle, use sparingly.
- Drone/Crane: crane up/down · drone push in/pull back · helicopter shot.
  Altitude moves — wrong register for handheld UGC; only for establishing wides.
- Human camera: handheld shot · body-mounted (Snorricam). Organic sway; the
  default register for self-filmed UGC commercial realism.
- Specials: first-person view · tilt-shift · time-lapse · pass-through. Rarely
  appropriate for influencer commercials; avoid unless asked.

SPEED WORDS: smooth, gradual, controlled (calm) · fast, quick, punchy, snappy
(energetic). Pick ONE per shot and commit — "slow or fast" style options break
generation.

PAIRING MOVES TO COMMERCIAL BEATS
- Hook (first 2s): static or slow push in — let the face and first line land.
- Product reveal / demo: crash zoom in, arc left/right, or slow zoom in on the
  product feature being demonstrated; keep the product tag in frame.
- Walking pitch: reverse tracking (camera leads, subject walks toward it) or
  handheld follow with walk-pace bob.
- Closer / CTA: dolly in to MCU, then hold static for the post-line beat.

HARD RULES (violating these breaks Seedance output)
- One movement per shot. Never offer alternatives ("dolly or truck").
- Handheld self-filmed shots keep arm's-length 24mm logic — no drone/crane.
- Locked-tripod styles ("static," "documentary") must not gain drift; the word
  "cinematic" itself pulls toward unwanted dolly movement.
- Faces need medium close-up or tighter for fidelity; wide shots go plasticky.
- End every final shot with a held frame, no talking or lip movement.`
