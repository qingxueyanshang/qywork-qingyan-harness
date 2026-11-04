"""真值采集：经 COM 取得 WPS 的屏幕显示（pptx 为经核对的导出图），逐页写为 PNG，并记录可信性核对的数据。

实例管理沿用 packages/runtime/office/com.py：只使用本次新启动并核对过进程的实例，文件只读打开其副本，
每个文档使用一个新实例，结束时关闭文档并退出实例。每个文档在启动实例前与退出实例后各取一次最近文档记录并比对：
WPS 退出时才写入界面布局等记录，比对不能早于退出。页面先写入调用目录，记录无变化且核对通过后才移入真值目录；
记录有变化即停止，不再处理后续文档。

docx：ActivePane.Pages(n).EnhMetaFileBits 取每页 EMF（屏幕排版的页面），由 emf.render_screen 按屏幕显示的字体质量回放，
  页面 EMF 中 WPS 自带的字体与文档嵌入的字体按 emf.document_fonts 改写，嵌入字体在回放期间载入本进程；
  数据表中没有的 WPS 自带字体（回放时 GDI 另取字体）按页记入 unmapped_wps_faces，清单的 checks 中列出其并集。
  核对：EMF 图片框与节的页面尺寸一致；绘制范围不超出图片框；窗格页数与 ComputeStatistics 页数一致。
  回放由 GDI 栅格化文字：96 dpi 下宋体等带点阵字形的字体在小字号使用点阵字形，192 dpi 下为轮廓字形，
  两种 dpi 的真值不可混用。
xlsx：Range.CopyPicture(xlScreen, xlBitmap) 取每个可见工作表 A1 起的区域（最多 MAX_ROWS 行、MAX_COLS 列），
  读取剪贴板的 CF_DIB。该取法按 100% 缩放输出，与窗口缩放比例无关；空白单元格为白底，网格线随工作表的显示设置。
  不要改用 xlPicture：其 PNG 中空白单元格是透明像素，去掉透明通道后为黑色。
  可见的图表工作表排在全部工作表之后（工作表的页号不受影响），以 Chart.CopyPicture(xlScreen, xlBitmap) 取图表区，
  页的 range 为 null。WPS 实测文件保存的缩放比例为 100% 时位图即图表区；不是 100% 时图表按另一高度重新排版
  （同一图表 75% 时位图高 421 像素、100% 时 428 像素），成因未查明，打开后改设窗口缩放比例不改变位图。
pptx：见 slides.py。Slide.Export 的导出图经 Slide.Copy 缩略图逐页核对，任一页不一致时整份不写入。
每份文档的清单记录采集时系统的字体平滑设置（font_smoothing）：WPS 经 GDI 绘制的文字随 ClearType 对比度改变，
xlsx 候选按清单中的对比度绘制。只读取，不修改系统设置。
"""

import ctypes
import json
import os
import time
from pathlib import Path

import clipboard
import com
import emf
import records
import slides

XL_SCREEN, XL_BITMAP = 1, 2
SPI_GETFONTSMOOTHING, SPI_GETFONTSMOOTHINGTYPE, SPI_GETFONTSMOOTHINGCONTRAST = 0x004A, 0x200A, 0x200C
MAX_ROWS, MAX_COLS = 60, 26
# 页面尺寸与图片框的允许偏差（mm）：图片框按 0.01 mm 取整且含边界，A4 实测偏差约 0.2 mm。
SIZE_TOL_MM = 1.0


def _font_smoothing() -> dict:
    """系统当前的字体平滑设置：enabled 为是否开启，type 为 1（标准）或 2（ClearType），contrast 为 ClearType 对比度。
    只调用 SystemParametersInfoW 的 SPI_GET*。"""
    spi = ctypes.windll.user32.SystemParametersInfoW

    def get(action: int) -> int:
        out = ctypes.c_uint(0)
        if not spi(action, 0, ctypes.byref(out), 0):
            raise ctypes.WinError()
        return out.value

    return {"enabled": get(SPI_GETFONTSMOOTHING) != 0, "type": get(SPI_GETFONTSMOOTHINGTYPE),
            "contrast": get(SPI_GETFONTSMOOTHINGCONTRAST)}


def _page_sizes_mm(doc) -> list:
    out = []
    for i in range(1, doc.Sections.Count + 1):
        ps = doc.Sections(i).PageSetup
        out.append((ps.PageWidth * 25.4 / 72, ps.PageHeight * 25.4 / 72))
    return out


def _size_ok(frame_mm, sizes) -> bool:
    return any(abs(frame_mm[0] - w) <= SIZE_TOL_MM and abs(frame_mm[1] - h) <= SIZE_TOL_MM
               for w, h in sizes)


def _overflow_mm(h) -> float:
    """绘制范围超出图片框的最大距离（mm）。"""
    b, f = h["bounds_mm"], h["frame_box_mm"]
    return round(max(0.0, f[0] - b[0], f[1] - b[1], b[2] - f[2], b[3] - f[3]), 2)


def _docx(inst, src, out_dir: Path, dpi: float) -> dict:
    faces, fonts = emf.document_fonts(src)
    doc = inst.open(src)
    try:
        stat_pages = doc.ComputeStatistics(2)
        pane = doc.ActiveWindow.ActivePane
        count = pane.Pages.Count
        sizes = _page_sizes_mm(doc)
        pages = []
        for n in range(1, count + 1):
            bits = bytes(pane.Pages(n).EnhMetaFileBits)
            h = emf.header(bits)
            with emf.private_fonts(fonts):
                img = emf.render_screen(bits, dpi, faces)
            unmapped = sorted(emf.unmapped_faces(bits, faces))
            png = out_dir / f"page-{n:04d}.png"
            img.save(png)
            pages.append({"n": n, "file": png.name, "width": img.width, "height": img.height,
                          "frame_mm": h["frame_mm"], "overflow_mm": _overflow_mm(h),
                          "size_ok": _size_ok(h["frame_mm"], sizes), "unmapped_wps_faces": unmapped})
    finally:
        inst.close_doc(doc)
    checks = {"pages_statistic": stat_pages, "pages_pane": count,
              "section_sizes_mm": [tuple(round(v, 2) for v in s) for s in sizes],
              "size_mismatch_pages": [p["n"] for p in pages if not p["size_ok"]],
              "max_overflow_mm": max((p["overflow_mm"] for p in pages), default=0.0),
              "unmapped_wps_faces": sorted({f for p in pages for f in p["unmapped_wps_faces"]})}
    return {"method": "ActivePane.Pages(n).EnhMetaFileBits + lfQuality 6 + 字体名改写 + GDI PlayEnhMetaFile",
            "dpi": dpi, "pages": pages, "checks": checks}


def _copy_bitmap(target, backup: Path, restores: list):
    """target.CopyPicture(xlScreen, xlBitmap) 后读取剪贴板的 CF_DIB；没有时返回 None。剪贴板的写回结果加入 restores。"""
    with clipboard.Borrowed(backup) as borrowed:
        target.CopyPicture(XL_SCREEN, XL_BITMAP)
        data = clipboard.read_formats({clipboard.CF_DIB})
        borrowed.copy_seen()
    restores.append(borrowed.outcome)
    return clipboard.dib_image(data[clipboard.CF_DIB]) if clipboard.CF_DIB in data else None


def _xlsx(inst, src, out_dir: Path, backup: Path) -> dict:
    wb = inst.open(src)
    pages, skipped, restores = [], [], []
    try:
        for i in range(1, wb.Worksheets.Count + 1):
            ws = wb.Worksheets(i)
            name = ws.Name
            if ws.Visible != -1:
                skipped.append({"sheet": name, "reason": "隐藏"})
                continue
            used = ws.UsedRange
            last_row = min(used.Row + used.Rows.Count - 1, MAX_ROWS)
            last_col = min(used.Column + used.Columns.Count - 1, MAX_COLS)
            rng = ws.Range(ws.Cells(1, 1), ws.Cells(last_row, last_col))
            img = _copy_bitmap(rng, backup, restores)
            if img is None:
                skipped.append({"sheet": name, "reason": "剪贴板中没有 CF_DIB"})
                continue
            n = len(pages) + 1
            png = out_dir / f"page-{n:04d}.png"
            img.save(png)
            expected = (round(rng.Width * 96 / 72), round(rng.Height * 96 / 72))
            pages.append({"n": n, "file": png.name, "sheet": name, "range": rng.Address.replace("$", ""),
                          "width": img.width, "height": img.height, "expected_100pct": expected,
                          "shapes": ws.Shapes.Count})
        for i in range(1, wb.Charts.Count + 1):
            chart = wb.Charts(i)
            name = chart.Name
            if chart.Visible != -1:
                skipped.append({"sheet": name, "reason": "隐藏"})
                continue
            img = _copy_bitmap(chart, backup, restores)
            if img is None:
                skipped.append({"sheet": name, "reason": "剪贴板中没有 CF_DIB"})
                continue
            n = len(pages) + 1
            png = out_dir / f"page-{n:04d}.png"
            img.save(png)
            area = chart.ChartArea
            expected = (round(area.Width * 96 / 72), round(area.Height * 96 / 72))
            pages.append({"n": n, "file": png.name, "sheet": name, "range": None,
                          "width": img.width, "height": img.height, "expected_100pct": expected})
    finally:
        inst.close_doc(wb)
    checks = {"skipped_sheets": skipped, "clipboard": restores,
              "size_delta_px": max((max(abs(p["width"] - p["expected_100pct"][0]),
                                        abs(p["height"] - p["expected_100pct"][1])) for p in pages),
                                   default=0)}
    return {"method": "Range.CopyPicture(xlScreen, xlBitmap) + CF_DIB", "dpi": 96,
            "max_rows": MAX_ROWS, "max_cols": MAX_COLS, "pages": pages, "checks": checks}


def _capture(fmt, inst, src, stage: Path, dpi: float, backup: Path, accepted: dict) -> dict:
    if fmt == "docx":
        return _docx(inst, src, stage, dpi)
    if fmt == "xlsx":
        return _xlsx(inst, src, stage, backup)
    return slides.capture(inst, src, stage, backup, accepted)


def _publish(entry: dict, stage: Path, out_dir: Path):
    """清除 out_dir 中的旧页面；status 为 ok 时把页面移入 out_dir，否则只写不含页面的清单。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("page-*.png"):
        old.unlink()
    (stage / "manifest.json").write_text(_dumps(entry), "utf-8")
    if entry["status"] == "ok":
        for p in entry["pages"]:
            os.replace(stage / p["file"], out_dir / p["file"])
        published = entry
    else:
        published = {k: v for k, v in entry.items() if k != "pages"} | {"stage": str(stage)}
    (out_dir / "manifest.json").write_text(_dumps(published), "utf-8")


def run(docs, truth_dir: Path, call_root: Path, dpi: float, review: list) -> dict:
    """review：人工核对接受的 pptx 页，[{"id", "page", "cause"}]，格式见 slides.rejection。"""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    call_dir = call_root / stamp
    call_dir.mkdir(parents=True, exist_ok=True)
    backup = call_dir / "clipboard-backup"
    results, statuses, stopped = [], [], None
    for d in docs:
        entry = {"id": d["id"], "path": d["path"], "format": d["format"], "font_smoothing": _font_smoothing()}
        stage = call_dir / d["id"]
        stage.mkdir(parents=True, exist_ok=True)
        before = records.snapshot()
        apps = com.Apps(call_dir, "fidelity")
        t0 = time.time()
        try:
            inst = apps.get(d["format"])
            accepted = {e["page"]: e["cause"] for e in review if e["id"] == d["id"]}
            data = _capture(d["format"], inst, d["path"], stage, dpi, backup, accepted)
            reason = slides.rejection(data["checks"]) if d["format"] == "pptx" else None
            entry.update(status="rejected" if reason else "ok", reason=reason, seconds=round(time.time() - t0, 1),
                         renderer={k: inst.info.get(k) for k in ("progid", "version")}, **data)
        except Exception as e:
            entry.update(status="error", error=f"{type(e).__name__}: {e}")
        finally:
            statuses.extend(apps.close())
        time.sleep(1)
        entry["records"] = records.diff(before, records.snapshot(), "ooxml-fidelity")
        if not entry["records"]["clean"]:
            entry.update(status="error", error="运行前后最近文档记录有变化，已停止")
        _publish(entry, stage, truth_dir / d["id"])
        results.append(entry)
        print(f"{d['id']}  {entry['status']}  {len(entry.get('pages', []))} 页", flush=True)
        if not entry["records"]["clean"]:
            stopped = d["id"]
            break
    run_info = {"call_dir": str(call_dir), "instances": statuses, "stopped_at": stopped,
                "records_clean": {r["id"]: r["records"]["clean"] for r in results}}
    top = truth_dir / "manifest.json"
    summary = json.loads(top.read_text("utf-8")) if top.exists() else {"documents": [], "runs": []}
    fresh = {r["id"]: {k: r.get(k) for k in ("id", "path", "format", "status", "reason", "error", "seconds",
                                             "method")}
             | {"pages": len(r.get("pages", [])) if r["status"] == "ok" else 0, "checks": r.get("checks")}
             for r in results}
    summary["documents"] = [fresh.pop(e["id"], e) for e in summary["documents"]] + list(fresh.values())
    summary["runs"].append(run_info)
    truth_dir.mkdir(parents=True, exist_ok=True)
    top.write_text(_dumps(summary), "utf-8")
    return {"run": run_info, "results": results}


def _dumps(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)
