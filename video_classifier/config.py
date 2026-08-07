from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ModelConfig:
    provider: str
    api_key: str
    base_url: str
    research_model: str
    vision_model: str

    @classmethod
    def load(cls, path: Path) -> "ModelConfig":
        payload: dict[str, Any] = {}
        if path.exists():
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise RuntimeError("config.json must contain an object")
            payload = loaded
        provider = _text(payload.get("provider")) or os.getenv("VAS_PROVIDER") or "dashscope"
        api_key = _text(payload.get("api_key")) or os.getenv("DASHSCOPE_API_KEY") or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("API Key 未配置，请先在模型设置中保存 API Key")
        return cls(
            provider=provider.lower(),
            api_key=api_key,
            base_url=_text(payload.get("base_url")) or os.getenv("VAS_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1",
            research_model=_text(payload.get("research_model")) or os.getenv("VAS_RESEARCH_MODEL") or "qwen-plus",
            vision_model=_text(payload.get("vision_model")) or os.getenv("VAS_VISION_MODEL") or "qwen-vl-plus",
        )


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None

