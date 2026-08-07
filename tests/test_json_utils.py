import pytest

from video_classifier.json_utils import content_to_text, extract_json_object


def test_extracts_fenced_and_embedded_json() -> None:
    assert extract_json_object('```json\n{"ok": true}\n```') == {"ok": True}
    assert extract_json_object('result follows: {"label_id":"a"} done') == {"label_id": "a"}


def test_rejects_missing_json() -> None:
    with pytest.raises(ValueError):
        extract_json_object("not json")


def test_content_blocks_to_text() -> None:
    assert content_to_text([{"type": "text", "text": "one"}, {"type": "text", "text": "two"}]) == "one\ntwo"

