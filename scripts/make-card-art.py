"""Draws the card pictures of the Rooms lab's tiles (icon.png 256x256, banner.png 1280x720) in Raku's
palette:
  house   a room (a rounded frame) with three people in it and the house's copper diamond above them
  poll    the live poll: three result bars, one ticked, and the live dot
  pong    Live Pong: the station Pong's court in green phosphor (two glowing paddles, the ball, the dashed net,
          scanlines), with "Live Pong / play together in a Raku room" on the banner (rooms-pong-plan.md, P22, V2)
Needs Python with Pillow. The pictures are kept in the folders: run this again only when a look changes (then
publish that tile again). Fonts: DejaVu (Linux) else the default font, so draw them where DejaVu exists.

Usage: python3 scripts/make-card-art.py [house] [poll] [pong]     (no names: all three)
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tiles', 'house')
POLL_OUT = os.path.join(ROOT, 'tiles', 'poll')
PONG_OUT = os.path.join(ROOT, 'tiles', 'pong')
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


# Live Pong: the tile's own look (green phosphor on black, a glow, scanlines), in Courier New's shapes
# (Liberation Mono has Courier New's metrics; Courier New itself on Windows).
PHOSPHOR, BALL, NET = (77, 255, 136), (234, 255, 234), (255, 255, 255)


def mono(size, bold=False):
    names = ['LiberationMono-Bold.ttf', 'courbd.ttf', 'DejaVuSansMono-Bold.ttf'] if bold else ['LiberationMono-Regular.ttf', 'cour.ttf', 'DejaVuSansMono.ttf']
    for name in names:
        for d in ['/usr/share/fonts/truetype/liberation', '/usr/share/fonts/liberation', '/usr/share/fonts/truetype/dejavu', 'C:/Windows/Fonts']:
            q = os.path.join(d, name)
            if os.path.exists(q):
                return ImageFont.truetype(q, size)
    return ImageFont.load_default()


def court(w, h, scale, text=None, bold=1.0):
    """The court (800 x 500 in the tile's units) drawn w x h at `scale` pixels a unit, glowing; with `text`
    (title, line), the two lines over its top; `bold` thickens the paddles and the ball (for the small icon)."""
    from PIL import ImageChops
    ox, oy = (w - 800 * scale) / 2, (h - 500 * scale) / 2
    X = lambda u: ox + u * scale
    Y = lambda u: oy + u * scale
    t, r = 6 * bold, 8 * bold
    sharp = Image.new('RGB', (w, h), (0, 0, 0))
    d = ImageDraw.Draw(sharp)
    band = (h * 0.08, h * 0.42) if text else (0, 0)         # no net behind the words
    u = 0.0
    while u < 500:                                          # the net, dashed
        y0, y1 = Y(u), Y(min(500, u + 10))
        if not (band[0] < y0 < band[1] or band[0] < y1 < band[1]):
            d.line([(X(400), y0), (X(400), y1)], fill=(80, 80, 80), width=max(2, int(3 * scale * bold)))
        u += 24
    d.rectangle([X(24 - t), Y(170), X(24 + t), Y(250)], fill=PHOSPHOR)       # the left paddle
    d.rectangle([X(776 - t), Y(300), X(776 + t), Y(380)], fill=PHOSPHOR)     # the right paddle
    bx, by = X(560), Y(345)
    d.ellipse([bx - r * scale, by - r * scale, bx + r * scale, by + r * scale], fill=BALL)   # the ball on its way
    if text:
        title, line = text
        tf, lf = mono(int(h * 0.17), True), mono(int(h * 0.065))
        for txt, f, top, col in [(title, tf, h * 0.11, BALL), (line, lf, h * 0.11 + h * 0.21, PHOSPHOR)]:
            tw = d.textlength(txt, font=f)
            d.text(((w - tw) / 2, top), txt, font=f, fill=col)
    # the glow: the bright parts blurred, under the sharp picture
    halo = sharp.filter(ImageFilter.GaussianBlur(max(2, w / 110)))
    im = ImageChops.lighter(sharp, halo.point(lambda v: min(255, int(v * 1.3))))
    # scanlines (every third row a little darker) and a vignette, as the tile's CRT effects
    rows = Image.new('L', (w, h), 255)
    rd = ImageDraw.Draw(rows)
    step = 3 if w > 400 else 2
    for yy in range(step - 1, h, step):
        rd.line([(0, yy), (w, yy)], fill=200 if w > 400 else 225)
    im = ImageChops.multiply(im, Image.merge('RGB', [rows] * 3))
    vig = Image.new('L', (w, h), 0)
    vd = ImageDraw.Draw(vig)
    for i in range(40):
        k = i / 40
        vd.ellipse([-w * 0.25 + w * 0.25 * k, -h * 0.25 + h * 0.25 * k, w * 1.25 - w * 0.25 * k, h * 1.25 - h * 0.25 * k], fill=int(255 * k ** 0.5))
    vig = vig.filter(ImageFilter.GaussianBlur(w / 20)).point(lambda v: int(120 + v * 135 / 255))
    return Image.composite(im, Image.new('RGB', (w, h), (0, 0, 0)), vig)


def pong_icon():
    court(256, 256, 0.3, bold=2.4).save(os.path.join(PONG_OUT, 'icon.png'))


def pong_banner():
    court(1280, 720, 1.44, ('Live Pong', 'play together in a Raku room')).save(os.path.join(PONG_OUT, 'banner.png'))


if __name__ == '__main__':
    import sys
    which = sys.argv[1:] or ['house', 'poll', 'pong']
    if 'house' in which:
        icon()
        banner()
        print('Wrote tiles/house/icon.png and tiles/house/banner.png')
    if 'poll' in which:
        poll_icon()
        poll_banner()
        print('Wrote tiles/poll/icon.png and tiles/poll/banner.png')
    if 'pong' in which:
        pong_icon()
        pong_banner()
        print('Wrote tiles/pong/icon.png and tiles/pong/banner.png')
