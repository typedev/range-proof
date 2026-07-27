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
- **Everything in the font** — the file's own inventory rather than a
  checklist: every mapped codepoint in its real Unicode block (named from the
  full UCD, not just the curated blocks), plus **unencoded glyphs** —
  alternates, ligature targets and mark components that no codepoint reaches.
  Those are drawn by rebuilding the font in memory with a cmap that maps one
  private-use codepoint to every glyph id; glyph names come from `post` or the
  CFF charset, and the list downloads as text. Grids in this section are built
  when you open a block, so a CJK font stays responsive.

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
  Unicode subtables are unioned. Format 14 and legacy subtables are read too,
  but only to tell which glyphs a codepoint can reach.
- `src/font/glyphnames.js` — glyph names from `post` format 2.0 or the CFF
  charset (`src/font/stdnames.js` holds the two standard name tables).
- `src/font/rebuild.js` — re-emits the parsed tables as a plain sfnt whose
  cmap maps U+F0000 + *gid* to every glyph, so unencoded glyphs can be drawn
  as a second `FontFace`. GSUB/GPOS/kern are dropped so the browser's default
  features cannot substitute one glyph for another; DSIG is dropped because
  the edit invalidates it. WOFF2 keeps `glyf`/`loca` in a transformed
  encoding this app does not undo, so those files fall back to a listing
  without shapes.
- `src/coverage.js` — intersects the font's codepoint set with the curated
  block data, and groups everything else by its real Unicode block.
- `src/ui.js`, `src/styles.css` — no-framework rendering.
- `src/data/blocks.json` — generated data: per-block assigned codepoints
  (general categories Cc/Cs/Co excluded), character names and categories,
  the full block name table, and the general category of every assigned
  codepoint, run-length encoded.
- `src/data/names.json` — the character name of every assigned codepoint
  (~1.4 MB, ~270 kB gzipped), imported lazily by `src/charnames.js` the first
  time a block outside the curated set is opened.

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
`cmap` output exactly, glyph names match `getGlyphOrder()` for both the
`post` and CFF paths, and the rebuilt GID font loads in fontTools with valid
checksums and a cmap that maps U+F0000 + *gid* to the right glyph (see the
scripts in the repo history / your own `fontTools` install if you want to
re-run the comparison).
