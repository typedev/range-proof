import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './styles.css'

import { parseFont } from './font/parse.js'
import { buildReport, unicodeVersion } from './coverage.js'
import { renderSpecimen, renderReport, showError } from './ui.js'

const drop = document.getElementById('drop')
const input = document.getElementById('file-input')
const main = document.getElementById('report')

document.getElementById('ucd-version').textContent = unicodeVersion
renderSpecimen(document.getElementById('drop-specimen'))

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

let activeFontFace = null

async function handleFile(file) {
  showError('')
  drop.classList.add('busy')
  try {
    const buffer = await file.arrayBuffer()
    const font = await parseFont(buffer)
    const fontRendered = await installFontFace(buffer)
    renderReport(main, buildReport(font.codepoints), font, fontRendered)
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

// Registers the uploaded font as "ProofFont" so grid cells render with the
// font itself. Returns false if the browser cannot use the file (coverage
// still works from the parsed cmap).
async function installFontFace(buffer) {
  if (activeFontFace) {
    document.fonts.delete(activeFontFace)
    activeFontFace = null
  }
  try {
    const face = new FontFace('ProofFont', buffer)
    await face.load()
    document.fonts.add(face)
    activeFontFace = face
    return true
  } catch {
    return false
  }
}
