from __future__ import annotations

import json
import re
from typing import Any


def content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        values: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                values.append(item["text"])
            elif hasattr(item, "text"):
                values.append(str(item.text))
        return "\n".join(values)
    return str(content or "")


def extract_json_object(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("model response contains no JSON object")
        payload = json.loads(cleaned[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("model response must be a JSON object")
    return payload

