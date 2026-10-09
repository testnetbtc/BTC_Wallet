#!/usr/bin/env python3
# Draws the Olesia site icons (the mark from web/olesia-icon.png, redrawn at 1024 px so every size
# is crisp): near-black rounded square, white O, orange dot.  Run from packages/bitcoin:
#   python3 mainnet/icons/make.py
# build.mjs copies the results into publish/ (favicon.ico, icon-*.png, apple-touch-icon.png).
from PIL import Image, ImageDraw
import os
HERE = os.path.dirname(os.path.abspath(__file__))

def master(n, radius_frac=0.22):
    im = Image.new('RGBA', (n, n), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * radius_frac), fill=(14, 17, 20, 255))
    cx, cy = n * 0.47, n * 0.5; R = n * 0.27; w = n * 0.085                      # the O
    d.ellipse([cx - R, cy - R * 1.12, cx + R, cy + R * 1.12], fill=(233, 236, 239, 255))
    d.ellipse([cx - R + w, cy - R * 1.12 + w * 1.05, cx + R - w, cy + R * 1.12 - w * 1.05], fill=(14, 17, 20, 255))
    r = n * 0.075; dx, dy = n * 0.79, n * 0.68                                    # the dot
    d.ellipse([dx - r, dy - r, dx + r, dy + r], fill=(242, 153, 27, 255))
    return im

m = master(1024)
m.save(f'{HERE}/icon-1024.png')
for n in (512, 192, 180, 32, 16):
    m.resize((n, n), Image.LANCZOS).save(f'{HERE}/icon-{n}.png')
m.resize((48, 48), Image.LANCZOS).save(f'{HERE}/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
# maskable (Android adaptive icons crop a circle): the mark on a full-bleed square with safe padding
mk = Image.new('RGBA', (512, 512), (14, 17, 20, 255)); inner = master(400, 0); mk.paste(inner, (56, 56), inner)
mk.save(f'{HERE}/icon-512-maskable.png')
print('icons written to', HERE)
