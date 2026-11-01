"""临时占用系统剪贴板：取图前保存用户的剪贴板内容，取图后原样写回。

保存方式：逐个格式复制原始字节。HGLOBAL 格式按 GlobalSize 复制；CF_ENHMETAFILE 用 GetEnhMetaFileBits 复制。
不保存的格式：可由系统从其他格式合成的位图与图元文件句柄（CF_BITMAP、CF_METAFILEPICT、CF_PALETTE），
OLE 内部格式（DataObject、Ole Private Data，其中记录的是源进程的对象，源进程放弃剪贴板后即失效），
以及显示格式与私有句柄格式。写回后其余各格式的字节与原内容相同。

写回前比较剪贴板序号：取图之后剪贴板被其他程序改写过（用户在采集期间复制了新内容），就不写回，
以用户最新的内容为准。保存的内容同时写入磁盘，正常退出时删除；进程异常结束后可用 restore_file 写回。
"""

import ctypes
import io
import json
import shutil
import struct
import time
from ctypes import wintypes
from pathlib import Path

from PIL import Image

CF_BITMAP, CF_METAFILEPICT, CF_DIB, CF_PALETTE, CF_ENHMETAFILE = 2, 3, 8, 9, 14
HANDLE_FORMATS = {CF_BITMAP, CF_METAFILEPICT, CF_PALETTE, 0x80, 0x81, 0x82, 0x83, 0x8E}
OLE_INTERNAL = {"DataObject", "Ole Private Data"}
GMEM_MOVEABLE = 0x0002

_u = ctypes.windll.user32
_k = ctypes.windll.kernel32
_g = ctypes.windll.gdi32
_vp = ctypes.c_void_p
_u.OpenClipboard.argtypes = [_vp]
_u.GetClipboardData.restype = _vp
_u.GetClipboardData.argtypes = [wintypes.UINT]
_u.SetClipboardData.restype = _vp
_u.SetClipboardData.argtypes = [wintypes.UINT, _vp]
_u.EnumClipboardFormats.argtypes = [wintypes.UINT]
_u.EnumClipboardFormats.restype = wintypes.UINT
_u.GetClipboardFormatNameW.argtypes = [wintypes.UINT, wintypes.LPWSTR, ctypes.c_int]
_u.RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
_u.RegisterClipboardFormatW.restype = wintypes.UINT
_u.GetClipboardSequenceNumber.restype = wintypes.DWORD
_k.GlobalSize.argtypes = [_vp]
_k.GlobalSize.restype = ctypes.c_size_t
_k.GlobalLock.argtypes = [_vp]
_k.GlobalLock.restype = _vp
_k.GlobalUnlock.argtypes = [_vp]
_k.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
_k.GlobalAlloc.restype = _vp
_k.GlobalFree.argtypes = [_vp]
_g.GetEnhMetaFileBits.argtypes = [_vp, wintypes.UINT, _vp]
_g.GetEnhMetaFileBits.restype = wintypes.UINT
_g.SetEnhMetaFileBits.argtypes = [wintypes.UINT, ctypes.c_char_p]
_g.SetEnhMetaFileBits.restype = _vp


class ClipboardBusy(Exception):
    """剪贴板被其他程序占用，重试后仍无法打开。"""


def sequence() -> int:
    return int(_u.GetClipboardSequenceNumber())


class _Open:
    def __enter__(self):
        for _ in range(50):
            if _u.OpenClipboard(None):
                return self
            time.sleep(0.1)
        raise ClipboardBusy("剪贴板被占用超过 5 秒")

    def __exit__(self, *exc):
        _u.CloseClipboard()


def _name(fmt: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    n = _u.GetClipboardFormatNameW(fmt, buf, 256)
    return buf.value if n else ""


def _formats() -> list:
    out, f = [], 0
    while True:
        f = _u.EnumClipboardFormats(f)
        if not f:
            return out
        out.append(f)


def _global_bytes(h) -> bytes:
    size = _k.GlobalSize(h)
    p = _k.GlobalLock(h)
    if not p:
        raise OSError("GlobalLock 失败")
    try:
        return ctypes.string_at(p, size)
    finally:
        _k.GlobalUnlock(h)


def _emf_bytes(h) -> bytes:
    n = _g.GetEnhMetaFileBits(h, 0, None)
    buf = ctypes.create_string_buffer(n)
    _g.GetEnhMetaFileBits(h, n, buf)
    return buf.raw


def read_formats(wanted) -> dict:
    """读取当前剪贴板中 wanted 所列格式的字节；wanted 可含格式号与注册名。"""
    out = {}
    with _Open():
        present = {f: _name(f) for f in _formats()}
        for f, name in present.items():
            key = f if f in wanted else name if name in wanted else None
            if key is None:
                continue
            h = _u.GetClipboardData(f)
            if h:
                out[key] = _emf_bytes(h) if f == CF_ENHMETAFILE else _global_bytes(h)
    return out


def dib_image(data: bytes) -> Image.Image:
    """CF_DIB（BITMAPINFO + 像素）补上文件头后由 Pillow 解码。"""
    hdr = struct.unpack_from("<I", data, 0)[0]
    bits = struct.unpack_from("<H", data, 14)[0]
    compression = struct.unpack_from("<I", data, 16)[0]
    used = struct.unpack_from("<I", data, 32)[0]
    palette = (used or (1 << bits if bits <= 8 else 0)) * 4
    masks = 12 if compression == 3 and hdr == 40 else 0
    head = b"BM" + struct.pack("<IHHI", 14 + len(data), 0, 0, 14 + hdr + palette + masks)
    with Image.open(io.BytesIO(head + data)) as im:
        return im.convert("RGB")


def formats_present() -> list:
    with _Open():
        return [{"id": f, "name": _name(f)} for f in _formats()]


def save() -> dict:
    """复制当前剪贴板的全部可保存格式。返回 {"items": [...], "skipped": [...], "sequence": n}。"""
    items, skipped = [], []
    with _Open():
        for f in _formats():
            name = _name(f)
            if f in HANDLE_FORMATS or name in OLE_INTERNAL:
                skipped.append({"id": f, "name": name})
                continue
            h = _u.GetClipboardData(f)
            if not h:
                skipped.append({"id": f, "name": name, "reason": "无数据"})
                continue
            try:
                data = _emf_bytes(h) if f == CF_ENHMETAFILE else _global_bytes(h)
            except OSError as e:
                skipped.append({"id": f, "name": name, "reason": str(e)})
                continue
            items.append({"id": f, "name": name, "data": data})
    return {"items": items, "skipped": skipped, "sequence": sequence()}


def _set(fmt: int, data: bytes):
    if fmt == CF_ENHMETAFILE:
        h = _g.SetEnhMetaFileBits(len(data), data)
        if not h or not _u.SetClipboardData(fmt, h):
            raise OSError(f"写回格式 {fmt} 失败")
        return
    h = _k.GlobalAlloc(GMEM_MOVEABLE, max(1, len(data)))
    p = _k.GlobalLock(h)
    ctypes.memmove(p, data, len(data))
    _k.GlobalUnlock(h)
    if not _u.SetClipboardData(fmt, h):
        _k.GlobalFree(h)
        raise OSError(f"写回格式 {fmt} 失败")


def restore(saved: dict):
    """清空剪贴板并写回 saved 中的全部格式。注册格式按名称重新取得格式号。"""
    with _Open():
        _u.EmptyClipboard()
        for item in saved["items"]:
            fmt = _u.RegisterClipboardFormatW(item["name"]) if item["name"] else item["id"]
            _set(fmt, item["data"])


def dump(saved: dict, directory: Path):
    """把 saved 写入 directory：index.json 记录格式，每个格式的字节单独成文件。"""
    directory.mkdir(parents=True, exist_ok=True)
    index = []
    for n, item in enumerate(saved["items"]):
        blob = directory / f"{n:02d}.bin"
        blob.write_bytes(item["data"])
        index.append({"id": item["id"], "name": item["name"], "file": blob.name})
    (directory / "index.json").write_text(
        json.dumps({"items": index, "skipped": saved["skipped"]}, ensure_ascii=False, indent=2),
        "utf-8")


def restore_file(directory: Path):
    index = json.loads((directory / "index.json").read_text("utf-8"))
    items = [{"id": e["id"], "name": e["name"], "data": (directory / e["file"]).read_bytes()}
             for e in index["items"]]
    restore({"items": items})


class Borrowed:
    """上下文管理器：进入时保存用户剪贴板，退出时写回。

    copy_seen() 在取图方读取完图片后调用，记录此刻的序号；退出时序号不变才写回。
    """

    def __init__(self, backup_dir: Path):
        self.backup_dir = backup_dir
        self.saved = None
        self.seen = None
        self.outcome = None

    def __enter__(self):
        self.saved = save()
        dump(self.saved, self.backup_dir)
        return self

    def copy_seen(self):
        self.seen = sequence()

    def __exit__(self, *exc):
        if self.seen is not None and sequence() != self.seen:
            self.outcome = "skipped_newer_content"
        else:
            restore(self.saved)
            self.outcome = "restored"
        shutil.rmtree(self.backup_dir, ignore_errors=True)
        return False
