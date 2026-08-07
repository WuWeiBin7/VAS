from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

from .client import VisionModelClient
from .config import ModelConfig
from .media import extract_frames, scan_videos, video_fingerprint, video_id
from .models import ClassificationPlan, FrameDecision, VideoFile, vote


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def emit(event_type: str, **payload: Any) -> None:
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def atomic_json(path: Path, payload: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"{path.name} 必须是 JSON 对象")
    return payload


def load_latest_frames(path: Path) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return latest
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            item = json.loads(raw)
            latest[item["checkpoint_key"]] = item
        except (json.JSONDecodeError, KeyError):
            continue
    return latest


def plan_hash(plan: ClassificationPlan) -> str:
    payload = json.dumps(plan.model_dump(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class Worker:
    def __init__(self, job_dir: Path, config_path: Path) -> None:
        self.job_dir = job_dir.resolve()
        self.manifest_path = self.job_dir / "manifest.json"
        self.manifest = read_json(self.manifest_path)
        self.input_dir = Path(self.manifest["input_dir"]).resolve()
        self.plan = ClassificationPlan.model_validate(read_json(self.job_dir / "classification_plan.json"))
        self.plan_digest = plan_hash(self.plan)
        if self.plan_digest != self.manifest.get("plan_hash"):
            raise RuntimeError("分类方案已变化，不能继续原任务，请创建新任务")
        self.frames_per_video = int(self.manifest["frames_per_video"])
        self.concurrency = int(self.manifest["concurrency"])
        self.cancel_path = self.job_dir / "cancel.requested"
        self.frame_jsonl = self.job_dir / "frame_results.jsonl"
        self.latest_frames = load_latest_frames(self.frame_jsonl)
        self.client = VisionModelClient(ModelConfig.load(config_path))
        self.video_results: list[dict[str, Any]] = list(self.manifest.get("video_results", []))
        self.completed_video_ids = {item["video_id"] for item in self.video_results if item.get("status") == "completed"}

    def run(self) -> int:
        self._update_manifest(status="running", error=None, started_at=self.manifest.get("started_at") or now_iso())
        videos = scan_videos(self.input_dir)
        self.manifest["total_videos"] = len(videos)
        self._persist_manifest()
        emit("job_started", total_videos=len(videos))
        for position, video in enumerate(videos, start=1):
            if self.cancel_path.exists():
                return self._cancel()
            vid = video_id(video.relative_path)
            if vid in self.completed_video_ids:
                emit("video_skipped", video_id=vid, relative_path=video.relative_path)
                continue
            self._update_manifest(current_video=video.relative_path)
            emit("video_started", video_id=vid, relative_path=video.relative_path, index=position, total=len(videos))
            try:
                result = self._process_video(video)
            except Exception as exc:
                result = {
                    "video_id": vid,
                    "relative_path": video.relative_path,
                    "status": "completed",
                    "label_id": "uncertain",
                    "vote_counts": {},
                    "error": str(exc),
                    "completed_frames": 0,
                    "failed_frames": self.frames_per_video,
                }
                emit("video_error", video_id=vid, relative_path=video.relative_path, error=str(exc))
            if self.cancel_path.exists():
                return self._cancel()
            self.video_results = [item for item in self.video_results if item.get("video_id") != vid]
            self.video_results.append(result)
            self.completed_video_ids.add(vid)
            self.manifest["video_results"] = self.video_results
            self.manifest["completed_videos"] = len(self.completed_video_ids)
            self._persist_manifest()
            self._write_outputs()
            emit("video_completed", result=result)
        self._update_manifest(status="completed", current_video=None, completed_at=now_iso())
        self._write_outputs()
        emit("job_completed", summary=self._summary())
        return 0

    def _process_video(self, video: VideoFile) -> dict[str, Any]:
        vid = video_id(video.relative_path)
        fingerprint = video_fingerprint(video)
        frame_dir = self.job_dir / "frames" / vid
        duration, samples = extract_frames(video, self.frames_per_video, frame_dir)
        successful: list[dict[str, Any]] = []
        failed_count = 0
        pending: dict[Future[FrameDecision], tuple[dict[str, Any], str]] = {}
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            for sample in samples:
                key = f"{fingerprint}:{self.plan_digest}:{self.frames_per_video}:{sample['sample_index']}"
                previous = self.latest_frames.get(key)
                if previous and previous.get("status") == "success":
                    successful.append(previous)
                    emit("frame_skipped", video_id=vid, sample_index=sample["sample_index"])
                    continue
                if sample.get("status") != "ready":
                    record = self._frame_record(video, vid, fingerprint, key, sample, status="failed", error=sample.get("error", "抽帧失败"))
                    self._append_frame(record)
                    failed_count += 1
                    emit("frame_failed", result=record)
                    continue
                future = pool.submit(self.client.classify_frame, Path(sample["frame_path"]), self.plan)
                pending[future] = (sample, key)
            for future in as_completed(pending):
                sample, key = pending[future]
                try:
                    decision = future.result()
                    record = self._frame_record(video, vid, fingerprint, key, sample, status="success", decision=decision)
                    successful.append(record)
                    emit("frame_completed", result=record)
                except Exception as exc:
                    record = self._frame_record(video, vid, fingerprint, key, sample, status="failed", error=str(exc))
                    failed_count += 1
                    emit("frame_failed", result=record)
                self._append_frame(record)
                self.manifest["completed_frames"] = int(self.manifest.get("completed_frames", 0)) + 1
                self.manifest["failed_frames"] = int(self.manifest.get("failed_frames", 0)) + (1 if record["status"] == "failed" else 0)
                self._persist_manifest()
                if self.cancel_path.exists():
                    for queued in pending:
                        queued.cancel()
        label_id, counts = vote([item["label_id"] for item in successful])
        return {
            "video_id": vid,
            "relative_path": video.relative_path,
            "duration_ms": round(duration * 1000),
            "status": "completed",
            "label_id": label_id,
            "vote_counts": counts,
            "completed_frames": len(successful),
            "failed_frames": failed_count,
            "error": None,
        }

    def _frame_record(self, video: VideoFile, vid: str, fingerprint: str, key: str, sample: dict[str, Any], *, status: str, decision: FrameDecision | None = None, error: str | None = None) -> dict[str, Any]:
        frame_path = sample.get("frame_path")
        relative_frame = str(Path(frame_path).relative_to(self.job_dir)).replace("\\", "/") if frame_path else None
        return {
            "checkpoint_key": key,
            "video_id": vid,
            "video_fingerprint": fingerprint,
            "relative_path": video.relative_path,
            "sample_index": sample["sample_index"],
            "target_timestamp_ms": sample.get("target_timestamp_ms"),
            "actual_timestamp_ms": sample.get("actual_timestamp_ms"),
            "frame_path": relative_frame,
            "status": status,
            "label_id": decision.label_id if decision else None,
            "confidence": decision.confidence if decision else None,
            "reason": decision.reason if decision else None,
            "error": error,
            "completed_at": now_iso(),
        }

    def _append_frame(self, record: dict[str, Any]) -> None:
        with self.frame_jsonl.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
        self.latest_frames[record["checkpoint_key"]] = record
        self._write_frame_csv()

    def _write_frame_csv(self) -> None:
        fields = ["relative_path", "sample_index", "target_timestamp_ms", "actual_timestamp_ms", "status", "label_id", "confidence", "reason", "error", "frame_path"]
        with (self.job_dir / "frames.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            for item in sorted(self.latest_frames.values(), key=lambda value: (value["relative_path"], value["sample_index"])):
                writer.writerow(item)

    def _write_outputs(self) -> None:
        fields = ["relative_path", "duration_ms", "status", "label_id", "completed_frames", "failed_frames", "vote_counts", "error"]
        with (self.job_dir / "videos.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            for item in sorted(self.video_results, key=lambda value: value["relative_path"]):
                row = {**item, "vote_counts": json.dumps(item.get("vote_counts", {}), ensure_ascii=False)}
                writer.writerow(row)
        atomic_json(self.job_dir / "summary.json", self._summary())

    def _summary(self) -> dict[str, Any]:
        labels: dict[str, int] = {}
        for item in self.video_results:
            label = item.get("label_id", "uncertain")
            labels[label] = labels.get(label, 0) + 1
        return {
            "job_id": self.manifest["id"],
            "status": self.manifest["status"],
            "total_videos": self.manifest.get("total_videos", 0),
            "completed_videos": len(self.completed_video_ids),
            "label_counts": labels,
            "updated_at": now_iso(),
            "video_results": self.video_results,
        }

    def _cancel(self) -> int:
        self._update_manifest(status="cancelled", current_video=None, cancelled_at=now_iso())
        self._write_outputs()
        emit("job_cancelled")
        return 2

    def _update_manifest(self, **values: Any) -> None:
        self.manifest.update(values)
        self.manifest["updated_at"] = now_iso()
        self._persist_manifest()

    def _persist_manifest(self) -> None:
        atomic_json(self.manifest_path, self.manifest)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    try:
        return Worker(args.job_dir, args.config).run()
    except Exception as exc:
        try:
            manifest_path = args.job_dir / "manifest.json"
            manifest = read_json(manifest_path)
            manifest.update({"status": "failed", "error": str(exc), "updated_at": now_iso()})
            atomic_json(manifest_path, manifest)
        except Exception:
            pass
        emit("job_error", error=str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
