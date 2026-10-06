"""xlsx 计算结果写回。

办公软件只读打开工作副本、全量重算，按区域批量读取每个公式单元格的 Value2；再由本模块直接修改工作副本中
这些单元格的缓存值 <v> 与值类型 t，并设置 calcPr fullCalcOnLoad="1"。公式文本、样式与其余部件原样保留。

不要改为由办公软件另存：WPS 另存会写入最近文档与账号打开记录，并重写整个文件包。
"""

import posixpath
import re
import zipfile

from lxml import etree

import util
from com import XL_ERRORS

M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/package/2006/relationships"

# SpecialCells 的 xlCellTypeFormulas。工作表中没有任何公式时该调用抛错。
XL_CELL_TYPE_FORMULAS = -4123


def convert(v):
    """Value2 → (t, 文本)。None 表示没有值；未知错误码返回 ('?', 码)。"""
    if v is None:
        return None
    if isinstance(v, bool):
        return ("b", "1" if v else "0")
    if isinstance(v, int):
        # 数值单元格的 Value2 是 float；int 只出现在错误码上。
        return ("e", XL_ERRORS[v]) if v in XL_ERRORS else ("?", str(v))
    if isinstance(v, float):
        return ("n", str(int(v)) if v.is_integer() and abs(v) < 1e15 else repr(v))
    return ("str", str(v))


def read_values(inst, path):
    """只读打开、全量重算，读取 {工作表: {单元格: (t, 文本)}}。"""
    values = {}
    wb = inst.open(path)
    try:
        inst.app.CalculateFull()
        for idx in range(1, wb.Worksheets.Count + 1):
            ws = wb.Worksheets(idx)
            sheet = values.setdefault(ws.Name, {})
            try:
                rng = ws.UsedRange.SpecialCells(XL_CELL_TYPE_FORMULAS)
            except Exception:
                continue
            for a in range(1, rng.Areas.Count + 1):
                area = rng.Areas(a)
                r0, c0 = area.Row, area.Column
                data = area.Value2
                if not isinstance(data, tuple):
                    data = ((data,),)
                for i, row in enumerate(data):
                    for j, v in enumerate(row):
                        sheet[f"{util.col_letter(c0 + j)}{r0 + i}"] = convert(v)
    finally:
        inst.close_doc(wb)
        del wb
    return values


def sheet_parts(z):
    wb = etree.fromstring(z.read("xl/workbook.xml"))
    rels = etree.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels.findall(f"{{{P}}}Relationship")}
    out = {}
    for s in wb.find(f"{{{M}}}sheets"):
        t = target[s.get(f"{{{R}}}id")]
        path = t.lstrip("/") if t.startswith("/") else posixpath.normpath(posixpath.join("xl", t))
        out[s.get("name")] = path
    return out


def _split_ref(ref):
    m = re.fullmatch(r"([A-Z]+)(\d+)", ref)
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return col, int(m.group(2))


def _cells_in(rng):
    a, _, b = rng.partition(":")
    (c0, r0), (c1, r1) = _split_ref(a), _split_ref(b or a)
    return [f"{util.col_letter(c)}{r}" for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]


def _cell(xml, ref):
    """工作表中 ref 对应的 c 元素；行或单元格不存在时按行号、列号顺序插入。"""
    data = xml.find(f"{{{M}}}sheetData")
    col, row = _split_ref(ref)
    row_el = None
    for r in data.findall(f"{{{M}}}row"):
        n = int(r.get("r"))
        if n == row:
            row_el = r
            break
        if n > row:
            row_el = etree.Element(f"{{{M}}}row", r=str(row))
            r.addprevious(row_el)
            break
    if row_el is None:
        row_el = etree.SubElement(data, f"{{{M}}}row", r=str(row))
    for c in row_el.findall(f"{{{M}}}c"):
        cur = _split_ref(c.get("r"))[0]
        if cur == col:
            return c
        if cur > col:
            new = etree.Element(f"{{{M}}}c", r=ref)
            c.addprevious(new)
            return new
    return etree.SubElement(row_el, f"{{{M}}}c", r=ref)


def _set_value(c, got, report, after=None):
    for old in c.findall(f"{{{M}}}v"):
        c.remove(old)
    c.attrib.pop("t", None)
    if got is None:
        return
    t, text = got
    if t != "n":
        c.set("t", t)
    v = etree.Element(f"{{{M}}}v")
    v.text = text
    if after is not None:
        after.addnext(v)
    else:
        c.append(v)
    report["written"] += 1
    report["types"][t] = report["types"].get(t, 0) + 1


def write_back(path, values):
    """把 values 写入 path 的缓存值。任一公式单元格不一致时不修改文件，报告写回失败。

    数组公式只有左上角的单元格带公式，其余成员单元格只存结果：成员单元格按重算结果写值，缺少的单元格补建。
    """
    report = {"result": "ok", "written": 0, "types": {}, "mismatch": [], "unknown_errors": []}
    replaced = {}
    with zipfile.ZipFile(path) as z:
        parts = sheet_parts(z)
        for name, part in parts.items():
            sheet_values = values.get(name)
            xml = etree.fromstring(z.read(part))
            changed = False
            members = []

            def lookup(ref):
                if sheet_values is None or ref not in sheet_values:
                    report["mismatch"].append(f"{name}!{ref}：重算结果中没有该公式单元格")
                    return False, None
                got = sheet_values[ref]
                if got is not None and got[0] == "?":
                    report["unknown_errors"].append(f"{name}!{ref}：错误码 {got[1]}")
                    return False, None
                return True, got

            for c in xml.iter(f"{{{M}}}c"):
                f = c.find(f"{{{M}}}f")
                if f is None:
                    continue
                ok, got = lookup(c.get("r"))
                if not ok:
                    continue
                _set_value(c, got, report, after=f)
                changed = True
                if f.get("t") == "array" and f.get("ref"):
                    members += [r for r in _cells_in(f.get("ref")) if r != c.get("r")]
            for ref in members:
                ok, got = lookup(ref)
                if ok:
                    _set_value(_cell(xml, ref), got, report)
            if changed:
                replaced[part] = etree.tostring(xml, xml_declaration=True, encoding="UTF-8",
                                                standalone=True)
        wbx = etree.fromstring(z.read("xl/workbook.xml"))
        calc = wbx.find(f"{{{M}}}calcPr")
        if calc is None:
            calc = etree.SubElement(wbx, f"{{{M}}}calcPr")
        calc.set("fullCalcOnLoad", "1")
        replaced["xl/workbook.xml"] = etree.tostring(wbx, xml_declaration=True, encoding="UTF-8",
                                                     standalone=True)
    if report["mismatch"] or report["unknown_errors"]:
        report["result"] = "failed"
        return report
    util.replace_parts(path, replaced)
    return report
