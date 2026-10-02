"""覆盖 video.py 与 worker 的 frames 动作：按画面变化选帧、首尾必选、真实时间戳、区间读取、
打不开的文件报名、说明里的未看区间与声音未处理。测试视频用 PyAV 现场生成：红、绿、蓝各 2 秒。
"""

import json
import unittest

from PIL import Image

from helpers import TempDir

import video
import worker

COLORS = ((255, 0, 0), (0, 255, 0), (0, 0, 255))


def make_clip(path, seconds_each=2, fps=10, size=(160, 120)):
    import av

    with av.open(str(path), "w") as c:
        stream = c.add_stream("mpeg4", rate=fps)
        stream.width, stream.height = size
        stream.pix_fmt = "yuv420p"
        for color in COLORS:
            for _ in range(seconds_each * fps):
                frame = av.VideoFrame.from_image(Image.new("RGB", size, color))
                for packet in stream.encode(frame):
                    c.mux(packet)
        for packet in stream.encode():
            c.mux(packet)


def dominant(path):
    """一张图的主色是红、绿、蓝里的哪一个。"""
    r, g, b = Image.open(path).convert("RGB").resize((1, 1)).getpixel((0, 0))
    return ("r", "g", "b")[max(range(3), key=lambda i: (r, g, b)[i])]


class PickTest(unittest.TestCase):
    def test_keeps_ends_and_largest_changes(self):
        same, other = bytes(4), bytes([200] * 4)
        thumbs = [same, same, other, other, same, same]
        times = [0, 1, 2, 3, 4, 5]
        # 画面在 2 与 4 处变化：首尾之外先选这两个。
        self.assertEqual(video.pick(times, thumbs, 4), [0, 2, 4, 5])
        self.assertEqual(video.pick(times, thumbs, 10), [0, 1, 2, 3, 4, 5])

    def test_static_scene_spreads_frames_evenly(self):
        # 画面不变时不能按下标挤在开头：首尾之后先补正中，再补剩下最大的空档。
        times = list(range(11))
        thumbs = [bytes(4)] * 11
        self.assertEqual(video.pick(times, thumbs, 4), [0, 2, 5, 10])
        self.assertEqual(video.pick(times, thumbs, 3), [0, 5, 10])

    def test_clock(self):
        self.assertEqual(video.clock(0), "00:00.0")
        self.assertEqual(video.clock(83.44), "01:23.4")
        self.assertEqual(video.clock(59.96), "01:00.0")
        self.assertEqual(video.clock(3725.0), "1:02:05.0")


class SampleTest(unittest.TestCase):
    def test_whole_clip_covers_every_color_in_time_order(self):
        with TempDir() as d:
            make_clip(d / "c.mp4")
            res = video.sample(d / "c.mp4", d / "out", max_frames=6)
            times = [f["time"] for f in res["frames"]]
            self.assertEqual(times, sorted(times))
            self.assertLessEqual(len(times), 6)
            self.assertAlmostEqual(times[0], 0.0, delta=0.11)
            self.assertGreater(times[-1], 5.5)
            colors = {dominant(f["path"]) for f in res["frames"]}
            self.assertEqual(colors, {"r", "g", "b"})
            self.assertAlmostEqual(res["duration"], 6.0, delta=0.2)
            self.assertFalse(res["has_audio"])
            self.assertEqual((res["width"], res["height"]), (160, 120))

    def test_range_only_returns_frames_inside(self):
        with TempDir() as d:
            make_clip(d / "c.mp4")
            res = video.sample(d / "c.mp4", d / "out", start=2.5, end=3.5, max_frames=4)
            for f in res["frames"]:
                self.assertGreaterEqual(f["time"], 2.4)
                self.assertLessEqual(f["time"], 3.5)
                self.assertEqual(dominant(f["path"]), "g")

    def test_frames_are_scaled_to_max_edge(self):
        with TempDir() as d:
            make_clip(d / "c.mp4", size=(320, 240))
            res = video.sample(d / "c.mp4", d / "out", max_frames=2, max_edge=100)
            for f in res["frames"]:
                self.assertEqual(max(f["width"], f["height"]), 100)

    def test_unreadable_file_names_itself(self):
        with TempDir() as d:
            (d / "bad.mp4").write_bytes(b"not a video")
            with self.assertRaises(video.Unreadable) as e:
                video.sample(d / "bad.mp4", d / "out")
            self.assertIn("bad.mp4", str(e.exception))

    def test_empty_range_is_refused(self):
        with TempDir() as d:
            make_clip(d / "c.mp4")
            with self.assertRaises(video.Unreadable):
                video.sample(d / "c.mp4", d / "out", start=10)

    def test_describe_states_gaps_and_how_to_continue(self):
        with TempDir() as d:
            make_clip(d / "c.mp4")
            res = video.sample(d / "c.mp4", d / "out", max_frames=3)
            text = video.describe("c.mp4", res)
            self.assertIn("时长 6.0 秒", text)
            self.assertIn("没有音轨", text)
            self.assertIn("中间的画面没有看到", text)
            self.assertIn("read_file 的 start 与 end", text)
            res["has_audio"] = True
            self.assertIn("声音没有处理", video.describe("c.mp4", res))


class FramesActionTest(unittest.TestCase):
    def run_frames(self, d, **body):
        req = {"action": "frames", "call_dir": str(d), **body}
        (d / "request.json").write_text(json.dumps(req), "utf-8")
        worker.main(["worker.py", str(d / "request.json")])
        return json.loads((d / "response.json").read_text("utf-8"))

    def test_returns_labelled_images_and_text(self):
        with TempDir() as d:
            make_clip(d / "c.mp4")
            resp = self.run_frames(d, path=str(d / "c.mp4"), max_frames=4)
            self.assertTrue(resp["ok"])
            self.assertTrue(resp["images"])
            self.assertEqual(resp["images"][0]["label"], "00:00.0")
            self.assertIn("视频 c.mp4", resp["text"])

    def test_missing_file(self):
        with TempDir() as d:
            resp = self.run_frames(d, path=str(d / "none.mp4"))
            self.assertFalse(resp["ok"])
            self.assertIn("不存在", resp["message"])

    def test_av_is_optional_in_probe(self):
        self.assertIn("av", worker.OPTIONAL)
        self.assertIn(("av", "av"), worker.PACKAGES)


if __name__ == "__main__":
    unittest.main()
