"""docx 目录页码回填。

办公软件只读打开工作副本导出 PDF，按标题文字在目录之后各页出现的位置得到页码，再由本模块改写目录域的结果：
域代码（begin、instrText、separate、end）不动，结果段落换成「条目文字 + 制表符 + 页码」，右对齐点线制表位。
回填后再导出一次核对页码；目录长度变化使页码改变时按新页码再回填一次，仍不一致时报告。

只处理 TOC 域。有标题在导出页面中未找到时，整个目录保留原结果并报告，不推测页码。
不要改为由办公软件更新域并另存：WPS 文字没有 SaveCopyAs，另存会写入最近文档与账号打开记录，并重写整个文件包。
"""

import copy
import re
import zipfile
from pathlib import Path

from lxml import etree

import render
import util

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
DEFAULT_TEXT_WIDTH = 9026  # A4 纵向、左右各 2.54 cm 时的版心宽度（twip）
INDENT_PER_LEVEL = 420  # 每一级目录条目的左缩进（twip）


def _w(tag):
    return f"{{{W}}}{tag}"


def find_toc(body):
    """查找第一个 TOC 域。返回 {begin, code, end, instr}，code 为 begin 到 separate（含）的各个 run。"""
    depth = 0
    cur = None
    for r in body.iter(_w("r")):
        fc = r.find(_w("fldChar"))
        it = r.find(_w("instrText"))
        kind = fc.get(_w("fldCharType")) if fc is not None else None
        if kind == "begin":
            depth += 1
            if depth == 1:
                cur = {"begin": r, "code": [r], "instr": "", "separate": None}
            continue
        if cur is None:
            continue
        if it is not None and depth == 1 and cur["separate"] is None:
            cur["instr"] += it.text or ""
            cur["code"].append(r)
        elif kind == "separate" and depth == 1:
            cur["separate"] = r
            cur["code"].append(r)
        elif kind == "end":
            if depth == 1:
                if cur["instr"].split()[:1] == ["TOC"]:
                    cur["end"] = r
                    return cur
                cur = None
            depth -= 1
    return None


def toc_levels(instr):
    m = re.search(r'\\o\s+"(\d+)-(\d+)"', instr)
    return (int(m.group(1)), int(m.group(2))) if m else (1, 3)


def style_levels(styles):
    """样式 id → 大纲级别（从 1 起）。识别 outlineLvl 与「heading N」样式名，并沿 basedOn 继承。"""
    if styles is None:
        return {}
    direct, based = {}, {}
    for s in styles.findall(_w("style")):
        sid = s.get(_w("styleId"))
        name = s.find(_w("name"))
        ol = s.find(f"{_w('pPr')}/{_w('outlineLvl')}")
        if ol is not None and ol.get(_w("val")) is not None:
            direct[sid] = int(ol.get(_w("val"))) + 1
        elif name is not None:
            m = re.fullmatch(r"heading (\d)", (name.get(_w("val")) or "").strip().lower())
            if m:
                direct[sid] = int(m.group(1))
        b = s.find(_w("basedOn"))
        if b is not None:
            based[sid] = b.get(_w("val"))
    out = {}
    for sid in set(direct) | set(based):
        cur, seen = sid, 0
        while cur is not None and cur not in direct and seen < 10:
            cur, seen = based.get(cur), seen + 1
        if cur in direct:
            out[sid] = direct[cur]
    return out


def _visible_text(p):
    """段落中未设为隐藏（w:vanish）的文字。隐藏文字不出现在导出页面中，无法确定页码。"""
    parts = []
    for r in p.iter(_w("r")):
        rpr = r.find(_w("rPr"))
        v = rpr.find(_w("vanish")) if rpr is not None else None
        if v is not None and v.get(_w("val"), "true") not in ("false", "0", "off"):
            continue
        parts.extend(t.text or "" for t in r.iter(_w("t")))
    return "".join(parts)


def headings_after(body, end_run, levels, slevels):
    """目录域之后、在目录级别范围内的标题 [(级别, 文字)]。整段均为隐藏文字的标题不列入目录。"""
    end_p = end_run.getparent()
    after = False
    out = []
    for p in body.iter(_w("p")):
        if p is end_p:
            after = True
            continue
        if not after:
            continue
        ppr = p.find(_w("pPr"))
        lvl = None
        if ppr is not None:
            ol = ppr.find(_w("outlineLvl"))
            ps = ppr.find(_w("pStyle"))
            if ol is not None:
                lvl = int(ol.get(_w("val"))) + 1
            elif ps is not None:
                lvl = slevels.get(ps.get(_w("val")))
        if lvl is None or not (levels[0] <= lvl <= levels[1]):
            continue
        text = _visible_text(p).strip()
        if text:
            out.append((lvl, text))
    return out


# 标题前的自动编号（多级列表）：它不在 w:t 中，只出现在导出页面上。
NUMBERING = re.compile(r"\d+(?:[.．]\d+)*[.．、]?|第[一二三四五六七八九十百零〇\d]+[章节部分篇条]"
                       r"|[一二三四五六七八九十]+、|[（(][一二三四五六七八九十\d]+[)）]")


def _stripped(raw):
    """去除空白后的文字，以及每个字符在原文中的位置。导出文字的中英文之间会插入空格，比较前须去除。"""
    chars, pos = [], []
    for i, ch in enumerate(raw):
        if not ch.isspace():
            chars.append(ch)
            pos.append(i)
    return "".join(chars), pos


def _line_start(raw, i):
    return max(raw.rfind("\n", 0, i), raw.rfind("\r", 0, i)) + 1


def _ends_line(raw, end):
    j = end
    while j < len(raw) and raw[j] in " \t　":
        j += 1
    return j == len(raw) or raw[j] in "\r\n"


def locate(headings, page_texts):
    """按文档顺序在导出页面中查找每个标题：[(页码, 目录条目文字)]，未找到为 None。

    正文中的标题独占一段：匹配处之后紧跟换行，前面是行首、空白或自动编号。目录条目之后是点线与页码，
    正文句子中的相同文字前后还有其他字符，两者都不算匹配。不要改为「后面紧跟数字就跳过」：
    下一行以编号开头（「1.2.1 …」）时，去除换行后标题之后即为数字。
    查找位置按页与页内偏移向后推进，同名标题按出现顺序对应。
    导出文字有时把标题接在上一段末行之后，仅隔一个空格，因此前面是空白也算匹配。
    条目文字包含页面上显示的自动编号。
    """
    pages = [(raw, *_stripped(raw)) for raw in page_texts]
    out = []
    cur_page, cur_off = 0, 0
    for _, text in headings:
        h = re.sub(r"\s+", "", text)
        found = None
        for pi in range(cur_page, len(pages)):
            raw, flat, pos = pages[pi]
            k = flat.find(h, cur_off if pi == cur_page else 0)
            while k != -1 and h:
                start, end = pos[k], pos[k + len(h) - 1] + 1
                before = re.sub(r"\s+", "", raw[_line_start(raw, start):start])
                starts = not before or raw[start - 1].isspace() or NUMBERING.fullmatch(before)
                if starts and _ends_line(raw, end):
                    label = f"{before} {text}" if before and NUMBERING.fullmatch(before) else text
                    found = (pi, k, label)
                    break
                k = flat.find(h, k + 1)
            if found is not None:
                break
        if found is None:
            out.append(None)
            continue
        pi, k, label = found
        out.append((pi + 1, label))
        cur_page, cur_off = pi, k + len(h)
    return out


def text_width(body):
    sect = body.find(_w("sectPr"))
    if sect is None:
        return DEFAULT_TEXT_WIDTH
    pg, mar = sect.find(_w("pgSz")), sect.find(_w("pgMar"))
    if pg is None or mar is None:
        return DEFAULT_TEXT_WIDTH
    return int(pg.get(_w("w"))) - int(mar.get(_w("left"), 0)) - int(mar.get(_w("right"), 0))


def _entry(level, text, page, width, styled):
    p = etree.Element(_w("p"))
    ppr = etree.SubElement(p, _w("pPr"))
    if styled:
        etree.SubElement(ppr, _w("pStyle")).set(_w("val"), f"TOC{level}")
    tabs = etree.SubElement(ppr, _w("tabs"))
    tab = etree.SubElement(tabs, _w("tab"))
    tab.set(_w("val"), "right")
    tab.set(_w("leader"), "dot")
    tab.set(_w("pos"), str(width))
    ind = etree.SubElement(ppr, _w("ind"))
    ind.set(_w("left"), str((level - 1) * INDENT_PER_LEVEL))
    r = etree.SubElement(p, _w("r"))
    t = etree.SubElement(r, _w("t"))
    t.set(XML_SPACE, "preserve")
    t.text = text
    etree.SubElement(etree.SubElement(p, _w("r")), _w("tab"))
    t2 = etree.SubElement(etree.SubElement(p, _w("r")), _w("t"))
    t2.text = str(page)
    return p


def rewrite_toc(document_xml: bytes, entries, styled_levels: set) -> bytes:
    """改写目录域结果。entries 为 [(级别, 文字, 页码)]；结构不支持时抛 ValueError。"""
    doc = etree.fromstring(document_xml)
    body = doc.find(_w("body"))
    toc = find_toc(body)
    if toc is None:
        raise ValueError("文档中没有目录域")
    begin, end = toc["begin"], toc["end"]
    p_b, p_e = begin.getparent(), end.getparent()
    if etree.QName(p_b).localname != "p" or etree.QName(p_e).localname != "p":
        raise ValueError("目录域不在普通段落中，本工具不支持该结构")
    container = p_b.getparent()
    if p_e.getparent() is not container:
        raise ValueError("目录域的开始与结束不在同一层级，本工具不支持该结构")
    kids = list(container)
    i_b, i_e = kids.index(p_b), kids.index(p_e)

    prefix = []
    for child in p_b:
        if child is begin:
            break
        if etree.QName(child).localname != "pPr":
            prefix.append(child)
    suffix = []
    seen_end = False
    for child in p_e:
        if seen_end:
            suffix.append(child)
        elif child is end:
            seen_end = True

    code = [copy.deepcopy(r) for r in toc["code"]]
    for r in code:
        fc = r.find(_w("fldChar"))
        if fc is not None:
            fc.attrib.pop(_w("dirty"), None)
    if toc["separate"] is None:
        sep = etree.Element(_w("r"))
        etree.SubElement(sep, _w("fldChar")).set(_w("fldCharType"), "separate")
        code.append(sep)

    width = text_width(body)
    new = []
    if prefix:
        head = etree.Element(_w("p"))
        ppr = p_b.find(_w("pPr"))
        if ppr is not None:
            head.append(copy.deepcopy(ppr))
        for c in prefix:
            head.append(copy.deepcopy(c))
        new.append(head)
    for n, (level, text, page) in enumerate(entries):
        p = _entry(level, text, page, width, level in styled_levels)
        if n == 0:
            ppr = p.find(_w("pPr"))
            for r in reversed(code):
                ppr.addnext(r)
        new.append(p)
    new[-1].append(copy.deepcopy(end))
    if suffix:
        tail = etree.Element(_w("p"))
        ppr = p_e.find(_w("pPr"))
        if ppr is not None:
            tail.append(copy.deepcopy(ppr))
        for c in suffix:
            tail.append(copy.deepcopy(c))
        new.append(tail)

    for k in kids[i_b: i_e + 1]:
        container.remove(k)
    for offset, p in enumerate(new):
        container.insert(i_b + offset, p)
    return etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)


def _export_texts(path, apps, pdf_path):
    inst = apps.get("docx")
    doc = inst.open(path)
    try:
        doc.ExportAsFixedFormat(str(pdf_path), 17)
    finally:
        inst.close_doc(doc)
        del doc
    return render.page_texts(pdf_path)


def update(path, apps, call_dir):
    """回填目录页码。返回 {status, detail, entries, passes}；status 取 completed / failed / not_run。"""
    with zipfile.ZipFile(path) as z:
        document_xml = z.read("word/document.xml")
        styles = etree.fromstring(z.read("word/styles.xml")) if "word/styles.xml" in z.namelist() else None
    body = etree.fromstring(document_xml).find(_w("body"))
    toc = find_toc(body)
    if toc is None:
        return {"status": "not_run", "detail": "文档中没有目录域（TOC）"}
    levels = toc_levels(toc["instr"])
    headings = headings_after(body, toc["end"], levels, style_levels(styles))
    if not headings:
        return {"status": "failed",
                "detail": f"目录之后没有 {levels[0]}–{levels[1]} 级标题，目录保留原结果"}
    style_ids = {s.get(_w("styleId")) for s in styles.findall(_w("style"))} if styles is not None else set()
    styled = {lvl for lvl in range(1, 10) if f"TOC{lvl}" in style_ids}

    found = locate(headings, _export_texts(path, apps, Path(call_dir) / "toc-pass1.pdf"))
    missing = [i for i, f in enumerate(found) if f is None]
    if missing:
        detail = "；".join(f"目录第 {i + 1} 条页码未确认：{headings[i][1]}" for i in missing[:10])
        return {"status": "failed", "detail": detail + "。目录保留原结果"}
    passes = 0
    for n in range(2, 4):
        entries = [(lvl, label, page) for (lvl, _), (page, label) in zip(headings, found)]
        try:
            new_xml = rewrite_toc(document_xml, entries, styled)
        except ValueError as e:
            return {"status": "failed", "detail": f"{e}。目录保留原结果"}
        util.replace_parts(path, {"word/document.xml": new_xml})
        passes += 1
        pdf = Path(call_dir) / f"toc-pass{n}.pdf"
        check = locate(headings, _export_texts(path, apps, pdf))
        if check == found:
            return {"status": "completed", "detail": f"回填 {len(entries)} 条目录页码",
                    "entries": len(entries), "passes": passes, "pdf": str(pdf)}
        if None in check:
            util.replace_parts(path, {"word/document.xml": document_xml})
            return {"status": "failed", "passes": passes,
                    "detail": "回填后按导出页面核对时未找到部分标题，目录保留原结果"}
        found = check
    return {"status": "failed", "passes": passes,
            "detail": "回填后目录页数变化，两次回填页码仍不一致；目录中的页码可能有偏差"}
