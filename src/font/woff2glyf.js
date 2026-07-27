// Undoes the WOFF2 table transforms (W3C WOFF2 §5.1–5.4), so a WOFF2 upload
// ends up with the same plain sfnt tables a TTF would give us. That is what
// rebuild.js needs to re-emit the font with a synthetic cmap and draw glyphs
// no codepoint reaches.
//
// WOFF2 stores TrueType outlines as nine parallel streams and drops `loca`
// entirely; `hmtx` may additionally omit the side-bearing arrays because they
// repeat each glyph's xMin.

const HEADER_SIZE = 36 // reserved, optionFlags, numGlyphs, indexFormat + 7 sizes
const OVERLAP_SIMPLE_BITMAP = 0x0001 // optionFlags bit 0

// composite component flags
const ARG_1_AND_2_ARE_WORDS = 0x0001
const WE_HAVE_A_SCALE = 0x0008
const MORE_COMPONENTS = 0x0020
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040
const WE_HAVE_A_TWO_BY_TWO = 0x0080
const WE_HAVE_INSTRUCTIONS = 0x0100

// simple glyph point flags
const ON_CURVE = 0x01
const X_SHORT = 0x02
const Y_SHORT = 0x04
const X_SAME_OR_POSITIVE = 0x10
const Y_SAME_OR_POSITIVE = 0x20
const OVERLAP_SIMPLE = 0x40

class TransformError extends Error {}

// Replaces transformed tables in `tables` with their reconstructed form and
// returns the tags that are still transformed. Reconstruction is best-effort:
// a font we cannot untransform keeps working as a coverage report, it just
// cannot show unencoded glyph shapes.
export function untransform(tables, transformed) {
  if (!transformed.length) return transformed
  const remaining = new Set(transformed)

  try {
    let xMins = null
    if (remaining.has('glyf') || remaining.has('loca')) {
      const result = reconstructGlyf(tables.glyf)
      tables.glyf = result.glyf
      tables.loca = result.loca
      tables.head = withLongLoca(tables.head)
      xMins = result.xMins
      remaining.delete('glyf')
      remaining.delete('loca')
    }
    if (remaining.has('hmtx')) {
      const numGlyphs = readNumGlyphs(tables.maxp)
      tables.hmtx = reconstructHmtx(
        tables.hmtx, tables.hhea, numGlyphs,
        xMins ?? readXMins(tables.glyf, tables.loca, tables.head, numGlyphs),
      )
      remaining.delete('hmtx')
    }
  } catch {
    // Leave whatever is left in `remaining` marked as transformed.
  }

  return [...remaining]
}

// ---------------------------------------------------------------- streams

// A cursor over one of the transformed table's sub-streams.
class Stream {
  constructor(bytes) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.pos = 0
  }

  need(n) {
    if (this.pos + n > this.bytes.length) throw new TransformError('stream overrun')
  }

  u8() {
    this.need(1)
    return this.bytes[this.pos++]
  }

  i16() {
    this.need(2)
    const value = this.view.getInt16(this.pos)
    this.pos += 2
    return value
  }

  u16() {
    this.need(2)
    const value = this.view.getUint16(this.pos)
    this.pos += 2
    return value
  }

  take(n) {
    this.need(n)
    const slice = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return slice
  }

  // 255UInt16: a byte below 253 is the value itself, the rest are escapes.
  // Encoders may pick any valid form, so all three are accepted.
  u255() {
    const code = this.u8()
    if (code === 253) return this.u16()
    if (code === 255) return this.u8() + 253
    if (code === 254) return this.u8() + 506
    return code
  }
}

// ------------------------------------------------------------------- glyf

function reconstructGlyf(data) {
  if (!data || data.length < HEADER_SIZE) throw new TransformError('short glyf')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const optionFlags = view.getUint16(2)
  const numGlyphs = view.getUint16(4)

  const sizes = []
  for (let i = 0; i < 7; i++) sizes.push(view.getUint32(8 + i * 4))

  let pos = HEADER_SIZE
  const streams = sizes.map((size) => {
    if (pos + size > data.length) throw new TransformError('stream past end of glyf')
    const slice = data.subarray(pos, pos + size)
    pos += size
    return new Stream(slice)
  })
  const [nContours, nPoints, flags, glyphs, composites, bboxes, instructions] = streams

  // The bbox bitmap sits at the head of the bbox stream and is padded to a
  // 32-bit boundary — not the same rule as the overlap bitmap below.
  const bboxBitmap = bboxes.take(((numGlyphs + 31) >> 5) << 2)

  let overlapBitmap = null
  if (optionFlags & OVERLAP_SIMPLE_BITMAP) {
    const size = (numGlyphs + 7) >> 3
    if (pos + size > data.length) throw new TransformError('short overlap bitmap')
    overlapBitmap = data.subarray(pos, pos + size)
    pos += size
  }
  if (pos !== data.length) throw new TransformError('trailing bytes in transformed glyf')

  const parts = []
  const xMins = new Int16Array(numGlyphs)
  for (let gid = 0; gid < numGlyphs; gid++) {
    const numberOfContours = nContours.i16()
    const hasBbox = bitSet(bboxBitmap, gid)

    if (numberOfContours === 0) {
      // An empty glyph is just two equal loca offsets; it carries no bbox.
      if (hasBbox) throw new TransformError(`bbox for empty glyph ${gid}`)
      parts.push(new Uint8Array(0))
      continue
    }

    const glyph = numberOfContours < 0
      ? readComposite(composites, glyphs, instructions)
      : readSimple(numberOfContours, nPoints, flags, glyphs, instructions,
        overlapBitmap && bitSet(overlapBitmap, gid))

    if (numberOfContours < 0 && !hasBbox) {
      throw new TransformError(`composite glyph ${gid} has no bbox`)
    }
    const bbox = hasBbox
      ? [bboxes.i16(), bboxes.i16(), bboxes.i16(), bboxes.i16()]
      : boundsOf(glyph.points)

    xMins[gid] = bbox[0]
    parts.push(encodeGlyph(numberOfContours, bbox, glyph))
  }

  return { ...assemble(parts), xMins }
}

function readSimple(numberOfContours, nPoints, flags, glyphs, instructions, overlaps) {
  const endPts = []
  let end = -1
  for (let i = 0; i < numberOfContours; i++) {
    end += nPoints.u255()
    endPts.push(end)
  }
  const count = end + 1
  if (count <= 0) throw new TransformError('simple glyph with no points')

  const points = decodeTriplets(glyphs, flags.take(count), count)
  if (overlaps) points[0].flag |= OVERLAP_SIMPLE

  return { endPts, points, instructions: readInstructions(glyphs, instructions) }
}

function readComposite(composites, glyphs, instructions) {
  const start = composites.pos
  let haveInstructions = false
  for (;;) {
    const flags = composites.u16()
    composites.u16() // glyphIndex — components are copied through verbatim
    composites.take(flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2)
    if (flags & WE_HAVE_A_SCALE) composites.take(2)
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) composites.take(4)
    else if (flags & WE_HAVE_A_TWO_BY_TWO) composites.take(8)
    if (flags & WE_HAVE_INSTRUCTIONS) haveInstructions = true
    if (!(flags & MORE_COMPONENTS)) break
  }

  return {
    components: composites.bytes.subarray(start, composites.pos),
    instructions: haveInstructions ? readInstructions(glyphs, instructions) : null,
  }
}

// The instruction length lives in the glyph stream, the bytecode in its own.
function readInstructions(glyphs, instructions) {
  return instructions.take(glyphs.u255())
}

// Point coordinates are packed as deltas whose width and sign are encoded in
// the flag byte. Ported from the reference implementation in fontTools
// (ttLib/woff2.py, WOFF2GlyfTable._decodeTriplets).
function decodeTriplets(glyphs, flagBytes, count) {
  const sign = (flag, value) => (flag & 1 ? value : -value)
  const points = []
  let x = 0
  let y = 0

  for (let i = 0; i < count; i++) {
    const raw = flagBytes[i]
    const onCurve = !(raw >> 7)
    const flag = raw & 0x7f
    const nBytes = flag < 84 ? 1 : flag < 120 ? 2 : flag < 124 ? 3 : 4
    const b = glyphs.take(nBytes)

    let dx
    let dy
    if (flag < 10) {
      dx = 0
      dy = sign(flag, ((flag & 14) << 7) + b[0])
    } else if (flag < 20) {
      dx = sign(flag, (((flag - 10) & 14) << 7) + b[0])
      dy = 0
    } else if (flag < 84) {
      const b0 = flag - 20
      dx = sign(flag, 1 + (b0 & 0x30) + (b[0] >> 4))
      dy = sign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b[0] & 0x0f))
    } else if (flag < 120) {
      const b0 = flag - 84
      dx = sign(flag, 1 + (Math.floor(b0 / 12) << 8) + b[0])
      dy = sign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + b[1])
    } else if (flag < 124) {
      dx = sign(flag, (b[0] << 4) + (b[1] >> 4))
      dy = sign(flag >> 1, ((b[1] & 0x0f) << 8) + b[2])
    } else {
      dx = sign(flag, (b[0] << 8) + b[1])
      dy = sign(flag >> 1, (b[2] << 8) + b[3])
    }

    x += dx
    y += dy
    points.push({ x, y, flag: onCurve ? ON_CURVE : 0 })
  }

  return points
}

function boundsOf(points) {
  if (!points || !points.length) return [0, 0, 0, 0]
  let xMin = points[0].x
  let yMin = points[0].y
  let xMax = xMin
  let yMax = yMin
  for (const p of points) {
    if (p.x < xMin) xMin = p.x
    if (p.x > xMax) xMax = p.x
    if (p.y < yMin) yMin = p.y
    if (p.y > yMax) yMax = p.y
  }
  return [xMin, yMin, xMax, yMax]
}

// ------------------------------------------------------- glyf re-encoding

function encodeGlyph(numberOfContours, bbox, glyph) {
  const out = new Writer()
  out.i16(numberOfContours)
  for (const v of bbox) out.i16(v)

  if (numberOfContours < 0) {
    out.raw(glyph.components)
    if (glyph.instructions) {
      out.u16(glyph.instructions.length)
      out.raw(glyph.instructions)
    }
    return out.done()
  }

  for (const end of glyph.endPts) out.u16(end)
  out.u16(glyph.instructions.length)
  out.raw(glyph.instructions)

  // Flags are written one per point: the REPEAT form would only shrink a
  // copy that never leaves memory.
  const deltas = []
  let prevX = 0
  let prevY = 0
  for (const p of glyph.points) {
    const dx = p.x - prevX
    const dy = p.y - prevY
    prevX = p.x
    prevY = p.y
    let flag = p.flag
    if (dx === 0) flag |= X_SAME_OR_POSITIVE
    else if (dx >= -255 && dx <= 255) flag |= X_SHORT | (dx > 0 ? X_SAME_OR_POSITIVE : 0)
    if (dy === 0) flag |= Y_SAME_OR_POSITIVE
    else if (dy >= -255 && dy <= 255) flag |= Y_SHORT | (dy > 0 ? Y_SAME_OR_POSITIVE : 0)
    out.u8(flag)
    deltas.push({ dx, dy, flag })
  }
  for (const { dx, flag } of deltas) {
    if (flag & X_SHORT) out.u8(Math.abs(dx))
    else if (!(flag & X_SAME_OR_POSITIVE)) out.i16(dx)
  }
  for (const { dy, flag } of deltas) {
    if (flag & Y_SHORT) out.u8(Math.abs(dy))
    else if (!(flag & Y_SAME_OR_POSITIVE)) out.i16(dy)
  }

  return out.done()
}

class Writer {
  constructor() {
    this.parts = []
    this.length = 0
  }

  raw(bytes) {
    this.parts.push(bytes)
    this.length += bytes.length
  }

  u8(value) {
    this.raw(Uint8Array.of(value & 0xff))
  }

  u16(value) {
    this.raw(Uint8Array.of((value >> 8) & 0xff, value & 0xff))
  }

  i16(value) {
    this.u16(value < 0 ? value + 0x10000 : value)
  }

  done() {
    const out = new Uint8Array(this.length)
    let pos = 0
    for (const part of this.parts) {
      out.set(part, pos)
      pos += part.length
    }
    return out
  }
}

// Concatenates the glyph records and builds a long-format loca. Long offsets
// are used whatever the source font had: without REPEAT-compressed flags a
// re-encoded glyf can outgrow the 128 KB a short loca can address.
function assemble(parts) {
  const offsets = [0]
  let total = 0
  for (const part of parts) {
    total += align4(part.length)
    offsets.push(total)
  }

  const glyf = new Uint8Array(total)
  let pos = 0
  for (const part of parts) {
    glyf.set(part, pos)
    pos += align4(part.length)
  }

  const loca = new Uint8Array(offsets.length * 4)
  const view = new DataView(loca.buffer)
  offsets.forEach((offset, i) => view.setUint32(i * 4, offset))

  return { glyf, loca }
}

const align4 = (n) => (n + 3) & ~3

// head.indexToLocFormat must agree with the loca we just wrote. The table is
// copied first: the original is a view into the decompressed WOFF2 body.
function withLongLoca(head) {
  if (!head || head.length < 52) throw new TransformError('missing head table')
  const copy = new Uint8Array(head)
  new DataView(copy.buffer).setInt16(50, 1)
  return copy
}

// ------------------------------------------------------------------- hmtx

// The transform drops the side bearings that simply repeat each glyph's xMin.
function reconstructHmtx(data, hheaTable, numGlyphs, xMins) {
  if (!data || !data.length) throw new TransformError('missing hmtx')
  if (!hheaTable || hheaTable.length < 36) throw new TransformError('missing hhea')
  if (!xMins) throw new TransformError('no xMin values to rebuild hmtx from')

  const flags = data[0]
  if (flags & 0b11111100) throw new TransformError('reserved hmtx flags set')
  const hasLsb = !(flags & 1)
  const hasSideBearings = !(flags & 2)
  if (hasLsb && hasSideBearings) throw new TransformError('hmtx transform with no omitted array')

  const hhea = new DataView(hheaTable.buffer, hheaTable.byteOffset, hheaTable.byteLength)
  const numberOfHMetrics = hhea.getUint16(34)
  if (numberOfHMetrics === 0 || numberOfHMetrics > numGlyphs) {
    throw new TransformError('bad numberOfHMetrics')
  }

  const stream = new Stream(data.subarray(1))
  const advances = []
  for (let i = 0; i < numberOfHMetrics; i++) advances.push(stream.u16())

  const bearings = []
  for (let i = 0; i < numberOfHMetrics; i++) {
    bearings.push(hasLsb ? stream.i16() : xMins[i])
  }
  for (let gid = numberOfHMetrics; gid < numGlyphs; gid++) {
    bearings.push(hasSideBearings ? stream.i16() : xMins[gid])
  }

  const out = new Writer()
  for (let i = 0; i < numberOfHMetrics; i++) {
    out.u16(advances[i])
    out.i16(bearings[i])
  }
  for (let gid = numberOfHMetrics; gid < numGlyphs; gid++) out.i16(bearings[gid])
  return out.done()
}

// --------------------------------------------------------------- helpers

const bitSet = (bitmap, i) => !!(bitmap[i >> 3] & (0x80 >> (i & 7)))

function readNumGlyphs(maxp) {
  if (!maxp || maxp.length < 6) throw new TransformError('missing maxp')
  return new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4)
}

// xMin per glyph straight from an untransformed glyf, for the rare font that
// transforms hmtx but not the outlines.
function readXMins(glyf, loca, head, numGlyphs) {
  if (!glyf || !loca || !head) throw new TransformError('cannot read xMin values')
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const long = headView.getInt16(50) === 1
  const locaView = new DataView(loca.buffer, loca.byteOffset, loca.byteLength)
  const glyfView = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength)

  const xMins = new Int16Array(numGlyphs)
  for (let gid = 0; gid < numGlyphs; gid++) {
    const start = long ? locaView.getUint32(gid * 4) : locaView.getUint16(gid * 2) * 2
    const end = long ? locaView.getUint32(gid * 4 + 4) : locaView.getUint16(gid * 2 + 2) * 2
    // An empty glyph has no outline, and so a side bearing of zero.
    xMins[gid] = end > start ? glyfView.getInt16(start + 2) : 0
  }
  return xMins
}
