"""Rebuild the aha icon crisply from the 219px source, then emit every app icon size.

Usage: python3 build/icon-source/gen-icons.py build/icon-source/ahastudio_icon.png <out-dir>
then copy icon.icns / icon.ico / icon.png to build/ and icon-96.png to public/. Needs Pillow + macOS iconutil.
"""
import os, subprocess, sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
S = 4096
BLACK, BLUE = (16, 16, 15), (12, 117, 253)

src = Image.open(SRC).convert('RGB').resize((S, S), Image.BICUBIC)
r, g, b = src.split()
smooth = lambda m: m.filter(ImageFilter.GaussianBlur(10)).point(lambda v: 255 if v >= 128 else 0)
blue = smooth(ImageChops.subtract(b, r).point(lambda v: 255 if v > 120 else 0))
dark = smooth(ImageChops.subtract(src.convert('L').point(lambda v: 255 if v < 130 else 0), blue.filter(ImageFilter.MaxFilter(9))))

# Background: the source's soft top-to-bottom grey (253 -> 244).
bg = Image.new('RGB', (S, S))
d = ImageDraw.Draw(bg)
for y in range(S):
    v = round(253 - 9 * y / (S - 1))
    d.line([(0, y), (S, y)], fill=(v, v, v))
art = bg.copy()
art.paste(Image.new('RGB', (S, S), BLACK), mask=dark)
art.paste(Image.new('RGB', (S, S), BLUE), mask=blue)

def squircle(size, n=5.0):
    """Superellipse mask, close to the macOS app-icon corner curve."""
    big = size * 4
    m = Image.new('L', (big, big), 0)
    pts, half = [], big / 2
    import math
    for i in range(720):
        t = 2 * math.pi * i / 720
        c, s_ = math.cos(t), math.sin(t)
        x = half + half * (abs(c) ** (2 / n)) * (1 if c >= 0 else -1)
        y = half + half * (abs(s_) ** (2 / n)) * (1 if s_ >= 0 else -1)
        pts.append((x, y))
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)

def tile(size):
    """Full-bleed rounded tile with a hairline edge so it reads on white."""
    a = art.resize((size, size), Image.LANCZOS).convert('RGBA')
    mask = squircle(size)
    edge = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(3 if size >= 64 else 1) if size >= 64 else mask)) if size >= 64 else None
    if edge is not None:
        a = Image.alpha_composite(a, Image.merge('RGBA', [Image.new('L', (size, size), 0)] * 3 + [edge.point(lambda v: v * 22 // 255)]))
    a.putalpha(mask)
    return a

def mac(size):
    """Apple template: 824/1024 tile centred with a soft drop shadow."""
    inner = round(size * 824 / 1024)
    t = tile(inner)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    off = (size - inner) // 2
    sh = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sh.paste(Image.new('RGBA', (inner, inner), (0, 0, 0, 77)), (off, off + round(size * 10 / 1024)), t.getchannel('A'))
    canvas = Image.alpha_composite(canvas, sh.filter(ImageFilter.GaussianBlur(size * 10 / 1024)))
    canvas.alpha_composite(t, (off, off))
    return canvas

master = tile(1024)
master.save(f'{OUT}/icon.png')                       # Linux + deb
tile(96).save(f'{OUT}/icon-96.png')                  # in-app logo (public/)
master.save(f'{OUT}/icon.ico', sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
iconset = f'{OUT}/icon.iconset'
os.makedirs(iconset, exist_ok=True)
for base in (16, 32, 128, 256, 512):
    mac(base).save(f'{iconset}/icon_{base}x{base}.png')
    mac(base * 2).save(f'{iconset}/icon_{base}x{base}@2x.png')
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', f'{OUT}/icon.icns'], check=True)
mac(1024).save(f'{OUT}/preview-mac.png')
print('ok')
