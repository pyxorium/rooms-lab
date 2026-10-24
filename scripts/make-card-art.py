"""Draws the card pictures of the Rooms lab's tiles (icon.png 256x256, banner.png 1280x720) in Raku's
palette:
  house   a room (a rounded frame) with three people in it and the house's copper diamond above them
  poll    the live poll: three result bars, one ticked, and the live dot
Needs Python with Pillow. The pictures are kept in the folders: run this again only when a look changes (then
publish that tile again). Fonts: DejaVu (Linux) else the default font, so draw them where DejaVu exists.

Usage: python3 scripts/make-card-art.py [house] [poll]     (no names: both)
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tiles', 'house')
POLL_OUT = os.path.join(ROOT, 'tiles', 'poll')
BG, PANEL, LINE, TEXT, MUTED, GLAZE, WARN = '#171411', '#26211d', '#52463b', '#efe6d8', '#b9ad9c', '#3fb8a8', '#e6b36a'
# The house's diamond: a brighter copper, after Raku's copper glaze (#8a4a2a, its Treeline mark), chosen by the
# owner Oct 24 from a comparison sheet (it stays visible at 40 px, where #8a4a2a fades into the dark).
COPPER = '#b8673a'


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
    # the house: a small diamond on the frame's top edge, in copper
    cx, cy, k = x + w / 2, y + s * 0.18, s * 0.11
    d.polygon([(cx, cy - k), (cx + k, cy), (cx, cy + k), (cx - k, cy)], fill=COPPER, outline=BG)


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
    # General on purpose (owner, Oct 24): it stays true as the house learns new kinds of request; the record's
    # description carries the detail. No page address (the tile shows up in Raku and the galleries).
    lines = ['Decides what each request in', 'the room may do. The person', 'sharing always decides.']
    for i, t in enumerate(lines):
        d.text((586, 420 + i * 44), t, font=font(30), fill=MUTED)
    im.save(os.path.join(OUT, 'banner.png'))


def bars(d, x, y, s):
    """The poll's glyph in a box s wide at (x, y): three result bars (the middle one ticked) and the live dot."""
    h = s * 0.17
    gap = s * 0.1
    widths = [0.55, 0.9, 0.38]
    top = y + s * 0.2
    for i, w in enumerate(widths):
        by = top + i * (h + gap)
        d.rounded_rectangle([x, by, x + s, by + h], radius=h * 0.35, outline=LINE, width=max(2, int(s * 0.012)), fill=PANEL)
        d.rounded_rectangle([x, by, x + s * w, by + h], radius=h * 0.35, fill=GLAZE if i == 1 else MUTED)
    # the tick on the chosen answer
    by = top + (h + gap)
    cx, cy, k = x + s * 0.12, by + h / 2, h * 0.28
    d.line([(cx - k, cy), (cx - k * 0.2, cy + k * 0.8), (cx + k * 1.2, cy - k * 0.9)], fill=BG, width=max(3, int(s * 0.03)), joint='curve')
    # the live dot, top right
    r = s * 0.055
    d.ellipse([x + s - 2 * r, y, x + s, y + 2 * r], fill=GLAZE)


def poll_icon():
    im = Image.new('RGB', (256, 256), BG)
    d = ImageDraw.Draw(im)
    bars(d, 36, 36, 184)
    im.save(os.path.join(POLL_OUT, 'icon.png'))


def poll_banner():
    im = Image.new('RGB', (1280, 720), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([40, 40, 1240, 680], radius=28, fill=PANEL, outline=LINE, width=2)
    bars(d, 120, 170, 380)
    d.text((580, 230), 'Live poll', font=font(84, True), fill=TEXT)
    d.text((584, 340), 'everyone votes together', font=font(44), fill=GLAZE)
    lines = ['Ask a question; the results', 'update as the votes come in.']
    for i, t in enumerate(lines):
        d.text((586, 420 + i * 44), t, font=font(30), fill=MUTED)
    im.save(os.path.join(POLL_OUT, 'banner.png'))


if __name__ == '__main__':
    import sys
    which = sys.argv[1:] or ['house', 'poll']
    if 'house' in which:
        icon()
        banner()
        print('Wrote tiles/house/icon.png and tiles/house/banner.png')
    if 'poll' in which:
        poll_icon()
        poll_banner()
        print('Wrote tiles/poll/icon.png and tiles/poll/banner.png')
