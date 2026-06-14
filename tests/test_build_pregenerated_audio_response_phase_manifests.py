from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from scripts import build_pregenerated_audio_response_phase_manifests as phases


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def test_build_outputs_excludes_phase2_composable_responses_and_splits_remaining_rows(tmp_path: Path) -> None:
    input_manifest = tmp_path / "pregenerated_text_response_manifest.json"
    _write_json(
        input_manifest,
        {
            "responses": [
                {
                    "id": "abby-tts-composable-phone",
                    "text": "Call five zero three, five five five, zero one zero zero.",
                    "sourceIds": ["scenario-1#turn-1", "scenario-2#turn-2"],
                },
                {
                    "id": "abby-tts-composable-static",
                    "text": "Call nine one one now.",
                    "sourceIds": ["scenario-3#turn-1"],
                },
                {
                    "id": "abby-tts-duplicate",
                    "text": "I can stay with you while you call.",
                    "sourceIds": ["scenario-4#turn-1", "scenario-5#turn-3"],
                    "priorityScore": 4.0,
                },
                {
                    "id": "abby-tts-residual",
                    "text": "This response only happens once.",
                    "sourceIds": ["scenario-6#turn-1"],
                    "priorityScore": 2.0,
                },
            ]
        },
    )

    audio_plan = tmp_path / "pregenerated_text_audio_slot_plan.json"
    _write_json(
        audio_plan,
        {
            "families": [
                {
                    "canonicalTemplate": "Call {phone_1}.",
                    "familyKind": "phone_or_number",
                    "estimatedSavedChunkCalls": 10,
                    "uniqueChunkCount": 2,
                    "sourceFamilies": ["phone_dialog"],
                },
                {
                    "canonicalTemplate": "Call nine one one now.",
                    "familyKind": "emergency_phrase",
                    "estimatedSavedChunkCalls": 5,
                    "uniqueChunkCount": 1,
                    "sourceFamilies": ["211"],
                },
            ]
        },
    )

    slot_manifest_dir = tmp_path / "slot-value-manifests"
    _write_json(
        slot_manifest_dir / "phone.json",
        {
            "slotKind": "phone",
            "responses": [
                {
                    "id": "abby-tts-slot-phone-1",
                    "text": "five zero three, five five five, zero one zero zero",
                    "sourceIds": ["audio-slot::phone::demo"],
                }
            ],
        },
    )

    args = SimpleNamespace(
        input_manifest=input_manifest,
        audio_plan=audio_plan,
        source_opportunities=None,
        slot_value_manifest_dir=slot_manifest_dir,
        duplicate_manifest=tmp_path / "duplicate.json",
        residual_manifest=tmp_path / "residual.json",
        report=tmp_path / "report.md",
        min_duplicate_source_refs=2,
    )

    duplicate_manifest, residual_manifest, report = phases.build_outputs(args)

    assert duplicate_manifest["summary"]["inputResponseCount"] == 4
    assert duplicate_manifest["summary"]["phase2ComposableExcludedCount"] == 2
    assert duplicate_manifest["summary"]["responseCount"] == 1
    assert residual_manifest["summary"]["responseCount"] == 1
    assert duplicate_manifest["responses"][0]["text"] == "I can stay with you while you call."
    assert duplicate_manifest["responses"][0]["canonicalSourceRefCount"] == 2
    assert duplicate_manifest["responses"][0]["phase"] == "duplicate_full_response"
    assert residual_manifest["responses"][0]["text"] == "This response only happens once."
    assert residual_manifest["responses"][0]["canonicalSourceRefCount"] == 1
    assert residual_manifest["responses"][0]["phase"] == "residual_full_response"
    assert "Call {phone_1}.: matched_responses=1" in report
    assert "Call nine one one now.: matched_responses=1" in report


def test_build_outputs_only_excludes_template_matches_when_slot_value_is_present(tmp_path: Path) -> None:
    input_manifest = tmp_path / "pregenerated_text_response_manifest.json"
    _write_json(
        input_manifest,
        {
            "responses": [
                {
                    "id": "abby-tts-uncovered-phone",
                    "text": "Call five zero three, five five five, zero one nine nine.",
                    "sourceIds": ["scenario-1#turn-1", "scenario-2#turn-2"],
                }
            ]
        },
    )

    audio_plan = tmp_path / "pregenerated_text_audio_slot_plan.json"
    _write_json(
        audio_plan,
        {
            "families": [
                {
                    "canonicalTemplate": "Call {phone_1}.",
                    "familyKind": "phone_or_number",
                    "estimatedSavedChunkCalls": 10,
                    "uniqueChunkCount": 2,
                    "sourceFamilies": ["phone_dialog"],
                }
            ]
        },
    )

    slot_manifest_dir = tmp_path / "slot-value-manifests"
    _write_json(
        slot_manifest_dir / "phone.json",
        {
            "slotKind": "phone",
            "responses": [
                {
                    "id": "abby-tts-slot-phone-1",
                    "text": "five zero three, five five five, zero one zero zero",
                    "sourceIds": ["audio-slot::phone::demo"],
                }
            ],
        },
    )

    args = SimpleNamespace(
        input_manifest=input_manifest,
        audio_plan=audio_plan,
        source_opportunities=None,
        slot_value_manifest_dir=slot_manifest_dir,
        duplicate_manifest=tmp_path / "duplicate.json",
        residual_manifest=tmp_path / "residual.json",
        report=tmp_path / "report.md",
        min_duplicate_source_refs=2,
    )

    duplicate_manifest, residual_manifest, report = phases.build_outputs(args)

    assert duplicate_manifest["summary"]["phase2ComposableExcludedCount"] == 0
    assert duplicate_manifest["summary"]["responseCount"] == 1
    assert residual_manifest["summary"]["responseCount"] == 0
    assert duplicate_manifest["responses"][0]["text"] == "Call five zero three, five five five, zero one nine nine."
    assert "Top Phase-2 Coverage Families" in report


def test_build_outputs_prefers_source_masked_templates_when_available(tmp_path: Path) -> None:
    input_manifest = tmp_path / "pregenerated_text_response_manifest.json"
    _write_json(
        input_manifest,
        {
            "responses": [
                {
                    "id": "abby-tts-masked-template-match",
                    "text": "A ride line number I can give is five zero three, five five five, zero one zero zero.",
                    "sourceIds": ["scenario-1#turn-1", "scenario-2#turn-2"],
                },
                {
                    "id": "abby-tts-other-duplicate",
                    "text": "This one should stay in the duplicate pass.",
                    "sourceIds": ["scenario-3#turn-1", "scenario-4#turn-2"],
                },
            ]
        },
    )

    audio_plan = tmp_path / "pregenerated_text_audio_slot_plan.json"
    _write_json(
        audio_plan,
        {
            "families": [
                {
                    "canonicalTemplate": "Call {phone_1}.",
                    "familyKind": "phone_or_number",
                    "estimatedSavedChunkCalls": 10,
                    "uniqueChunkCount": 2,
                    "sourceFamilies": ["phone_dialog"],
                }
            ]
        },
    )

    source_opportunities = tmp_path / "pregenerated_text_rewrite_opportunities.json"
    _write_json(
        source_opportunities,
        {
            "opportunities": [
                {
                    "canonicalTemplate": "Call {phone_1}.",
                    "familyKind": "phone_or_number",
                    "estimatedSavedChunkCalls": 10,
                    "uniqueChunkCount": 2,
                    "sourceFamilies": ["phone_dialog"],
                    "sourceMaskedTemplates": ["A ride line number I can give is {phone_1}."],
                }
            ]
        },
    )

    slot_manifest_dir = tmp_path / "slot-value-manifests"
    _write_json(
        slot_manifest_dir / "phone.json",
        {
            "slotKind": "phone",
            "responses": [
                {
                    "id": "abby-tts-slot-phone-1",
                    "text": "five zero three, five five five, zero one zero zero",
                    "sourceIds": ["audio-slot::phone::demo"],
                }
            ],
        },
    )

    args = SimpleNamespace(
        input_manifest=input_manifest,
        audio_plan=audio_plan,
        source_opportunities=source_opportunities,
        slot_value_manifest_dir=slot_manifest_dir,
        duplicate_manifest=tmp_path / "duplicate.json",
        residual_manifest=tmp_path / "residual.json",
        report=tmp_path / "report.md",
        min_duplicate_source_refs=2,
    )

    duplicate_manifest, residual_manifest, report = phases.build_outputs(args)

    assert duplicate_manifest["summary"]["phase2ComposableExcludedCount"] == 1
    assert duplicate_manifest["summary"]["responseCount"] == 1
    assert residual_manifest["summary"]["responseCount"] == 0
    assert duplicate_manifest["responses"][0]["id"] == "abby-tts-other-duplicate"
    assert "Call {phone_1}.: matched_responses=1" in report