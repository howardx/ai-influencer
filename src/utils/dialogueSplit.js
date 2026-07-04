// Sentence handling for video dialogue distribution.
//
// CJK scripts end sentences with 。！？ and use no trailing space — an
// ASCII-only splitter saw a Chinese script as ONE giant sentence, crammed it
// into the 2-second hook shot, and left every later shot dialogue-less
// (Seedance then invented its own lines to fill the silence).
//
// ASCII terminators still require following whitespace so decimals ("9.9")
// and dotted tokens never split; CJK terminators split immediately.
const SENTENCE_END = /(?<=[.!?])\s+|(?<=[。！？])\s*/

export function splitDialogueSentences(text) {
  if (!text || !text.trim()) return []
  return text.split(SENTENCE_END).map(s => s.trim()).filter(Boolean)
}

// Distribute sentences across shots as contiguous chunks weighted by shot
// duration — the old one-sentence-per-shot mapping silently dropped every
// sentence past shot N. Returns one array of sentences per shot; nothing is
// ever dropped or reordered, and while lines remain no earlier shot may sit
// empty (proportional rounding alone strands a sparse script's only line in a
// middle shot, opening the video with a silent hook).
export function distributeSentences(lines, shotDurations) {
  const total = shotDurations.reduce((a, b) => a + b, 0) || 1
  const chunks = []
  let start = 0
  let elapsed = 0
  for (let i = 0; i < shotDurations.length; i++) {
    elapsed += shotDurations[i]
    let end = i === shotDurations.length - 1
      ? lines.length
      : Math.round(lines.length * (elapsed / total))
    // Front-load: every chunk takes at least one remaining line
    end = Math.max(end, Math.min(start + 1, lines.length))
    chunks.push(lines.slice(start, Math.max(start, end)))
    start = Math.max(start, end)
  }
  return chunks
}
