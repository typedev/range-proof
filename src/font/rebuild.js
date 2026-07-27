// Rebuilds the uploaded font as a plain sfnt whose cmap maps one private-use
// codepoint to every glyph id. Loaded as a second FontFace, that copy lets the
// page draw glyphs no codepoint reaches in the original — alternates,
// ligature targets, components — which the browser otherwise cannot address.
//
// Nothing else about the font changes: every other table is copied verbatim.

const PLANE_15 = 0xf0000 // U+F0000–U+FFFFD, 65534 private-use codepoints
const PLANE_16 = 0x100000 // the last two glyph ids of a full font spill here
const PLANE_15_GLYPHS = 0xffffd - PLANE_15 + 1

// Layout tables are dropped: the copy exists to show one glyph per cell, and
// the browser applies default features (ccmp, calt, liga…) that could
// substitute one glyph for another. DSIG is dropped because editing the font
// invalidates it.
const DROP = new Set(['cmap', 'DSIG', 'GSUB', 'GPOS', 'kern'])

const TAG_OTTO = 0x4f54544f
const TAG_V1 = 0x00010000

// The private-use codepoint that addresses a glyph id in the rebuilt font.
export function gidToCodepoint(gid) {
  return gid < PLANE_15_GLYPHS
    ? PLANE_15 + gid
    : PLANE_16 + (gid - PLANE_15_GLYPHS)
}

// Returns an ArrayBuffer for the rebuilt font, or null when the original
// cannot be re-emitted (WOFF2 stores glyf/loca and sometimes hmtx in a
// transformed encoding this app does not undo).
export function buildGidFont({ numGlyphs, binary }) {
  if (!numGlyphs || !binary) return null
  const { tables, flavor, transformed } = binary
  if (transformed.length) return null

  const entries = Object.entries(tables)
    .filter(([tag]) => !DROP.has(tag))
    .map(([tag, data]) => [tag, data])
  entries.push(['cmap', buildCmap(numGlyphs)])
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))

  const isCff = 'CFF ' in tables || 'CFF2' in tables
  const sfntVersion = flavor === TAG_OTTO || flavor === TAG_V1
    ? flavor
    : (isCff ? TAG_OTTO : TAG_V1)

  return assemble(sfntVersion, entries)
}

// --------------------------------------------------------------- cmap

function buildCmap(numGlyphs) {
  // One format 12 group per contiguous run of glyph ids; a font only spans a
  // second plane if it uses nearly all 65536 glyph slots.
  const groups = []
  const inPlane15 = Math.min(numGlyphs, PLANE_15_GLYPHS)
  groups.push([PLANE_15, PLANE_15 + inPlane15 - 1, 0])
  if (numGlyphs > PLANE_15_GLYPHS) {
    groups.push([PLANE_16, PLANE_16 + (numGlyphs - PLANE_15_GLYPHS) - 1, PLANE_15_GLYPHS])
  }

  const subtableLength = 16 + groups.length * 12
  const subtableOffset = 4 + 2 * 8 // header + two encoding records
  const out = new DataView(new ArrayBuffer(subtableOffset + subtableLength))

  out.setUint16(0, 0) // version
  out.setUint16(2, 2) // numTables
  // Windows UCS-4 and Unicode full-repertoire records, both pointing at the
  // same subtable, so every engine finds one it recognises.
  out.setUint16(4, 3)
  out.setUint16(6, 10)
  out.setUint32(8, subtableOffset)
  out.setUint16(12, 0)
  out.setUint16(14, 4)
  out.setUint32(16, subtableOffset)

  const s = subtableOffset
  out.setUint16(s, 12)
  out.setUint16(s + 2, 0)
  out.setUint32(s + 4, subtableLength)
  out.setUint32(s + 8, 0) // language
  out.setUint32(s + 12, groups.length)
  groups.forEach(([start, end, startGid], i) => {
    const g = s + 16 + i * 12
    out.setUint32(g, start)
    out.setUint32(g + 4, end)
    out.setUint32(g + 8, startGid)
  })

  return new Uint8Array(out.buffer)
}

// --------------------------------------------------------------- sfnt

function assemble(sfntVersion, entries) {
  const numTables = entries.length
  const headerSize = 12 + numTables * 16
  const size = entries.reduce((n, [, data]) => n + align4(data.length), headerSize)

  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  const entrySelector = Math.floor(Math.log2(numTables))
  const searchRange = 2 ** entrySelector * 16

  view.setUint32(0, sfntVersion)
  view.setUint16(4, numTables)
  view.setUint16(6, searchRange)
  view.setUint16(8, entrySelector)
  view.setUint16(10, numTables * 16 - searchRange)

  let offset = headerSize
  let headOffset = -1
  entries.forEach(([tag, data], i) => {
    const rec = 12 + i * 16
    out.set(data, offset)
    if (tag === 'head') {
      headOffset = offset
      // head is checksummed with checkSumAdjustment zeroed, so clear it before
      // the table checksum is taken and fill it in once the file is complete.
      if (data.length >= 12) view.setUint32(offset + 8, 0)
    }
    for (let c = 0; c < 4; c++) view.setUint8(rec + c, tag.charCodeAt(c))
    view.setUint32(rec + 4, checksum(out, offset, align4(data.length)))
    view.setUint32(rec + 8, offset)
    view.setUint32(rec + 12, data.length)
    offset += align4(data.length)
  })

  if (headOffset >= 0 && headOffset + 12 <= size) {
    view.setUint32(headOffset + 8, (0xb1b0afba - checksum(out, 0, size)) >>> 0)
  }

  return out.buffer
}

const align4 = (n) => (n + 3) & ~3

function checksum(bytes, start, length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let sum = 0
  for (let i = 0; i < length; i += 4) {
    sum = (sum + view.getUint32(start + i)) >>> 0
  }
  return sum
}
