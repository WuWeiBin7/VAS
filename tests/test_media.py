from pathlib import Path

import av
from PIL import Image

from video_classifier.media import extract_frames, scan_videos, video_fingerprint
from video_classifier.models import VideoFile


def test_recursive_scan_excludes_outputs_and_symlinks(tmp_path: Path) -> None:
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "A.MP4").write_bytes(b"video")
    (tmp_path / "movie.mkv").write_bytes(b"video2")
    (tmp_path / "readme.txt").write_text("ignore", encoding="utf-8")
    output = tmp_path / "_video_classification" / "job"
    output.mkdir(parents=True)
    (output / "copy.mp4").write_bytes(b"ignore")

    videos = scan_videos(tmp_path)

    assert [item.relative_path for item in videos] == ["movie.mkv", "nested/A.MP4"]
    assert video_fingerprint(videos[0]) != video_fingerprint(videos[1])


def test_extracts_midpoint_frames_from_real_video(tmp_path: Path) -> None:
    video_path = tmp_path / "sample.mp4"
    container = av.open(str(video_path), mode="w")
    stream = container.add_stream("mpeg4", rate=10)
    stream.width = 800
    stream.height = 450
    stream.pix_fmt = "yuv420p"
    for index in range(30):
        frame = av.VideoFrame.from_image(Image.new("RGB", (800, 450), (index * 7 % 255, 70, 160)))
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()

    stat = video_path.stat()
    video = VideoFile(video_path, "sample.mp4", stat.st_size, stat.st_mtime_ns)
    duration, frames = extract_frames(video, 4, tmp_path / "frames")

    assert duration == 3.0
    assert len(frames) == 4
    assert all(frame["status"] == "ready" for frame in frames)
    assert all(Path(frame["frame_path"]).exists() for frame in frames)
    with Image.open(frames[0]["frame_path"]) as sampled:
        assert sampled.size == (640, 360)
