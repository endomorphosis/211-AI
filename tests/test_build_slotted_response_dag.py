from __future__ import annotations

import argparse
import json
from pathlib import Path

from scripts.build_slotted_response_dag import build_slotted_dag


def test_build_slotted_dag_embeds_canonical_intents_and_unique_exemplars(tmp_path: Path) -> None:
    memory = tmp_path / "memory.json"
    slot_dedupe = tmp_path / "slot.json"
    memory.write_text(
        json.dumps(
            {
                "records": [
                    {
                        "id": "scenario-1#turn-1",
                        "scenarioId": "scenario-1",
                        "route": "grounded_211_answer",
                        "user": "I need food in Portland.",
                        "assistant": "Call two one one.",
                        "evidenceDocIds": ["service:food"],
                    },
                    {
                        "id": "scenario-2#turn-1",
                        "scenarioId": "scenario-2",
                        "route": "grounded_211_answer",
                        "user": "I need shelter in Salem.",
                        "assistant": "Call two one one.",
                        "evidenceDocIds": ["service:shelter"],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    slot_dedupe.write_text(
        json.dumps(
            {
                "records": [
                    {
                        "id": "scenario-1#turn-1",
                        "route": "grounded_211_answer",
                        "queryMaskedText": "I need {service_1} in {location_1}.",
                        "canonicalQueryTemplate": "I need {service_1} in {location_1}.",
                        "querySlots": [
                            {"kind": "service", "value": "food"},
                            {"kind": "location", "value": "Portland"},
                        ],
                        "responseMaskedText": "Call two one one.",
                        "responseSignature": "Call two one one.",
                        "responseSlots": [],
                    },
                    {
                        "id": "scenario-2#turn-1",
                        "route": "grounded_211_answer",
                        "queryMaskedText": "I need {service_1} in {location_1}.",
                        "canonicalQueryTemplate": "I need {service_1} in {location_1}.",
                        "querySlots": [
                            {"kind": "service", "value": "shelter"},
                            {"kind": "location", "value": "Salem"},
                        ],
                        "responseMaskedText": "Call two one one.",
                        "responseSignature": "Call two one one.",
                        "responseSlots": [],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    args = argparse.Namespace(
        memory=memory,
        slot_dedupe=slot_dedupe,
        embedding_provider="deterministic_sparse",
        embedding_model="test-model",
        embedding_device=None,
        embedding_batch_size=8,
        examples_per_node=2,
        examples_per_edge=2,
        top_counts=5,
        top_slot_values=5,
        top_evidence_docs=5,
        include_unique_exemplars=True,
    )

    dag = build_slotted_dag(args)

    assert dag["summary"]["intentNodeCount"] == 1
    assert dag["summary"]["responseFrameNodeCount"] == 1
    assert dag["summary"]["edgeCount"] == 1
    assert dag["summary"]["reusableEdgeCount"] == 1
    intent = dag["nodes"]["intents"][0]
    assert intent["canonicalQueryTemplate"] == "I need {service_1} in {location_1}."
    assert intent["embedding"]
    assert intent["querySlotKinds"] == {"location": 2, "service": 2}
