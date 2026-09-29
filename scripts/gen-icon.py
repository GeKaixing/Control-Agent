#!/usr/bin/env python3
"""从 docs/logo.png 生成 macOS 应用图标源图 docs/logo-icon.png。

为什么需要：logo.png 是满幅白底方图，直接打包 icns 在 Dock 里是直角白方块
（macOS 不会自动加圆角蒙版，那是 iOS 的行为）。本脚本按 macOS 图标规范
重排：1024 画布 + 824 圆角 tile 居中（radius 185，Apple 标准比例）+
四角 alpha=0 + 1px 边缘抗锯齿，logo 双线性缩放后内缩 80px 居中。

用法（仓库根执行）：
  python3 scripts/gen-icon.py            # 亮色（白底黑线，默认）
  python3 scripts/gen-icon.py --dark     # 暗色（深灰底白线）

产物被 scripts/ensure-dock-icon.cjs 优先消费（回退 logo.png）。
零第三方依赖：PNG 编解码、filter 解析、缩放全部标准库实现。

logo 改版后重跑本脚本，再跑 npm run desktop:dev（会自动刷新 icns）。
"""

import struct
import sys
import zlib
from math import hypot
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "docs" / "logo.png"
OUT = REPO / "docs" / "logo-icon.png"

# macOS 图标规范：1024 画布，824 tile 居中，圆角半径约 tile 的 22.4%
CANVAS = 1024
TILE = 824
MARGIN = (CANVAS - TILE) // 2
RADIUS = 185
# logo 在 tile 内的留白
LOGO_PAD = 80


def decode_grayscale_png(data: bytes) -> tuple[int, int, bytearray]:
    """解 8-bit 灰度 PNG（含全部 5 种 filter），返回 (w, h, 像素)。"""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"
    w, h = struct.unpack(">II", data[16:24])
    color_type, interlace = data[25], data[28]
    assert color_type == 0 and interlace == 0, f"仅支持 8-bit 灰度非隔行，got ct={color_type}"
    pos, idat = 8, b""
    while pos < len(data):
        ln = struct.unpack(">I", data[pos : pos + 4])[0]
        typ = data[pos + 4 : pos + 8]
        if typ == b"IDAT":
            idat += data[pos + 8 : pos + 8 + ln]
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w + 1
    gray = bytearray(w * h)
    prev = bytearray(w)
    for y in range(h):
        ro = y * stride
        f = raw[ro]
        line = bytearray(raw[ro + 1 : ro + stride])
        if f == 1:  # Sub
            for i in range(1, len(line)):
                line[i] = (line[i] + line[i - 1]) & 0xFF
        elif f == 2:  # Up
            for i in range(len(line)):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:  # Average
            for i in range(len(line)):
                a = line[i - 1] if i >= 1 else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:  # Paeth
            for i in range(len(line)):
                a = line[i - 1] if i >= 1 else 0
                b = prev[i]
                c = prev[i - 1] if i >= 1 else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        gray[y * w : (y + 1) * w] = line
        prev = line
    return w, h, gray


def render(w: int, h: int, gray: bytearray, dark: bool) -> bytes:
    """合成 1024 RGBA：圆角 tile + 双线性缩放的 logo，四角透明。"""
    logo_w = TILE - 2 * LOGO_PAD
    scale = w / logo_w

    def sample(dx: float, dy: float) -> int:
        sx = min(max(dx * scale, 0.0), w - 1.001)
        sy = min(max(dy * scale, 0.0), h - 1.001)
        x0, y0 = int(sx), int(sy)
        fx, fy = sx - x0, sy - y0
        a = gray[y0 * w + x0]
        b = gray[y0 * w + x0 + 1]
        c = gray[(y0 + 1) * w + x0]
        e = gray[(y0 + 1) * w + x0 + 1]
        return int(a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + e * fx * fy)

    out = bytearray(CANVAS * CANVAS * 4)
    for y in range(CANVAS):
        for x in range(CANVAS):
            # 圆角 alpha（带 1px 抗锯齿）
            if MARGIN <= x < MARGIN + TILE and MARGIN <= y < MARGIN + TILE:
                qx = max(MARGIN + RADIUS - x, x - (MARGIN + TILE - 1 - RADIUS), 0)
                qy = max(MARGIN + RADIUS - y, y - (MARGIN + TILE - 1 - RADIUS), 0)
                if qx == 0 and qy == 0:
                    alpha = 255.0
                else:
                    d = RADIUS - hypot(qx, qy)
                    alpha = min(max(d + 0.5, 0.0), 1.0) * 255.0
            else:
                alpha = 0.0
            if alpha <= 0:
                continue
            v = sample(x - MARGIN - LOGO_PAD, y - MARGIN - LOGO_PAD)
            if dark:
                v = 255 - v  # 深灰底白线：反转明度
            i = (y * CANVAS + x) * 4
            out[i] = v
            out[i + 1] = v
            out[i + 2] = v
            out[i + 3] = int(alpha)
    return bytes(out)


def encode_rgba_png(w: int, h: int, px: bytes) -> bytes:
    raw = b"".join(b"\x00" + px[y * w * 4 : (y + 1) * w * 4] for y in range(h))

    def chunk(typ: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    dark = "--dark" in sys.argv
    sw, sh, gray = decode_grayscale_png(SRC.read_bytes())
    OUT.write_bytes(encode_rgba_png(CANVAS, CANVAS, render(sw, sh, gray, dark)))
    print(f"[gen-icon] docs/logo-icon.png 已生成（{'暗色' if dark else '亮色'}，{CANVAS}x{CANVAS}）")


if __name__ == "__main__":
    main()
