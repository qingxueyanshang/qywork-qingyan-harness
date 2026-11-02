"""公式校准：把页面 EMF 中的绘制记录整理为文字、填充路径与折线三类项，写为 JSON，供 math-calibrate.ts 比对。

坐标为记录中的逻辑坐标（WPS 页面 EMF 为缇，世界变换把缇映射为 96 dpi 像素）。只整理公式对照需要的记录：
- 文字（EMR_EXTTEXTOUTW）：当前字体的名称与高度、参考点（基线）、字形编号或字符、逐字前进宽度；
- 填充路径（BEGINPATH 至 FILLPATH）：命令与点，三次曲线按原样保留；
- 折线（EMR_POLYPOLYLINE）：端点与当前画笔的宽度、样式。

用法：python math_emf.py <EMF 文件>... ；每个文件旁写出同名的 .items.json。
"""

import json
import struct
import sys
from pathlib import Path

EXTTEXTOUTW, EXTCREATEFONTINDIRECTW, SELECTOBJECT, DELETEOBJECT = 84, 82, 37, 40
EXTCREATEPEN, CREATEPEN, CREATEBRUSHINDIRECT = 95, 38, 39
BEGINPATH, ENDPATH, FILLPATH, STROKEPATH, STROKEANDFILLPATH = 59, 60, 62, 64, 63
MOVETOEX, LINETO, POLYBEZIERTO, POLYBEZIERTO16, POLYLINETO16 = 27, 54, 5, 88, 89
POLYPOLYLINE, POLYPOLYLINE16 = 7, 90
ETO_GLYPH_INDEX, ETO_PDY = 0x10, 0x2000
STOCK = 0x80000000


def records(data: bytes):
    off = 0
    while off + 8 <= len(data):
        kind, size = struct.unpack_from("<II", data, off)
        if size < 8:
            break
        yield kind, data[off:off + size]
        off += size


def items(data: bytes) -> list:
    objects, font, pen = {}, None, None
    path, out = None, []
    for kind, rec in records(data):
        if kind == EXTCREATEFONTINDIRECTW:
            handle = struct.unpack_from("<I", rec, 8)[0]
            height = struct.unpack_from("<i", rec, 12)[0]
            weight = struct.unpack_from("<i", rec, 28)[0]
            italic = rec[32]
            face = rec[40:104].decode("utf-16-le", errors="replace").split("\x00")[0]
            objects[handle] = {"type": "font", "face": face, "height": -height, "weight": weight,
                               "italic": italic}
        elif kind == EXTCREATEPEN:
            handle = struct.unpack_from("<I", rec, 8)[0]
            style, width = struct.unpack_from("<II", rec, 28)
            objects[handle] = {"type": "pen", "style": style, "width": width}
        elif kind == CREATEPEN:
            handle, style, width = struct.unpack_from("<IIi", rec, 8)
            objects[handle] = {"type": "pen", "style": style, "width": width}
        elif kind == CREATEBRUSHINDIRECT:
            handle = struct.unpack_from("<I", rec, 8)[0]
            objects[handle] = {"type": "brush"}
        elif kind == SELECTOBJECT:
            handle = struct.unpack_from("<I", rec, 8)[0]
            obj = objects.get(handle) if handle < STOCK else None
            if obj is not None and obj["type"] == "font":
                font = obj
            elif obj is not None and obj["type"] == "pen":
                pen = obj
        elif kind == EXTTEXTOUTW:
            x, y, n, off_str, opts = struct.unpack_from("<iiIII", rec, 36)
            off_dx = struct.unpack_from("<I", rec, 72)[0]
            raw = rec[off_str:off_str + 2 * n]
            count = n * (2 if opts & ETO_PDY else 1)
            dx = list(struct.unpack_from(f"<{count}i", rec, off_dx)) if off_dx else []
            item = {"kind": "text", "x": x, "y": y, "dx": dx[::2] if opts & ETO_PDY else dx,
                    "face": font["face"] if font else None, "height": font["height"] if font else None,
                    "weight": font["weight"] if font else None, "italic": font["italic"] if font else None}
            if opts & ETO_GLYPH_INDEX:
                item["glyphs"] = list(struct.unpack_from(f"<{n}H", raw))
            else:
                item["text"] = raw.decode("utf-16-le", errors="replace")
            out.append(item)
        elif kind == BEGINPATH:
            path = []
        elif path is not None and kind == MOVETOEX:
            path.append(["M", *struct.unpack_from("<ii", rec, 8)])
        elif path is not None and kind == LINETO:
            path.append(["L", *struct.unpack_from("<ii", rec, 8)])
        elif path is not None and kind in (POLYBEZIERTO, POLYBEZIERTO16, POLYLINETO16):
            count = struct.unpack_from("<I", rec, 24)[0]
            wide = kind == POLYBEZIERTO
            fmt, step = ("<ii", 8) if wide else ("<hh", 4)
            pts = [struct.unpack_from(fmt, rec, 28 + step * i) for i in range(count)]
            if kind == POLYLINETO16:
                path.extend(["L", *p] for p in pts)
            else:
                for i in range(0, count - 2, 3):
                    path.append(["C", *pts[i], *pts[i + 1], *pts[i + 2]])
        elif kind in (FILLPATH, STROKEANDFILLPATH, STROKEPATH):
            if path:
                out.append({"kind": "path", "fill": kind != STROKEPATH, "commands": path})
            path = None
        elif kind in (POLYPOLYLINE, POLYPOLYLINE16):
            npolys, total = struct.unpack_from("<II", rec, 24)
            counts = struct.unpack_from(f"<{npolys}I", rec, 32)
            base = 32 + 4 * npolys
            fmt, step = ("<ii", 8) if kind == POLYPOLYLINE else ("<hh", 4)
            pts = [list(struct.unpack_from(fmt, rec, base + step * i)) for i in range(total)]
            out.append({"kind": "polyline", "counts": list(counts), "points": pts,
                        "width": pen["width"] if pen else None, "style": pen["style"] if pen else None})
    return out


def main():
    for name in sys.argv[1:]:
        p = Path(name)
        p.with_suffix(".items.json").write_text(json.dumps(items(p.read_bytes()), ensure_ascii=False), "utf-8")


if __name__ == "__main__":
    main()
