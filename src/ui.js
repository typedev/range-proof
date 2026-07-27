// DOM rendering for the coverage report. No framework: the report is built
// as one HTML string per section and wired up with event delegation.

import { categoryOf } from './coverage.js'
import { loadCharNames, charName } from './charnames.js'
import { gidToCodepoint } from './font/rebuild.js'

let currentReport = null
let currentFamily = 'font'
let gidRendered = false

const esc = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const hex = (cp) => cp.toString(16).toUpperCase().padStart(4, '0')

const INVISIBLE_CATS = new Set(['Zs', 'Zl', 'Zp', 'Cf'])
const COMBINING_CATS = new Set(['Mn', 'Mc', 'Me'])

// ------------------------------------------------------------- empty state

const SPECIMEN = ['R', 'a', 'n', 'g', 'e', 'P', 'r', 'o', 'o', 'f']

export function renderSpecimen(el) {
  el.innerHTML = SPECIMEN.map((ch) => `
    <div class="cell sample">
      <span class="g">${ch}</span>
      <span class="cp">${hex(ch.codePointAt(0))}</span>
    </div>`).join('')
}

export function showError(message) {
  const el = document.getElementById('drop-error')
  el.textContent = message
  el.hidden = !message
}

// ------------------------------------------------------------------ report

export function renderReport(main, report, font, rendered) {
  currentReport = report
  currentFamily = font.family || 'font'
  gidRendered = rendered.gid
  main.dataset.filter = ''

  const name = [font.family, font.subfamily].filter(Boolean).join(' ') || 'Unnamed font'
  const pct = Math.round((report.totals.present / report.totals.assigned) * 100)
  const unencoded = report.glyphs.unencoded.length

  main.innerHTML = `
    <div class="fontbar">
      <div class="font-id">
        <span class="font-name proof">${esc(name)}</span>
        <span class="font-meta">${esc(font.format)}
          · ${font.numGlyphs ?? '?'} glyphs${unencoded
            ? ` (${unencoded} unencoded)` : ''}
          · ${report.totals.mapped} mapped codepoints
          · covers ${report.totals.present} of ${report.totals.assigned}
            characters in these blocks (${pct}%)</span>
        ${rendered.font ? '' : `<span class="font-warn">This browser could not
          render the file, so shapes below are shown in a fallback font.
          Coverage data is unaffected.</span>`}
      </div>
      <div class="font-actions">
        <label class="toggle"><input type="checkbox" id="missing-only" />
          missing only</label>
        <button type="button" class="btn" id="dl-all">↓ all missing (.txt)</button>
      </div>
    </div>
    <div class="columns">
      <nav class="rail" aria-label="Blocks">${railHtml(report)}</nav>
      <div class="blocks">
        ${report.groups.map(groupHtml).join('')}
        ${everythingHtml(report)}
      </div>
    </div>`

  wire(main)
}

function railHtml(report) {
  const curated = report.groups.map((group) => `
    <div class="rail-group">${esc(group.name)}</div>
    ${group.blocks.map((b) => {
      const cls = b.presentCount === 0 ? 'empty'
        : b.presentCount === b.assignedCount ? 'complete' : 'partial'
      return `<a class="rail-item ${cls}" href="#b-${hex(b.start)}">
        <span class="rail-name">${esc(b.name)}</span>
        <span class="rail-n">${b.presentCount}/${b.assignedCount}</span></a>`
    }).join('')}`).join('')

  const everything = `
    <div class="rail-group">Everything in the font</div>
    ${report.all.blocks.map((b) => `
      <a class="rail-item" href="#a-${hex(b.start)}">
        <span class="rail-name">${esc(b.name)}</span>
        <span class="rail-n">${b.cps.length}</span></a>`).join('')}
    ${report.glyphs.unencoded.length ? `
      <a class="rail-item" href="#a-unencoded">
        <span class="rail-name">Unencoded glyphs</span>
        <span class="rail-n">${report.glyphs.unencoded.length}</span></a>` : ''}`

  return curated + everything
}

function groupHtml(group) {
  return `<section class="group">
    <h2 class="group-name">${esc(group.name)}</h2>
    ${group.blocks.map(blockHtml).join('')}
  </section>`
}

function blockHtml(b) {
  const missing = b.assignedCount - b.presentCount
  const stats = b.presentCount === b.assignedCount
    ? '<span class="n-complete">complete</span>'
    : `<span class="n-missing">${missing} missing</span>`
  const extras = b.extraCount
    ? `<span class="n-extra">+${b.extraCount} unassigned</span>` : ''

  return `<details class="block" id="b-${hex(b.start)}"
      ${b.presentCount > 0 ? 'open' : ''} data-missing="${missing}">
    <summary class="block-head">
      <span class="block-title">${esc(b.name)}
        <span class="block-range">U+${hex(b.start)}–${hex(b.end)}</span></span>
      ${barcodeSvg(b.name, b.start, b.end, b.cells)}
      <span class="block-stats">
        <span class="n-present">${b.presentCount}/${b.assignedCount}</span>
        ${stats} ${extras}
      </span>
    </summary>
    <div class="block-body">
      <div class="grid">${b.cells.map(cellHtml).join('')}</div>
      ${missing > 0 ? `<div class="block-foot">
        <button type="button" class="btn btn-dl" data-block="${hex(b.start)}">
          ↓ missing list (${missing})</button></div>` : ''}
    </div>
  </details>`
}

function cellHtml(cell) {
  const { cp, name, cat, state } = cell
  const classes = ['cell', state]
  let glyph = String.fromCodePoint(cp)
  if (cat && COMBINING_CATS.has(cat)) glyph = ' ' + glyph
  if (cat && INVISIBLE_CATS.has(cat)) {
    classes.push('inv')
    glyph = ''
  }
  const label = state === 'extra'
    ? `U+${hex(cp)} — mapped by the font, unassigned in Unicode`
    : `U+${hex(cp)}${name ? ` ${name}` : ''}${state === 'missing' ? ' — missing' : ''}`
  return `<div class="${classes.join(' ')}" title="${esc(label)}">
    <span class="g">${esc(glyph)}</span><span class="cp">${hex(cp)}</span></div>`
}

// The block's coverage fingerprint: one 1-unit-wide tick per codepoint,
// merged into runs. Gaps (unassigned, unmapped) show the paper background.
// Fills are set in CSS per state so they follow the active theme.
function barcodeSvg(name, start, end, items) {
  const span = end - start + 1
  const runs = []
  for (const item of items) {
    const x = item.cp - start
    const last = runs[runs.length - 1]
    if (last && last.state === item.state && last.x + last.w === x) last.w += 1
    else runs.push({ x, w: 1, state: item.state })
  }
  const rects = runs.map((r) =>
    `<rect x="${r.x}" y="0" width="${r.w}" height="10" class="${r.state}"/>`,
  ).join('')
  return `<svg class="bar" viewBox="0 0 ${span} 10" preserveAspectRatio="none"
    role="img" aria-label="Coverage map of ${esc(name)}">${rects}</svg>`
}

// ------------------------------------------------- everything in the font

// The font's own inventory rather than a checklist: every mapped codepoint,
// in its real Unicode block, plus the glyphs no codepoint reaches. Grids are
// filled in on demand (see fillLazyBlock) — a CJK font would otherwise build
// tens of thousands of cells nobody asked to see.
function everythingHtml(report) {
  const { all, glyphs } = report
  return `<section class="group everything">
    <h2 class="group-name">Everything in the font</h2>
    <p class="note">Not a checklist — the full contents of the file:
      ${all.count} mapped codepoint${all.count === 1 ? '' : 's'} across
      ${all.blocks.length} Unicode block${all.blocks.length === 1 ? '' : 's'}${
        glyphs.unencoded.length
          ? `, and ${glyphs.unencoded.length} glyphs no codepoint reaches`
          : ''}. Open a block to draw it.</p>
    ${all.blocks.map(allBlockHtml).join('')}
    ${unencodedHtml(glyphs)}
  </section>`
}

function allBlockHtml(b) {
  const items = b.cps.map((cp) => ({ cp, state: categoryOf(cp) ? 'present' : 'extra' }))
  const extras = b.extraCount
    ? `<span class="n-extra">+${b.extraCount} unassigned</span>` : ''

  return `<details class="block" id="a-${hex(b.start)}" data-lazy="all"
      data-start="${hex(b.start)}">
    <summary class="block-head">
      <span class="block-title">${esc(b.name)}
        <span class="block-range">U+${hex(b.start)}–${hex(b.end)}</span></span>
      ${barcodeSvg(b.name, b.start, b.end, items)}
      <span class="block-stats">
        <span class="n-present">${b.cps.length} mapped</span> ${extras}
      </span>
    </summary>
    <div class="block-body"><div class="grid"></div></div>
  </details>`
}

function unencodedHtml(glyphs) {
  const list = glyphs.unencoded
  if (!list.length) return ''
  const warn = gidRendered ? '' : `<p class="note warn">These glyphs cannot be
    drawn here: reaching them needs a rewritten copy of the font, which this
    file's format does not allow (WOFF2 stores its outlines transformed).
    Upload the same font as TTF or OTF to see the shapes.</p>`

  return `<details class="block" id="a-unencoded" data-lazy="gids">
    <summary class="block-head">
      <span class="block-title">Unencoded glyphs
        <span class="block-range">reached by no codepoint</span></span>
      <span class="bar-slot"></span>
      <span class="block-stats"><span class="n-present">${list.length} glyphs</span>
        ${glyphs.named ? '' : '<span class="n-extra">unnamed</span>'}</span>
    </summary>
    <div class="block-body">
      ${warn}
      <div class="grid"></div>
      <div class="block-foot">
        <button type="button" class="btn btn-dl" id="dl-glyphs">
          ↓ glyph list (${list.length})</button>
      </div>
    </div>
  </details>`
}

// Grids are built the first time a block is opened, and kept afterwards.
async function fillLazyBlock(details) {
  const grid = details.querySelector('.grid')
  if (!grid || grid.dataset.filled) return
  grid.dataset.filled = '1'

  if (details.dataset.lazy === 'gids') {
    grid.innerHTML = currentReport.glyphs.unencoded.map(gidCellHtml).join('')
    return
  }

  const block = currentReport.all.blocks.find(
    (b) => hex(b.start) === details.dataset.start)
  if (!block) return
  // Character names for the whole of Unicode are a separate download.
  await loadCharNames().catch(() => null)
  grid.innerHTML = block.cps.map(allCellHtml).join('')
}

function allCellHtml(cp) {
  const cat = categoryOf(cp)
  const name = charName(cp)
  return cellHtml({ cp, name, cat, state: cat ? 'present' : 'extra' })
}

function gidCellHtml({ gid, name, mark }) {
  const label = `glyph ${gid}${name ? ` — ${name}` : ''}${
    mark ? ' (no advance width)' : ''}${
    gidRendered ? '' : ' — cannot be drawn from this file format'}`
  // a mark with no base would render on top of the cell's left edge
  const glyph = gidRendered
    ? (mark ? ' ' : '') + esc(String.fromCodePoint(gidToCodepoint(gid)))
    : ''
  return `<div class="cell gid${mark ? ' mark' : ''}" title="${esc(label)}">
    <span class="g">${glyph}</span>
    <span class="cp">${esc(name || `gid ${gid}`)}</span></div>`
}

// ------------------------------------------------------------ interactions

function wire(main) {
  main.querySelector('#missing-only').addEventListener('change', (e) => {
    main.dataset.filter = e.target.checked ? 'missing' : ''
  })
  main.querySelector('#dl-all').addEventListener('click', downloadAllMissing)
  main.querySelector('.blocks').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-dl')
    if (!btn) return
    if (btn.id === 'dl-glyphs') downloadGlyphList()
    else downloadBlockMissing(btn.dataset.block)
  })
  // 'toggle' does not bubble, so listen in the capture phase.
  main.addEventListener('toggle', (e) => {
    const details = e.target
    if (details.open && details.dataset?.lazy) fillLazyBlock(details)
  }, true)
  main.querySelector('.rail').addEventListener('click', (e) => {
    const link = e.target.closest('.rail-item')
    if (!link) return
    e.preventDefault()
    const block = main.querySelector(link.getAttribute('href'))
    if (!block) return
    // a collapsed block would scroll to nothing but its own header
    const justOpened = !block.open
    block.open = true
    // center short blocks; align tall ones to the top so their header
    // (name, counts, barcode) stays on screen
    const tall = justOpened || block.offsetHeight > window.innerHeight * 0.8
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    block.scrollIntoView({
      block: tall ? 'start' : 'center',
      behavior: reduced ? 'auto' : 'smooth',
    })
    history.replaceState(null, '', link.getAttribute('href'))
  })
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

const missingLines = (b) =>
  b.missing.map((m) => `U+${hex(m.cp)}\t${m.name}`).join('\n')

const spaceList = (missing) => missing.map((m) => `U+${hex(m.cp)}`).join(' ')

function downloadBlockMissing(startHex) {
  for (const group of currentReport.groups) {
    for (const b of group.blocks) {
      if (hex(b.start) === startHex) {
        const text = `${missingLines(b)}\n\n# as a single list\n${spaceList(b.missing)}\n`
        downloadText(`${slug(currentFamily)}-missing-${slug(b.name)}.txt`, text)
        return
      }
    }
  }
}

function downloadAllMissing() {
  const parts = []
  const all = []
  for (const group of currentReport.groups) {
    for (const b of group.blocks) {
      if (b.missing.length === 0) continue
      parts.push(`# ${b.name} (U+${hex(b.start)}–U+${hex(b.end)}): ${b.missing.length} missing`)
      parts.push(missingLines(b), '')
      all.push(...b.missing)
    }
  }
  if (!parts.length) return
  parts.push('# all missing as a single list', spaceList(all), '')
  downloadText(`${slug(currentFamily)}-missing-all.txt`, parts.join('\n'))
}

function downloadGlyphList() {
  const list = currentReport.glyphs.unencoded
  const lines = list.map((g) => `${g.gid}\t${g.name ?? ''}`)
  const text = `# glyphs in ${currentFamily} that no codepoint reaches\n`
    + `# glyph id\tname\n${lines.join('\n')}\n`
  downloadText(`${slug(currentFamily)}-unencoded-glyphs.txt`, text)
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
