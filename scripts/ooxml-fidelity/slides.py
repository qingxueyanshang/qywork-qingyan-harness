"""pptx 对照图：Slide.Export 逐页导出 PNG，并与 Slide.Copy 放入剪贴板的缩略图逐页核对。

不取窗口：WPS 演示只在 Application.Visible 为真时绘制窗口，而设置 Visible 会使其窗口成为前台，
并写入 wpp\\RecentFiles\\Sequence、账号打开记录与 wpp\\wppongmani；不设 Visible 时窗口客户区不绘制，
SlideShowSettings.Run 返回 E_FAIL。因此对照图取导出图，缩略图只用于核对导出图。
导出尺寸：幻灯片尺寸（磅）按 96 dpi 换算为像素。
核对：导出图按面积平均缩小到缩略图尺寸，计算整页 SSIM 与分块 SSIM 的最小值。分块最小值用于发现局部差异：
缺少一个小对象时整页 SSIM 仍接近 1。
嵌入字体：文件嵌入而本机未安装的字体，导出图按该字体绘制，缩略图改用替代字体（实测华文行楷、汉仪程行简、
演示流云楷）。使用这类字体的页不一致时按导出图，只作标注；其余原因的不一致使整份文件不写入，
经人工核对接受的页除外（格式见 rejection）。「WPS 屏幕显示使用嵌入字体」是未经屏幕核实的前提。
"""

import ctypes
import io
import re
import zipfile
from ctypes import wintypes

import clipboard
import numpy as np
import score
from PIL import Image

DPI = 96.0
GRID = (6, 8)
# 阈值依据（2026-11-01，37 页）：同一导出图分别以 BOX 与 LANCZOS 缩小后互比，整页 SSIM 不低于 0.984、分块最小值不低于 0.960，
# 低于此水平的差异来自绘制而不是比较方法；目视一致的页分块最小值为 0.966–1.000，字体替换或文字错位的页不高于 0.785。
MIN_SSIM = 0.95
MIN_BLOCK = 0.90
METHOD = "导出图；嵌入字体页与屏幕缩略图不一致，按导出图"


def export_size(width_pt: float, height_pt: float, dpi: float = DPI) -> tuple:
    """幻灯片尺寸（磅）换算为导出像素尺寸。"""
    return round(width_pt * dpi / 72), round(height_pt * dpi / 72)


def block_min(m: np.ndarray, grid=GRID) -> float:
    """SSIM 图按 grid（行数, 列数）等分后各块均值的最小值。"""
    return float(min(b.mean() for rows in np.array_split(m, grid[0], axis=0)
                     for b in np.array_split(rows, grid[1], axis=1)))


def compare(export: Image.Image, thumb: Image.Image) -> dict:
    """导出图缩小到缩略图尺寸后与缩略图比较。BOX 为面积平均，接近按低分辨率直接绘制时的覆盖率抗锯齿。"""
    small = export.resize(thumb.size, Image.BOX)
    m = score.ssim_map(score.gray(thumb), score.gray(small))
    return {"ssim": round(float(m.mean()), 4), "min_block": round(block_min(m), 4)}


def consistent(page: dict) -> bool:
    return page["ssim"] >= MIN_SSIM and page["min_block"] >= MIN_BLOCK


# ── 嵌入字体 ──

class _LOGFONTW(ctypes.Structure):
    _fields_ = [("lfHeight", wintypes.LONG), ("lfWidth", wintypes.LONG), ("lfEscapement", wintypes.LONG),
                ("lfOrientation", wintypes.LONG), ("lfWeight", wintypes.LONG), ("lfItalic", wintypes.BYTE),
                ("lfUnderline", wintypes.BYTE), ("lfStrikeOut", wintypes.BYTE), ("lfCharSet", wintypes.BYTE),
                ("lfOutPrecision", wintypes.BYTE), ("lfClipPrecision", wintypes.BYTE),
                ("lfQuality", wintypes.BYTE), ("lfPitchAndFamily", wintypes.BYTE),
                ("lfFaceName", wintypes.WCHAR * 32)]


_ENUM = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, wintypes.LPARAM)


def installed(face: str) -> bool:
    """GDI 能否按该名称（含本地化名称）枚举到字体。"""
    user, gdi = ctypes.windll.user32, ctypes.windll.gdi32
    user.GetDC.restype = ctypes.c_void_p
    found = []
    lf = _LOGFONTW()
    lf.lfCharSet = 1
    lf.lfFaceName = face[:31]
    hdc = user.GetDC(None)
    try:
        gdi.EnumFontFamiliesExW(ctypes.c_void_p(hdc), ctypes.byref(lf),
                                _ENUM(lambda *_: found.append(1) or 0), 0, 0)
    finally:
        user.ReleaseDC(None, ctypes.c_void_p(hdc))
    return bool(found)


def _rels(z: zipfile.ZipFile, part: str) -> list:
    """part 的关系：[(Id, Type, 目标部件路径)]。

    按 OPC 规则解析目标：以 `/` 开头为包内绝对路径，其余相对 part 所在目录；外部目标（TargetMode="External"）不是部件，不列出。
    """
    folder, name = part.rsplit("/", 1)
    xml = z.read(f"{folder}/_rels/{name}.rels").decode("utf-8")
    out = []
    for attrs in re.findall(r"<Relationship\b([^>]*)>", xml):
        get = {k: v for k, v in re.findall(r'(\w+)="([^"]*)"', attrs)}
        if get.get("TargetMode") == "External":
            continue
        target = get["Target"]
        parts = [] if target.startswith("/") else folder.split("/")
        for seg in target.lstrip("/").split("/"):
            if seg == "..":
                parts.pop()
            elif seg != ".":
                parts.append(seg)
        out.append((get["Id"], get["Type"], "/".join(parts)))
    return out


def _target(z: zipfile.ZipFile, part: str, rel_type: str) -> str:
    return next(p for _, t, p in _rels(z, part) if t.endswith("/" + rel_type))


def _faces(xml: str, theme: dict) -> set:
    """xml 中出现的字体名；+mj-lt 等主题引用按 theme 换成实际字体名，空名称不计。"""
    out = set()
    for face in re.findall(r'typeface="([^"]*)"', xml):
        face = theme.get(face, face)
        if face:
            out.add(face)
    return out


def _theme_faces(xml: str) -> dict:
    out = {}
    for kind, tag in (("mj", "majorFont"), ("mn", "minorFont")):
        body = re.search(rf"<a:{tag}>(.*?)</a:{tag}>", xml, re.S)
        for slot, short in (("latin", "lt"), ("ea", "ea"), ("cs", "cs")):
            m = re.search(rf'<a:{slot} typeface="([^"]*)"', body.group(1)) if body else None
            out[f"+{kind}-{short}"] = m.group(1) if m else ""
    return out


def _cSld(xml: str) -> str:
    m = re.search(r"<p:cSld\b.*?</p:cSld>", xml, re.S)
    return m.group(0) if m else ""


def embedded_faces(path):
    """每页（按放映顺序）使用的、文件嵌入而本机未安装的字体名；不是 zip 包（.ppt）时为 None，各页按没有嵌入字体核对，
    导出图与缩略图不一致的页归入「其他」。

    取幻灯片、其版式与母版的形状树中的字体；幻灯片含占位符时另取母版文字样式（占位符文字从中继承字体）。
    """
    # 按文件头判断：zipfile.is_zipfile 在文件末尾查找结束记录，.ppt 中内嵌的 ZIP 数据会使它返回真。
    with open(path, "rb") as f:
        if f.read(4) != b"PK\x03\x04":
            return None
    with zipfile.ZipFile(path) as z:
        pres_part = "ppt/presentation.xml"
        pres = z.read(pres_part).decode("utf-8")
        missing = {f for f in re.findall(r'<p:embeddedFont>\s*<p:font typeface="([^"]+)"', pres) if not installed(f)}
        parts = {rid: p for rid, _, p in _rels(z, pres_part)}
        out = []
        for rid in re.findall(r'<p:sldId\b[^>]*r:id="([^"]+)"', pres):
            slide = parts[rid]
            layout = _target(z, slide, "slideLayout")
            master = _target(z, layout, "slideMaster")
            theme = _theme_faces(z.read(_target(z, master, "theme")).decode("utf-8"))
            slide_xml = z.read(slide).decode("utf-8")
            master_xml = z.read(master).decode("utf-8")
            faces = _faces(_cSld(slide_xml), theme) | _faces(_cSld(z.read(layout).decode("utf-8")), theme)
            faces |= _faces(_cSld(master_xml), theme)
            if "<p:ph" in slide_xml:
                styles = re.search(r"<p:txStyles>.*?</p:txStyles>", master_xml, re.S)
                faces |= _faces(styles.group(0) if styles else "", theme)
            out.append(sorted(faces & missing))
        return out


def classify(page: dict, accepted: dict) -> dict:
    """标注不一致的原因：None（一致）、「嵌入字体」、「人工核对接受」或「其他」。"""
    if consistent(page):
        return {"difference": None}
    if page["embedded_fonts"]:
        return {"difference": "嵌入字体"}
    if page["n"] in accepted:
        return {"difference": "人工核对接受", "note": accepted[page["n"]]}
    return {"difference": "其他"}


def rejection(checks: dict):
    """不写入对照图的原因；None 表示可以写入。

    原因为「其他」的不一致页与导出尺寸不符的页使整份文件不写入。人工核对接受的页由调用方从
    .tmp/ooxml-fidelity/pptx-review.json 读取，格式为 {"accepted": [{"id": 文档标识, "page": 页号, "cause": 原因}]}。
    """
    parts = []
    if checks["other_pages"]:
        parts.append(f"嵌入字体以外原因的不一致页：{checks['other_pages']}")
    if checks["size_mismatch_pages"]:
        parts.append(f"导出尺寸与换算尺寸不符的页：{checks['size_mismatch_pages']}")
    return "；".join(parts) or None


def _thumbnail(data: dict) -> Image.Image:
    if "PNG" in data:
        with Image.open(io.BytesIO(data["PNG"])) as im:
            return im.convert("RGBA")
    return clipboard.dib_image(data[clipboard.CF_DIB])


def capture(inst, src, out_dir, backup, accepted: dict) -> dict:
    """逐页导出到 out_dir/page-NNNN.png，缩略图写为 thumb-NNNN.png 供目视核对。accepted 为 {页号: 原因}。"""
    faces = embedded_faces(src)
    pres = inst.open(src)
    pages, outcomes, formats = [], [], None
    try:
        size_pt = (pres.PageSetup.SlideWidth, pres.PageSetup.SlideHeight)
        width, height = export_size(*size_pt)
        for n in range(1, pres.Slides.Count + 1):
            slide = pres.Slides(n)
            png = out_dir / f"page-{n:04d}.png"
            slide.Export(str(png), "PNG", width, height)
            with clipboard.Borrowed(backup) as borrowed:
                slide.Copy()
                if formats is None:
                    formats = clipboard.formats_present()
                data = clipboard.read_formats({clipboard.CF_DIB, "PNG"})
                borrowed.copy_seen()
            outcomes.append(borrowed.outcome)
            if not data:
                raise RuntimeError(f"第 {n} 页：剪贴板中没有 PNG 或 CF_DIB")
            thumb = _thumbnail(data)
            thumb.save(out_dir / f"thumb-{n:04d}.png")
            with Image.open(png) as im:
                im.load()
                page = {"n": n, "slide": n, "file": png.name, "width": im.width, "height": im.height,
                        "mode": im.mode, "hidden": bool(slide.SlideShowTransition.Hidden),
                        "thumb_size": thumb.size, "thumb_format": "PNG" if "PNG" in data else "CF_DIB",
                        "embedded_fonts": [] if faces is None else faces[n - 1], **compare(im, thumb)}
            pages.append({**page, **classify(page, accepted)})
    finally:
        inst.close_doc(pres)
    by = {kind: [p["n"] for p in pages if p["difference"] == kind] for kind in ("嵌入字体", "人工核对接受", "其他")}
    checks = {"slide_size_pt": size_pt, "export_size": (width, height),
              "size_mismatch_pages": [p["n"] for p in pages if (p["width"], p["height"]) != (width, height)],
              "min_ssim": min((p["ssim"] for p in pages), default=None),
              "min_block": min((p["min_block"] for p in pages), default=None),
              "thresholds": {"ssim": MIN_SSIM, "min_block": MIN_BLOCK, "grid": GRID},
              "embedded_font_pages": by["嵌入字体"], "accepted_pages": by["人工核对接受"], "other_pages": by["其他"],
              "clipboard_formats": formats, "clipboard": outcomes}
    return {"method": METHOD, "export": "Slide.Export PNG", "check": "Slide.Copy 剪贴板缩略图", "dpi": DPI,
            "pages": pages, "checks": checks}
