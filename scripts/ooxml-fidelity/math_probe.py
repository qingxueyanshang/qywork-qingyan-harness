"""公式校准的 WPS 采集：只读打开构造的 docx，取每页 EMF（ActivePane.Pages(n).EnhMetaFileBits）与逐字坐标。

每个文档写出 `<名称>-p<页>.emf`、96 dpi 回放的 `<名称>-p<页>.png`，以及 `<名称>.json`：逐段逐字的
[位置, 字符, Information(3) 页, Information(5) 横坐标, Information(6) 行顶]（磅）与 `OMaths` 的范围。
EMF 再由 math_emf.py 整理为绘制记录，供 math-calibrate.ts 比对。

实例管理沿用 packages/runtime/office/com.py：只使用本次新启动并核对过进程的实例，打开文件副本、只读、不另存，
KWPS 每个实例只打开一个文件，结束时关闭文档并退出实例。不设置 Application.Visible：替换 Instance._configure，
只设置 DisplayAlerts 与 AutomationSecurity；启动后读取 Visible，为真时立即停止。不向任何窗口发送输入。
每个文件运行前后各取一次 WPS 最近文档记录快照（records.py），有变化时停止，退出码为 3；整棵子树中的查找串取调用目录名
（打开的副本位于调用目录中）。

用法：python math_probe.py <输出目录> <docx 文件或目录>... [--call <调用根目录>]
（调用根目录缺省为 .tmp/ooxml-fidelity/call，其中为每次运行建一个调用目录）
"""

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CALL = ROOT / ".tmp" / "ooxml-fidelity" / "call"
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "packages" / "runtime" / "office"))
sys.path.insert(0, str(HERE))

import com  # noqa: E402
import emf  # noqa: E402
import records  # noqa: E402

PAGE, X, Y = 3, 5, 6


def configure(self):
    for name, value in (("DisplayAlerts", 0), ("AutomationSecurity", 3)):
        try:
            setattr(self.app, name, value)
        except Exception:
            pass


com.Instance._configure = configure


def chars(doc) -> dict:
    """逐段逐字取所在页、横坐标与行顶，以及公式区的范围。公式中的字符按 UTF-16 码元逐个列出。"""
    paras = []
    for i in range(1, doc.Paragraphs.Count + 1):
        rng = doc.Paragraphs(i).Range
        items = []
        for pos in range(rng.Start, rng.End):
            r = doc.Range(pos, pos + 1)
            try:
                items.append([pos, r.Text, r.Information(PAGE), round(r.Information(X), 3),
                              round(r.Information(Y), 3)])
            except Exception as e:
                items.append([pos, None, str(e)[:60]])
        paras.append({"start": rng.Start, "end": rng.End, "chars": items})
    maths = []
    for k in range(1, doc.OMaths.Count + 1):
        om = doc.OMaths(k)
        maths.append({"start": om.Range.Start, "end": om.Range.End, "type": om.Type})
    return {"paragraphs": paras, "omaths": maths}


def run_one(path: Path, out: Path, call_dir: Path, dpi=96.0):
    apps = com.Apps(call_dir, "math-probe")
    visible = None
    try:
        inst = apps.get("docx")
        visible = bool(inst.app.Visible)
        if visible:
            raise RuntimeError("WPS 实例可见，停止")
        doc = inst.open(str(path))
        try:
            pane = doc.ActiveWindow.ActivePane
            pages = []
            for k in range(1, pane.Pages.Count + 1):
                bits = bytes(pane.Pages(k).EnhMetaFileBits)
                (out / f"{path.stem}-p{k}.emf").write_bytes(bits)
                emf.render_screen(bits, dpi).save(out / f"{path.stem}-p{k}.png")
                pages.append(f"{path.stem}-p{k}.png")
            data = {"id": path.stem, "renderer": {k: inst.info.get(k) for k in ("progid", "version")},
                    "pages": pages, **chars(doc)}
        finally:
            inst.close_doc(doc)
        # 公式中的字符按码元列出，代理项单独出现，以 ASCII 转义写出。
        (out / f"{path.stem}.json").write_text(json.dumps(data), "utf-8")
    finally:
        statuses = apps.close()
    return statuses, visible


def main():
    args = sys.argv[1:]
    root = CALL
    if "--call" in args:
        i = args.index("--call")
        root = Path(args[i + 1]).resolve()
        del args[i:i + 2]
    if len(args) < 2:
        print(__doc__)
        sys.exit(2)
    out = Path(args[0]).resolve()
    inputs = []
    for a in args[1:]:
        p = Path(a).resolve()
        inputs += sorted(p.glob("*.docx")) if p.is_dir() else [p]
    out.mkdir(parents=True, exist_ok=True)
    call_dir = root / f"math-{time.strftime('%Y%m%d-%H%M%S')}"
    call_dir.mkdir(parents=True, exist_ok=True)
    report = {"documents": []}
    for path in inputs:
        t0 = time.time()
        before = records.snapshot()
        statuses, visible, diff = None, None, None
        try:
            statuses, visible = run_one(path, out, call_dir)
        finally:
            time.sleep(1)
            diff = records.diff(before, records.snapshot(), call_dir.name)
            report["documents"].append({"id": path.stem, "instances": statuses, "visible": visible,
                                        "records": diff})
            (out / f"_run-{call_dir.name}.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=1, default=str), "utf-8")
            print(path.stem, f"{time.time() - t0:.1f}s", statuses, "visible", visible, "clean", diff["clean"],
                  flush=True)
        if not diff["clean"]:
            print("记录有变化，停止", json.dumps(diff, ensure_ascii=False, default=str)[:3000])
            sys.exit(3)


if __name__ == "__main__":
    main()
