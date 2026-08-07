from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

import av
from PIL import Image

from video_classifier.models import CategoryLabel, ClassificationPlan
from video_classifier.worker import Worker, plan_hash


class FakeModelHandler(BaseHTTPRequestHandler):
    calls = 0

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        type(self).calls += 1
        content = json.dumps(
            {"label_id": "first_person", "confidence": 0.91, "reason": "测试画面"},
            ensure_ascii=False,
        )
        payload = {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1,
            "model": "fake-vision",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args: object) -> None:
        return


def make_video(path: Path) -> None:
    container = av.open(str(path), mode="w")
    stream = container.add_stream("mpeg4", rate=10)
    stream.width = 160
    stream.height = 90
    stream.pix_fmt = "yuv420p"
    for index in range(20):
        frame = av.VideoFrame.from_image(Image.new("RGB", (160, 90), (index * 8, 50, 120)))
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()


def test_worker_outputs_and_frame_level_resume(tmp_path: Path) -> None:
    FakeModelHandler.calls = 0
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModelHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        make_video(input_dir / "clip.mp4")
        plan = ClassificationPlan(
            task_description="区分第一和第三人称视角",
            labels=[
                CategoryLabel(id="first_person", name="第一人称", definition="摄像机代表主体视角"),
                CategoryLabel(id="third_person", name="第三人称", definition="能从外部观察主体"),
            ],
            frame_prompt="请依据摄像机与主体的相对关系进行分类。",
        )
        job_dir = input_dir / "_video_classification" / "test-job"
        job_dir.mkdir(parents=True)
        (job_dir / "classification_plan.json").write_text(plan.model_dump_json(indent=2), encoding="utf-8")
        manifest = {
            "id": "test-job",
            "input_dir": str(input_dir),
            "job_dir": str(job_dir),
            "status": "interrupted",
            "frames_per_video": 3,
            "concurrency": 2,
            "plan_hash": plan_hash(plan),
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
            "video_results": [],
        }
        (job_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        config = tmp_path / "config.json"
        config.write_text(
            json.dumps(
                {
                    "provider": "generic",
                    "api_key": "test-key",
                    "base_url": f"http://127.0.0.1:{server.server_port}/v1",
                    "research_model": "fake-research",
                    "vision_model": "fake-vision",
                }
            ),
            encoding="utf-8",
        )

        assert Worker(job_dir, config).run() == 0
        assert FakeModelHandler.calls == 3
        assert (job_dir / "frames.csv").exists()
        assert (job_dir / "videos.csv").exists()
        summary = json.loads((job_dir / "summary.json").read_text(encoding="utf-8"))
        assert summary["video_results"][0]["label_id"] == "first_person"

        # Simulate a restart before the video summary was committed. Frame checkpoints
        # remain authoritative and must suppress duplicate model requests.
        saved = json.loads((job_dir / "manifest.json").read_text(encoding="utf-8"))
        saved.update({"status": "interrupted", "video_results": [], "completed_videos": 0})
        (job_dir / "manifest.json").write_text(json.dumps(saved, ensure_ascii=False), encoding="utf-8")
        assert Worker(job_dir, config).run() == 0
        assert FakeModelHandler.calls == 3
    finally:
        server.shutdown()
        server.server_close()

