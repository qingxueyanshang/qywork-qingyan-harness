"""办公软件实例管理。

只使用本调用新起的进程：创建后核对 COM 对象对应的进程，确认是新进程才使用，并先把登记写进
调用目录的 instances.json，再把对象交给调用方。

文件一律只读打开，从不另存：WPS 的可写打开与另存会写入最近文档（RecentFiles 的 files、
files_bak、Sequence）和账号的 openfilelist，且不认 AddToRecentFiles / AddToMru 参数；
同一进程里再次打开同一路径也会写入。每个路径只打开一次（见 Instance.open）时，只读打开、导出 PDF、
逐页导出图片都不写。

pywin32 与 psutil 只在函数里导入：非 Windows 上本模块照样能导入，能力探测如实报告不可用。
"""

import gc
import shutil
import sys
import time
import uuid
from pathlib import Path

import util

# 默认关联 ProgId 的前缀 → 对应的自动化 ProgID。
ASSOC = {
    "docx": (("WPS.", "KWPS.Application"), ("KWPS.", "KWPS.Application"),
             ("Word.", "Word.Application")),
    "xlsx": (("ET.", "KET.Application"), ("KET.", "KET.Application"),
             ("Excel.", "Excel.Application")),
    "pptx": (("WPP.", "KWPP.Application"), ("KWPP.", "KWPP.Application"),
             ("PowerPoint.", "PowerPoint.Application")),
}
WPS_PROGIDS = {"KWPS.Application", "KET.Application", "KWPP.Application"}

# 同一实例里第二次及以后的打开会写入最近文档与账号打开记录（只读打开也一样）的组件；
# 这些组件每个实例只打开一个文件，再打开就换一个新实例。
ONE_OPEN_PER_INSTANCE = {"KWPS.Application"}

# 组件规则表：异常结束（worker 已被结束、无法再调用 COM）时能否按 PID 结束。
# end：实测用户以资源管理器打开的文件不会并入产品新起的实例，按 PID 结束不影响用户文档。
# report：未验证的组件（含 Microsoft Office），只报告残留，不结束。
RULES = {("wps", "12"): {"KWPS.Application": "end", "KET.Application": "end",
                         "KWPP.Application": "end"}}

AUTOMATION_NAMES = {"wps.exe", "et.exe", "wpp.exe", "winword.exe", "excel.exe", "powerpnt.exe"}

# Value2 里的错误值是 0x800A0000 加 Excel 错误号（CVErr）。表里是全部错误号，不要只列常见几种：
# 缺一个，含该错误的工作簿整份写回失败，交付件没有任何计算结果。
XL_ERROR_NAMES = {2000: "#NULL!", 2007: "#DIV/0!", 2015: "#VALUE!", 2023: "#REF!", 2029: "#NAME?",
                  2036: "#NUM!", 2042: "#N/A", 2043: "#GETTING_DATA", 2045: "#SPILL!", 2046: "#CONNECT!",
                  2047: "#BLOCKED!", 2048: "#UNKNOWN!", 2049: "#FIELD!", 2050: "#CALC!"}
XL_ERRORS = {-2146828288 + n: name for n, name in XL_ERROR_NAMES.items()}


class Busy(Exception):
    """实例或锁被占用、或者拿到的不是新进程。"""


class Unavailable(Exception):
    """这台机器上没有可用的办公软件。"""


def product_of(progid: str) -> str:
    return "wps" if progid in WPS_PROGIDS else "msoffice"


def rule_for(progid: str, version) -> str:
    product = product_of(progid)
    major = (version or "").split(".")[0]
    return RULES.get((product, major), {}).get(progid, "report")


def host_of(cmdline: str):
    """WPS 组件进程的命令行带宿主进程号：kprometheus.<宿主 PID>.…"""
    marker = "kprometheus."
    if marker not in cmdline:
        return None
    try:
        return int(cmdline.split(marker, 1)[1].split(".", 1)[0])
    except ValueError:
        return None


def _reg_value(root, path, name="", flags=0):
    import winreg

    try:
        with winreg.OpenKey(root, path, 0, winreg.KEY_READ | flags) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def _server_exe(progid: str):
    """ProgID 对应的本地服务程序路径。32 位与 64 位两个视图都查。"""
    import winreg

    clsid = _reg_value(winreg.HKEY_CLASSES_ROOT, rf"{progid}\CLSID")
    if not clsid:
        return None
    for flags in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        cmd = _reg_value(winreg.HKEY_CLASSES_ROOT, rf"CLSID\{clsid}\LocalServer32", "", flags)
        if cmd:
            cmd = cmd.strip()
            return cmd[1:].split('"', 1)[0] if cmd.startswith('"') else cmd.split(" ", 1)[0]
    return None


def _file_version(path):
    try:
        import win32api

        info = win32api.GetFileVersionInfo(path, "\\")
        ms, ls = info["FileVersionMS"], info["FileVersionLS"]
        return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"
    except Exception:
        return None


def default_app(fmt: str) -> dict:
    """按扩展名的默认关联选组件，并核验它的自动化接口已注册。"""
    base = {"progid": None, "product": None, "version": None, "rule": "report",
            "available": False, "reason": ""}
    if sys.platform != "win32":
        return {**base, "reason": "渲染与重算只支持 Windows 上的 WPS / Microsoft Office"}
    import winreg

    ext = "." + fmt
    choice = _reg_value(
        winreg.HKEY_CURRENT_USER,
        rf"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{ext}\UserChoice",
        "ProgId",
    ) or _reg_value(winreg.HKEY_CLASSES_ROOT, ext)
    if not choice:
        return {**base, "reason": f"{ext} 没有默认打开程序"}
    progid = next((p for prefix, p in ASSOC[fmt] if choice.startswith(prefix)), None)
    if not progid:
        return {**base, "reason": f"{ext} 默认用 {choice} 打开，不是 WPS 或 Microsoft Office"}
    if _reg_value(winreg.HKEY_CLASSES_ROOT, rf"{progid}\CLSID") is None:
        return {**base, "progid": progid, "reason": f"{progid} 的自动化接口没有注册"}
    exe = _server_exe(progid)
    version = _file_version(exe) if exe else None
    return {**base, "progid": progid, "product": product_of(progid), "version": version,
            "rule": rule_for(progid, version), "available": True}


def automation_residue() -> list:
    """现存命令行带 /Automation 的办公软件进程。"""
    import psutil

    out = []
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        name = (p.info["name"] or "").lower()
        cmd = " ".join(p.info["cmdline"] or [])
        if name in AUTOMATION_NAMES and "/automation" in cmd.lower():
            out.append({"pid": p.info["pid"], "name": name, "cmdline": cmd[:240]})
    return out


def foreign_residue(call_dir) -> list:
    """取得锁时现存、且不是本调用登记过的自动化进程：别的调用都在等锁，列出的只可能是残留或其他程序。"""
    own = {e.get("pid") for e in _load_instances(call_dir)}
    return [r for r in automation_residue() if r["pid"] not in own]


def _procs() -> dict:
    import psutil

    out = {}
    for p in psutil.process_iter(["pid", "name", "create_time", "cmdline"]):
        if (p.info["name"] or "").lower() in AUTOMATION_NAMES:
            out[p.info["pid"]] = {"create_time": p.info["create_time"],
                                  "cmdline": " ".join(p.info["cmdline"] or [])}
    return out


def _pid_of_hwnd(h) -> int:
    import win32process

    return win32process.GetWindowThreadProcessId(int(h))[1]


class Lock:
    """所有组件共用一把系统具名锁，覆盖取得实例到清理结束；协调产品内多个调用与 server / CLI。

    不要改成按组件分锁：残留扫描（foreign_residue）看的是全部组件的自动化进程，分锁后另一个组件
    正在用的实例会被报成残留。同一线程再次等待自己已持有的互斥体立即返回，同一调用里同时持有
    几个实例不会自锁。锁对象在最后一个句柄关闭时被系统回收，下一个持有者拿到的是新锁，
    不能靠锁的状态判断上一调用是否异常结束。
    """

    NAME = "Local\\qywork-office"

    def __init__(self, timeout_s: float = 60):
        self.name = self.NAME
        self.timeout_s = timeout_s
        self.handle = None

    def acquire(self):
        import win32event

        h = win32event.CreateMutex(None, False, self.name)
        r = win32event.WaitForSingleObject(h, int(self.timeout_s * 1000))
        if r not in (win32event.WAIT_OBJECT_0, win32event.WAIT_ABANDONED):
            h.Close()
            raise Busy(f"{self.name} 被占用超过 {self.timeout_s:.0f} 秒")
        self.handle = h

    def release(self):
        if self.handle is None:
            return
        import win32event

        try:
            win32event.ReleaseMutex(self.handle)
        except Exception:
            pass
        self.handle.Close()
        self.handle = None


class Instance:
    """一个本调用新起的办公软件实例。"""

    def __init__(self, fmt: str, app_info: dict, call_dir, label: str):
        self.fmt = fmt
        self.info = app_info
        self.progid = app_info["progid"]
        self.call_dir = Path(call_dir)
        self.label = label
        self.app = None
        self.lock = Lock()
        self.opened = []
        self.opens = 0
        self.entries = []
        self.residue = []
        self.pids = []

    # ── 创建与核对 ──
    def start(self):
        import win32com.client

        self.lock.acquire()
        try:
            self.residue = foreign_residue(self.call_dir)
            before = _procs()
            app = win32com.client.DispatchEx(self.progid)
            after = _procs()
            new = [p for p in after if p not in before]
            pid, method = self._identify(app, new, after)
            if pid is None or pid not in new:
                # 绑到了已有进程（单实例组件被别的自动化调用方占着）：不退出它，只放掉引用。
                del app
                gc.collect()
                raise Busy(f"{self.progid} 没有新起进程，现有自动化实例正被占用")
            self.app = app
            self._register(pid, after, method)
            self._configure()
        except Exception:
            self.lock.release()
            raise
        return self

    def _identify(self, app, new, after):
        """用窗口句柄对上组件进程；WPS 演示没有 HWND 成员，按宿主与组件进程配对。"""
        pid = None
        method = None
        try:
            if self.fmt == "xlsx":
                pid, method = _pid_of_hwnd(app.Hwnd), "Application.Hwnd"
            elif self.fmt == "docx":
                d = app.Documents.Add()
                try:
                    pid, method = _pid_of_hwnd(d.ActiveWindow.Hwnd), "Document.ActiveWindow.Hwnd"
                finally:
                    d.Close(0)
            elif self.progid == "PowerPoint.Application":
                pid, method = _pid_of_hwnd(app.HWND), "Application.HWND"
        except Exception:
            pid = None
        if pid is None and product_of(self.progid) == "wps":
            pairs = [c for c in new if host_of(after[c]["cmdline"]) in new
                     and "/automation" in after[c]["cmdline"].lower()]
            if len(pairs) == 1:
                pid, method = pairs[0], "prometheus pair"
        return pid, method

    def _register(self, pid, procs, method):
        import psutil

        rule = self.info["rule"]
        common = {"label": self.label, "progid": self.progid, "product": self.info["product"],
                  "version": self.info["version"], "rule": rule, "method": method,
                  "registered_at": time.time(), "status": "running"}
        p = psutil.Process(pid)
        self.entries = [{**common, "role": "component", "pid": pid,
                         "create_time": p.create_time(), "cmdline": procs[pid]["cmdline"][:240]}]
        host = host_of(procs[pid]["cmdline"])
        if host is not None and host in procs:
            self.entries.append({**common, "role": "host", "pid": host,
                                 "create_time": psutil.Process(host).create_time(),
                                 "cmdline": procs[host]["cmdline"][:240]})
        self.pids = [e["pid"] for e in self.entries]
        _append_instances(self.call_dir, self.entries)

    def _configure(self):
        app = self.app
        settings = {
            "docx": [("DisplayAlerts", 0), ("Visible", False)],
            "xlsx": [("DisplayAlerts", False), ("Visible", False), ("AskToUpdateLinks", False),
                     ("ScreenUpdating", False)],
            "pptx": [("DisplayAlerts", 1)],
        }[self.fmt]
        # 3 为强制禁用宏；带宏文件在打开前已被拒绝，这一项只是第二道设置。
        settings.append(("AutomationSecurity", 3))
        for name, value in settings:
            try:
                setattr(app, name, value)
            except Exception:
                pass

    # ── 只读打开 ──
    def open(self, path):
        """只读打开 path 的一份文件名唯一的副本，副本在 close_doc 时删除。

        打开副本而不是 path 本身：正式文件与工作副本的路径就不会出现在办公软件的任何记录里。
        ONE_OPEN_PER_INSTANCE 里的组件每个实例只允许打开一次，第二次打开会写入最近文档，这里直接拒绝。
        """
        if util.has_macros(path):
            raise ValueError(f"{Path(path).name} 含宏，拒绝打开")
        if self.progid in ONE_OPEN_PER_INSTANCE and self.opens > 0:
            raise RuntimeError(f"{self.progid} 的一个实例只打开一个文件；再打开要换新实例")
        self.opens += 1
        stage = self.call_dir / "opened"
        stage.mkdir(parents=True, exist_ok=True)
        copy = stage / f"{uuid.uuid4().hex[:8]}-{Path(path).name}"
        shutil.copyfile(path, copy)
        app = self.app
        p = str(copy)
        if self.fmt == "docx":
            doc = app.Documents.Open(FileName=p, ConfirmConversions=False, ReadOnly=True,
                                     AddToRecentFiles=False, Visible=False)
        elif self.fmt == "xlsx":
            doc = app.Workbooks.Open(Filename=p, UpdateLinks=0, ReadOnly=True, AddToMru=False)
        else:
            doc = app.Presentations.Open(p, True, False, False)
        self.opened.append((doc, copy))
        return doc

    def close_doc(self, doc):
        entry = next((e for e in self.opened if e[0] is doc), None)
        try:
            if self.fmt == "docx":
                doc.Close(0)
            elif self.fmt == "xlsx":
                doc.Close(False)
            else:
                doc.Close()
        finally:
            if entry is not None:
                self.opened.remove(entry)
                try:
                    entry[1].unlink()
                except OSError:
                    pass

    def _doc_count(self):
        col = {"docx": "Documents", "xlsx": "Workbooks", "pptx": "Presentations"}[self.fmt]
        return getattr(self.app, col).Count

    # ── 正常结束 ──
    def close(self):
        """关掉本调用打开的文档；实例里没有别的文档才退出，有就留着并报告。"""
        import psutil

        status = "closed"
        try:
            for doc, _ in list(self.opened):
                try:
                    self.close_doc(doc)
                except Exception:
                    pass
            remaining = self._doc_count()
            if remaining == 0:
                self.app.Quit()
            else:
                status = "left_running_other_documents"
        except Exception as e:
            status = f"close_error: {e}"
        finally:
            self.app = None
            self.opened = []
            gc.collect()
            deadline = time.time() + 10
            while status == "closed" and time.time() < deadline:
                if not any(psutil.pid_exists(p) for p in self.pids):
                    break
                time.sleep(0.2)
            if status == "closed" and any(psutil.pid_exists(p) for p in self.pids):
                status = "quit_but_process_alive"
            _update_instances(self.call_dir, self.pids, status)
            self.lock.release()
        return status


class Apps:
    """按格式取实例：reuse 为真时同一调用里复用，ONE_OPEN_PER_INSTANCE 的组件打开过一次就换新实例；
    reuse 为假时每次都新起。结束时统一关闭。"""

    def __init__(self, call_dir, label: str, reuse: bool = True):
        self.call_dir = call_dir
        self.label = label
        self.reuse = reuse
        self.instances = {}
        self.retired = []
        self.residues = {}
        self.statuses = []

    def get(self, fmt) -> Instance:
        cur = self.instances.get(fmt)
        if cur is not None and self.reuse and not (
                cur.progid in ONE_OPEN_PER_INSTANCE and cur.opens > 0):
            return cur
        if cur is not None and self.reuse:
            self.statuses.append(cur.close())
            del self.instances[fmt]
        info = default_app(fmt)
        if not info["available"]:
            raise Unavailable(info["reason"])
        inst = Instance(fmt, info, self.call_dir, f"{self.label}-{fmt}").start()
        for r in inst.residue:
            self.residues[r["pid"]] = r
        if self.reuse:
            self.instances[fmt] = inst
        else:
            self.retired.append(inst)
        return inst

    @property
    def residue(self):
        return list(self.residues.values())

    def close(self):
        for inst in list(self.instances.values()) + self.retired:
            self.statuses.append(inst.close())
        self.instances.clear()
        self.retired = []
        return self.statuses


def _instances_path(call_dir):
    return Path(call_dir) / "instances.json"


def _load_instances(call_dir):
    p = _instances_path(call_dir)
    return util.read_json(p) if p.exists() else []


def _append_instances(call_dir, entries):
    items = _load_instances(call_dir)
    items.extend(entries)
    util.write_json(_instances_path(call_dir), items)


def _update_instances(call_dir, pids, status):
    items = _load_instances(call_dir)
    for e in items:
        if e.get("pid") in pids and e.get("status") == "running":
            e["status"] = status
    util.write_json(_instances_path(call_dir), items)


def cleanup(call_dir) -> list:
    """worker 被结束后按登记处理残留：规则为 end 且 PID 与创建时间一致才结束，其余只报告。"""
    import psutil

    items = _load_instances(call_dir)
    report = []
    for e in sorted(items, key=lambda x: 0 if x.get("role") == "component" else 1):
        if e.get("status") != "running":
            report.append({**e, "action": "already_closed"})
            continue
        pid, ct = e.get("pid"), e.get("create_time")
        try:
            p = psutil.Process(pid)
            same = abs(p.create_time() - ct) < 0.01
        except psutil.Error:
            same = False
        if not same:
            e["status"] = "exited"
            report.append({**e, "action": "already_exited"})
            continue
        if e.get("rule") != "end":
            e["status"] = "left_running_unverified_component"
            report.append({**e, "action": "reported"})
            continue
        try:
            p.kill()
            p.wait(10)
            e["status"] = "ended_by_pid"
            report.append({**e, "action": "ended"})
        except psutil.Error as err:
            e["status"] = f"end_failed: {err}"
            report.append({**e, "action": "end_failed"})
    util.write_json(_instances_path(call_dir), items)
    return report
