#!/usr/bin/env python3
"""生成扩展图标（16/32/48/128）。

图标设计：蓝色渐变圆角方块 + 白色对话气泡 + 三点。
仅依赖 Pillow，属于可选的开发辅助脚本；仓库中已包含生成好的 PNG，
因此正常构建流程**不需要**执行它。

用法：
    python scripts/gen_icons.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

# 品牌色（与 Popup / 悬浮面板保持一致）
COLOR_TOP = (91, 140, 255)
COLOR_BOTTOM = (47, 107, 255)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "icons")
SIZES = (16, 32, 48, 128)

# 以 1024 为基准绘制，再等比缩放，保证小尺寸也有不错的抗锯齿效果
BASE = 1024


def vertical_gradient(size: int) -> Image.Image:
    """生成竖直渐变底图。"""
    gradient = Image.new("RGB", (1, size))
    for y in range(size):
        ratio = y / max(1, size - 1)
        gradient.putpixel(
            (0, y),
            (
                round(COLOR_TOP[0] + (COLOR_BOTTOM[0] - COLOR_TOP[0]) * ratio),
                round(COLOR_TOP[1] + (COLOR_BOTTOM[1] - COLOR_TOP[1]) * ratio),
                round(COLOR_TOP[2] + (COLOR_BOTTOM[2] - COLOR_TOP[2]) * ratio),
            ),
        )
    return gradient.resize((size, size))


def render_master() -> Image.Image:
    """绘制 1024x1024 主图。"""
    size = BASE
    image = vertical_gradient(size).convert("RGBA")

    # 圆角遮罩
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.23), fill=255)
    image.putalpha(mask)

    draw = ImageDraw.Draw(image)

    # 白色对话气泡
    bx0, by0 = int(size * 0.20), int(size * 0.24)
    bx1, by1 = int(size * 0.80), int(size * 0.66)
    draw.rounded_rectangle((bx0, by0, bx1, by1), radius=int(size * 0.11), fill=(255, 255, 255, 255))

    # 气泡尾巴
    draw.polygon(
        [
            (int(size * 0.32), int(size * 0.62)),
            (int(size * 0.30), int(size * 0.80)),
            (int(size * 0.45), int(size * 0.64)),
        ],
        fill=(255, 255, 255, 255),
    )

    # 三个点
    dot_r = int(size * 0.045)
    dot_y = int(size * 0.45)
    for ratio in (0.34, 0.50, 0.66):
        cx = int(size * ratio)
        draw.ellipse((cx - dot_r, dot_y - dot_r, cx + dot_r, dot_y + dot_r), fill=COLOR_BOTTOM + (255,))

    return image


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    master = render_master()
    for size in SIZES:
        target = master.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        target.save(path, format="PNG", optimize=True)
        print(f"已生成 {os.path.relpath(path, ROOT)}")


if __name__ == "__main__":
    main()
