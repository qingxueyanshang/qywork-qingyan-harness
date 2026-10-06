"""视频抽帧：在指定区间内按画面变化选出数量有上限的一组帧，保存为 JPEG，带真实时间戳。

解码使用 PyAV（自带 LGPL 的 FFmpeg）。它是可选依赖：缺少时只有抽帧不可用，Office 其余动作不受影响。
不处理声音，并在回执中写明：模型不能依据画面回答与声音相关的问题。
"""

from pathlib import Path

# 候选时间点个数：帧上限的 4 倍，至少 8 个，至多 48 个。每个候选都需从前一个关键帧开始解码，数量更多时耗时过长。
CANDIDATES_PER_FRAME = 4
MIN_CANDIDATES = 8
MAX_CANDIDATES = 48
MAX_FRAMES = 24
THUMB = 16
# 16×16 灰度缩略图的平均逐像素差超过该值即视为画面变化；同一画面内编码噪声造成的差在 3 以下。
CHANGE = 6
JPEG_QUALITY = 80


class Unreadable(Exception):
    """无法打开或没有视频轨的文件。消息面向用户，包含文件名。"""


def clock(seconds):
    """秒数格式化为 mm:ss.s；超过一小时时为 h:mm:ss.s。"""
    whole = int(seconds)
    tenth = int(round((seconds - whole) * 10))
    if tenth == 10:
        whole, tenth = whole + 1, 0
    h, rest = divmod(whole, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}.{tenth}" if h else f"{m:02d}:{s:02d}.{tenth}"


def _duration(container, stream):
    if container.duration:
        return container.duration / 1_000_000
    if stream.duration and stream.time_base:
        return float(stream.duration * stream.time_base)
    return None


def _frame_at(container, stream, t):
    """时间点 t（秒）处或其后的第一帧，返回 (实际时间, 帧)。无法读取时返回 None。"""
    container.seek(int(t / stream.time_base), stream=stream, backward=True, any_frame=False)
    last = None
    for frame in container.decode(stream):
        if frame.time is None:
            continue
        last = frame
        if frame.time >= t - 1e-3:
            return frame.time, frame
    return (last.time, last) if last is not None else None


def _fit(img, max_edge):
    """按长边缩小到 max_edge 以内。候选帧解码后立即缩小：保留 48 张 4K 原图需要数百 MB 内存。"""
    scale = max_edge / max(img.size)
    if scale >= 1:
        return img
    return img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))


def _difference(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def pick(times, thumbs, limit):
    """从候选中选出至多 limit 个下标，按时间排序。

    首尾必选；其次选择画面明显变化的候选（与前一个候选的差超过 `CHANGE`），差值大的优先；剩余名额按时间
    均匀补足：每次选择距已选时间点最远的候选，距离相同时取靠前者。不要改为全部按画面差排序：静止画面中
    候选之间的差都接近 0，排序退化为按下标排列，帧全部集中在区间开头。
    """
    n = len(times)
    if n <= limit:
        return list(range(n))
    chosen = {0, n - 1}
    diffs = {i: _difference(thumbs[i], thumbs[i - 1]) for i in range(1, n - 1)}
    for i in sorted((i for i in diffs if diffs[i] > CHANGE), key=lambda i: diffs[i], reverse=True):
        if len(chosen) >= limit:
            break
        chosen.add(i)
    while len(chosen) < limit:
        rest = [i for i in range(n) if i not in chosen]
        far = max(rest, key=lambda i: (min(abs(times[i] - times[c]) for c in chosen), -i))
        chosen.add(far)
    return sorted(chosen)


def sample(path, out_dir, start=None, end=None, max_frames=12, max_edge=1024):
    """抽帧并写出 JPEG。返回时长、画面尺寸、音轨、本次区间与每一帧的 (时间, 路径, 宽, 高)。"""
    import av

    path = Path(path)
    max_frames = max(1, min(int(max_frames), MAX_FRAMES))
    try:
        container = av.open(str(path))
    except (av.FFmpegError, OSError) as e:
        raise Unreadable(f"{path.name} 无法打开（{e}）") from e
    with container:
        stream = next(iter(container.streams.video), None)
        if stream is None:
            raise Unreadable(f"{path.name} 中没有视频轨")
        stream.thread_type = "AUTO"
        duration = _duration(container, stream)
        has_audio = bool(container.streams.audio)
        lo = max(0.0, float(start or 0.0))
        hi = float(end) if end is not None else duration
        if duration is not None:
            hi = min(hi, duration) if hi is not None else duration
        if hi is None or hi <= lo:
            raise Unreadable(f"{path.name} 的区间 {lo}–{hi} 不成立（时长 {duration}）")
        count = max(MIN_CANDIDATES, min(MAX_CANDIDATES, max_frames * CANDIDATES_PER_FRAME))
        # 末尾保留少量余量：恰好位于时长终点的时间点通常已没有帧。
        span = max(hi - lo - 0.05, 0.0)
        wanted = [lo + span * i / (count - 1) for i in range(count)]
        seen, times, frames = set(), [], []
        for t in wanted:
            got = _frame_at(container, stream, t)
            if got is None:
                continue
            actual, frame = got
            key = round(actual, 3)
            if key in seen:
                continue
            seen.add(key)
            times.append(actual)
            frames.append(_fit(frame.to_image().convert("RGB"), max_edge))
        if not frames:
            raise Unreadable(f"{path.name} 在 {clock(lo)}–{clock(hi)} 之间无法解码出画面")
        thumbs = [img.convert("L").resize((THUMB, THUMB)).tobytes() for img in frames]
        keep = pick(times, thumbs, max_frames)
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        out = []
        for order, i in enumerate(keep):
            img = frames[i]
            target = out_dir / f"frame-{order:02d}.jpg"
            img.save(target, "JPEG", quality=JPEG_QUALITY)
            out.append({"time": times[i], "path": str(target), "width": img.width, "height": img.height})
        return {
            "duration": duration,
            "width": stream.codec_context.width,
            "height": stream.codec_context.height,
            "fps": float(stream.average_rate) if stream.average_rate else None,
            "has_audio": has_audio,
            "start": lo,
            "end": hi,
            "candidates": len(times),
            "frames": out,
        }


def describe(name, result):
    """提供给模型的说明：概况、实际查看的时间点、最大的未查看区间、继续读取的方式、声音未处理。"""
    frames = result["frames"]
    times = [f["time"] for f in frames]
    size = f"{result['width']}×{result['height']}" if result["width"] else "尺寸未知"
    fps = f"，{result['fps']:.0f} fps" if result["fps"] else ""
    total = f"时长 {result['duration']:.1f} 秒" if result["duration"] else "时长未知"
    lines = [f"视频 {name}：{total}，{size}{fps}，{'有音轨' if result['has_audio'] else '没有音轨'}。"]
    lines.append(
        f"本次区间 {clock(result['start'])}–{clock(result['end'])}，从 {result['candidates']} 个候选时间点中"
        f"按画面变化选取 {len(frames)} 帧："+ "、".join(clock(t) for t in times) + "。"
    )
    edges = [result["start"], *times, result["end"]]
    gap, at = 0.0, (result["start"], result["end"])
    for a, b in zip(edges, edges[1:]):
        if b - a > gap:
            gap, at = b - a, (a, b)
    lines.append(
        f"只看到这些时间点的画面；相邻两帧最长相隔 {gap:.1f} 秒（{clock(at[0])}–{clock(at[1])}），"
        "中间的画面没有看到。需要某一段的细节时，用 read_file 的 start 与 end（秒）指定该区间后重新读取。"
    )
    if result["has_audio"]:
        lines.append("声音未处理：不能依据这些画面回答与声音或对白相关的问题。")
    return "\n".join(lines)
