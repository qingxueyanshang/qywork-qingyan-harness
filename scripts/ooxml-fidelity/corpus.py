"""语料检索：在本机目录中查找 docx / xlsx / pptx，读取包内结构判定特征，按特征覆盖挑选语料。

只读取文件，不复制、不修改。特征只从 zip 包的部件名与 XML 文本中按标记计数，不解析 XML 树。
挑选规则：必测文档先入选；其余按「新覆盖的特征数」从多到少逐个选入，相同时取页数（或大小）较小者；
特征全部覆盖后按特征数从多到少补足配额。同名不同副本（「(1)」「(2)」后缀）只选一份；
每种格式至少一份来自 AI 产出目录（存在时）。
"""

import hashlib
import os
import re
import zipfile
from pathlib import Path

EXTS = {".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx"}
# 代码仓库中的测试样例是生成的文件，不代表用户文档。
SKIP_DIRS = {"node_modules", ".git", ".tmp", "__pycache__", "$RECYCLE.BIN", "site-packages",
             "fixtures", "tests", "test", "testdata"}
# 每个部件最多读取的字节数：特征标记在前若干 MB 内即可判定，超大的 XML 不整份读入。
PART_LIMIT = 32 << 20


def doc_id(path: str, fmt: str) -> str:
    """按规范化路径计算的稳定标识，真值目录与候选目录都按它命名。"""
    norm = os.path.normcase(os.path.abspath(path))
    return f"{fmt}-{hashlib.sha1(norm.encode('utf-8')).hexdigest()[:8]}"


def _read(z, name) -> str:
    with z.open(name) as f:
        return f.read(PART_LIMIT).decode("utf-8", "replace")


def _count(names, pattern) -> int:
    rx = re.compile(pattern)
    return sum(1 for n in names if rx.search(n))


def _docx(z, names) -> dict:
    body = _read(z, "word/document.xml")
    feats = {
        "tables": body.count("<w:tbl>"),
        "images": _count(names, r"^word/media/"),
        "charts": _count(names, r"^word/charts/chart\d+\.xml$"),
        "floating": body.count("<wp:anchor"),
        "sections": body.count("<w:sectPr"),
        "headers": _count(names, r"^word/header\d+\.xml$"),
        "textboxes": body.count("<wps:txbx") + body.count("<v:textbox"),
        "smartart": _count(names, r"^word/diagrams/data\d+\.xml$"),
        "equations": body.count("<m:oMath>") + body.count("<m:oMath "),
        "columns": len(re.findall(r'<w:cols [^>]*w:num="[2-9]"', body)),
    }
    bg = re.search(r"<w:background\b.*?</w:background>", body, re.S)
    if bg:
        fill = re.search(r'<v:fill\b[^>]*type="(\w+)"', bg.group(0))
        feats["background"] = fill.group(1) if fill else "color"
    if "docProps/app.xml" in names:
        m = re.search(r"<Pages>(\d+)</Pages>", _read(z, "docProps/app.xml"))
        feats["pages"] = int(m.group(1)) if m else None
    return feats


def _xlsx(z, names) -> dict:
    wb = _read(z, "xl/workbook.xml")
    sheets = [n for n in names if re.match(r"^xl/worksheets/sheet\d+\.xml$", n)]
    feats = {"sheets": wb.count("<sheet "), "hidden_sheets": len(re.findall(r'<sheet [^>]*state="(?:hidden|veryHidden)"', wb)),
             "merged": 0, "frozen": 0, "conditional": 0, "autofilter": 0, "no_gridlines": 0,
             "charts": _count(names, r"^xl/charts/chart\d+\.xml$"),
             "images": _count(names, r"^xl/media/"),
             "chartsheets": _count(names, r"^xl/chartsheets/sheet\d+\.xml$"),
             "cells": 0}
    for n in sheets:
        s = _read(z, n)
        feats["merged"] += s.count("<mergeCell ")
        feats["frozen"] += 1 if re.search(r'<pane [^>]*state="frozen', s) else 0
        feats["conditional"] += s.count("<conditionalFormatting")
        feats["autofilter"] += 1 if "<autoFilter" in s else 0
        feats["no_gridlines"] += 1 if 'showGridLines="0"' in s else 0
        feats["cells"] += s.count("<c ")
    return feats


def _pptx(z, names) -> dict:
    slides = [n for n in names if re.match(r"^ppt/slides/slide\d+\.xml$", n)]
    feats = {"slides": len(slides), "images": _count(names, r"^ppt/media/.*\.(png|jpe?g|gif|bmp|emf|wmf|svg)$"),
             "charts": _count(names, r"^ppt/charts/chart\d+\.xml$"),
             "smartart": _count(names, r"^ppt/diagrams/data\d+\.xml$"),
             "video": _count(names, r"^ppt/media/.*\.(mp4|wmv|avi|mov|mp3|wav|m4a)$"),
             "tables": 0, "groups": 0, "slide_backgrounds": 0}
    for n in slides:
        s = _read(z, n)
        feats["tables"] += s.count("<a:tbl>")
        feats["groups"] += s.count("<p:grpSp>")
        feats["slide_backgrounds"] += 1 if "<p:bg>" in s else 0
    pres = _read(z, "ppt/presentation.xml")
    m = re.search(r'<p:sldSz cx="(\d+)" cy="(\d+)"', pres)
    if m:
        feats["slide_size"] = f"{int(m.group(1)) / 914400 * 2.54:.2f}x{int(m.group(2)) / 914400 * 2.54:.2f}cm"
    return feats


def features(path: str, fmt: str) -> dict:
    """返回特征字典；无法读取的文件返回 {"error": 原因}。"""
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            if any(n.lower().endswith("vbaproject.bin") for n in names):
                return {"error": "含宏"}
            return {"docx": _docx, "xlsx": _xlsx, "pptx": _pptx}[fmt](z, names)
    except zipfile.BadZipFile:
        return {"error": "不是 zip 包（加密或损坏）"}
    except (KeyError, OSError) as e:
        return {"error": f"缺少部件或无法读取：{e}"}


def find(roots) -> list:
    out, seen = [], set()
    for root in roots:
        root = Path(root)
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                fmt = EXTS.get(Path(name).suffix.lower())
                if fmt is None or name.startswith("~$"):
                    continue
                full = os.path.join(dirpath, name)
                key = os.path.normcase(os.path.abspath(full))
                if key not in seen:
                    seen.add(key)
                    out.append((full, fmt))
    return out


def _tags(fmt: str, f: dict) -> set:
    """特征字典转为用于覆盖计数的标签集合。"""
    tags = set()
    for k, v in f.items():
        if k in ("pages", "slides", "sheets", "cells", "slide_size", "sections"):
            continue
        if k == "background":
            tags.add(f"background:{v}")
        elif isinstance(v, int) and v > 0:
            tags.add(k)
    if fmt == "xlsx" and f.get("sheets", 0) > 1:
        tags.add("multi_sheet")
    if fmt == "docx" and f.get("sections", 0) > 1:
        tags.add("multi_section")
    return tags


def _stem(path: str) -> str:
    return re.sub(r"(\(\d+\))+$", "", Path(path).stem).strip()


def _weight(fmt: str, f: dict, size: int) -> float:
    if fmt == "docx":
        return f.get("pages") or size / 50000
    if fmt == "pptx":
        return f.get("slides", 0) + size / 5_000_000
    return f.get("cells", 0) / 200 + f.get("sheets", 0)


def select(found, must, ai_roots, per_format: dict) -> list:
    """found 为 [(路径, 格式, 特征, 大小)]。返回入选条目及理由。"""
    ai_keys = [os.path.normcase(os.path.abspath(r)) for r in ai_roots]

    def is_ai(p):
        return any(os.path.normcase(os.path.abspath(p)).startswith(k) for k in ai_keys)

    picked = []
    for fmt, quota in per_format.items():
        pool = [x for x in found if x[1] == fmt and "error" not in x[2]]
        chosen, covered, stems = [], set(), set()

        def take(item, reason):
            chosen.append({**_entry(item, is_ai(item[0])), "reason": reason})
            covered.update(_tags(fmt, item[2]))
            stems.add(_stem(item[0]))

        for item in pool:
            if any(os.path.normcase(os.path.abspath(item[0])) == os.path.normcase(os.path.abspath(m)) for m in must):
                take(item, "必测文档：" + "、".join(sorted(_tags(fmt, item[2]))))
        ai_pool = [x for x in pool if is_ai(x[0])]
        if ai_pool and not any(c["source"] == "ai" for c in chosen):
            best = max(ai_pool, key=lambda x: (len(_tags(fmt, x[2])), -_weight(fmt, x[2], x[3])))
            take(best, "AI 产出文档：" + ("、".join(sorted(_tags(fmt, best[2]))) or "纯文本与基础格式"))
        while len(chosen) < quota:
            rest = [x for x in pool if _stem(x[0]) not in stems]
            gains = [(len(_tags(fmt, x[2]) - covered), -_weight(fmt, x[2], x[3]), x) for x in rest]
            if not gains:
                break
            gain, _, best = max(gains, key=lambda g: (g[0], g[1]))
            if gain > 0:
                take(best, "新覆盖：" + "、".join(sorted(_tags(fmt, best[2]) - covered)))
                continue
            best = max(rest, key=lambda x: (len(_tags(fmt, x[2])), -_weight(fmt, x[2], x[3])))
            take(best, "补足配额，特征组合：" + "、".join(sorted(_tags(fmt, best[2]))))
        picked.extend(chosen)
    return picked


def _entry(item, ai: bool) -> dict:
    path, fmt, feats, size = item
    return {"id": doc_id(path, fmt), "path": path, "format": fmt, "size": size,
            "source": "ai" if ai else "user", "features": feats}
