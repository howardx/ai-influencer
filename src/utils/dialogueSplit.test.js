import { describe, it, expect } from 'vitest'
import { splitDialogueSentences, distributeSentences } from './dialogueSplit.js'

const MARY_SCRIPT = '果然物理防晒，才是防晒界的神。这个100桑蚕丝防晒口罩，上脸简直不要太舒服。滑溜溜，冰凉凉的，关键这种面料还能养肤。敏肌放心用。\n加高护眼角，眼角也能防护到位。隐藏透气孔，呼吸顺畅不闷热。戴了它再也不抹黏糊糊的防晒霜了'

describe('splitDialogueSentences', () => {
  it('splits CJK sentences ending in 。！？ with no trailing space', () => {
    const lines = splitDialogueSentences(MARY_SCRIPT)
    expect(lines).toHaveLength(7)
    expect(lines[0]).toBe('果然物理防晒，才是防晒界的神。')
    expect(lines[3]).toBe('敏肌放心用。')
    expect(lines[6]).toBe('戴了它再也不抹黏糊糊的防晒霜了')
  })

  it('splits ASCII sentences on terminator + whitespace', () => {
    expect(splitDialogueSentences('First one. Second one! Third?')).toEqual(['First one.', 'Second one!', 'Third?'])
  })

  it('does not split decimals or dotted tokens', () => {
    expect(splitDialogueSentences('Only 9.9 dollars today. Grab it now.')).toEqual(['Only 9.9 dollars today.', 'Grab it now.'])
  })

  it('handles mixed CJK and ASCII punctuation', () => {
    expect(splitDialogueSentences('这个真的好用！Seriously, try it. 快去买？')).toEqual(['这个真的好用！', 'Seriously, try it.', '快去买？'])
  })

  it('returns empty array for empty or whitespace input', () => {
    expect(splitDialogueSentences('')).toEqual([])
    expect(splitDialogueSentences('  \n ')).toEqual([])
    expect(splitDialogueSentences(null)).toEqual([])
  })
})

describe('distributeSentences', () => {
  it('spreads sentences across shots proportional to shot duration, dropping none', () => {
    const lines = splitDialogueSentences(MARY_SCRIPT) // 7 lines
    const chunks = distributeSentences(lines, [2, 3, 5, 5]) // Mary's 15s / 4-shot split
    expect(chunks).toHaveLength(4)
    expect(chunks.flat()).toEqual(lines) // nothing dropped, order preserved
    // the 2s hook shot must not carry the whole script
    expect(chunks[0].length).toBeLessThanOrEqual(2)
    // no shot is empty while others overflow
    expect(chunks.every(c => c.length >= 1)).toBe(true)
  })

  it('gives every line to the single shot of a oner-style split', () => {
    expect(distributeSentences(['a.', 'b.'], [8])).toEqual([['a.', 'b.']])
  })

  it('leaves later shots empty when there are fewer lines than shots', () => {
    const chunks = distributeSentences(['Only line.'], [2, 3, 5, 5])
    expect(chunks.flat()).toEqual(['Only line.'])
    expect(chunks).toHaveLength(4)
  })

  it('never leaves the hook shot silent while lines exist — empties go at the end', () => {
    // Proportional rounding alone strands a single line in shot 3 (round(1×2/15)=0)
    // and the video opens with a silent hook.
    expect(distributeSentences(['Only line.'], [2, 3, 5, 5])[0]).toEqual(['Only line.'])
    const two = distributeSentences(['A.', 'B.'], [2, 3, 5, 5])
    expect(two[0]).toEqual(['A.'])
    expect(two.flat()).toEqual(['A.', 'B.'])
    // no empty chunk may precede a non-empty one
    for (const chunks of [two, distributeSentences(['A.', 'B.', 'C.'], [2, 3, 5, 5])]) {
      const firstEmpty = chunks.findIndex(c => c.length === 0)
      if (firstEmpty !== -1) expect(chunks.slice(firstEmpty).every(c => c.length === 0)).toBe(true)
    }
  })

  it('handles no dialogue at all', () => {
    expect(distributeSentences([], [2, 3, 5])).toEqual([[], [], []])
  })
})
