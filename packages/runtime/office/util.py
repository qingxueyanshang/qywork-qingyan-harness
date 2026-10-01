"""worker 各模块共用的函数：哈希、JSON 读写、原子替换、格式判定、宏检测。"""

import hashlib
import json
import os
import shutil
import uuid
import zipfile
from pathlib import Path

FORMATS = {".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx"}

# 带宏的格式在打开前一律拒绝：本机 WPS 取不到 VBProject，禁宏效果没有验证过。
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
    """同目录临时文件加 os.replace：目标要么是旧字节，要么是新字节，不会停在写了一半的状态。"""
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


def has_macros(path) -> bool:
    """扩展名是带宏格式，或包里有 vbaProject.bin。"""
    if Path(path).suffix.lower() in MACRO_EXTS:
        return True
    try:
        with zipfile.ZipFile(path) as z:
            return any(n.lower().endswith("vbaproject.bin") for n in z.namelist())
    except (zipfile.BadZipFile, OSError):
        return False


def is_ole(path) -> bool:
    """OLE 复合文件：加密的 docx / xlsx / pptx，或改了扩展名的 doc / xls / ppt。两者都不是 zip 包。"""
    try:
        with open(path, "rb") as f:
            return f.read(8) == bytes.fromhex("d0cf11e0a1b11ae1")
    except OSError:
        return False


def replace_parts(path, parts: dict) -> None:
    """只替换包里给定的部件，其余部件按原顺序、原压缩参数写回。"""
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
    """列号（从 1 起）转成 A、B … AA。"""
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s
