"""EMF 解析与回放：用 GDI 的 PlayEnhMetaFile 把图片框（rclFrame）映射到整张位图。

输出尺寸只由图片框与 dpi 决定，图片框以外的绘制被位图边界裁去。不要以绘制范围（rclBounds）
作为输出尺寸或目标矩形：绘制超出页面时两者不一致，输出会缩放并带出页面以外的内容。

PlayEnhMetaFile 在任一记录回放失败时返回假，其余记录照常回放。GDI 拒绝参数无效的对象（宽度不为 1 的修饰画笔等），
该句柄随后的选入与删除随之失败，设备上下文保留原先选入的对象：这类失败按 GDI 的回放结果接受（`rejected_objects`），
其余失败报错。WPS 页面 EMF 中下划线的画笔为宽度 2 的修饰画笔（thu-docx-021）。

WPS 页面 EMF 中有两类主机上没有的字体：WPS 自带的字体（以 KSOF 开头）按 `replay-fonts.ts` 给出的对应改为数据表中的
主机字体（`with_faces`，与本方绘制相同）；文档嵌入的字体由 `replay-fonts.ts` 给出字节，回放期间以 `private_fonts` 载入。
"""

import base64
import ctypes
import json
import shutil
import struct
import subprocess
from contextlib import contextmanager
from ctypes import wintypes
from pathlib import Path

from PIL import Image

EMF_SIGNATURE = 0x464D4520
HALFTONE = 4
WHITENESS = 0x00FF0062
EMR_EXTCREATEFONTINDIRECTW = 82
# lfQuality 在记录中的偏移：记录头 8 字节与 ihFont 4 字节之后为 LOGFONTW，lfQuality 是其第 26 字节。
LF_QUALITY_OFFSET = 12 + 26
# lfFaceName 在记录中的偏移与长度（32 个 UTF-16 码元，含结尾的 0）。
LF_FACE_OFFSET = 12 + 28
LF_FACE_CHARS = 32
# WPS 自带字体的字体名前缀：主机上没有，GDI 回放时另取字体。
WPS_FACE_PREFIX = "KSOF"
ROOT = Path(__file__).resolve().parents[2]


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


def _font_records(data: bytes):
    """逐条给出 EMR_EXTCREATEFONTINDIRECTW 记录的偏移。只处理顶层记录；记录长度无效或记录过短时报错。"""
    header(data)
    off = 0
    while off < len(data):
        if off + 8 > len(data):
            raise ValueError(f"EMF 记录头不完整：偏移 {off}")
        itype, size = struct.unpack_from("<II", data, off)
        if size < 8 or size % 4 or off + size > len(data):
            raise ValueError(f"EMF 记录长度无效：偏移 {off}，长度 {size}")
        if itype == EMR_EXTCREATEFONTINDIRECTW:
            if size < LF_FACE_OFFSET + 2 * LF_FACE_CHARS:
                raise ValueError(f"EMR_EXTCREATEFONTINDIRECTW 记录过短：偏移 {off}")
            yield off
        off += size


def with_font_quality(data: bytes, quality: int) -> bytes:
    """把每条 EMR_EXTCREATEFONTINDIRECTW 记录的 lfQuality 改为 quality，其余字节不变。
    记录长度无效时报错，不返回部分改写的数据。"""
    out = bytearray(data)
    for off in _font_records(data):
        out[off + LF_QUALITY_OFFSET] = quality
    return bytes(out)


def _face_name(data, off: int) -> str:
    at = off + LF_FACE_OFFSET
    return bytes(data[at:at + 2 * LF_FACE_CHARS]).decode("utf-16-le").split(chr(0), 1)[0]


def unmapped_faces(data: bytes, faces: dict) -> set:
    """页面 EMF 中以 KSOF 开头而不在 faces 中的字体名：数据表中没有该字体名，回放时 GDI 另取字体，与 WPS 屏幕不同。"""
    return {f for f in (_face_name(data, off) for off in _font_records(data))
            if f.startswith(WPS_FACE_PREFIX) and f not in faces}


def with_faces(data: bytes, faces: dict) -> bytes:
    """把每条 EMR_EXTCREATEFONTINDIRECTW 记录中在 faces 里的 lfFaceName 改为对应的字体名，其余字节不变。"""
    out = bytearray(data)
    size = 2 * LF_FACE_CHARS
    for off in _font_records(data):
        at = off + LF_FACE_OFFSET
        target = faces.get(_face_name(out, off))
        if target is None:
            continue
        encoded = target.encode("utf-16-le")
        if len(encoded) >= size:
            raise ValueError(f"字体名过长：{target}")
        out[at:at + size] = encoded + bytes(size - len(encoded))
    return bytes(out)


def document_fonts(path) -> tuple:
    """docx 真值回放所需的字体（`replay-fonts.ts`）：返回 (faces, fonts)，faces 为 WPS 自带字体的字体名到回放所用的主机字体，
    fonts 为回放期间须载入的嵌入字体字节。由 Bun 以本方解析器读取文件，失败时报错。"""
    bun = shutil.which("bun")
    if bun is None:
        raise RuntimeError("未找到 bun：无法取得真值回放所需的字体")
    script = ROOT / "scripts" / "ooxml-fidelity" / "replay-fonts.ts"
    done = subprocess.run([bun, "run", str(script), str(Path(path).resolve())], cwd=ROOT, capture_output=True,
                          check=False)
    if done.returncode != 0:
        raise RuntimeError(f"replay-fonts.ts 失败：{done.stderr.decode('utf-8', 'replace')[-400:]}")
    out = json.loads(done.stdout)
    return out["faces"], [base64.b64decode(f) for f in out["fonts"]]


@contextmanager
def private_fonts(fonts: list):
    """以 AddFontMemResourceEx 把字体字节载入本进程（不安装、不写文件，其他进程不可见），退出时移除。"""
    gdi32 = ctypes.windll.gdi32
    gdi32.AddFontMemResourceEx.restype = ctypes.c_void_p
    gdi32.AddFontMemResourceEx.argtypes = [ctypes.c_char_p, wintypes.DWORD, ctypes.c_void_p,
                                           ctypes.POINTER(wintypes.DWORD)]
    gdi32.RemoveFontMemResourceEx.argtypes = [ctypes.c_void_p]
    handles = []
    try:
        for data in fonts:
            count = wintypes.DWORD(0)
            handle = gdi32.AddFontMemResourceEx(data, len(data), None, ctypes.byref(count))
            if not handle:
                raise RuntimeError("AddFontMemResourceEx 失败")
            handles.append(handle)
        yield
    finally:
        for handle in handles:
            gdi32.RemoveFontMemResourceEx(handle)


# 页面 EMF 中字体的 lfQuality 为 0（缺省），GDI 回放时按 ClearType 兼容宽度绘制；
# WPS 在屏幕上绘制时请求的是 CLEARTYPE_NATURAL_QUALITY（自然宽度）。不改写时真值的字形与屏幕显示不一致。
CLEARTYPE_NATURAL_QUALITY = 6


def render_screen(data: bytes, dpi: float, faces: dict | None = None) -> Image.Image:
    """按 WPS 屏幕显示的字体质量回放 WPS 页面 EMF，字体名按 faces 改写（`document_fonts`；为 None 时不改写）。
    数据表中没有的 WPS 自带字体由调用方以 `unmapped_faces` 记入清单。docx 真值与公式校准的采集都经此处，不要直接调用 render。"""
    return render(with_faces(with_font_quality(data, CLEARTYPE_NATURAL_QUALITY), faces or {}), dpi)


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


# 创建对象的记录：CREATEPEN、CREATEBRUSHINDIRECT、CREATEPALETTE、EXTCREATEFONTINDIRECTW、CREATEMONOBRUSH、
# CREATEDIBPATTERNBRUSHPT、EXTCREATEPEN。这些记录与选入、删除对象的记录的第一个参数为句柄表下标。
OBJECT_RECORDS = {38, 39, 49, 82, 93, 94, 95}
EMR_SELECTOBJECT = 37
EMR_DELETEOBJECT = 40


def _replay(data: bytes, width: int, height: int, play):
    """在 width × height 的白底 32 位位图上调用 play(gdi32, dc, hemf, rect, bits)，返回其结果；结束时释放全部 GDI 对象。"""
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
        try:
            return play(gdi32, dc, hemf, wintypes.RECT(0, 0, width, height), bits)
        finally:
            gdi32.SelectObject(dc, old)
    finally:
        if bmp:
            gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(dc)
        user32.ReleaseDC(None, screen)
        gdi32.DeleteEnhMetaFile(hemf)


def _failed_records(gdi32, dc, hemf, rect, _bits) -> list:
    """逐条回放（EnumEnhMetaFile 与 PlayEnhMetaFileRecord），返回回放失败的记录：[(序号, 类型, 句柄)]，
    句柄为创建、选入与删除对象的记录的第一个参数，其他记录为 None。"""
    vp = ctypes.c_void_p
    proc_type = ctypes.WINFUNCTYPE(ctypes.c_int, vp, vp, vp, ctypes.c_int, vp)
    gdi32.EnumEnhMetaFile.argtypes = [vp, vp, proc_type, vp, ctypes.POINTER(wintypes.RECT)]
    gdi32.PlayEnhMetaFileRecord.argtypes = [vp, vp, vp, wintypes.UINT]
    failed, index = [], [0]

    def play(hdc, table, record, count, _param):
        itype, size = struct.unpack("<II", ctypes.string_at(record, 8))
        if not gdi32.PlayEnhMetaFileRecord(hdc, table, record, count):
            uses_handle = itype in OBJECT_RECORDS or itype in (EMR_SELECTOBJECT, EMR_DELETEOBJECT)
            handle = struct.unpack("<I", ctypes.string_at(record + 8, 4))[0] if uses_handle and size >= 12 else None
            failed.append((index[0], itype, handle))
        index[0] += 1
        return 1

    gdi32.EnumEnhMetaFile(dc, hemf, proc_type(play), None, ctypes.byref(rect))
    return failed


def rejected_objects(failed: list) -> list:
    """回放失败的记录中不属于「GDI 拒绝创建的对象」的部分：对象创建失败，以及其后选入、删除同一句柄而失败的记录，
    直到该句柄再次创建成功为止，都按 GDI 的回放结果接受。返回其余的失败记录。"""
    rejected, rest = set(), []
    for index, itype, handle in failed:
        if itype in OBJECT_RECORDS:
            rejected.add(handle)
        elif itype in (EMR_SELECTOBJECT, EMR_DELETEOBJECT) and handle in rejected:
            if itype == EMR_DELETEOBJECT:
                rejected.discard(handle)
        else:
            rest.append((index, itype, handle))
    return rest


def render(data: bytes, dpi: float) -> Image.Image:
    """按 dpi 把 EMF 的图片框回放为 RGB 位图；底色为白色。回放失败的记录不全是 GDI 拒绝创建的对象时报错。"""
    info = header(data)
    width = max(1, round(info["frame_mm"][0] / 25.4 * dpi))
    height = max(1, round(info["frame_mm"][1] / 25.4 * dpi))

    def play(gdi32, dc, hemf, rect, bits):
        if not gdi32.PlayEnhMetaFile(dc, hemf, ctypes.byref(rect)):
            # 在另一张位图上逐条回放以查明失败的记录，不在已绘制的位图上重复绘制。
            rest = rejected_objects(_replay(data, width, height, _failed_records))
            if rest:
                raise RuntimeError(f"PlayEnhMetaFile 失败：记录（序号, 类型, 句柄）{rest[:10]}")
        gdi32.GdiFlush()
        raw = ctypes.string_at(bits, width * height * 4)
        return Image.frombuffer("RGB", (width, height), raw, "raw", "BGRX", 0, 1).copy()

    return _replay(data, width, height, play)
