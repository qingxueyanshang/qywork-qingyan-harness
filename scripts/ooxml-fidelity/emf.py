"""EMF 解析与回放：用 GDI 的 PlayEnhMetaFile 把图片框（rclFrame）映射到整张位图。

输出尺寸只由图片框与 dpi 决定，图片框以外的绘制被位图边界裁去。不要以绘制范围（rclBounds）
作为输出尺寸或目标矩形：绘制超出页面时两者不一致，输出会缩放并带出页面以外的内容。
"""

import ctypes
import struct
from ctypes import wintypes

from PIL import Image

EMF_SIGNATURE = 0x464D4520
HALFTONE = 4
WHITENESS = 0x00FF0062
EMR_EXTCREATEFONTINDIRECTW = 82
# lfQuality 在记录中的偏移：记录头 8 字节与 ihFont 4 字节之后为 LOGFONTW，lfQuality 是其第 26 字节。
LF_QUALITY_OFFSET = 12 + 26


def header(data: bytes) -> dict:
    """ENHMETAHEADER 的尺寸字段。frame 单位为 0.01 mm，bounds 单位为参考设备像素，两者均含右下边界。"""
    if len(data) < 88:
        raise ValueError("EMF 数据过短")
    itype, _size = struct.unpack_from("<II", data, 0)
    bounds = struct.unpack_from("<4i", data, 8)
    frame = struct.unpack_from("<4i", data, 24)
    signature = struct.unpack_from("<I", data, 40)[0]
    if itype != 1 or signature != EMF_SIGNATURE:
        raise ValueError("不是 EMF 数据")
    device = struct.unpack_from("<2i", data, 72)
    millimeters = struct.unpack_from("<2i", data, 80)
    frame_mm = ((frame[2] - frame[0] + 1) / 100, (frame[3] - frame[1] + 1) / 100)
    px_per_mm = (device[0] / millimeters[0], device[1] / millimeters[1])
    bounds_mm = tuple(v / px_per_mm[i % 2] for i, v in enumerate(bounds))
    frame_box_mm = tuple(v / 100 for v in frame)
    return {"bounds": bounds, "frame": frame, "device": device, "millimeters": millimeters,
            "frame_mm": frame_mm, "bounds_mm": bounds_mm, "frame_box_mm": frame_box_mm}


def with_font_quality(data: bytes, quality: int) -> bytes:
    """把每条 EMR_EXTCREATEFONTINDIRECTW 记录的 lfQuality 改为 quality，其余字节不变。
    只处理顶层记录；记录长度无效时报错，不返回部分改写的数据。"""
    header(data)
    out = bytearray(data)
    off = 0
    while off < len(out):
        if off + 8 > len(out):
            raise ValueError(f"EMF 记录头不完整：偏移 {off}")
        itype, size = struct.unpack_from("<II", out, off)
        if size < 8 or size % 4 or off + size > len(out):
            raise ValueError(f"EMF 记录长度无效：偏移 {off}，长度 {size}")
        if itype == EMR_EXTCREATEFONTINDIRECTW:
            if size <= LF_QUALITY_OFFSET:
                raise ValueError(f"EMR_EXTCREATEFONTINDIRECTW 记录过短：偏移 {off}")
            out[off + LF_QUALITY_OFFSET] = quality
        off += size
    return bytes(out)


# 页面 EMF 中字体的 lfQuality 为 0（缺省），GDI 回放时按 ClearType 兼容宽度绘制；
# WPS 在屏幕上绘制时请求的是 CLEARTYPE_NATURAL_QUALITY（自然宽度）。不改写时真值的字形与屏幕显示不一致。
CLEARTYPE_NATURAL_QUALITY = 6


def render_screen(data: bytes, dpi: float) -> Image.Image:
    """按 WPS 屏幕显示的字体质量回放 WPS 页面 EMF。docx 真值与公式校准的采集都经此处，不要直接调用 render。"""
    return render(with_font_quality(data, CLEARTYPE_NATURAL_QUALITY), dpi)


class _BitmapInfoHeader(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
                ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
                ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
                ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


def _gdi():
    gdi32, user32 = ctypes.windll.gdi32, ctypes.windll.user32
    vp, ip = ctypes.c_void_p, ctypes.c_int
    gdi32.SetEnhMetaFileBits.restype = vp
    gdi32.SetEnhMetaFileBits.argtypes = [wintypes.UINT, ctypes.c_char_p]
    gdi32.DeleteEnhMetaFile.argtypes = [vp]
    gdi32.CreateCompatibleDC.restype = vp
    gdi32.CreateCompatibleDC.argtypes = [vp]
    gdi32.CreateDIBSection.restype = vp
    gdi32.CreateDIBSection.argtypes = [vp, ctypes.c_void_p, wintypes.UINT,
                                       ctypes.POINTER(ctypes.c_void_p), vp, wintypes.DWORD]
    gdi32.SelectObject.restype = vp
    gdi32.SelectObject.argtypes = [vp, vp]
    gdi32.DeleteObject.argtypes = [vp]
    gdi32.DeleteDC.argtypes = [vp]
    gdi32.PatBlt.argtypes = [vp, ip, ip, ip, ip, wintypes.DWORD]
    gdi32.SetStretchBltMode.argtypes = [vp, ip]
    gdi32.SetBrushOrgEx.argtypes = [vp, ip, ip, vp]
    gdi32.PlayEnhMetaFile.argtypes = [vp, vp, ctypes.POINTER(wintypes.RECT)]
    user32.GetDC.restype = vp
    user32.GetDC.argtypes = [vp]
    user32.ReleaseDC.argtypes = [vp, vp]
    return gdi32, user32


def render(data: bytes, dpi: float) -> Image.Image:
    """按 dpi 把 EMF 的图片框回放为 RGB 位图；底色为白色。"""
    info = header(data)
    width = max(1, round(info["frame_mm"][0] / 25.4 * dpi))
    height = max(1, round(info["frame_mm"][1] / 25.4 * dpi))
    gdi32, user32 = _gdi()
    hemf = gdi32.SetEnhMetaFileBits(len(data), data)
    if not hemf:
        raise ValueError("SetEnhMetaFileBits 失败")
    screen = user32.GetDC(None)
    dc = gdi32.CreateCompatibleDC(screen)
    bmi = _BitmapInfoHeader(ctypes.sizeof(_BitmapInfoHeader), width, -height, 1, 32, 0, 0, 0, 0, 0, 0)
    bits = ctypes.c_void_p()
    bmp = gdi32.CreateDIBSection(dc, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    try:
        if not bmp:
            raise MemoryError(f"CreateDIBSection {width}x{height} 失败")
        old = gdi32.SelectObject(dc, bmp)
        gdi32.PatBlt(dc, 0, 0, width, height, WHITENESS)
        gdi32.SetStretchBltMode(dc, HALFTONE)
        gdi32.SetBrushOrgEx(dc, 0, 0, None)
        rect = wintypes.RECT(0, 0, width, height)
        if not gdi32.PlayEnhMetaFile(dc, hemf, ctypes.byref(rect)):
            raise RuntimeError("PlayEnhMetaFile 失败")
        gdi32.GdiFlush()
        raw = ctypes.string_at(bits, width * height * 4)
        gdi32.SelectObject(dc, old)
        return Image.frombuffer("RGB", (width, height), raw, "raw", "BGRX", 0, 1).copy()
    finally:
        if bmp:
            gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(dc)
        user32.ReleaseDC(None, screen)
        gdi32.DeleteEnhMetaFile(hemf)
