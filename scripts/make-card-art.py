"""Draws the house tile's card pictures (tiles/house/icon.png 256x256, tiles/house/banner.png 1280x720) in
Raku's palette: a room (a rounded frame) with three people in it and the house's key above them. Needs
Python with Pillow. The pictures are kept in the folder: run this again only when the look changes (then
publish the house again).

Usage: python3 scripts/make-card-art.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tiles', 'house')
BG, PANEL, LINE, TEXT, MUTED, GLAZE, WARN = '#171411', '#26211d', '#52463b', '#efe6d8', '#b9ad9c', '#3fb8a8', '#e6b36a'


def font(size, bold=False):
    for name in (['DejaVuSans-Bold.ttf'] if bold else ['DejaVuSans.ttf']):
        for d in ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/dejavu', 'C:/Windows/Fonts']:
            p = os.path.join(d, name)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def room(d, x, y, s):
    """The glyph, in a box s wide at (x, y): a room with three people and the house's diamond above."""
    w = s
    d.rounded_rectangle([x, y + s * 0.18, x + w, y + s], radius=s * 0.12, outline=GLAZE, width=max(3, int(s * 0.045)))
    for i, c in enumerate([MUTED, GLAZE, MUTED]):
        cx = x + w * (0.27 + 0.23 * i)
        cy = y + s * 0.62
        r = s * 0.075
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
        d.rounded_rectangle([cx - r * 1.5, cy + r * 1.3, cx + r * 1.5, cy + r * 3.2], radius=r, fill=c)
    # the house: a small diamond on the frame's top edge, the warm colour
    cx, cy, k = x + w / 2, y + s * 0.18, s * 0.11
    d.polygon([(cx, cy - k), (cx + k, cy), (cx, cy + k), (cx - k, cy)], fill=WARN, outline=BG)


def icon():
    im = Image.new('RGB', (256, 256), BG)
    d = ImageDraw.Draw(im)
    room(d, 40, 34, 176)
    im.save(os.path.join(OUT, 'icon.png'))


def banner():
    im = Image.new('RGB', (1280, 720), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([40, 40, 1240, 680], radius=28, fill=PANEL, outline=LINE, width=2)
    room(d, 120, 170, 380)
    d.text((580, 230), 'Rooms lab', font=font(84, True), fill=TEXT)
    d.text((584, 340), 'house: the rules for a room', font=font(44), fill=GLAZE)
    lines = ['Who may ask to see a screen,', 'who may present. The person', 'sharing always decides.']
    for i, t in enumerate(lines):
        d.text((586, 420 + i * 44), t, font=font(30), fill=MUTED)
    d.text((586, 600), 'thunderbird.cafe/webtiles/rooms-lab/', font=font(26), fill=MUTED)
    im.save(os.path.join(OUT, 'banner.png'))


if __name__ == '__main__':
    icon()
    banner()
    print('Wrote tiles/house/icon.png and tiles/house/banner.png')
