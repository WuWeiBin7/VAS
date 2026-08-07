from __future__ import annotations

import base64
import json
from pathlib import Path
import time
from typing import Any

from pydantic import ValidationError

from .config import ModelConfig
from .json_utils import content_to_text, extract_json_object
from .models import ClassificationPlan, FrameDecision


RESEARCH_SYSTEM = """你是一名严谨的视频视觉分类方案设计师。你需要把用户的自然语言分类任务转换为互斥、可执行、适合单帧判断的视觉分类方案。必须只输出 JSON，不要输出 Markdown。类别 ID 只能使用小写字母、数字、下划线或连字符。不要把 uncertain 加入 labels，系统会自动保留该结果。"""


def build_research_prompt(task: str) -> str:
    return f"""请联网调研并为以下视频分类任务设计逐帧判断方案：

任务：{task}

只输出以下 JSON 结构：
{{
  "task_description": "整理后的任务描述",
  "research_summary": "简洁的调研结论",
  "labels": [
    {{
      "id": "stable_ascii_id",
      "name": "中文类别名",
      "definition": "清晰且互斥的定义",
      "positive_cues": ["正向视觉线索"],
      "negative_cues": ["容易混淆但不属于该类别的线索"]
    }}
  ],
  "global_rules": ["跨类别通用判断规则"],
  "frame_prompt": "发送给视觉模型的完整逐帧任务说明"
}}

要求至少两个类别；类别应覆盖用户明确要求的分类范围；对证据不足的帧要求输出 uncertain。"""


class VisionModelClient:
    def __init__(self, config: ModelConfig) -> None:
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError("缺少 openai Python 包，请先安装依赖") from exc
        self.config = config
        self.client = OpenAI(api_key=config.api_key, base_url=config.base_url, timeout=120)

    def research(self, task: str) -> ClassificationPlan:
        kwargs: dict[str, Any] = {}
        if self.config.provider == "dashscope":
            kwargs["extra_body"] = {"enable_search": True}
        try:
            completion = self.client.chat.completions.create(
                model=self.config.research_model,
                messages=[
                    {"role": "system", "content": RESEARCH_SYSTEM},
                    {"role": "user", "content": build_research_prompt(task)},
                ],
                temperature=0,
                **kwargs,
            )
        except Exception as exc:
            if self.config.provider == "dashscope":
                raise RuntimeError(f"联网分类调研失败；请确认 DashScope 模型支持 enable_search：{exc}") from exc
            raise
        text = content_to_text(completion.choices[0].message.content)
        return self._parse_or_repair(text, ClassificationPlan, "分类方案")

    def classify_frame(self, image_path: Path, plan: ClassificationPlan) -> FrameDecision:
        label_context = json.dumps(
            [item.model_dump() for item in plan.labels], ensure_ascii=False, indent=2
        )
        system = f"""你是视频单帧分类器。严格依据确认后的方案判断图像，只输出 JSON。

类别方案：
{label_context}

通用规则：
{json.dumps(plan.global_rules, ensure_ascii=False)}

逐帧提示词：
{plan.frame_prompt}

输出结构：{{"label_id":"类别 ID 或 uncertain","confidence":0.0,"reason":"简短视觉依据"}}
只能使用方案内的类别 ID 或 uncertain。证据不足、画面损坏或无法可靠判断时使用 uncertain。"""
        encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                completion = self.client.chat.completions.create(
                    model=self.config.vision_model,
                    messages=[
                        {"role": "system", "content": system},
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "请分类这一帧。"},
                                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}},
                            ],
                        },
                    ],
                    temperature=0,
                )
                text = content_to_text(completion.choices[0].message.content)
                decision = self._parse_or_repair(text, FrameDecision, "逐帧结果")
                valid_ids = {item.id for item in plan.labels} | {"uncertain"}
                if decision.label_id not in valid_ids:
                    raise ValueError(f"模型返回了方案外类别：{decision.label_id}")
                return decision
            except (ValidationError, ValueError) as exc:
                raise RuntimeError(f"视觉模型返回格式无效：{exc}") from exc
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(2**attempt)
        raise RuntimeError(f"视觉模型请求重试 3 次后仍失败：{last_error}")

    def _parse_or_repair(self, text: str, schema: type[Any], label: str) -> Any:
        try:
            return schema.model_validate(extract_json_object(text))
        except (ValidationError, ValueError, json.JSONDecodeError) as first_error:
            completion = self.client.chat.completions.create(
                model=self.config.research_model,
                messages=[
                    {"role": "system", "content": "你是 JSON 格式修复器。只输出修复后的 JSON，不改变原意。"},
                    {"role": "user", "content": f"请修复以下{label}，使其成为合法 JSON：\n{text}"},
                ],
                temperature=0,
            )
            repaired = content_to_text(completion.choices[0].message.content)
            try:
                return schema.model_validate(extract_json_object(repaired))
            except Exception as repair_error:
                raise ValueError(f"首次解析失败：{first_error}；修复后仍无效：{repair_error}") from repair_error

