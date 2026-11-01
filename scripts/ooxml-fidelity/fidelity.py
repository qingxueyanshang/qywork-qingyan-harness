"""Office 文档预览的保真对比基准：语料检索、WPS 屏幕显示真值采集、逐页 SSIM 打分。

运行（解释器与 office 工具相同，见 packages/runtime/src/office.ts 的 findPython）：
  python scripts/ooxml-fidelity/fidelity.py corpus [--must <路径>]   检索语料，写入 corpus.json
  python scripts/ooxml-fidelity/fidelity.py truth [--only <标识或格式>] [--dpi 96] [--out <目录>]
                                                        采集真值，缺省写入 truth/<文档标识>/
  python scripts/ooxml-fidelity/fidelity.py pdf [--only …]   导出 PDF 并栅格化，写入 candidates/wps-pdf/（只用于检验打分流程）
  python scripts/ooxml-fidelity/fidelity.py score --candidates <目录> [--truth <目录>] [--format <格式>…] [--name report]
                                                        打分，写入 <name>.md 与 <name>.json；--format 只计入给定格式的文档
  python scripts/ooxml-fidelity/fidelity.py restore-clipboard   采集异常结束后写回用户剪贴板
  python -m unittest discover -s scripts/ooxml-fidelity/tests   打分、EMF 回放与幻灯片核对的单元测试
产物位于 .tmp/ooxml-fidelity/，语料与图片不入库。

候选目录与真值目录结构相同：<文档标识>/page-0001.png 起逐页编号；xlsx 的页即可见工作表，顺序见真值清单。
docx 与 xlsx 的真值只取 WPS 屏幕显示，不使用任何导出路径（ExportAsFixedFormat、SaveAs、打印）。
pptx 的屏幕显示无法在不显示窗口的条件下取得，真值取 Slide.Export 的导出图，逐页与 Slide.Copy 的缩略图核对（见 slides.py）；
人工核对接受的不一致页登记在 pptx-review.json。
依赖：pywin32、psutil、Pillow、numpy、pypdfium2（office 工具的依赖已包含）。
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / ".tmp" / "ooxml-fidelity"
sys.path.insert(0, str(ROOT / "packages" / "runtime" / "office"))
sys.path.insert(0, str(HERE))

import corpus  # noqa: E402

HOME = Path.home()
AI_ROOTS = [HOME / ".qywork" / "workspaces"]


def _shell_folder(name):
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as k:
            return Path(os.path.expandvars(winreg.QueryValueEx(k, name)[0]))
    except OSError:
        return None


def default_roots():
    roots = [HOME / "Desktop", HOME / "Documents", HOME / "Downloads", *AI_ROOTS,
             _shell_folder("Personal"), _shell_folder("{374DE290-123F-4565-9164-39C4925E467B}")]
    out, seen = [], set()
    for r in roots:
        if r is None:
            continue
        key = os.path.normcase(str(r))
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def _write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), "utf-8")


def cmd_corpus(args):
    roots = [Path(r) for r in args.root] if args.root else default_roots()
    t0 = time.time()
    must = args.must or []
    files = [f for f in corpus.find(roots)
             if not os.path.normcase(os.path.abspath(f[0])).startswith(os.path.normcase(str(ROOT)))]
    files += [(m, corpus.EXTS[Path(m).suffix.lower()]) for m in must if Path(m).is_file()]
    files = list({os.path.normcase(os.path.abspath(f[0])): f for f in files}.values())
    found = []
    for path, fmt in files:
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        found.append((path, fmt, corpus.features(path, fmt), size))
    quota = {"docx": args.docx, "pptx": args.pptx, "xlsx": args.xlsx}
    picked = corpus.select(found, must, AI_ROOTS, quota)
    missing = [m for m in must if not Path(m).is_file()]
    counts = {}
    for _, fmt, feats, _ in found:
        c = counts.setdefault(fmt, {"found": 0, "unreadable": 0})
        c["found"] += 1
        c["unreadable"] += 1 if "error" in feats else 0
    data = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "roots": [str(r) for r in roots],
            "scanned": counts, "seconds": round(time.time() - t0, 1), "must_missing": missing,
            "documents": picked}
    _write_json(OUT / "corpus.json", data)
    for d in picked:
        print(f"{d['id']}  {d['format']}  {Path(d['path']).name}  {d['reason']}")
    print(f"共 {len(picked)} 份，写入 {OUT / 'corpus.json'}")


def _load_corpus(args):
    data = json.loads((OUT / "corpus.json").read_text("utf-8"))
    docs = data["documents"]
    if args.only:
        docs = [d for d in docs if d["id"] in args.only or d["format"] in args.only]
    return docs


def cmd_truth(args):
    import capture

    docs = _load_corpus(args)
    out = Path(args.out) if args.out else OUT / "truth"
    review_file = OUT / "pptx-review.json"
    review = json.loads(review_file.read_text("utf-8"))["accepted"] if review_file.exists() else []
    result = capture.run(docs, out, OUT / "call", args.dpi, review)
    print(json.dumps(result["run"], ensure_ascii=False, indent=2, default=str))


def cmd_pdf(args):
    import pdf_candidates

    docs = _load_corpus(args)
    out = Path(args.out) if args.out else OUT / "candidates" / "wps-pdf"
    result = pdf_candidates.run(docs, out, OUT / "call", args.dpi)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_score(args):
    import score

    truth = Path(args.truth) if args.truth else OUT / "truth"
    formats = set(args.format) if args.format else None
    report = score.run(truth, Path(args.candidates), OUT / (args.name + ".json"), OUT / (args.name + ".md"),
                       formats)
    print(f"{report['pages']} 页，平均 {report['mean']:.4f}，写入 {OUT / (args.name + '.md')}")


def cmd_restore_clipboard(args):
    import clipboard

    found = sorted((OUT / "call").glob("*/clipboard-backup"), key=lambda d: d.stat().st_mtime)
    if not found:
        print("没有剪贴板备份")
        return
    clipboard.restore_file(found[-1])
    print(f"已从 {found[-1]} 写回剪贴板")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["TEMP"] = os.environ["TMP"] = str(OUT / "tmp")
    (OUT / "tmp").mkdir(parents=True, exist_ok=True)
    p = argparse.ArgumentParser(prog="fidelity.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("corpus")
    c.add_argument("--root", action="append", help="检索根目录，可重复；缺省为桌面、文档、下载与 AI 工作区")
    c.add_argument("--must", action="append", help="必测文档路径，可重复；无论特征如何都入选")
    c.add_argument("--docx", type=int, default=6)
    c.add_argument("--pptx", type=int, default=4)
    c.add_argument("--xlsx", type=int, default=5)
    for name in ("truth", "pdf"):
        s = sub.add_parser(name)
        s.add_argument("--only", nargs="*", help="只处理给定标识或格式")
        s.add_argument("--dpi", type=float, default=96.0, help="docx 的输出分辨率；xlsx 与 pptx 固定为 96 dpi")
        s.add_argument("--out", help="输出目录，缺省为 truth/ 或 candidates/wps-pdf/")
    sub.add_parser("restore-clipboard", help="采集异常结束后，把最近一次的剪贴板备份写回")
    s = sub.add_parser("score")
    s.add_argument("--candidates", required=True)
    s.add_argument("--truth")
    s.add_argument("--format", nargs="+", choices=sorted(set(corpus.EXTS.values())),
                   help="只计入给定格式的文档，可给出多个；缺省为全部格式")
    s.add_argument("--name", default="report")
    args = p.parse_args()
    {"corpus": cmd_corpus, "truth": cmd_truth, "pdf": cmd_pdf, "score": cmd_score,
     "restore-clipboard": cmd_restore_clipboard}[args.cmd](args)


if __name__ == "__main__":
    main()
