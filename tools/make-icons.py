"""
生成扩展图标（纯标准库，无第三方依赖）。
用有符号距离场(SDF)绘制圆角方块 + 对话气泡，边缘自带抗锯齿。

用法: python tools/make-icons.py
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

BG_FROM = (76, 111, 255)    # #4C6FFF
BG_TO = (123, 92, 255)      # #7B5CFF
DOT = (43, 58, 143)         # #2B3A8F


def clamp01(v):
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


def lerp(a, b, t):
    return a + (b - a) * t


def sd_round_rect(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ax = max(qx, 0.0)
    ay = max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - r


def sd_circle(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r


def coverage(sd, size):
    """距离场 -> 像素覆盖率（做 ~1px 的抗锯齿）"""
    return clamp01(0.5 - sd * size)


def over(dst, src, alpha):
    """src over dst，输入输出都是 (r,g,b,a)，a 为 0..1"""
    sr, sg, sb = src
    sa = alpha
    dr, dg, db, da = dst
    oa = sa + da * (1 - sa)
    if oa <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    orr = (sr * sa + dr * da * (1 - sa)) / oa
    og = (sg * sa + dg * da * (1 - sa)) / oa
    ob = (sb * sa + db * da * (1 - sa)) / oa
    return (orr, og, ob, oa)


def render(size):
    gap = 1.0 / size
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            u = (x + 0.5) / size
            v = (y + 0.5) / size

            px = (0.0, 0.0, 0.0, 0.0)

            # 1) 圆角方块背景 + 对角渐变
            d_bg = sd_round_rect(u, v, 0.5, 0.5, 0.5, 0.5, 0.225)
            c_bg = coverage(d_bg, size)
            if c_bg > 0:
                t = clamp01((u + v) * 0.5)
                col = (lerp(BG_FROM[0], BG_TO[0], t),
                       lerp(BG_FROM[1], BG_TO[1], t),
                       lerp(BG_FROM[2], BG_TO[2], t))
                px = over(px, col, c_bg)

            # 2) 白色对话气泡（圆角矩形 + 左下角小圆当尾巴）
            d_bubble = sd_round_rect(u, v, 0.5, 0.435, 0.255, 0.152, 0.078)
            d_tail = sd_circle(u, v, 0.355, 0.615, 0.062)
            d_shape = min(d_bubble, d_tail)
            c_bubble = coverage(d_shape, size)
            if c_bubble > 0:
                px = over(px, (255.0, 255.0, 255.0), c_bubble)

            # 3) 三个点（小尺寸时合并成一个横条，避免糊成一团）
            if size >= 32:
                dot_r = 0.030
                for dx in (-0.108, 0.0, 0.108):
                    d = sd_circle(u, v, 0.5 + dx, 0.435, dot_r)
                    c = coverage(d, size)
                    if c > 0:
                        px = over(px, DOT, c)
            else:
                d = sd_round_rect(u, v, 0.5, 0.435, 0.10, 0.028, 0.028)
                c = coverage(d, size)
                if c > 0:
                    px = over(px, DOT, c)

            r, g, b, a = px
            row += bytes((
                int(round(clamp01(r / 255) * 255)),
                int(round(clamp01(g / 255) * 255)),
                int(round(clamp01(b / 255) * 255)),
                int(round(clamp01(a) * 255)),
            ))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)
    compressed = zlib.compress(raw, 9)

    def chunk(typ, data):
        out = struct.pack(">I", len(data)) + typ + data
        out += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        return out

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", compressed)
           + chunk(b"IEND", b""))
    with open(path, "wb") as fp:
        fp.write(png)
    return len(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        rows = render(size)
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        n = write_png(path, size, rows)
        print("wrote %s (%d bytes, %dx%d RGBA)" % (path, n, size, size))


if __name__ == "__main__":
    main()
