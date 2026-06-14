from __future__ import annotations

import argparse
import json
from pathlib import Path

from scripts.analyze_slot_friendly_query_response_pairs import build_analysis, mask_query


def test_mask_query_slots_service_location_and_entity() -> None:
    masked = mask_query("I need shelter near Portland and I lost my Oregon ID.")

    assert "{service_1}" in masked["maskedText"]
    assert "{location_1}" in masked["maskedText"]
    assert any(slot["kind"] == "service" and slot["value"] == "shelter" for slot in masked["slots"])
    assert any(slot["kind"] == "location" and slot["value"] == "Portland" for slot in masked["slots"])


def test_build_analysis_deduplicates_query_response_pairs(tmp_path: Path) -> None:
    memory = tmp_path / "memory.json"
    memory.write_text(
        json.dumps(
            {
                "records": [
                    {
                        "id": "scenario-1#turn-1",
                        "scenarioId": "scenario-1",
                        "turnIndex": 0,
                        "user": "I need food in Portland.",
                        "route": "grounded_211_answer",
                        "assistant": "Call two one one.",
                    },
                    {
                        "id": "scenario-2#turn-1",
                        "scenarioId": "scenario-2",
                        "turnIndex": 0,
                        "user": "I need groceries in Salem.",
                        "route": "grounded_211_answer",
                        "assistant": "Call two one one.",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    args = argparse.Namespace(
        memory=memory,
        top=10,
        top_slot_values=5,
        examples_per_template=2,
        include_details=True,
    )

    report = build_analysis(args)

    assert report["summary"]["recordCount"] == 2
    assert report["summary"]["reusableResponseTemplates"] == 1
    assert any("{service_1}" in item["maskedText"] for item in report["topQueryTemplates"])
    assert report["records"][0]["responseMaskedText"] == "Call two one one."
