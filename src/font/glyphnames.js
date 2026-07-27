// Glyph names, so unencoded glyphs can be identified by something better
// than their glyph id. TrueType keeps them in `post`, CFF in its charset.

import { MAC_GLYPH_NAMES, CFF_STANDARD_STRINGS } from './stdnames.js'

// Returns an array of numGlyphs names, or null if the font carries none
// (post format 3.0, CFF2, CID-keyed fonts without a usable charset).
export function readGlyphNames(tables, numGlyphs) {
  try {
    if (tables.post) {
      const names = parsePost(tables.post, numGlyphs)
      if (names) return names
    }
    if (tables['CFF ']) return parseCffCharset(tables['CFF '], numGlyphs)
  } catch {
    // Malformed name data is never worth failing the whole report over.
  }
  return null
}

function parsePost(table, numGlyphs) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
  if (view.getUint32(0) !== 0x00020000) return null // only format 2.0 has names

  const count = Math.min(view.getUint16(32), numGlyphs)
  const indices = []
  for (let i = 0; i < count; i++) indices.push(view.getUint16(34 + i * 2))

  // Pascal strings follow the index array, in order of first use.
  const custom = []
  let pos = 34 + count * 2
  while (pos < table.length) {
    const len = table[pos]
    custom.push(latin1(table, pos + 1, len))
    pos += 1 + len
  }

  return Array.from({ length: numGlyphs }, (_, gid) => {
    const idx = indices[gid]
    if (idx === undefined) return null
    return idx < 258 ? MAC_GLYPH_NAMES[idx] : custom[idx - 258] ?? null
  })
}

// ---------------------------------------------------------------------- CFF

function parseCffCharset(table, numGlyphs) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const hdrSize = view.getUint8(2)

  const nameIndex = readIndex(table, view, hdrSize)
  const topDictIndex = readIndex(table, view, nameIndex.end)
  const stringIndex = readIndex(table, view, topDictIndex.end)
  if (!topDictIndex.items.length) return null

  const top = parseDict(table, topDictIndex.items[0])
  const isCid = top.has('12 30') // ROS: charset holds CIDs, not name ids
  const charsetOffset = top.get('15')?.[0] ?? 0

  const sids = readCharset(view, charsetOffset, numGlyphs)
  if (!sids) return null

  const string = (sid) => sid < 391
    ? CFF_STANDARD_STRINGS[sid]
    : latin1Range(table, stringIndex.items[sid - 391])

  return sids.map((sid, gid) => {
    if (gid === 0) return '.notdef'
    if (sid === undefined) return null
    return isCid ? `cid${sid}` : string(sid) ?? null
  })
}

// Predefined charset 0 (ISOAdobe) means "sid == gid"; 1 and 2 are the Expert
// charsets, rare enough that falling back to glyph ids is fine.
function readCharset(view, offset, numGlyphs) {
  if (offset === 0) return Array.from({ length: numGlyphs }, (_, gid) => gid)
  if (offset === 1 || offset === 2) return null

  const format = view.getUint8(offset)
  const sids = [0]
  if (format === 0) {
    for (let gid = 1; gid < numGlyphs; gid++) {
      sids.push(view.getUint16(offset + 1 + (gid - 1) * 2))
    }
  } else if (format === 1 || format === 2) {
    const nLeftSize = format === 1 ? 1 : 2
    let pos = offset + 1
    while (sids.length < numGlyphs) {
      const first = view.getUint16(pos)
      const nLeft = format === 1 ? view.getUint8(pos + 2) : view.getUint16(pos + 2)
      pos += 2 + nLeftSize
      for (let i = 0; i <= nLeft && sids.length < numGlyphs; i++) sids.push(first + i)
    }
  } else {
    return null
  }
  return sids
}

// CFF INDEX: a count, then offsets into a shared data block.
function readIndex(bytes, view, pos) {
  const count = view.getUint16(pos)
  if (count === 0) return { items: [], end: pos + 2 }
  const offSize = view.getUint8(pos + 2)
  const offsets = []
  let p = pos + 3
  for (let i = 0; i <= count; i++) {
    let value = 0
    for (let b = 0; b < offSize; b++) value = value * 256 + bytes[p++]
    offsets.push(value)
  }
  const dataStart = p - 1 // offsets are 1-based into the data block
  const items = []
  for (let i = 0; i < count; i++) {
    items.push([dataStart + offsets[i], dataStart + offsets[i + 1]])
  }
  return { items, end: dataStart + offsets[count] }
}

// A CFF DICT is a flat operand/operator stream. Keys are the operator number
// as a string ('15' = charset, '12 30' = ROS).
function parseDict(bytes, [start, end]) {
  const dict = new Map()
  let operands = []
  let pos = start
  while (pos < end) {
    const b0 = bytes[pos]
    if (b0 <= 21) {
      const key = b0 === 12 ? `12 ${bytes[pos + 1]}` : String(b0)
      pos += b0 === 12 ? 2 : 1
      dict.set(key, operands)
      operands = []
    } else if (b0 === 28) {
      operands.push((bytes[pos + 1] << 8 | bytes[pos + 2]) << 16 >> 16)
      pos += 3
    } else if (b0 === 29) {
      operands.push(
        bytes[pos + 1] << 24 | bytes[pos + 2] << 16 | bytes[pos + 3] << 8 | bytes[pos + 4])
      pos += 5
    } else if (b0 === 30) {
      // real number: packed nibbles terminated by 0xf. Never a charset offset,
      // so the value itself does not matter — just skip it.
      pos += 1
      while (pos < end && (bytes[pos] & 0x0f) !== 0x0f && (bytes[pos] >> 4) !== 0x0f) pos++
      pos++
      operands.push(0)
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139)
      pos += 1
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + bytes[pos + 1] + 108)
      pos += 2
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - bytes[pos + 1] - 108)
      pos += 2
    } else {
      break // reserved byte: the dict is not what we think it is
    }
  }
  return dict
}

const latin1 = (bytes, start, length) =>
  String.fromCharCode(...bytes.subarray(start, start + length))

const latin1Range = (bytes, range) =>
  range ? latin1(bytes, range[0], range[1] - range[0]) : null
