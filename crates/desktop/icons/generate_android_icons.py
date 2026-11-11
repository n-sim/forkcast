"""Generate the Android launcher icons from crates/desktop/icons/icon.png.

Usage (from the repository root, needs Pillow):

    python3 crates/desktop/icons/generate_android_icons.py

Writes mipmap-*/ic_launcher.png, ic_launcher_round.png and the adaptive-icon
ic_launcher_foreground.png into crates/desktop/gen/android/app/src/main/res/.
The adaptive icon's background colour lives in values/ic_launcher_background.xml.
"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[3]
src = Image.open(root / "crates/desktop/icons/icon.png").convert("RGBA")
assert src.size == (512, 512)
res = root / "crates/desktop/gen/android/app/src/main/res"

BG = (164, 66, 40)      # #A44228, tile colour
FG = (250, 248, 243)    # #FAF8F3, glyph colour
SQUARE = 454            # visible tile extent in source px (29..483)

# Extract the "f." glyph as cream with alpha (unmix from the tile colour).
glyph = Image.new("RGBA", src.size, (0, 0, 0, 0))
d = [FG[i] - BG[i] for i in range(3)]
dd = sum(x * x for x in d)
sp, gp = src.load(), glyph.load()
for y in range(110, 410):
    for x in range(130, 380):
        r, g, b, a = sp[x, y]
        assert a == 255
        t = sum((c - BG[i]) * d[i] for i, c in enumerate((r, g, b))) / dd
        t = max(0.0, min(1.0, t))
        gp[x, y] = FG + (round(t * 255),)
# Edges of the extraction window must be pure tile colour.
assert glyph.crop((130, 110, 380, 111)).getextrema()[3][1] == 0

# Adaptive foreground: 108dp canvas, the source tile maps to the 72dp visible area.
canvas_px = round(108 * SQUARE / 72)
off = (canvas_px - 512) // 2
fg_canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
fg_canvas.paste(glyph, (off, off))

# Round legacy icon: tile-coloured circle with the glyph, same extent as the square tile.
ss = 4
circle = Image.new("RGBA", (512 * ss, 512 * ss), (0, 0, 0, 0))
c0 = (512 - SQUARE) // 2 * ss
ImageDraw.Draw(circle).ellipse((c0, c0, 512 * ss - c0 - 1, 512 * ss - c0 - 1), fill=BG + (255,))
circle = circle.resize((512, 512), Image.LANCZOS)
round_icon = Image.alpha_composite(circle, glyph)

densities = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for name, scale in densities.items():
    out = res / f"mipmap-{name}"
    out.mkdir(parents=True, exist_ok=True)
    launcher = round(48 * scale)
    src.resize((launcher, launcher), Image.LANCZOS).save(out / "ic_launcher.png", optimize=True)
    round_icon.resize((launcher, launcher), Image.LANCZOS).save(out / "ic_launcher_round.png", optimize=True)
    fg = round(108 * scale)
    fg_canvas.resize((fg, fg), Image.LANCZOS).save(out / "ic_launcher_foreground.png", optimize=True)
print("ok", canvas_px, off)
