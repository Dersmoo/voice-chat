"""
Generates icon.ico (256x256 multi-res) and tray.ico (16x16, 32x32)
for the Voice Chat app.

Uses only Python stdlib — no Pillow or other deps needed.
Design: orange microphone on a dark background.
"""

import struct
import zlib
import math
import os

# ── Colour palette ────────────────────────────────────────────────────────────
BG      = (17,  17,  17,  255)   # #111111
ACCENT  = (249, 115, 22,  255)   # #f97316  orange
WHITE   = (255, 255, 255, 255)
TRANSP  = (0,   0,   0,   0)

# ── Pixel canvas helpers ──────────────────────────────────────────────────────

def new_image(w, h, fill=TRANSP):
    """Return a flat list of (R,G,B,A) tuples, row-major top-down."""
    return [fill] * (w * h)

def set_pixel(img, w, x, y, color):
    if 0 <= x < w and 0 <= y < len(img) // w:
        img[y * w + x] = color

def fill_rect(img, W, x, y, rw, rh, color):
    for dy in range(rh):
        for dx in range(rw):
            set_pixel(img, W, x + dx, y + dy, color)

def fill_circle(img, W, cx, cy, r, color, aa=True):
    """Filled circle with optional 1-pixel anti-aliased edge."""
    for dy in range(-r - 1, r + 2):
        for dx in range(-r - 1, r + 2):
            dist = math.sqrt(dx * dx + dy * dy)
            if dist <= r - 0.5:
                set_pixel(img, W, cx + dx, cy + dy, color)
            elif aa and dist <= r + 0.5:
                # blend alpha for edge pixel
                alpha_f = (r + 0.5 - dist)
                a = int(color[3] * alpha_f)
                set_pixel(img, W, cx + dx, cy + dy, (color[0], color[1], color[2], a))

def fill_rounded_rect(img, W, x, y, rw, rh, r, color):
    """Rectangle with rounded corners."""
    fill_rect(img, W, x + r, y,     rw - 2*r, rh,     color)
    fill_rect(img, W, x,     y + r, rw,       rh - 2*r, color)
    fill_circle(img, W, x + r,          y + r,          r, color)
    fill_circle(img, W, x + rw - r - 1, y + r,          r, color)
    fill_circle(img, W, x + r,          y + rh - r - 1, r, color)
    fill_circle(img, W, x + rw - r - 1, y + rh - r - 1, r, color)

def draw_ring(img, W, cx, cy, r_outer, r_inner, color):
    """Hollow ring (annulus)."""
    for dy in range(-r_outer - 1, r_outer + 2):
        for dx in range(-r_outer - 1, r_outer + 2):
            dist = math.sqrt(dx * dx + dy * dy)
            if r_inner <= dist <= r_outer:
                set_pixel(img, W, cx + dx, cy + dy, color)

def draw_arc(img, W, cx, cy, r_outer, r_inner, angle_start, angle_end, color, steps=300):
    """Filled arc segment."""
    for i in range(steps + 1):
        t = angle_start + (angle_end - angle_start) * i / steps
        for r in range(r_inner, r_outer + 1):
            x = int(round(cx + r * math.cos(t)))
            y = int(round(cy + r * math.sin(t)))
            set_pixel(img, W, x, y, color)

# ── Microphone icon drawing ───────────────────────────────────────────────────

def draw_mic_icon(size):
    """
    Draws a microphone icon at `size`×`size` pixels.
    Scales all measurements proportionally.
    """
    s   = size
    img = new_image(s, s, BG)

    # Background circle
    fill_circle(img, s, s//2, s//2, s//2 - 1, BG, aa=False)

    if s >= 32:
        # ── Mic body (rounded rectangle) ──────────────────────────────────────
        bw = max(2, s // 7)        # body width (half)
        bh = max(4, s * 5 // 16)   # body height
        br = max(1, bw - 1)        # corner radius
        bx = s // 2 - bw
        by = s // 5
        fill_rounded_rect(img, s, bx, by, bw * 2, bh, br, ACCENT)

        # ── Arc (the horseshoe) ───────────────────────────────────────────────
        arc_cy    = by + bh - 1
        arc_r_out = max(3, s * 9 // 32)
        arc_r_in  = max(2, arc_r_out - max(2, s // 20))
        draw_arc(img, s, s // 2, arc_cy,
                 arc_r_out, arc_r_in,
                 math.pi, 2 * math.pi, ACCENT, steps=400)

        # ── Stand (vertical line) ─────────────────────────────────────────────
        stem_w  = max(1, s // 24)
        stem_h  = max(2, s // 10)
        stem_x  = s // 2 - stem_w
        stem_y  = arc_cy + arc_r_out
        fill_rect(img, s, stem_x, stem_y, stem_w * 2, stem_h, ACCENT)

        # ── Base (horizontal bar) ─────────────────────────────────────────────
        base_w  = max(4, s // 4)
        base_h  = max(1, s // 24)
        base_x  = s // 2 - base_w // 2
        base_y  = stem_y + stem_h
        fill_rect(img, s, base_x, base_y, base_w, base_h, ACCENT)

    else:
        # ── Simplified mic for 16px ────────────────────────────────────────────
        # Just a bold filled shape
        fill_rect(img, s,  s//2 - 2, 2,      4, 7, ACCENT)
        fill_rect(img, s,  s//2 - 3, 8,      6, 2, ACCENT)
        fill_rect(img, s,  s//2 - 1, 10,     2, 3, ACCENT)
        fill_rect(img, s,  s//2 - 2, 13,     4, 1, ACCENT)

    return img

# ── PNG encoder (stdlib only) ─────────────────────────────────────────────────

def encode_png(img, w, h):
    def chunk(tag, data):
        c = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", c)

    raw = b""
    for y in range(h):
        raw += b"\x00"   # filter type None
        for x in range(w):
            r, g, b, a = img[y * w + x]
            raw += bytes([r, g, b, a])

    compressed = zlib.compress(raw, 9)

    png  = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2 | (1 << 0), 0, 0, 0))
    # colour type 6 = RGBA
    png  = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">II", w, h) + bytes([8, 6, 0, 0, 0])
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")
    return png

# ── ICO encoder ───────────────────────────────────────────────────────────────

def encode_ico(images):
    """
    images: list of (w, h, png_bytes)
    Builds a multi-resolution ICO file where each frame is stored as a PNG.
    """
    num   = len(images)
    # ICO header: 6 bytes
    # Directory entries: num * 16 bytes
    header_size = 6 + num * 16
    offsets = []
    offset  = header_size
    for _, _, png in images:
        offsets.append(offset)
        offset += len(png)

    data = struct.pack("<HHH", 0, 1, num)   # reserved, type=1 (icon), count
    for i, (w, h, png) in enumerate(images):
        ww = 0 if w == 256 else w
        hh = 0 if h == 256 else h
        data += struct.pack("<BBBBHHII",
            ww, hh,    # width, height (0 = 256)
            0,         # colour count (0 = no palette)
            0,         # reserved
            1,         # colour planes
            32,        # bits per pixel
            len(png),  # size of image data
            offsets[i] # offset of image data
        )

    for _, _, png in images:
        data += png

    return data

# ── Main ──────────────────────────────────────────────────────────────────────

out_dir = os.path.dirname(os.path.abspath(__file__))

# icon.ico — 16, 32, 48, 256
icon_sizes  = [16, 32, 48, 256]
icon_frames = []
for sz in icon_sizes:
    pixels = draw_mic_icon(sz)
    png    = encode_png(pixels, sz, sz)
    icon_frames.append((sz, sz, png))

with open(os.path.join(out_dir, "icon.ico"), "wb") as f:
    f.write(encode_ico(icon_frames))
print("Written icon.ico")

# tray.ico — 16, 32
tray_sizes  = [16, 32]
tray_frames = []
for sz in tray_sizes:
    pixels = draw_mic_icon(sz)
    png    = encode_png(pixels, sz, sz)
    tray_frames.append((sz, sz, png))

with open(os.path.join(out_dir, "tray.ico"), "wb") as f:
    f.write(encode_ico(tray_frames))
print("Written tray.ico")

print("Done.")
