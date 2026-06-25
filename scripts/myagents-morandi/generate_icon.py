#!/usr/bin/env python3

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path("/Users/hanako/Documents/New project 2/scripts/myagents-morandi")
ICONSET = ROOT / "MyAgentsMorandi.iconset"
ICNS = ROOT / "MyAgents莫兰迪绿补丁.app" / "Contents" / "Resources" / "morandi-patch.icns"


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    mask = rounded_rect_mask(size, int(size * 0.23))

    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg)
    for y in range(size):
      t = y / max(size - 1, 1)
      r = int(214 + (164 - 214) * t)
      g = int(232 + (193 - 232) * t)
      b = int(220 + (178 - 220) * t)
      bg_draw.line((0, y, size, y), fill=(r, g, b, 255))
    bg.putalpha(mask)
    img.alpha_composite(bg)

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    pad = int(size * 0.2)
    shadow_draw.rounded_rectangle(
        (pad, pad + int(size * 0.04), size - pad, size - pad + int(size * 0.04)),
        radius=int(size * 0.16),
        fill=(44, 69, 56, 64),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(2, size // 40)))
    img.alpha_composite(shadow)

    body = (
        int(size * 0.23),
        int(size * 0.24),
        int(size * 0.77),
        int(size * 0.76),
    )
    draw.rounded_rectangle(body, radius=int(size * 0.15), fill=(252, 253, 251, 255))
    draw.rounded_rectangle(body, radius=int(size * 0.15), outline=(118, 145, 128, 255), width=max(2, size // 64))

    eye_y = int(size * 0.47)
    eye_r = max(3, size // 36)
    draw.ellipse((int(size * 0.39) - eye_r, eye_y - eye_r, int(size * 0.39) + eye_r, eye_y + eye_r), fill=(87, 108, 94, 255))
    draw.ellipse((int(size * 0.61) - eye_r, eye_y - eye_r, int(size * 0.61) + eye_r, eye_y + eye_r), fill=(87, 108, 94, 255))

    mouth_box = (int(size * 0.43), int(size * 0.57), int(size * 0.57), int(size * 0.66))
    draw.arc(mouth_box, start=15, end=165, fill=(113, 140, 123, 255), width=max(2, size // 64))

    leaf = [
        (int(size * 0.69), int(size * 0.19)),
        (int(size * 0.83), int(size * 0.11)),
        (int(size * 0.79), int(size * 0.28)),
    ]
    draw.polygon(leaf, fill=(121, 164, 135, 255))
    draw.line((int(size * 0.75), int(size * 0.13), int(size * 0.74), int(size * 0.25)), fill=(233, 245, 237, 220), width=max(1, size // 96))

    dot_r = max(2, size // 42)
    draw.ellipse((int(size * 0.19) - dot_r, int(size * 0.25) - dot_r, int(size * 0.19) + dot_r, int(size * 0.25) + dot_r), fill=(241, 251, 244, 235))
    draw.ellipse((int(size * 0.84) - dot_r, int(size * 0.79) - dot_r, int(size * 0.84) + dot_r, int(size * 0.79) + dot_r), fill=(241, 251, 244, 200))

    return img


def save_iconset() -> None:
    ICONSET.mkdir(parents=True, exist_ok=True)
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    for size in sizes:
        icon = draw_icon(size)
        if size == 16:
            icon.save(ICONSET / "icon_16x16.png")
            draw_icon(32).save(ICONSET / "icon_16x16@2x.png")
        elif size == 32:
            icon.save(ICONSET / "icon_32x32.png")
            draw_icon(64).save(ICONSET / "icon_32x32@2x.png")
        elif size == 128:
            icon.save(ICONSET / "icon_128x128.png")
            draw_icon(256).save(ICONSET / "icon_128x128@2x.png")
        elif size == 256:
            icon.save(ICONSET / "icon_256x256.png")
            draw_icon(512).save(ICONSET / "icon_256x256@2x.png")
        elif size == 512:
            icon.save(ICONSET / "icon_512x512.png")
            draw_icon(1024).save(ICONSET / "icon_512x512@2x.png")


if __name__ == "__main__":
    save_iconset()
    print(ICONSET)
