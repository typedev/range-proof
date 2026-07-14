#!/usr/bin/env python3
"""Generate src/data/blocks.json from Unicode Character Database files.

Usage:
    python3 tools/build_data.py <UnicodeData.txt> <Blocks.txt>

The curated block list below defines which Unicode blocks the app proofs
against. To add a block, append its exact Blocks.txt name to a group.
"""

import json
import re
import sys
from pathlib import Path

# Categories that never count as proofable characters: unassigned, controls,
# surrogates, private use. Format characters (Cf) stay in: fonts routinely
# cover SOFT HYPHEN, ZWJ/ZWNJ etc.
EXCLUDED_CATEGORIES = {"Cc", "Cs", "Co"}

CURATED_GROUPS = [
    ("Latin", [
        "Basic Latin",
        "Latin-1 Supplement",
        "Latin Extended-A",
        "Latin Extended-B",
        "IPA Extensions",
        "Spacing Modifier Letters",
        "Phonetic Extensions",
        "Phonetic Extensions Supplement",
        "Latin Extended Additional",
        "Latin Extended-C",
        "Latin Extended-D",
        "Latin Extended-E",
        "Latin Extended-F",
        "Latin Extended-G",
        "Modifier Tone Letters",
        "Alphabetic Presentation Forms",
    ]),
    ("Combining marks", [
        "Combining Diacritical Marks",
        "Combining Diacritical Marks Extended",
        "Combining Diacritical Marks Supplement",
        "Combining Diacritical Marks for Symbols",
        "Combining Half Marks",
    ]),
    ("Greek", [
        "Greek and Coptic",
        "Greek Extended",
    ]),
    ("Cyrillic", [
        "Cyrillic",
        "Cyrillic Supplement",
        "Cyrillic Extended-A",
        "Cyrillic Extended-B",
        "Cyrillic Extended-C",
        "Cyrillic Extended-D",
    ]),
    ("Other scripts", [
        "Armenian",
        "Hebrew",
        "Arabic",
        "Georgian",
        "Devanagari",
        "Thai",
        "Hiragana",
        "Katakana",
    ]),
    ("Punctuation", [
        "General Punctuation",
        "Supplemental Punctuation",
        "Superscripts and Subscripts",
        "Currency Symbols",
    ]),
    ("Symbols", [
        "Letterlike Symbols",
        "Number Forms",
        "Arrows",
        "Supplemental Arrows-A",
        "Supplemental Arrows-B",
        "Miscellaneous Symbols and Arrows",
        "Mathematical Operators",
        "Supplemental Mathematical Operators",
        "Miscellaneous Mathematical Symbols-A",
        "Miscellaneous Mathematical Symbols-B",
        "Miscellaneous Technical",
        "Control Pictures",
        "Enclosed Alphanumerics",
        "Box Drawing",
        "Block Elements",
        "Geometric Shapes",
        "Geometric Shapes Extended",
        "Miscellaneous Symbols",
        "Dingbats",
        "Ornamental Dingbats",
    ]),
]


def parse_unicode_data(path):
    """Return dict codepoint -> (category, name) for every assigned codepoint."""
    assigned = {}
    range_first = None
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        fields = line.split(";")
        cp = int(fields[0], 16)
        name, cat = fields[1], fields[2]
        if name.endswith(", First>"):
            range_first = (cp, cat, name[1:-8])
            continue
        if name.endswith(", Last>"):
            first_cp, first_cat, range_name = range_first
            assert first_cat == cat
            for c in range(first_cp, cp + 1):
                assigned[c] = (cat, f"{range_name}-{c:04X}")
            range_first = None
            continue
        assigned[cp] = (cat, name)
    return assigned


def parse_blocks(path):
    """Return list of (start, end, name) from Blocks.txt."""
    blocks = []
    pattern = re.compile(r"^([0-9A-F]+)\.\.([0-9A-F]+);\s*(.+)$")
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        m = pattern.match(line.strip())
        if m:
            blocks.append((int(m.group(1), 16), int(m.group(2), 16), m.group(3)))
    return blocks


def to_ranges(codepoints):
    """Compress a sorted list of ints into [[start, end], ...] ranges."""
    ranges = []
    for cp in codepoints:
        if ranges and cp == ranges[-1][1] + 1:
            ranges[-1][1] = cp
        else:
            ranges.append([cp, cp])
    return ranges


def main():
    unicode_data_path, blocks_path = sys.argv[1], sys.argv[2]
    assigned = parse_unicode_data(unicode_data_path)
    all_blocks = parse_blocks(blocks_path)
    by_name = {name: (start, end) for start, end, name in all_blocks}

    version = "unknown"
    first_line = Path(blocks_path).read_text(encoding="utf-8").splitlines()[0]
    m = re.search(r"Blocks-(.+)\.txt", first_line)
    if m:
        version = m.group(1)

    groups = []
    for group_name, block_names in CURATED_GROUPS:
        blocks = []
        for name in block_names:
            if name not in by_name:
                sys.exit(f"error: block {name!r} not found in Blocks.txt")
            start, end = by_name[name]
            cps = [
                cp for cp in range(start, end + 1)
                if cp in assigned and assigned[cp][0] not in EXCLUDED_CATEGORIES
            ]
            blocks.append({
                "name": name,
                "start": start,
                "end": end,
                "assigned": to_ranges(cps),
                "assignedCount": len(cps),
                # Parallel to the ascending expansion of "assigned" ranges.
                "names": [assigned[cp][1] for cp in cps],
                "cats": [assigned[cp][0] for cp in cps],
            })
        groups.append({"name": group_name, "blocks": blocks})

    out = {
        "unicodeVersion": version,
        "groups": groups,
        # Every Unicode block (name + range only) so glyphs outside the curated
        # set can still be attributed to a block by name.
        "allBlocks": [[s, e, n] for s, e, n in all_blocks],
    }

    out_path = Path(__file__).resolve().parent.parent / "src" / "data" / "blocks.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")

    total = sum(b["assignedCount"] for g in groups for b in g["blocks"])
    n_blocks = sum(len(g["blocks"]) for g in groups)
    print(f"Unicode {version}: {n_blocks} curated blocks, {total} assigned codepoints")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
