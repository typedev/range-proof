# Range Proof

A proofing sheet for Unicode blocks. Drop a font — OTF, TTF, WOFF or WOFF2 —
and see which popular Unicode blocks it covers, which assigned characters are
still missing, and what the font maps at codepoints Unicode has not assigned
yet (e.g. provisional currency signs).

Everything runs in the browser. The font file never leaves your machine, so
unreleased fonts are safe to proof.

## Features

- **61 curated blocks** (Unicode 17.0.0): the full Latin range (Basic
  through Extended-G, IPA, phonetic extensions), all combining-mark blocks,
  Greek, Cyrillic, Armenian, Hebrew, Arabic, Georgian, Devanagari, Thai,
  Hiragana/Katakana, punctuation, currency, arrows, math, geometric shapes,
  dingbats and more.
- **Glyph grid per block**, rendered with the uploaded font itself (via the
  FontFace API). Missing characters are dimmed and shown in a fallback font.
- **Honest coverage**: "missing" means *assigned in Unicode but absent from
  the font*. Unassigned codepoints inside a block don't count against you —
  but if the font maps one anyway, it is shown with an amber marker.
- **Coverage barcode** per block — a one-tick-per-codepoint fingerprint of
  what's present, missing and unofficial.
- **Missing lists as text** (`U+XXXX<tab>CHARACTER NAME`), per block or for
  the whole font.
- "Elsewhere in the font" summary for mapped codepoints outside the curated
  blocks.

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # static build in dist/ — host anywhere
```

## Architecture

- `src/font/parse.js` — self-contained sfnt/cmap/name parser. WOFF is
  inflated with the browser's `DecompressionStream`; WOFF2 is decompressed
  with the pure-JS `brotli` package and the table directory is reconstructed
  per the W3C spec. cmap formats 0, 4, 6, 12 and 13 are supported; all
  Unicode subtables are unioned.
- `src/coverage.js` — intersects the font's codepoint set with the curated
  block data.
- `src/ui.js`, `src/styles.css` — no-framework rendering.
- `src/data/blocks.json` — generated data: per-block assigned codepoints
  (general categories Cc/Cs/Co excluded), character names and categories,
  plus the full block name table.

### Updating Unicode data

```sh
curl -O https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt
curl -O https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt
python3 tools/build_data.py UnicodeData.txt Blocks.txt
```

To add or remove blocks, edit `CURATED_GROUPS` in `tools/build_data.py` and
regenerate.

### Parser verification

The parser was cross-checked against fontTools: for TTF, CFF-OTF, variable
OTF, WOFF and WOFF2 inputs, the extracted codepoint sets match fontTools'
`cmap` output exactly (see the scripts in the repo history / your own
`fontTools` install if you want to re-run the comparison).
