from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class CategoryLabel(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=80)
    definition: str = Field(min_length=1)
    positive_cues: list[str] = Field(default_factory=list)
    negative_cues: list[str] = Field(default_factory=list)


class ClassificationPlan(BaseModel):
    task_description: str = Field(min_length=3)
    research_summary: str = ""
    labels: list[CategoryLabel] = Field(min_length=2)
    global_rules: list[str] = Field(default_factory=list)
    frame_prompt: str = Field(min_length=10)

    @field_validator("labels")
    @classmethod
    def unique_labels(cls, labels: list[CategoryLabel]) -> list[CategoryLabel]:
        ids = [item.id for item in labels]
        if len(ids) != len(set(ids)):
            raise ValueError("label ids must be unique")
        return labels


class FrameDecision(BaseModel):
    label_id: str = Field(min_length=1)
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=500)


@dataclass(frozen=True)
class VideoFile:
    path: Path
    relative_path: str
    size: int
    mtime_ns: int


FrameStatus = Literal["success", "failed"]


def sample_positions(duration_seconds: float, count: int) -> list[float]:
    if count < 1:
        raise ValueError("count must be positive")
    if duration_seconds <= 0:
        raise ValueError("duration must be positive")
    return [duration_seconds * (index + 0.5) / count for index in range(count)]


def vote(frame_labels: list[str]) -> tuple[str, dict[str, int]]:
    counts: dict[str, int] = {}
    for label in frame_labels:
        counts[label] = counts.get(label, 0) + 1
    eligible_counts = {label: count for label, count in counts.items() if label != "uncertain"}
    if not eligible_counts:
        return "uncertain", counts
    highest = max(eligible_counts.values())
    winners = [label for label, count in eligible_counts.items() if count == highest]
    if len(winners) != 1:
        return "uncertain", counts
    return winners[0], counts
