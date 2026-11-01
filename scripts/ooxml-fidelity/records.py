"""WPS 最近文档记录的快照与比对：采集前后各取一次，比对结果写入采集清单。

范围：HKCU\\Software\\Kingsoft\\Office\\6.0 下路径含 RecentFiles、openfilelist 或 ongmani 的键（各组件的 files、
files_bak、Sequence，账号打开记录，以及各组件退出时写入的界面布局，如 wpp\\wppongmani），
以及 %APPDATA%\\Microsoft\\Windows\\Recent 的文件名。
另在整棵 6.0 子树中查找含 needle 的值：needle 取采集的调用目录名，用于发现上述范围之外的新记录。
"""

import os
import winreg
from pathlib import Path

BASE = r"Software\Kingsoft\Office\6.0"
WATCH = ("recentfiles", "openfilelist", "ongmani")


def _subkeys(key):
    out, i = [], 0
    while True:
        try:
            out.append(winreg.EnumKey(key, i))
        except OSError:
            return out
        i += 1


def _values(key):
    out, i = {}, 0
    while True:
        try:
            name, data, _ = winreg.EnumValue(key, i)
        except OSError:
            return out
        out[name] = data if isinstance(data, (str, int)) else repr(data)
        i += 1


def _walk(path, acc):
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, path)
    except OSError:
        return
    with key:
        acc[path] = _values(key)
        for sub in _subkeys(key):
            _walk(f"{path}\\{sub}", acc)


def snapshot() -> dict:
    tree = {}
    _walk(BASE, tree)
    recent_dir = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Recent"
    recent = sorted(p.name for p in recent_dir.iterdir()) if recent_dir.is_dir() else []
    return {"registry": tree, "shell_recent": recent}


def _watched(path: str) -> bool:
    low = path.lower()
    return any(w in low for w in WATCH)


def diff(before: dict, after: dict, needle: str) -> dict:
    """返回监视范围内新增、删除、修改的键值，整棵子树中含 needle 的值，以及 Windows Recent 新增的文件名。

    clean 要求以上各项全部为空。采集期间用户自己打开文件同样使 clean 为假，调用方不做区分，停止并报告。
    """
    b, a = before["registry"], after["registry"]
    added, removed, changed = [], [], []
    for path in sorted(set(a) | set(b)):
        if not _watched(path):
            continue
        if path not in b:
            added.append({"key": path[len(BASE) + 1:], "values": a[path]})
        elif path not in a:
            removed.append({"key": path[len(BASE) + 1:], "values": b[path]})
        elif a[path] != b[path]:
            changed.append({"key": path[len(BASE) + 1:], "before": b[path], "after": a[path]})
    low = needle.lower()
    mentions = [{"key": path[len(BASE) + 1:], "name": name, "value": value}
                for path, vals in a.items() for name, value in vals.items()
                if low in str(value).lower() or low in name.lower()]
    shell_added = sorted(set(after["shell_recent"]) - set(before["shell_recent"]))
    watched_keys = sum(1 for p in a if _watched(p))
    return {"watched_keys": watched_keys, "added": added, "removed": removed, "changed": changed,
            "mentions": mentions, "shell_recent_added": shell_added,
            "clean": not (added or removed or changed or mentions or shell_added)}
