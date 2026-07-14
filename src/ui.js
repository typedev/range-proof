// DOM rendering for the coverage report. No framework: the report is built
// as one HTML string per section and wired up with event delegation.

let currentReport = null
let currentFamily = 'font'

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

export function renderReport(main, report, font, fontRendered) {
  currentReport = report
  currentFamily = font.family || 'font'
  main.dataset.filter = ''

  const name = [font.family, font.subfamily].filter(Boolean).join(' ') || 'Unnamed font'
  const pct = Math.round((report.totals.present / report.totals.assigned) * 100)

  main.innerHTML = `
    <div class="fontbar">
      <div class="font-id">
        <span class="font-name proof">${esc(name)}</span>
        <span class="font-meta">${esc(font.format)}
          · ${font.numGlyphs ?? '?'} glyphs
          · ${report.totals.mapped} mapped codepoints
          · covers ${report.totals.present} of ${report.totals.assigned}
            characters in these blocks (${pct}%)</span>
        ${fontRendered ? '' : `<span class="font-warn">This browser could not
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
        ${outsideHtml(report.outside)}
      </div>
    </div>`

  wire(main)
}

function railHtml(report) {
  return report.groups.map((group) => `
    <div class="rail-group">${esc(group.name)}</div>
    ${group.blocks.map((b) => {
      const cls = b.presentCount === 0 ? 'empty'
        : b.presentCount === b.assignedCount ? 'complete' : 'partial'
      return `<a class="rail-item ${cls}" href="#b-${hex(b.start)}">
        <span class="rail-name">${esc(b.name)}</span>
        <span class="rail-n">${b.presentCount}/${b.assignedCount}</span></a>`
    }).join('')}`).join('')
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
      ${barcodeSvg(b)}
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
    : `U+${hex(cp)} ${name}${state === 'missing' ? ' — missing' : ''}`
  return `<div class="${classes.join(' ')}" title="${esc(label)}">
    <span class="g">${esc(glyph)}</span><span class="cp">${hex(cp)}</span></div>`
}

// The block's coverage fingerprint: one 1-unit-wide tick per codepoint,
// merged into runs. Gaps (unassigned, unmapped) show the paper background.
// Fills are set in CSS per state so they follow the active theme.
function barcodeSvg(b) {
  const span = b.end - b.start + 1
  const runs = []
  for (const cell of b.cells) {
    const x = cell.cp - b.start
    const last = runs[runs.length - 1]
    if (last && last.state === cell.state && last.x + last.w === x) last.w += 1
    else runs.push({ x, w: 1, state: cell.state })
  }
  const rects = runs.map((r) =>
    `<rect x="${r.x}" y="0" width="${r.w}" height="10" class="${r.state}"/>`,
  ).join('')
  return `<svg class="bar" viewBox="0 0 ${span} 10" preserveAspectRatio="none"
    role="img" aria-label="Coverage map of ${esc(b.name)}">${rects}</svg>`
}

function outsideHtml(outside) {
  if (!outside.length) return ''
  return `<section class="group outside">
    <h2 class="group-name">Elsewhere in the font</h2>
    <p class="note">Mapped codepoints outside the blocks above.</p>
    <ul class="chips">${outside.map((o) =>
      `<li>${esc(o.name)} <b>×${o.count}</b></li>`).join('')}
    </ul>
  </section>`
}

// ------------------------------------------------------------ interactions

function wire(main) {
  main.querySelector('#missing-only').addEventListener('change', (e) => {
    main.dataset.filter = e.target.checked ? 'missing' : ''
  })
  main.querySelector('#dl-all').addEventListener('click', downloadAllMissing)
  main.querySelector('.blocks').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-dl')
    if (btn) downloadBlockMissing(btn.dataset.block)
  })
  main.querySelector('.rail').addEventListener('click', (e) => {
    const link = e.target.closest('.rail-item')
    if (!link) return
    e.preventDefault()
    const block = main.querySelector(link.getAttribute('href'))
    if (!block) return
    // center short blocks; align tall ones to the top so their header
    // (name, counts, barcode) stays on screen
    const tall = block.offsetHeight > window.innerHeight * 0.8
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

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
