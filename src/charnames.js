// Character names for the whole of Unicode, not just the curated blocks.
// The table is ~1.4 MB, so it is fetched only when the reader opens a section
// that needs it, and every lookup before that quietly returns null.

let table = null

export async function loadCharNames() {
  if (!table) table = (await import('./data/names.json')).default
  return table
}

export function charName(cp) {
  if (!table) return null
  const hex = cp.toString(16).toUpperCase().padStart(4, '0')
  const name = table.names[hex]
  if (name) return name
  // Ideographs, Hangul syllables and the like are named by rule.
  for (const [start, end, prefix] of table.ranges) {
    if (cp >= start && cp <= end) return `${prefix}-${hex}`
  }
  return null
}
