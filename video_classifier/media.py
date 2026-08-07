from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

from PIL import Image

from .models import VideoFile, sample_positions

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpeg", ".mpg"}
MAX_IMAGE_EDGE = 640


def scan_videos(root: Path) -> list[VideoFile]:
    root = root.resolve()
    videos: list[VideoFile] = []
    for directory, dirnames, filenames in os.walk(root, followlinks=False, onerror=lambda _error: None):
        directory_path = Path(directory)
        dirnames[:] = [
            name
            for name in dirnames
            if name != "_video_classification" and not (directory_path / name).is_symlink()
        ]
        for name in filenames:
            path = directory_path / name
            if path.is_symlink() or path.suffix.lower() not in VIDEO_EXTENSIONS:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            videos.append(VideoFile(path, path.relative_to(root).as_posix(), stat.st_size, stat.st_mtime_ns))
    return sorted(videos, key=lambda item: item.relative_path.casefold())


def video_fingerprint(video: VideoFile) -> str:
    source = f"{video.relative_path}\0{video.size}\0{video.mtime_ns}"
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def video_id(relative_path: str) -> str:
    return hashlib.sha1(relative_path.encode("utf-8")).hexdigest()[:12]


def extract_frames(video: VideoFile, count: int, output_dir: Path) -> tuple[float, list[dict[str, Any]]]:
    try:
        import av
    except ImportError as exc:
        raise RuntimeError("缺少 PyAV，请先安装 Python 依赖") from exc

    output_dir.mkdir(parents=True, exist_ok=True)
    with av.open(str(video.path)) as container:
        stream = next((item for item in container.streams if item.type == "video"), None)
        if stream is None:
            raise RuntimeError("视频文件中没有可解码的视频流")
        duration = _duration_seconds(container, stream)
        positions = sample_positions(duration, count)
        results: list[dict[str, Any]] = []
        last_pts: int | None = None
        rotation = _rotation(stream)
        for index, target in enumerate(positions):
            frame, actual = _seek_frame(container, stream, target, last_pts)
            if frame is None:
                results.append({"sample_index": index, "target_timestamp_ms": round(target * 1000), "status": "failed", "error": "目标时间附近没有可解码帧"})
                continue
            last_pts = frame.pts
            image = frame.to_image()
            image = _apply_rotation(image, rotation)
            image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
            frame_name = f"{index + 1:04d}_{round(actual * 1000):012d}.jpg"
            frame_path = output_dir / frame_name
            image.convert("RGB").save(frame_path, "JPEG", quality=88, optimize=True)
            results.append({
                "sample_index": index,
                "target_timestamp_ms": round(target * 1000),
                "actual_timestamp_ms": round(actual * 1000),
                "status": "ready",
                "frame_path": str(frame_path),
            })
    return duration, results


def _duration_seconds(container: Any, stream: Any) -> float:
    if stream.duration is not None and stream.time_base is not None:
        duration = float(stream.duration * stream.time_base)
    elif container.duration is not None:
        import av
        duration = float(container.duration / av.time_base)
    else:
        duration = 0.0
    if duration <= 0:
        raise RuntimeError("无法读取视频时长")
    return duration


def _seek_frame(container: Any, stream: Any, target: float, last_pts: int | None) -> tuple[Any | None, float]:
    time_base = float(stream.time_base)
    target_pts = max(0, int(target / time_base))
    container.seek(target_pts, stream=stream, any_frame=False, backward=True)
    candidate = None
    candidate_time = 0.0
    for frame in container.decode(stream):
        if frame.pts is None:
            continue
        actual = float(frame.pts * frame.time_base)
        if last_pts is not None and frame.pts == last_pts:
            continue
        candidate, candidate_time = frame, actual
        if actual >= target:
            break
        if actual > target + 5:
            break
    return candidate, candidate_time


def _rotation(stream: Any) -> int:
    try:
        return int(float(stream.metadata.get("rotate", "0"))) % 360
    except (TypeError, ValueError):
        return 0


def _apply_rotation(image: Image.Image, rotation: int) -> Image.Image:
    if rotation == 90:
        return image.transpose(Image.Transpose.ROTATE_270)
    if rotation == 180:
        return image.transpose(Image.Transpose.ROTATE_180)
    if rotation == 270:
        return image.transpose(Image.Transpose.ROTATE_90)
    return image
