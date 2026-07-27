import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './styles.css'

import { parseFont } from './font/parse.js'
import { buildGidFont } from './font/rebuild.js'
import { buildReport, unicodeVersion } from './coverage.js'
import { renderSpecimen, renderReport, showError } from './ui.js'

const drop = document.getElementById('drop')
const input = document.getElementById('file-input')
const main = document.getElementById('report')

document.getElementById('ucd-version').textContent = unicodeVersion
renderSpecimen(document.getElementById('drop-specimen'))

// theme: dark by default, manual toggle, persisted (initial value is set
// by the inline script in index.html before first paint)
const themeToggle = document.getElementById('theme-toggle')

function applyThemeLabel() {
  const dark = document.documentElement.dataset.theme !== 'light'
  themeToggle.textContent = dark ? '☀ light' : '☾ dark'
}

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = next
  localStorage.setItem('rangeproof-theme', next)
  applyThemeLabel()
})
applyThemeLabel()

// The whole page is a drop target; the drop zone is just the visual cue.
window.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('over')
})
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) drop.classList.remove('over')
})
window.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  const file = e.dataTransfer.files[0]
  if (file) handleFile(file)
})

drop.addEventListener('click', () => input.click())
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    input.click()
  }
})
input.addEventListener('change', () => {
  if (input.files[0]) handleFile(input.files[0])
  input.value = ''
})

const activeFaces = new Map() // family -> FontFace

async function handleFile(file) {
  showError('')
  drop.classList.add('busy')
  try {
    const buffer = await file.arrayBuffer()
    const font = await parseFont(buffer)
    const fontRendered = await installFontFace(buffer, 'ProofFont')
    const report = buildReport(font)
    // A copy of the font with one private-use codepoint per glyph id, so the
    // unencoded glyphs can be drawn too — only worth building when there are
    // any.
    const gidFont = report.glyphs.unencoded.length ? buildGidFont(font) : null
    const gidRendered = gidFont ? await installFontFace(gidFont, 'ProofGid') : false
    renderReport(main, report, font, { font: fontRendered, gid: gidRendered })
    main.hidden = false
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    main.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' })
  } catch (err) {
    console.error(err)
    showError(`${file.name}: ${err.message}`)
  } finally {
    drop.classList.remove('busy')
  }
}

// Registers a font binary under a CSS family name so grid cells render with
// the font itself. Returns false if the browser cannot use it (coverage still
// works from the parsed cmap).
async function installFontFace(buffer, family) {
  const previous = activeFaces.get(family)
  if (previous) {
    document.fonts.delete(previous)
    activeFaces.delete(family)
  }
  try {
    const face = new FontFace(family, buffer)
    await face.load()
    document.fonts.add(face)
    activeFaces.set(family, face)
    return true
  } catch {
    return false
  }
}
