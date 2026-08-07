from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .client import VisionModelClient
from .config import ModelConfig


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    try:
        plan = VisionModelClient(ModelConfig.load(args.config)).research(args.task)
        print(json.dumps({"ok": True, "plan": plan.model_dump()}, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())

