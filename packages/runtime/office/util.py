"""worker 各模块共用的函数：哈希、JSON 读写、原子替换、格式判定、宏检测。"""

import hashlib
import json
import os
import shutil
import struct
import uuid
import zipfile
from pathlib import Path

FORMATS = {".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx"}

# 带宏的格式在打开前一律拒绝：本机 WPS 无法取得 VBProject，禁用宏的效果未经验证。
MACRO_EXTS = {".docm", ".dotm", ".xlsm", ".xltm", ".xlsb", ".pptm", ".potm", ".ppsm"}


def sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_or_none(path):
    return sha256(path) if Path(path).is_file() else None


def read_json(path):
    return json.loads(Path(path).read_text("utf-8"))


def write_json(path, data) -> None:
    """先写临时文件再替换：读方只会读到完整的 JSON。"""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), "utf-8")
    os.replace(tmp, path)


def atomic_copy(src, dst) -> None:
    """同目录临时文件加 os.replace：目标文件只会是旧内容或新内容，不会停留在写入一半的状态。"""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.name}.qy-{uuid.uuid4().hex}.tmp")
    try:
        shutil.copyfile(src, tmp)
        os.replace(tmp, dst)
    finally:
        if tmp.exists():
            tmp.unlink()


def fmt_of(path):
    return FORMATS.get(Path(path).suffix.lower())


def is_pdf(path) -> bool:
    return Path(path).suffix.lower() == ".pdf"


def same_path(a, b) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


OLE_SIGNATURE = bytes.fromhex("d0cf11e0a1b11ae1")

# OLE 复合文件中存放宏的存储：Excel 97–2003 为 _VBA_PROJECT_CUR，Word 97–2003 为 Macros。
OLE_MACRO_STORAGES = {"_vba_project_cur", "macros"}

# PowerPoint 97–2003 的 VBA 工程不在复合文件目录中，而是 PowerPoint Document 流中的持久对象：
# VBAInfoContainer（记录头 1F 00 FF 03 14 00 00 00）内的 VBAInfoAtom（记录头 02 00 00 04 0C 00 00 00），
# 其后 4 字节的 persistIdRef 不为 0 时指向 VBA 工程的存储。
PPT_VBA_INFO = bytes.fromhex("1f00ff0314000000020000040c000000")


def has_macros(path) -> bool:
    """扩展名是带宏格式，zip 包中含有 vbaProject.bin，OLE 复合文件的目录中有宏存储，或 .ppt 带 VBA 工程。

    OLE 复合文件逐项检查目录中的全部已分配项，不只检查根存储的直接子项：嵌入对象（Word 的 ObjectPool）中的工作簿
    同样可能带宏存储。PowerPoint Document 流中每一处 VBAInfoAtom 都检查：快速保存的文件中较早的文档容器仍在流中。
    目录无法读取时按不含宏返回，与无法读取的 zip 包相同。
    """
    if Path(path).suffix.lower() in MACRO_EXTS:
        return True
    try:
        with open(path, "rb") as f:
            if f.read(8) == OLE_SIGNATURE:
                entries, read = _ole_entries(f)
                if any(e[0].lower() in OLE_MACRO_STORAGES for e in entries):
                    return True
                ppt = next((e for e in entries if e[0].lower() == "powerpoint document" and e[1] == 2), None)
                stream = b"" if ppt is None else read(ppt[2], ppt[3])
                at = stream.find(PPT_VBA_INFO)
                while at >= 0:
                    if stream[at + 16:at + 20] not in (b"", b"\0\0\0\0"):
                        return True
                    at = stream.find(PPT_VBA_INFO, at + 1)
                return False
        with zipfile.ZipFile(path) as z:
            return any(n.lower().endswith("vbaproject.bin") for n in z.namelist())
    except (zipfile.BadZipFile, OSError):
        return False


def _ole_entries(f):
    """OLE 复合文件目录中全部已分配项（存储与流）的 (名称, 类型, 起始扇区, 长度)，以及按起始扇区与长度读取流的函数。

    目录扇区经 FAT 链接；FAT 扇区的位置前 109 个在文件头中，其余在 DIFAT 扇区链中。长度小于文件头第 56 字节所记阈值的流
    位于迷你流（根存储项所指的普通流）中，以 64 字节为单位经迷你 FAT（起点与扇区数在文件头第 60、64 字节）链接。
    扇区号越界、链成环或长度不足时返回已读到的部分。
    """

    def read_at(offset, size):
        f.seek(offset)
        data = f.read(size)
        return data if len(data) == size else None

    def nothing(_start, _size):
        return b""

    header = read_at(0, 512)
    if header is None:
        return [], nothing
    shift = struct.unpack_from("<H", header, 30)[0]
    if shift not in (9, 12):
        return [], nothing
    sector_size = 1 << shift
    per_sector = sector_size // 4
    f.seek(0, 2)
    max_sectors = f.tell() // sector_size
    difat_start, difat_count = struct.unpack_from("<II", header, 68)
    header_difat = struct.unpack_from("<109I", header, 76)

    def fat_sector(index):
        if index < 109:
            return header_difat[index]
        rest = index - 109
        sector = difat_start
        for _ in range(min(difat_count, max_sectors)):
            data = read_at((sector + 1) * sector_size, sector_size)
            if data is None:
                return None
            if rest < per_sector - 1:
                return struct.unpack_from("<I", data, rest * 4)[0]
            sector = struct.unpack_from("<I", data, (per_sector - 1) * 4)[0]
            rest -= per_sector - 1
        return None

    def next_sector(sector):
        fat = fat_sector(sector // per_sector)
        if fat is None or fat > 0xFFFFFFFA:
            return None
        data = read_at((fat + 1) * sector_size + (sector % per_sector) * 4, 4)
        return None if data is None else struct.unpack("<I", data)[0]

    def regular(start, size):
        out, sector = [], start
        for _ in range(max_sectors):
            if sector is None or sector > 0xFFFFFFFA or len(out) * sector_size >= size:
                break
            data = read_at((sector + 1) * sector_size, sector_size)
            if data is None:
                break
            out.append(data)
            sector = next_sector(sector)
        return b"".join(out)[:size]

    entries = []
    sector = struct.unpack_from("<I", header, 48)[0]
    for _ in range(max_sectors):
        if sector is None or sector > 0xFFFFFFFA:
            break
        data = read_at((sector + 1) * sector_size, sector_size)
        if data is None:
            break
        for p in range(0, sector_size, 128):
            length = struct.unpack_from("<H", data, p + 64)[0]
            if data[p + 66] != 0 and 2 <= length <= 64:
                start, size = struct.unpack_from("<II", data, p + 116)
                entries.append((data[p:p + length - 2].decode("utf-16-le", "replace"), data[p + 66], start, size))
        sector = next_sector(sector)

    cutoff, mini_fat_start, mini_fat_count = struct.unpack_from("<III", header, 56)

    def read(start, size):
        if size >= cutoff:
            return regular(start, size)
        root = next((e for e in entries if e[1] == 5), None)
        if root is None:
            return b""
        mini = regular(root[2], root[3])
        fat = regular(mini_fat_start, mini_fat_count * sector_size)
        out, sector = [], start
        for _ in range(len(fat) // 4 + 1):
            if sector > 0xFFFFFFFA or len(out) * 64 >= size or (sector + 1) * 64 > len(mini):
                break
            out.append(mini[sector * 64:(sector + 1) * 64])
            sector = struct.unpack_from("<I", fat, sector * 4)[0] if sector * 4 + 4 <= len(fat) else 0xFFFFFFFE
        return b"".join(out)[:size]

    return entries, read


def is_ole(path) -> bool:
    """OLE 复合文件：加密的 docx / xlsx / pptx，或修改了扩展名的 doc / xls / ppt。两者都不是 zip 包。"""
    try:
        with open(path, "rb") as f:
            return f.read(8) == OLE_SIGNATURE
    except OSError:
        return False


def replace_parts(path, parts: dict) -> None:
    """只替换包中给定的部件，其余部件按原顺序、原压缩参数写回。"""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.qy-parts-{uuid.uuid4().hex}.tmp")
    try:
        with zipfile.ZipFile(path) as zi, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zo:
            for info in zi.infolist():
                zo.writestr(info, parts.get(info.filename, zi.read(info.filename)))
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit // 2] + f"\n…（中间省略 {len(text) - limit} 字）…\n" + text[-limit // 2 :]


def col_letter(n: int) -> str:
    """列号（从 1 起）转换为 A、B … AA。"""
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s
