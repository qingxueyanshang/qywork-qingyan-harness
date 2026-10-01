"""渲染：只读打开文件，导出 PDF 或逐页图片，按文件哈希缓存；供 write 的渲染阶段、view 与 PDF 附带输出使用。

PDF 原件只供 view：不经过办公软件，直接按页栅格化，且只转被查看的页。

缓存目录 <cache_dir>/<sha256>/，manifest.json 最后写入：它存在就说明这一份渲染是完整的。
整页按 200 dpi 渲染；局部图从这份原始渲染图裁出，不先缩小再放大。
"""

import re
import shutil
from pathlib import Path

import util

DPI = 200
# 幻灯片导出宽度的上限（像素）；16:9 按 200 dpi 约 2667，取整到这个上限以内。
SLIDE_MAX_WIDTH = 2400


class Unreadable(Exception):
    """PDF 打不开：已加密、已损坏或不是 PDF。"""


def _open_pdf(pdf_path):
    import pypdfium2 as pdfium

    try:
        return pdfium.PdfDocument(str(pdf_path))
    except pdfium.PdfiumError as e:
        raise Unreadable(f"{Path(pdf_path).name} 已加密、已损坏或不是 PDF（{e}）") from e


def _render_page(pdf, index, png):
    page = pdf[index]
    try:
        img = page.render(scale=DPI / 72).to_pil()
        img.save(png)
        return str(png), img.width, img.height
    finally:
        page.close()


def rasterize(pdf_path, out_dir, prefix):
    """PDF 逐页转 PNG。返回 [(路径, 宽, 高)]。"""
    pdf = _open_pdf(pdf_path)
    try:
        return [_render_page(pdf, i, Path(out_dir) / f"{prefix}{i + 1}.png") for i in range(len(pdf))]
    finally:
        pdf.close()


def page_texts(pdf_path):
    """PDF 每页的文字，用于按标题查页码。"""
    texts = []
    pdf = _open_pdf(pdf_path)
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            tp = page.get_textpage()
            try:
                texts.append(tp.get_text_range())
            finally:
                tp.close()
                page.close()
    finally:
        pdf.close()
    return texts


def segments(lo, hi, breaks):
    """按分页符把 [lo, hi] 切成若干段，每个分页符所在的行（列）是新一段的起点。"""
    starts = [lo] + sorted(b for b in breaks if lo < b <= hi)
    ends = [s - 1 for s in starts[1:]] + [hi]
    return list(zip(starts, ends))


def page_ranges(ws):
    """按打印区域（没有就用已用区域）与分页符算出每页对应的单元格区域；算不出返回 None。"""
    try:
        area = ws.PageSetup.PrintArea
        rng = ws.Range(area) if area else ws.UsedRange
        r0, c0 = rng.Row, rng.Column
        r1, c1 = r0 + rng.Rows.Count - 1, c0 + rng.Columns.Count - 1
        hb = [ws.HPageBreaks.Item(i).Location.Row for i in range(1, ws.HPageBreaks.Count + 1)]
        vb = [ws.VPageBreaks.Item(i).Location.Column for i in range(1, ws.VPageBreaks.Count + 1)]
        rows, cols = segments(r0, r1, hb), segments(c0, c1, vb)
        # PageSetup.Order：1 为先向下再向右，2 为先向右再向下。
        if ws.PageSetup.Order == 2:
            pairs = [(rs, cs) for rs in rows for cs in cols]
        else:
            pairs = [(rs, cs) for cs in cols for rs in rows]
        return [f"{util.col_letter(cs[0])}{rs[0]}:{util.col_letter(cs[1])}{rs[1]}"
                for rs, cs in pairs]
    except Exception:
        return None


def _cache_dir(path, cache_dir):
    sha = util.sha256(path)
    return sha, Path(cache_dir) / sha


def _pdf_pages(pdf, d):
    return [{"key": str(i), "label": f"第 {i} 页", "png": png, "width": w, "height": h}
            for i, (png, w, h) in enumerate(rasterize(pdf, d, "page"), 1)]


def _fresh(d):
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True, exist_ok=True)


def seed_docx(path, pdf, cache_dir, renderer):
    """用已经导出的 PDF 建 docx 的渲染缓存。pdf 必须由与 path 当前字节相同的文件导出。"""
    sha, d = _cache_dir(path, cache_dir)
    if (d / "manifest.json").exists():
        return
    _fresh(d)
    target = d / "document.pdf"
    shutil.copyfile(pdf, target)
    manifest = {"sha256": sha, "format": "docx", "dpi": DPI, "pages": _pdf_pages(target, d),
                "sheets": None, "pdf": str(target), "renderer": renderer}
    util.write_json(d / "manifest.json", manifest)


def render(path, fmt, cache_dir, apps):
    """渲染一份文件；同一哈希已有完整缓存时直接返回缓存的清单。"""
    sha, d = _cache_dir(path, cache_dir)
    manifest_path = d / "manifest.json"
    if manifest_path.exists():
        return util.read_json(manifest_path)
    _fresh(d)
    if fmt == "pdf":
        # 清单只列页，图在 view 时按页转：大文件不为没看的页付栅格化时间和磁盘。
        doc = _open_pdf(path)
        try:
            count = len(doc)
        finally:
            doc.close()
        pages = [{"key": str(i), "label": f"第 {i} 页", "png": str(d / f"page{i}.png"),
                  "width": None, "height": None} for i in range(1, count + 1)]
        manifest = {"sha256": sha, "format": "pdf", "dpi": DPI, "pages": pages, "sheets": None,
                    "pdf": None, "renderer": {"progid": "pypdfium2"}}
        util.write_json(manifest_path, manifest)
        return manifest
    inst = apps.get(fmt)
    pages, sheets, pdf = [], None, None
    doc = inst.open(path)
    try:
        if fmt == "docx":
            pdf = d / "document.pdf"
            doc.ExportAsFixedFormat(str(pdf), 17)
            pages = _pdf_pages(pdf, d)
        elif fmt == "xlsx":
            sheets = []
            for idx in range(1, doc.Worksheets.Count + 1):
                ws = doc.Worksheets(idx)
                name = ws.Name
                if ws.Visible != -1:
                    sheets.append({"name": name, "pages": 0, "ranges": None, "hidden": True})
                    continue
                sheet_pdf = d / f"sheet{idx}.pdf"
                try:
                    ws.ExportAsFixedFormat(0, str(sheet_pdf))
                except Exception as e:
                    sheets.append({"name": name, "pages": 0, "ranges": None,
                                   "error": f"导出失败：{e}"})
                    continue
                ranges = page_ranges(ws)
                pngs = rasterize(sheet_pdf, d, f"sheet{idx}-p")
                if ranges is not None and len(ranges) != len(pngs):
                    ranges = None
                for n, (png, w, h) in enumerate(pngs, 1):
                    label = f"{name} 第 {n} 页" + (f"（{ranges[n - 1]}）" if ranges else "")
                    pages.append({"key": f"{name}:{n}", "label": label, "png": png, "width": w,
                                  "height": h, "range": ranges[n - 1] if ranges else None})
                sheets.append({"name": name, "pages": len(pngs), "ranges": ranges})
        else:
            w_pt, h_pt = doc.PageSetup.SlideWidth, doc.PageSetup.SlideHeight
            width = min(SLIDE_MAX_WIDTH, round(w_pt / 72 * DPI))
            height = round(width * h_pt / w_pt)
            for i in range(1, doc.Slides.Count + 1):
                png = d / f"slide{i}.png"
                doc.Slides(i).Export(str(png), "PNG", width, height)
                pages.append({"key": str(i), "label": f"第 {i} 页", "png": str(png),
                              "width": width, "height": height})
    finally:
        inst.close_doc(doc)
        del doc
    manifest = {"sha256": sha, "format": fmt, "dpi": DPI, "pages": pages, "sheets": sheets,
                "pdf": str(pdf) if pdf else None,
                "renderer": {k: inst.info.get(k) for k in ("progid", "product", "version")}}
    util.write_json(manifest_path, manifest)
    return manifest


def export_pdf(path, fmt, dst, cache_dir, apps):
    """PDF 附带输出。docx 复用渲染缓存里的 PDF；xlsx 导出整个工作簿；pptx 另存为 PDF。"""
    if fmt == "docx":
        manifest = render(path, fmt, cache_dir, apps)
        util.atomic_copy(manifest["pdf"], dst)
        return
    inst = apps.get(fmt)
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(dst).with_name(f".{Path(dst).name}.qy.pdf")
    doc = inst.open(path)
    try:
        if fmt == "xlsx":
            doc.ExportAsFixedFormat(0, str(tmp))
        else:
            doc.SaveAs(str(tmp), 32)
    finally:
        inst.close_doc(doc)
        del doc
    util.atomic_copy(tmp, dst)
    tmp.unlink(missing_ok=True)


def _safe(key):
    return re.sub(r"[^0-9A-Za-z_-]+", "_", key)


def _ensure_pdf_page(path, page):
    """PDF 原件的页在第一次被查看时转图。源用本次调用的 path：缓存按字节哈希共享，清单里不记来源路径。"""
    png = Path(page["png"])
    if not png.exists():
        doc = _open_pdf(path)
        try:
            _render_page(doc, int(page["key"]) - 1, png)
        finally:
            doc.close()
    from PIL import Image

    with Image.open(png) as im:
        return {**page, "width": im.width, "height": im.height}


def view(path, fmt, pages, region, cache_dir, call_dir, apps):
    """返回所选页的整页图或局部图，以及找不到的页。"""
    from PIL import Image

    manifest = render(path, fmt, cache_dir, apps)
    by_key = {p["key"]: p for p in manifest["pages"]}
    images, missing = [], []
    for key in pages:
        key = str(key).strip()
        page = by_key.get(key)
        if page is None:
            missing.append(key)
            continue
        if fmt == "pdf":
            page = _ensure_pdf_page(path, page)
        if not region:
            images.append({"path": page["png"], "label": page["label"], "width": page["width"],
                           "height": page["height"]})
            continue
        with Image.open(page["png"]) as im:
            W, H = im.size
            left = max(0.0, min(1.0, float(region.get("left", 0))))
            top = max(0.0, min(1.0, float(region.get("top", 0))))
            right = max(left, min(1.0, left + float(region.get("width", 1))))
            bottom = max(top, min(1.0, top + float(region.get("height", 1))))
            box = (round(left * W), round(top * H), round(right * W), round(bottom * H))
            crop = im.crop(box)
            out = Path(call_dir) / f"view-{_safe(key)}-crop.png"
            crop.save(out)
            images.append({"path": str(out), "label": f"{page['label']} · 局部",
                           "width": crop.width, "height": crop.height})
    return manifest, images, missing
