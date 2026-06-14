from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pandas as pd

from scripts import build_pregenerated_audio_vocabulary_manifest as vocab


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_build_outputs_merges_bm25_slot_values_and_graphrag_candidates(tmp_path: Path) -> None:
    audio_plan = {
        "families": [
            {
                "canonicalTemplate": "Call {phone_1}.",
                "familyKind": "phone_or_number",
                "sourceFamilies": ["housing"],
                "estimatedSavedChunkCalls": 12,
                "uniqueChunkCount": 4,
                "topSlotValues": {
                    "phone": [["(503) 555-0100", 5]],
                    "address": [["111 W Burnside Street Portland, OR 97209", 3]],
                },
            }
        ]
    }
    audio_plan_path = tmp_path / "audio-plan.json"
    _write_json(audio_plan_path, audio_plan)

    corpus_dir = tmp_path / "corpus"
    generated_dir = corpus_dir / "generated"
    generated_dir.mkdir(parents=True)
    _write_json(
        generated_dir / "bm25-documents.json",
        {
            "schemaVersion": 1,
            "documentFrequency": {"pantry": 2, "food": 1, "the": 2},
            "documents": [
                {
                    "doc_id": "service:1",
                    "doc_type": "service",
                    "document_length": 10,
                    "terms": {"pantry": 4.0, "food": 1.0, "the": 8.0},
                    "term_idf": {"pantry": 1.5, "food": 0.2, "the": 0.01},
                },
                {
                    "doc_id": "service:2",
                    "doc_type": "service",
                    "document_length": 8,
                    "terms": {"pantry": 2.0},
                    "term_idf": {"pantry": 1.5},
                },
            ],
        },
    )
    pd.DataFrame(
        [
            {
                "doc_id": "service:1",
                "doc_type": "service",
                "title": "Pantry Site",
                "provider_name": "Portland Rescue Mission",
                "program_name": "Community Pantry",
                "phones": [{"value": "(503) 555-0100"}],
                "addresses": [{"address": "111 W Burnside Street Portland, OR 97209"}],
            },
            {
                "doc_id": "service:2",
                "doc_type": "service",
                "title": "Pantry Site Two",
                "provider_name": "Portland Rescue Mission",
                "program_name": "Community Pantry",
                "phones": [{"value": "+1 503-555-0100"}],
                "addresses": [{"address": "111 W Burnside Street Portland, OR 97209"}],
            },
        ]
    ).to_parquet(generated_dir / "documents.parquet", index=False)

    args = SimpleNamespace(
        audio_plan=audio_plan_path,
        browser_corpus_dir=corpus_dir,
        doc_type=["service"],
        top_bm25_terms=10,
        top_slot_values=10,
        top_entity_names=10,
        top_phones=10,
        top_addresses=10,
        min_bm25_document_frequency=2,
        min_graph_occurrence=2,
        min_slot_observed=2,
        top_report_items=5,
        vocab_inventory=tmp_path / "inventory.json",
        vocab_manifest=tmp_path / "manifest.json",
        graphrag_candidates=tmp_path / "graphrag.json",
        report=tmp_path / "report.md",
    )

    inventory, manifest, bm25_manifest, graphrag_inventory = vocab.build_outputs(args)

    assert inventory["summary"]["bm25TermCount"] == 1
    assert inventory["summary"]["bm25ManifestCount"] == 1
    assert inventory["bm25Terms"][0]["spokenText"] == "pantry"
    assert inventory["bm25Terms"][0]["matchedDocumentCount"] == 2
    assert bm25_manifest["summary"]["responseCount"] == 1
    assert bm25_manifest["responses"][0]["text"] == "pantry"
    assert bm25_manifest["responses"][0]["sourceTypes"] == ["graphrag.bm25_term"]

    assert graphrag_inventory["summary"]["entityNameCount"] >= 2
    assert graphrag_inventory["summary"]["phoneCount"] == 1
    assert graphrag_inventory["summary"]["addressCount"] == 1

    phone_entry = next(item for item in manifest["responses"] if "phone" in item["slotKinds"])
    assert "audio_plan.slot_value" in phone_entry["sourceTypes"]
    assert "graphrag.phone" in phone_entry["sourceTypes"]
    assert phone_entry["normalizedValues"]["phone"] == ["5035550100"]

    address_entry = next(item for item in manifest["responses"] if "address" in item["slotKinds"])
    assert address_entry["observedCount"] >= 5

    assert any(item["text"] == "pantry" for item in manifest["responses"])


def test_build_bm25_term_candidates_keeps_all_repeated_terms_when_uncapped() -> None:
    payload = {
        "documentFrequency": {"pantry": 2, "shelter": 2, "the": 5},
        "documents": [
            {
                "doc_id": "service:1",
                "doc_type": "service",
                "terms": {"pantry": 4.0, "shelter": 1.0, "the": 9.0},
                "term_idf": {"pantry": 1.5, "shelter": 0.8, "the": 0.01},
            },
            {
                "doc_id": "service:2",
                "doc_type": "service",
                "terms": {"pantry": 1.0, "shelter": 3.0},
                "term_idf": {"pantry": 1.5, "shelter": 0.8},
            },
        ],
    }
    args = SimpleNamespace(doc_type=["service"], top_bm25_terms=0, min_bm25_document_frequency=2)

    candidates = vocab.build_bm25_term_candidates(payload, args)

    assert [item["normalizedValue"] for item in candidates] == ["pantry", "shelter"]


def test_build_bm25_term_candidates_filters_artifacts_and_spells_supported_tokens() -> None:
    payload = {
        "documentFrequency": {
            "30 PM": 2,
            "20cooling": 2,
            "ebt": 2,
            "dd214": 2,
            "lgbtqia2s": 2,
        },
        "documents": [
            {
                "doc_id": "service:1",
                "doc_type": "service",
                "terms": {
                    "30 PM": 2.0,
                    "20cooling": 2.0,
                    "ebt": 2.0,
                    "dd214": 2.0,
                    "lgbtqia2s": 2.0,
                },
                "term_idf": {
                    "30 PM": 1.0,
                    "20cooling": 1.0,
                    "ebt": 1.0,
                    "dd214": 1.0,
                    "lgbtqia2s": 1.0,
                },
            },
            {
                "doc_id": "service:2",
                "doc_type": "service",
                "terms": {
                    "30 PM": 1.0,
                    "20cooling": 1.0,
                    "ebt": 1.0,
                    "dd214": 1.0,
                    "lgbtqia2s": 1.0,
                },
                "term_idf": {
                    "30 PM": 1.0,
                    "20cooling": 1.0,
                    "ebt": 1.0,
                    "dd214": 1.0,
                    "lgbtqia2s": 1.0,
                },
            },
        ],
    }
    args = SimpleNamespace(doc_type=["service"], top_bm25_terms=0, min_bm25_document_frequency=2)

    candidates = vocab.build_bm25_term_candidates(payload, args)

    by_value = {item["normalizedValue"]: item for item in candidates}
    assert "30 pm" not in by_value
    assert "20cooling" not in by_value
    assert by_value["ebt"]["spokenText"] == "E B T"
    assert by_value["dd214"]["spokenText"] == "D D two one four"
    assert by_value["lgbtqia2s"]["spokenText"] == "L G B T Q I A two S"