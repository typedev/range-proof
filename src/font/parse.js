// Font parsing: extracts the set of mapped Unicode codepoints plus basic
// naming info from TTF / OTF / TTC / WOFF / WOFF2 binaries. No rendering —
// glyph drawing is done by the browser via the FontFace API.
//
// The raw tables are kept as well: rebuild.js re-emits them as a plain sfnt
// with a synthetic cmap so glyphs no codepoint reaches can still be drawn.

import decompressBrotli from 'brotli/decompress.js'
import { readGlyphNames } from './glyphnames.js'

const TAG_TTCF = 0x74746366
const TAG_OTTO = 0x4f54544f
const TAG_TRUE = 0x74727565
const TAG_V1 = 0x00010000
const TAG_WOFF = 0x774f4646
const TAG_WOF2 = 0x774f4632

// WOFF2 known table tags, indexed by the 6-bit value in each directory
// entry's flags byte (W3C WOFF2 spec, "Known Table Tags").
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post',
  'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
]

class ParseError extends Error {}

export async function parseFont(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  if (bytes.length < 12) throw new ParseError('File is too short to be a font.')
  const view = new DataView(arrayBuffer)
  const sig = view.getUint32(0)

  let tables // { tag: Uint8Array }
  let format
  let flavor = sig
  // WOFF/WOFF2 tables that arrive in a transformed encoding this parser does
  // not undo; their presence rules out rebuilding the font (see rebuild.js).
  let transformed = []
  if (sig === TAG_WOFF) {
    format = 'WOFF'
    flavor = view.getUint32(4)
    tables = await readWoffTables(bytes, view)
  } else if (sig === TAG_WOF2) {
    format = 'WOFF2'
    flavor = view.getUint32(4)
    ;({ tables, transformed } = readWoff2Tables(bytes, view))
  } else if (sig === TAG_V1 || sig === TAG_OTTO || sig === TAG_TRUE) {
    format = sig === TAG_OTTO ? 'OTF' : 'TTF'
    tables = readSfntTables(bytes, view, 0)
  } else if (sig === TAG_TTCF) {
    format = 'TTC'
    tables = readSfntTables(bytes, view, view.getUint32(12))
  } else {
    throw new ParseError('Not a recognized font file (expected TTF, OTF, WOFF or WOFF2).')
  }

  if (!tables.cmap) throw new ParseError('Font has no cmap table.')

  const { codepoints, encodedGids } = parseCmap(tables.cmap)
  const names = tables.name ? parseName(tables.name) : {}
  const numGlyphs = tables.maxp ? new DataView(
    tables.maxp.buffer, tables.maxp.byteOffset, tables.maxp.byteLength,
  ).getUint16(4) : null

  return {
    format,
    codepoints,
    encodedGids,
    numGlyphs,
    zeroWidthGids: readZeroWidthGids(tables, numGlyphs, transformed),
    glyphNames: numGlyphs ? readGlyphNames(tables, numGlyphs) : null,
    family: names.family || null,
    subfamily: names.subfamily || null,
    version: names.version || null,
    binary: { tables, flavor, transformed },
  }
}

// -------------------------------------------------------------------- hmtx

// Glyphs with no advance are combining marks, which need a base to sit on to
// be legible in a grid. Returns an empty set when the widths are unreadable.
function readZeroWidthGids(tables, numGlyphs, transformed) {
  const zero = new Set()
  if (!numGlyphs || !tables.hhea || !tables.hmtx) return zero
  if (transformed.includes('hmtx') || transformed.includes('hhea')) return zero

  const hhea = new DataView(tables.hhea.buffer, tables.hhea.byteOffset, tables.hhea.byteLength)
  const numberOfHMetrics = hhea.getUint16(34)
  const hmtx = new DataView(tables.hmtx.buffer, tables.hmtx.byteOffset, tables.hmtx.byteLength)

  let lastAdvance = 0
  for (let gid = 0; gid < numGlyphs; gid++) {
    if (gid < numberOfHMetrics) {
      if (gid * 4 + 2 > hmtx.byteLength) break
      lastAdvance = hmtx.getUint16(gid * 4)
    }
    // Glyphs past numberOfHMetrics all share the last advance width.
    if (lastAdvance === 0) zero.add(gid)
  }
  return zero
}

// ---------------------------------------------------------------- sfnt / TTC

function readSfntTables(bytes, view, base) {
  const numTables = view.getUint16(base + 4)
  const tables = {}
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16
    if (rec + 16 > bytes.length) throw new ParseError('Truncated table directory.')
    const tag = tagToString(view.getUint32(rec))
    const offset = view.getUint32(rec + 8)
    const length = view.getUint32(rec + 12)
    if (offset + length > bytes.length) throw new ParseError(`Table ${tag} exceeds file size.`)
    tables[tag] = bytes.subarray(offset, offset + length)
  }
  return tables
}

// --------------------------------------------------------------------- WOFF

async function readWoffTables(bytes, view) {
  const numTables = view.getUint16(12)
  const tables = {}
  for (let i = 0; i < numTables; i++) {
    const rec = 44 + i * 20
    const tag = tagToString(view.getUint32(rec))
    const offset = view.getUint32(rec + 4)
    const compLength = view.getUint32(rec + 8)
    const origLength = view.getUint32(rec + 12)
    const comp = bytes.subarray(offset, offset + compLength)
    tables[tag] = compLength < origLength ? await inflate(comp) : comp
  }
  return tables
}

async function inflate(bytes) {
  // WOFF table data is zlib-compressed (RFC 1950), which is what the
  // standard 'deflate' DecompressionStream format means.
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// -------------------------------------------------------------------- WOFF2

function readWoff2Tables(bytes, view) {
  const numTables = view.getUint16(12)
  const totalCompressedSize = view.getUint32(20)

  // Table directory: variable-length entries starting at byte 48.
  let pos = 48
  const entries = []
  for (let i = 0; i < numTables; i++) {
    const flags = bytes[pos++]
    let tag
    if ((flags & 0x3f) === 63) {
      tag = tagToString(view.getUint32(pos))
      pos += 4
    } else {
      tag = WOFF2_KNOWN_TAGS[flags & 0x3f]
    }
    const transformVersion = (flags >> 6) & 3
    const [origLength, p1] = readUIntBase128(bytes, pos)
    pos = p1
    // glyf and loca use transform version 3 for "null transform"; every
    // other table uses version 0. A transformed table stores its length
    // in an extra transformLength field.
    const isTransformed = (tag === 'glyf' || tag === 'loca')
      ? transformVersion !== 3
      : transformVersion !== 0
    let streamLength = origLength
    if (isTransformed) {
      const [transformLength, p2] = readUIntBase128(bytes, pos)
      pos = p2
      streamLength = transformLength
    }
    entries.push({ tag, streamLength, isTransformed })
  }

  const compressed = bytes.subarray(pos, pos + totalCompressedSize)
  const decompressed = decompressBrotli(compressed)
  if (!decompressed) throw new ParseError('WOFF2 brotli decompression failed.')

  // The decompressed stream is all tables concatenated in directory order,
  // without padding.
  const tables = {}
  const transformed = []
  let offset = 0
  for (const { tag, streamLength, isTransformed } of entries) {
    tables[tag] = decompressed.subarray(offset, offset + streamLength)
    if (isTransformed) transformed.push(tag)
    offset += streamLength
  }
  return { tables, transformed }
}

function readUIntBase128(bytes, pos) {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const byte = bytes[pos++]
    if (i === 0 && byte === 0x80) throw new ParseError('Invalid UIntBase128 (leading zero).')
    if (value & 0xfe000000) throw new ParseError('UIntBase128 overflow.')
    value = (value << 7) | (byte & 0x7f)
    if ((byte & 0x80) === 0) return [value >>> 0, pos]
  }
  throw new ParseError('UIntBase128 exceeds 5 bytes.')
}

// -------------------------------------------------------------------- cmap

function parseCmap(table) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const numSubtables = view.getUint16(2)
  const unicodeSubtables = []
  const otherSubtables = []
  for (let i = 0; i < numSubtables; i++) {
    const rec = 4 + i * 8
    const platformID = view.getUint16(rec)
    const encodingID = view.getUint16(rec + 2)
    const offset = view.getUint32(rec + 4)
    const isUnicode = platformID === 0
      || (platformID === 3 && (encodingID === 1 || encodingID === 10))
    ;(isUnicode ? unicodeSubtables : otherSubtables).push(offset)
  }

  const codepoints = new Set()
  const encodedGids = new Set()
  // Union of all Unicode subtables; fall back to whatever exists (e.g.
  // symbol-encoded fonts) if there are none.
  const chosen = unicodeSubtables.length ? unicodeSubtables : otherSubtables
  for (const offset of chosen) parseCmapSubtable(view, offset, codepoints, encodedGids)
  // Which glyphs count as "reachable by a codepoint" is a broader question
  // than which codepoints the font claims: a legacy Mac subtable or a
  // variation sequence reaches glyphs too.
  for (const offset of otherSubtables) {
    if (!chosen.includes(offset)) parseCmapSubtable(view, offset, null, encodedGids)
  }
  return { codepoints, encodedGids }
}

// Collects codepoints into `out` (may be null) and the glyph ids they reach
// into `gids` (may be null).
function parseCmapSubtable(view, off, out, gids) {
  const format = view.getUint16(off)
  const add = (cp, gid) => {
    out?.add(cp)
    gids?.add(gid)
  }
  if (format === 0) {
    for (let c = 0; c < 256; c++) {
      const gid = view.getUint8(off + 6 + c)
      if (gid !== 0) add(c, gid)
    }
  } else if (format === 4) {
    const segCount = view.getUint16(off + 6) / 2
    const endCodes = off + 14
    const startCodes = endCodes + segCount * 2 + 2
    const idDeltas = startCodes + segCount * 2
    const idRangeOffsets = idDeltas + segCount * 2
    for (let seg = 0; seg < segCount; seg++) {
      const end = view.getUint16(endCodes + seg * 2)
      const start = view.getUint16(startCodes + seg * 2)
      const idDelta = view.getInt16(idDeltas + seg * 2)
      const idRangeOffset = view.getUint16(idRangeOffsets + seg * 2)
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let glyph
        if (idRangeOffset === 0) {
          glyph = (c + idDelta) & 0xffff
        } else {
          const addr = idRangeOffsets + seg * 2 + idRangeOffset + (c - start) * 2
          if (addr + 2 > view.byteLength) continue
          glyph = view.getUint16(addr)
          if (glyph !== 0) glyph = (glyph + idDelta) & 0xffff
        }
        if (glyph !== 0) add(c, glyph)
      }
    }
  } else if (format === 6) {
    const first = view.getUint16(off + 6)
    const count = view.getUint16(off + 8)
    for (let i = 0; i < count; i++) {
      const gid = view.getUint16(off + 10 + i * 2)
      if (gid !== 0) add(first + i, gid)
    }
  } else if (format === 14) {
    // Variation sequences: the glyphs listed for non-default sequences are
    // reachable, but only through a selector, so they add no codepoints.
    const numRecords = view.getUint32(6)
    for (let i = 0; i < numRecords; i++) {
      const rec = off + 10 + i * 11
      const nonDefault = view.getUint32(rec + 7)
      if (nonDefault === 0) continue
      const numMappings = view.getUint32(off + nonDefault)
      for (let m = 0; m < numMappings; m++) {
        gids?.add(view.getUint16(off + nonDefault + 4 + m * 5 + 3))
      }
    }
  } else if (format === 12 || format === 13) {
    const nGroups = view.getUint32(off + 12)
    for (let g = 0; g < nGroups; g++) {
      const rec = off + 16 + g * 12
      const start = view.getUint32(rec)
      const end = view.getUint32(rec + 4)
      const startGlyph = view.getUint32(rec + 8)
      if (end - start > 0x10ffff) throw new ParseError('Malformed cmap group.')
      for (let c = start; c <= end; c++) {
        const glyph = format === 12 ? startGlyph + (c - start) : startGlyph
        if (glyph !== 0) add(c, glyph)
      }
    }
  }
  // Formats 2, 8 and 10 are skipped: they are practically extinct.
}

// -------------------------------------------------------------------- name

const NAME_IDS = { 1: 'family', 2: 'subfamily', 5: 'version', 16: 'family', 17: 'subfamily' }

function parseName(table) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const count = view.getUint16(2)
  const stringsBase = view.getUint16(4)
  // score: prefer typographic IDs (16/17) and Windows/Unicode platforms.
  const best = {}
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12
    const platformID = view.getUint16(rec)
    const encodingID = view.getUint16(rec + 2)
    const languageID = view.getUint16(rec + 4)
    const nameID = view.getUint16(rec + 6)
    const length = view.getUint16(rec + 8)
    const offset = view.getUint16(rec + 10)
    const key = NAME_IDS[nameID]
    if (!key) continue
    let score = 0
    if (nameID === 16 || nameID === 17) score += 8
    if (platformID === 3 && encodingID === 1) score += 4
    if (platformID === 0) score += 3
    if (platformID === 1 && encodingID === 0) score += 1
    if (platformID === 3 && languageID === 0x409) score += 1
    if (score === 0) continue
    if (best[key] && best[key].score >= score) continue
    const start = stringsBase + offset
    if (start + length > view.byteLength) continue
    const utf16 = platformID === 0 || platformID === 3
    best[key] = { score, value: decodeNameString(table, start, length, utf16) }
  }
  const result = {}
  for (const [key, { value }] of Object.entries(best)) result[key] = value
  return result
}

function decodeNameString(table, start, length, utf16) {
  const bytes = table.subarray(start, start + length)
  if (!utf16) return String.fromCharCode(...bytes) // Mac Roman ≈ Latin-1 for ASCII
  let s = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
  }
  return s
}

function tagToString(tag) {
  return String.fromCharCode((tag >> 24) & 0xff, (tag >> 16) & 0xff, (tag >> 8) & 0xff, tag & 0xff)
}
