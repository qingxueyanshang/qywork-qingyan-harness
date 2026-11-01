"""检验打分流程用的候选组：WPS 导出 PDF 后按真值的 dpi 栅格化。

这组图片走导出路径，与屏幕显示已知不一致（页面背景为整页拉伸图片时，导出结果平铺约 5×6 块），
只用于确认打分能区分此类差异，不得作为真值。只处理 docx：xlsx 的 PDF 按打印分页，
与真值的工作表区域不对应；pptx 没有真值。
"""

import json
import time
from pathlib import Path

import com
import records

WD_EXPORT_PDF = 17


def run(docs, out_dir: Path, call_root: Path, dpi: float) -> dict:
    import pypdfium2 as pdfium

    call_dir = call_root / ("pdf-" + time.strftime("%Y%m%d-%H%M%S"))
    call_dir.mkdir(parents=True, exist_ok=True)
    before = records.snapshot()
    results = []
    apps = com.Apps(call_dir, "fidelity-pdf")
    try:
        for d in docs:
            if d["format"] != "docx":
                results.append({"id": d["id"], "status": "skipped", "reason": "只处理 docx"})
                continue
            target = out_dir / d["id"]
            target.mkdir(parents=True, exist_ok=True)
            for old in target.glob("page-*.png"):
                old.unlink()
            pdf_path = call_dir / f"{d['id']}.pdf"
            try:
                inst = apps.get("docx")
                doc = inst.open(d["path"])
                try:
                    doc.ExportAsFixedFormat(str(pdf_path), WD_EXPORT_PDF)
                finally:
                    inst.close_doc(doc)
                pdf = pdfium.PdfDocument(str(pdf_path))
                try:
                    for i in range(len(pdf)):
                        page = pdf[i]
                        page.render(scale=dpi / 72).to_pil().convert("RGB").save(target / f"page-{i + 1:04d}.png")
                        page.close()
                    count = len(pdf)
                finally:
                    pdf.close()
                results.append({"id": d["id"], "status": "ok", "pages": count})
            except Exception as e:
                results.append({"id": d["id"], "status": "error", "error": f"{type(e).__name__}: {e}"})
            print(f"{d['id']}  {results[-1]['status']}", flush=True)
    finally:
        statuses = apps.close()
    time.sleep(1)
    run_info = {"call_dir": str(call_dir), "dpi": dpi, "instances": statuses, "documents": results,
                "records": records.diff(before, records.snapshot(), "ooxml-fidelity")}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "run.json").write_text(json.dumps(run_info, ensure_ascii=False, indent=2), "utf-8")
    return run_info
