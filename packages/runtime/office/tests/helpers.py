"""测试共用函数：把 office 目录加入导入路径，创建临时目录，生成样本文件。

临时目录取自 tempfile，受 TEMP / TMP / TMPDIR 控制；门禁把它们设置为仓库 .tmp 下的目录。
"""

import shutil
import sys
import tempfile
from pathlib import Path

OFFICE_DIR = Path(__file__).resolve().parent.parent
if str(OFFICE_DIR) not in sys.path:
    sys.path.insert(0, str(OFFICE_DIR))


class TempDir:
    def __enter__(self):
        self.path = Path(tempfile.mkdtemp(prefix="qy-office-test-"))
        return self.path

    def __exit__(self, *exc):
        shutil.rmtree(self.path, ignore_errors=True)


def ole_file(path, entries):
    """OLE 复合文件（版本 3，512 字节扇区）：entries 为 (名称, 类型) 或 (名称, 类型, 内容) 的列表，类型 1 为存储、2 为流，
    依次为根存储的子项。

    第 0 个扇区为 FAT，目录自第 1 个扇区起经 FAT 链接，每个扇区 4 项；流的内容不短于 4096 字节（普通扇区），
    依次写在目录之后，没有内容的项长度为 0。
    """
    import struct

    end, free, fat_sector, none = 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFD, 0xFFFFFFFF
    items = [("Root Entry", 5, b"")] + [(*e, b"")[:3] for e in entries]
    count = (len(items) + 3) // 4
    fat = [fat_sector] + [s + 1 for s in range(1, count)] + [end]
    starts, body = [], bytearray()
    for _, _, data in items:
        sectors = (len(data) + 511) // 512
        starts.append(len(fat) if sectors else end)
        fat += [len(fat) + k + 1 for k in range(sectors - 1)] + ([end] if sectors else [])
        body += data + bytes(sectors * 512 - len(data))
    fat += [free] * (128 - len(fat))
    header = bytearray(512)
    header[0:8] = bytes.fromhex("d0cf11e0a1b11ae1")
    struct.pack_into("<HHHHH", header, 24, 0x3E, 3, 0xFFFE, 9, 6)
    struct.pack_into("<IIIIIIII", header, 44, 1, 1, 0, 4096, end, 0, end, 0)
    struct.pack_into("<109I", header, 76, 0, *([free] * 108))
    directory = bytearray(count * 512)
    for i, (name, kind, data) in enumerate(items):
        p = i * 128
        raw = name.encode("utf-16-le")
        directory[p:p + len(raw)] = raw
        right = i + 1 if 0 < i < len(items) - 1 else none
        child = 1 if i == 0 and len(items) > 1 else none
        struct.pack_into("<HBBIII", directory, p + 64, len(raw) + 2, kind, 1, none, right, child)
        struct.pack_into("<II", directory, p + 116, starts[i], len(data))
    Path(path).write_bytes(bytes(header) + struct.pack("<128I", *fat) + bytes(directory) + bytes(body))
    return path


def toc_docx(path, prefix_title=False):
    """带一个 TOC 域（占位结果，dirty）和两级标题的 docx。"""
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    doc = Document()
    p = doc.add_paragraph("目录" if prefix_title else None)

    def run_with(el):
        r = OxmlElement("w:r")
        r.append(el)
        p._p.append(r)

    b = OxmlElement("w:fldChar")
    b.set(qn("w:fldCharType"), "begin")
    b.set(qn("w:dirty"), "true")
    run_with(b)
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = 'TOC \\o "1-2" \\h \\z \\u'
    run_with(it)
    s = OxmlElement("w:fldChar")
    s.set(qn("w:fldCharType"), "separate")
    run_with(s)
    t = OxmlElement("w:t")
    t.text = "（目录待更新）"
    run_with(t)
    e = OxmlElement("w:fldChar")
    e.set(qn("w:fldCharType"), "end")
    run_with(e)
    doc.add_heading("第一章 概述", level=1)
    doc.add_paragraph("正文一。")
    doc.add_heading("1.1 背景", level=2)
    doc.add_paragraph("正文二。")
    doc.add_heading("第二章 市场", level=1)
    doc.add_heading("三级标题不进目录", level=3)
    doc.save(path)
    return path
