#!/usr/bin/env python3
"""Generate the Done! app icons: Fraunces wordmark on a dark rounded square,
same styling as the Spend Less / Invest More icon set (single word + bang)."""
import os

from PIL import Image, ImageDraw, ImageFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

BASE = os.path.dirname(os.path.abspath(__file__))
FONT_PATH = os.path.join(BASE, 'icon-fonts', 'Fraunces-600.ttf')
OUTPUT_DIR = os.path.join(BASE, 'public', 'icons')

CANVAS = 512
CORNER_RADIUS = 128
BACKGROUND = '#12110F'
WORD = 'Done!'
WORD_SIZE = 170
WORD_COLOR = '#f5efe6'
OUTPUTS = [
    ('favicon.svg', None),
    ('icon-192.png', 192),
    ('icon-512.png', 512),
    ('apple-touch-icon.png', 180),
    ('favicon-32.png', 32),
]

font = TTFont(FONT_PATH)
cmap = font.getBestCmap()
glyf = font.getGlyphSet()
hmtx = font['hmtx']
upem = font['head'].unitsPerEm


def word_ink_bbox(text, size):
    units = size / upem
    rec = RecordingPen()
    x = 0
    for ch in text:
        name = cmap[ord(ch)]
        tp = TransformPen(rec, (1, 0, 0, 1, x, 0))
        glyf[name].draw(tp)
        x += hmtx[name][0]
    bp = BoundsPen(glyf)
    rec.replay(bp)
    return tuple(v * units for v in bp.bounds)


def word_svg_paths(text, size):
    units = size / upem
    x = 0
    parts = []
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyf)
        glyf[name].draw(pen)
        parts.append(
            f'<g transform="translate({x:.3f} 0)"><path d="{pen.getCommands()}"/></g>'
        )
        x += hmtx[name][0]
    return f'<g transform="scale({units:.6f}, {-units:.6f})">' + ''.join(parts) + '</g>'


def layout():
    box = word_ink_bbox(WORD, WORD_SIZE)
    # Center the ink box on the canvas (matches the two-row layout math:
    # ty is the baseline offset that centers ink vertically).
    tx = CANVAS / 2 - (box[0] + box[2]) / 2
    ty = CANVAS / 2 + (box[1] + box[3]) / 2
    return (tx, ty)


def build_svg(pos):
    tx, ty = pos
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{CANVAS}" height="{CANVAS}" '
        f'viewBox="0 0 {CANVAS} {CANVAS}">'
        f'<rect width="{CANVAS}" height="{CANVAS}" rx="{CORNER_RADIUS}" fill="{BACKGROUND}"/>'
        f'<g transform="translate({tx:.3f} {ty:.3f})"><g fill="{WORD_COLOR}">'
        + word_svg_paths(WORD, WORD_SIZE)
        + '</g></g></svg>'
    )


def build_master_png(pos):
    tx, ty = pos
    img = Image.new('RGB', (CANVAS, CANVAS), BACKGROUND)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, CANVAS - 1, CANVAS - 1),
                        radius=CORNER_RADIUS, fill=BACKGROUND)
    f = ImageFont.truetype(FONT_PATH, WORD_SIZE)
    bb = d.textbbox((0, 0), WORD, font=f, anchor='ls')
    d.text((CANVAS / 2 - (bb[0] + bb[2]) / 2, ty),
           WORD, font=f, fill=WORD_COLOR, anchor='ls')
    return img


def build_maskable(master):
    # Maskable safe zone: artwork at 80% centered on the background.
    img = Image.new('RGB', (CANVAS, CANVAS), BACKGROUND)
    small = master.resize((int(CANVAS * 0.8), int(CANVAS * 0.8)), Image.LANCZOS)
    img.paste(small, ((CANVAS - small.width) // 2, (CANVAS - small.height) // 2))
    return img


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    pos = layout()
    svg = build_svg(pos)
    master = build_master_png(pos)
    maskable = build_maskable(master)
    for name, size in OUTPUTS:
        out = os.path.join(OUTPUT_DIR, name)
        if size is None:
            with open(out, 'w') as fh:
                fh.write(svg)
            print(f'Generated {name}')
        else:
            master.resize((size, size), Image.LANCZOS).save(out)
            print(f'Generated {name} ({size}x{size})')
    maskable.save(os.path.join(OUTPUT_DIR, 'maskable-512.png'))
    print('Generated maskable-512.png (512x512)')


if __name__ == '__main__':
    main()
