#!/usr/bin/env python3
"""Build shell and slot-value audio manifests from the pregenerated text audio plan."""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(REPO_ROOT))

from scripts.precompute_indextts_responses import (  # noqa: E402
    normalize_slot_value_text,
    stable_id,
)


DEFAULT_AUDIO_PLAN = REPO_ROOT / "docs" / "pregenerated_text_audio_slot_plan.json"
DEFAULT_SHELL_MANIFEST = REPO_ROOT / "docs" / "pregenerated_text_audio_shell_manifest.json"
DEFAULT_SLOT_VALUE_INVENTORY = REPO_ROOT / "docs" / "pregenerated_text_audio_slot_value_inventory.json"
DEFAULT_SLOT_VALUE_MANIFEST = REPO_ROOT / "docs" / "pregenerated_text_audio_slot_value_manifest.json"
DEFAULT_SLOT_VALUE_MANIFEST_DIR = REPO_ROOT / "docs" / "pregenerated_text_audio_slot_value_manifests"
DEFAULT_REPORT = REPO_ROOT / "docs" / "PREGENERATED_TEXT_AUDIO_ASSET_MANIFESTS.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio-plan", type=Path, default=DEFAULT_AUDIO_PLAN)
    parser.add_argument("--shell-manifest", type=Path, default=DEFAULT_SHELL_MANIFEST)
    parser.add_argument("--slot-value-inventory", type=Path, default=DEFAULT_SLOT_VALUE_INVENTORY)
    parser.add_argument("--slot-value-manifest", type=Path, default=DEFAULT_SLOT_VALUE_MANIFEST)
    parser.add_argument("--slot-value-manifest-dir", type=Path, default=DEFAULT_SLOT_VALUE_MANIFEST_DIR)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--min-estimated-saved", type=int, default=1)
    parser.add_argument("--top", type=int, default=20)
    return parser.parse_args()


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def is_spoken_shell(text: str) -> bool:
    normalized = normalize_text(text)
    return bool(normalized and re.search(r"[A-Za-z0-9]", normalized))


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")
    return slug or stable_id(str(text or ""))


def collect_slot_value_stats(plan: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    counts_by_kind: dict[str, Counter[str]] = defaultdict(Counter)
    family_counts_by_kind: dict[str, Counter[str]] = defaultdict(Counter)
    source_families_by_value: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    family_kinds_by_value: dict[str, dict[str, Counter[str]]] = defaultdict(lambda: defaultdict(Counter))
    raw_values_by_value: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))

    for family in plan.get("families") or []:
        estimated_saved = int(family.get("estimatedSavedChunkCalls") or 0)
        if estimated_saved < args.min_estimated_saved:
            continue
        family_kind = str(family.get("familyKind") or "") or "unknown"
        source_families = {str(item or "").strip() for item in family.get("sourceFamilies") or [] if str(item or "").strip()}
        for slot_kind, values in (family.get("topSlotValues") or {}).items():
            normalized_kind = str(slot_kind or "").strip()
            if not normalized_kind:
                continue
            family_counts_by_kind[normalized_kind][family_kind] += 1
            for value, count in values or []:
                raw_value = normalize_text(str(value or ""))
                if not raw_value:
                    continue
                normalized_value = normalize_slot_value_text(normalized_kind, raw_value)
                if not normalized_value:
                    continue
                counts_by_kind[normalized_kind][normalized_value] += int(count or 0)
                source_families_by_value[normalized_kind][normalized_value].update(source_families)
                family_kinds_by_value[normalized_kind][normalized_value][family_kind] += 1
                raw_values_by_value[normalized_kind][normalized_value].add(raw_value)

    return {
        "countsByKind": counts_by_kind,
        "familyCountsByKind": family_counts_by_kind,
        "sourceFamiliesByValue": source_families_by_value,
        "familyKindsByValue": family_kinds_by_value,
        "rawValuesByValue": raw_values_by_value,
    }


def build_shell_manifest(plan: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    shell_entries: dict[str, dict[str, Any]] = {}
    skipped_non_spoken = 0
    eligible_families = 0

    for family in plan.get("families") or []:
        estimated_saved = int(family.get("estimatedSavedChunkCalls") or 0)
        if estimated_saved < args.min_estimated_saved:
            continue
        eligible_families += 1
        canonical_template = str(family.get("canonicalTemplate") or "")
        family_hash = stable_id(canonical_template)
        source_families = sorted({str(item or "").strip() for item in family.get("sourceFamilies") or [] if str(item or "").strip()})
        slot_kinds = sorted({str(item or "").strip() for item in family.get("slotKindsInOrder") or [] if str(item or "").strip()})
        family_kind = str(family.get("familyKind") or "")
        for index, raw_segment in enumerate(family.get("staticSegments") or [], start=1):
            segment = normalize_text(str(raw_segment or ""))
            if not is_spoken_shell(segment):
                skipped_non_spoken += 1
                continue
            text_hash = stable_id(segment)
            entry = shell_entries.setdefault(
                segment,
                {
                    "id": f"abby-tts-shell-{text_hash}",
                    "textHash": text_hash,
                    "text": segment,
                    "originalTexts": [],
                    "routes": [],
                    "serviceTags": [],
                    "locationTags": [],
                    "sourceTypes": {"audio_plan.static_segment"},
                    "sourceIds": [],
                    "sourceFamilies": set(),
                    "familyKinds": set(),
                    "canonicalTemplates": set(),
                    "slotKinds": set(),
                    "sourceTemplateCount": 0,
                    "aggregatedEstimatedSavedChunkCalls": 0,
                    "aggregatedUniqueChunkCount": 0,
                    "examples": [],
                },
            )
            source_id = f"audio-shell::{family_hash}::{index}"
            if source_id not in entry["sourceIds"]:
                entry["sourceIds"].append(source_id)
            entry["sourceFamilies"].update(source_families)
            if family_kind:
                entry["familyKinds"].add(family_kind)
            entry["canonicalTemplates"].add(canonical_template)
            entry["slotKinds"].update(slot_kinds)
            entry["sourceTemplateCount"] = len(entry["canonicalTemplates"])
            entry["aggregatedEstimatedSavedChunkCalls"] += estimated_saved
            entry["aggregatedUniqueChunkCount"] += int(family.get("uniqueChunkCount") or 0)
            example = next(iter(family.get("examples") or []), "")
            if example and example not in entry["examples"] and len(entry["examples"]) < 6:
                entry["examples"].append(str(example))

    responses: list[dict[str, Any]] = []
    for entry in shell_entries.values():
        responses.append(
            {
                "id": entry["id"],
                "textHash": entry["textHash"],
                "text": entry["text"],
                "originalTexts": entry["originalTexts"],
                "routes": entry["routes"],
                "serviceTags": entry["serviceTags"],
                "locationTags": entry["locationTags"],
                "sourceTypes": sorted(entry["sourceTypes"]),
                "sourceIds": entry["sourceIds"],
                "sourceFamilies": sorted(entry["sourceFamilies"]),
                "familyKinds": sorted(entry["familyKinds"]),
                "canonicalTemplates": sorted(entry["canonicalTemplates"]),
                "slotKinds": sorted(entry["slotKinds"]),
                "sourceTemplateCount": entry["sourceTemplateCount"],
                "aggregatedEstimatedSavedChunkCalls": entry["aggregatedEstimatedSavedChunkCalls"],
                "aggregatedUniqueChunkCount": entry["aggregatedUniqueChunkCount"],
                "priorityScore": float(entry["aggregatedEstimatedSavedChunkCalls"]),
                "examples": entry["examples"],
            }
        )
    responses.sort(key=lambda item: (-int(item.get("aggregatedEstimatedSavedChunkCalls") or 0), item.get("text") or ""))
    for index, item in enumerate(responses, start=1):
        item["priorityRank"] = index
    summary = {
        "eligibleFamilyCount": eligible_families,
        "shellResponseCount": len(responses),
        "skippedNonSpokenSegments": skipped_non_spoken,
        "topShells": [
            {
                "text": item["text"],
                "aggregatedEstimatedSavedChunkCalls": item["aggregatedEstimatedSavedChunkCalls"],
                "sourceFamilies": item["sourceFamilies"],
                "slotKinds": item["slotKinds"],
            }
            for item in responses[: args.top]
        ],
    }
    return {
        "schemaVersion": 1,
        "purpose": "Reusable spoken shell segments derived from the pregenerated text audio slot plan.",
        "inputAudioPlan": str(args.audio_plan),
        "summary": summary,
        "responses": responses,
    }


def build_slot_value_inventory(slot_stats: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    counts_by_kind = slot_stats["countsByKind"]
    family_counts_by_kind = slot_stats["familyCountsByKind"]
    source_families_by_value = slot_stats["sourceFamiliesByValue"]
    raw_values_by_value = slot_stats["rawValuesByValue"]
    slot_kinds: dict[str, Any] = {}
    for kind, counter in sorted(counts_by_kind.items()):
        slot_kinds[kind] = {
            "uniqueValueCount": len(counter),
            "topValues": [
                {
                    "value": value,
                    "count": count,
                    "sourceFamilies": sorted(source_families_by_value[kind][value]),
                    "rawVariants": sorted(raw_values_by_value[kind][value]),
                }
                for value, count in counter.most_common(args.top)
            ],
            "familyKindCounts": dict(sorted(family_counts_by_kind[kind].items())),
        }

    return {
        "schemaVersion": 1,
        "purpose": "Aggregated high-frequency slot values from the pregenerated text audio slot plan.",
        "inputAudioPlan": str(args.audio_plan),
        "summary": {
            "slotKindCount": len(slot_kinds),
            "topSlotKinds": {
                kind: payload["uniqueValueCount"]
                for kind, payload in sorted(slot_kinds.items(), key=lambda item: (-int(item[1]["uniqueValueCount"]), item[0]))[: args.top]
            },
        },
        "slotKinds": slot_kinds,
    }


def build_slot_value_manifests(slot_stats: dict[str, Any], args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    counts_by_kind = slot_stats["countsByKind"]
    source_families_by_value = slot_stats["sourceFamiliesByValue"]
    family_kinds_by_value = slot_stats["familyKindsByValue"]
    raw_values_by_value = slot_stats["rawValuesByValue"]

    combined_entries: dict[str, dict[str, Any]] = {}
    manifests_by_kind: dict[str, dict[str, Any]] = {}

    for kind, counter in sorted(counts_by_kind.items()):
        responses: list[dict[str, Any]] = []
        for value, count in counter.most_common():
            text_hash = stable_id(value)
            source_families = sorted(source_families_by_value[kind][value])
            family_kind_counts = dict(sorted(family_kinds_by_value[kind][value].items()))
            raw_variants = sorted(raw_values_by_value[kind][value])
            responses.append(
                {
                    "id": f"abby-tts-slot-{slugify(kind)}-{text_hash}",
                    "textHash": text_hash,
                    "text": value,
                    "originalTexts": [item for item in raw_variants if item != value],
                    "routes": [],
                    "serviceTags": [],
                    "locationTags": [],
                    "sourceTypes": ["audio_plan.slot_value"],
                    "sourceIds": [f"audio-slot::{kind}::{text_hash}"],
                    "sourceFamilies": source_families,
                    "slotKinds": [kind],
                    "familyKindCounts": family_kind_counts,
                    "observedCount": count,
                    "priorityScore": float(count),
                }
            )
            combined_entry = combined_entries.setdefault(
                value,
                {
                    "id": f"abby-tts-slot-value-{text_hash}",
                    "textHash": text_hash,
                    "text": value,
                    "originalTexts": set(),
                    "routes": [],
                    "serviceTags": [],
                    "locationTags": [],
                    "sourceTypes": {"audio_plan.slot_value"},
                    "sourceIds": [],
                    "sourceFamilies": set(),
                    "slotKinds": set(),
                    "familyKindCounts": Counter(),
                    "slotKindCounts": {},
                    "aggregatedObservedCount": 0,
                },
            )
            combined_entry["sourceIds"].append(f"audio-slot::{kind}::{text_hash}")
            combined_entry["sourceFamilies"].update(source_families)
            combined_entry["slotKinds"].add(kind)
            combined_entry["originalTexts"].update(item for item in raw_variants if item != value)
            combined_entry["familyKindCounts"].update(family_kind_counts)
            combined_entry["slotKindCounts"][kind] = count
            combined_entry["aggregatedObservedCount"] += count

        for index, response in enumerate(responses, start=1):
            response["priorityRank"] = index

        manifests_by_kind[kind] = {
            "schemaVersion": 1,
            "purpose": f"High-frequency '{kind}' slot values derived from the pregenerated text audio slot plan.",
            "inputAudioPlan": str(args.audio_plan),
            "slotKind": kind,
            "summary": {
                "responseCount": len(responses),
                "topValues": [
                    {
                        "value": item["text"],
                        "observedCount": item["observedCount"],
                        "sourceFamilies": item["sourceFamilies"],
                        "rawVariants": item["originalTexts"],
                    }
                    for item in responses[: args.top]
                ],
            },
            "responses": responses,
        }

    combined_responses: list[dict[str, Any]] = []
    for entry in combined_entries.values():
        combined_responses.append(
            {
                "id": entry["id"],
                "textHash": entry["textHash"],
                "text": entry["text"],
                "originalTexts": sorted(entry["originalTexts"]),
                "routes": entry["routes"],
                "serviceTags": entry["serviceTags"],
                "locationTags": entry["locationTags"],
                "sourceTypes": sorted(entry["sourceTypes"]),
                "sourceIds": entry["sourceIds"],
                "sourceFamilies": sorted(entry["sourceFamilies"]),
                "slotKinds": sorted(entry["slotKinds"]),
                "familyKindCounts": dict(sorted(entry["familyKindCounts"].items())),
                "slotKindCounts": dict(sorted(entry["slotKindCounts"].items())),
                "aggregatedObservedCount": entry["aggregatedObservedCount"],
                "priorityScore": float(entry["aggregatedObservedCount"]),
            }
        )

    combined_responses.sort(key=lambda item: (-int(item.get("aggregatedObservedCount") or 0), item.get("text") or ""))
    for index, response in enumerate(combined_responses, start=1):
        response["priorityRank"] = index

    combined_manifest = {
        "schemaVersion": 1,
        "purpose": "High-frequency slot values derived from the pregenerated text audio slot plan.",
        "inputAudioPlan": str(args.audio_plan),
        "summary": {
            "slotKindCount": len(manifests_by_kind),
            "responseCount": len(combined_responses),
            "topValues": [
                {
                    "value": item["text"],
                    "aggregatedObservedCount": item["aggregatedObservedCount"],
                    "slotKinds": item["slotKinds"],
                    "sourceFamilies": item["sourceFamilies"],
                }
                for item in combined_responses[: args.top]
            ],
            "slotKindManifests": {
                kind: str((args.slot_value_manifest_dir / f"{slugify(kind)}.json").relative_to(REPO_ROOT))
                for kind in sorted(manifests_by_kind)
            },
        },
        "responses": combined_responses,
    }
    return combined_manifest, manifests_by_kind


def build_report(
    shell_manifest: dict[str, Any],
    slot_inventory: dict[str, Any],
    slot_value_manifest: dict[str, Any],
    slot_kind_manifests: dict[str, dict[str, Any]],
    args: argparse.Namespace,
) -> str:
    shell_summary = shell_manifest.get("summary") or {}
    slot_summary = slot_inventory.get("summary") or {}
    slot_manifest_summary = slot_value_manifest.get("summary") or {}
    lines = [
        "# Pregenerated Text Audio Asset Manifests",
        "",
        f"Audio plan input: {args.audio_plan.relative_to(REPO_ROOT)}",
        f"Shell manifest: {args.shell_manifest.relative_to(REPO_ROOT)}",
        f"Slot-value inventory: {args.slot_value_inventory.relative_to(REPO_ROOT)}",
        f"Slot-value manifest: {args.slot_value_manifest.relative_to(REPO_ROOT)}",
        f"Per-slot manifests: {args.slot_value_manifest_dir.relative_to(REPO_ROOT)}",
        "",
        "## Summary",
        "",
        f"- Eligible reusable families: {shell_summary.get('eligibleFamilyCount', 0)}",
        f"- Reusable spoken shell assets: {shell_summary.get('shellResponseCount', 0)}",
        f"- Skipped punctuation-only/non-spoken segments: {shell_summary.get('skippedNonSpokenSegments', 0)}",
        f"- Slot kinds with aggregated values: {slot_summary.get('slotKindCount', 0)}",
        f"- Combined slot-value assets: {slot_manifest_summary.get('responseCount', 0)}",
        "",
        "## Top Shell Assets",
        "",
    ]
    for item in shell_summary.get("topShells") or []:
        lines.append(
            f"- {item.get('text')}: estimated_saved={item.get('aggregatedEstimatedSavedChunkCalls')}, families={', '.join(item.get('sourceFamilies') or []) or 'unknown'}, slot_kinds={', '.join(item.get('slotKinds') or []) or 'none'}"
        )
    lines.extend(["", "## Top Slot Kinds", ""])
    for kind, count in (slot_summary.get("topSlotKinds") or {}).items():
        lines.append(f"- {kind}: {count} unique high-frequency values")
    lines.extend(["", "## Top Slot Values", ""])
    for item in slot_manifest_summary.get("topValues") or []:
        lines.append(
            f"- {item.get('value')}: observed_count={item.get('aggregatedObservedCount')}, slot_kinds={', '.join(item.get('slotKinds') or []) or 'none'}, families={', '.join(item.get('sourceFamilies') or []) or 'unknown'}"
        )
    lines.extend(["", "## Per-Slot Manifests", ""])
    for kind in sorted(slot_kind_manifests):
        manifest_path = args.slot_value_manifest_dir / f"{slugify(kind)}.json"
        summary = slot_kind_manifests[kind].get("summary") or {}
        lines.append(
            f"- {kind}: {summary.get('responseCount', 0)} values -> {manifest_path.relative_to(REPO_ROOT)}"
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    args = parse_args()
    plan = load_json(args.audio_plan)
    slot_stats = collect_slot_value_stats(plan, args)
    shell_manifest = build_shell_manifest(plan, args)
    slot_inventory = build_slot_value_inventory(slot_stats, args)
    slot_value_manifest, slot_kind_manifests = build_slot_value_manifests(slot_stats, args)

    args.shell_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.shell_manifest.write_text(json.dumps(shell_manifest, indent=2), encoding="utf-8")
    args.slot_value_inventory.parent.mkdir(parents=True, exist_ok=True)
    args.slot_value_inventory.write_text(json.dumps(slot_inventory, indent=2), encoding="utf-8")
    args.slot_value_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.slot_value_manifest.write_text(json.dumps(slot_value_manifest, indent=2), encoding="utf-8")
    args.slot_value_manifest_dir.mkdir(parents=True, exist_ok=True)
    for kind, manifest in slot_kind_manifests.items():
        manifest_path = args.slot_value_manifest_dir / f"{slugify(kind)}.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        build_report(shell_manifest, slot_inventory, slot_value_manifest, slot_kind_manifests, args),
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "shellManifest": str(args.shell_manifest),
                "slotValueInventory": str(args.slot_value_inventory),
                "slotValueManifest": str(args.slot_value_manifest),
                "slotValueManifestDir": str(args.slot_value_manifest_dir),
                "report": str(args.report),
                "summary": {
                    "shellResponseCount": shell_manifest.get("summary", {}).get("shellResponseCount", 0),
                    "slotKindCount": slot_inventory.get("summary", {}).get("slotKindCount", 0),
                    "slotValueResponseCount": slot_value_manifest.get("summary", {}).get("responseCount", 0),
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()