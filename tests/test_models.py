import pytest

from video_classifier.models import CategoryLabel, ClassificationPlan, sample_positions, vote


def test_midpoint_sampling() -> None:
    assert sample_positions(10, 1) == [5]
    assert sample_positions(8, 4) == [1, 3, 5, 7]


def test_sampling_rejects_invalid_values() -> None:
    with pytest.raises(ValueError):
        sample_positions(0, 4)
    with pytest.raises(ValueError):
        sample_positions(10, 0)


@pytest.mark.parametrize(
    ("labels", "expected"),
    [
        (["first", "first", "third"], "first"),
        (["first", "third"], "uncertain"),
        (["uncertain", "uncertain", "first"], "first"),
        (["first"] * 4 + ["uncertain"] * 5 + ["third"], "first"),
        (["first", "third", "uncertain", "uncertain"], "uncertain"),
        (["uncertain", "uncertain"], "uncertain"),
        ([], "uncertain"),
    ],
)
def test_vote_policy(labels: list[str], expected: str) -> None:
    result, counts = vote(labels)
    assert result == expected
    assert sum(counts.values()) == len(labels)


def test_plan_rejects_duplicate_ids() -> None:
    labels = [
        CategoryLabel(id="same", name="A", definition="A definition"),
        CategoryLabel(id="same", name="B", definition="B definition"),
    ]
    with pytest.raises(ValueError):
        ClassificationPlan(
            task_description="valid task",
            labels=labels,
            frame_prompt="classify this frame carefully",
        )
