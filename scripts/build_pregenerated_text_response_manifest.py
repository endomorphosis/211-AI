#!/usr/bin/env python3
"""Build a unified inventory of pregenerated Abby text responses.

The output manifest becomes the reviewable source of truth for future audio
passes. It merges canonical response families from source DAG/results pairs and
retains historical manifest provenance so older runs remain visible.
"""
from __future__ import annotations

import argparse
import glob
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(REPO_ROOT))

from scripts.precompute_indextts_responses import (  # noqa: E402
    DEFAULT_SLOTTED_RESPONSE_INDEX,
    SLOTTED_RESPONSE_FIELDS,
    display_path,
    load_audio_responses,
    normalize_indextts_spoken_text,
    stable_id,
)


DEFAULT_OUTPUT = REPO_ROOT / "docs/pregenerated_text_response_manifest.json"
DEFAULT_REPORT = REPO_ROOT / "docs/PREGENERATED_TEXT_RESPONSE_INVENTORY.md"
SERVED_PUBLIC_ROOT = REPO_ROOT / "wallet_interface" / "ui" / "public"


CANONICAL_SOURCE_FAMILIES = (
    {
        "id": "211",
        "label": "211 chat simulation",
        "dag": REPO_ROOT / "docs/211_conversation_dag.json",
        "results": REPO_ROOT / "docs/211_chatbot_simulation_results.json",
        "legacyManifests": (
            REPO_ROOT / "docs/211_indextts_precompute_manifest.json",
            REPO_ROOT / "wallet_interface/ui/public/assets/audio/precomputed/211-dag-indextts/manifest.json",
        ),
        "legacyManifestGlobs": (
            str(REPO_ROOT / "docs/211_indextts_precompute_batches/*.json"),
        ),
    },
    {
        "id": "phone_dialog",
        "label": "Phone dialog generation",
        "dag": REPO_ROOT / "docs/phone_dialog_generation/phone_dialog_dag.json",
        "results": REPO_ROOT / "docs/phone_dialog_generation/phone_dialog_results.json",
        "legacyManifests": (
            REPO_ROOT / "docs/phone_dialog_generation/phone_dialog_indextts_manifest.json",
            REPO_ROOT / "docs/phone_dialog_generation/phone_dialog_indextts_public_manifest.json",
        ),
        "legacyManifestGlobs": (),
    },
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--slotted-response-index", type=Path, default=DEFAULT_SLOTTED_RESPONSE_INDEX)
    return parser.parse_args()


def load_manifest_responses(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return [item for item in (payload.get("responses") or []) if isinstance(item, dict)]


def is_served_public_path(path: Path) -> bool:
    try:
        path.relative_to(SERVED_PUBLIC_ROOT)
        return True
    except ValueError:
        return False


def ensure_entry(by_text: dict[str, dict[str, Any]], text: str) -> dict[str, Any] | None:
    raw_text = " ".join(str(text or "").split())
    if not raw_text:
        return None
    normalized = normalize_indextts_spoken_text(raw_text)
    if not normalized:
        return None
    text_hash = stable_id(normalized)
    entry = by_text.setdefault(
        normalized,
        {
            "id": f"abby-tts-{text_hash}",
            "textHash": text_hash,
            "text": normalized,
            "originalTexts": set(),
            "routes": set(),
            "serviceTags": set(),
            "locationTags": set(),
            "sourceTypes": set(),
            "sourceIds": set(),
            "sourceFamilies": set(),
            "canonicalSourceFamilies": set(),
            "legacyManifestPaths": set(),
            "servedManifestPaths": set(),
            "preferredAudioPaths": set(),
            "preferredAudioUrls": set(),
            "historicalStatuses": Counter(),
            "manifestProvenance": set(),
            **{field: set() for field in SLOTTED_RESPONSE_FIELDS},
        },
    )
    if raw_text != normalized:
        entry["originalTexts"].add(raw_text)
    return entry


def merge_common_fields(entry: dict[str, Any], item: dict[str, Any]) -> None:
    for original_text in item.get("originalTexts") or []:
        collapsed = " ".join(str(original_text or "").split())
        if collapsed and collapsed != entry["text"]:
            entry["originalTexts"].add(collapsed)
    for route in item.get("routes") or []:
        normalized_route = str(route or "").strip()
        if normalized_route:
            entry["routes"].add(normalized_route)
    for service_tag in item.get("serviceTags") or []:
        normalized_service_tag = str(service_tag or "").strip()
        if normalized_service_tag:
            entry["serviceTags"].add(normalized_service_tag)
    for location_tag in item.get("locationTags") or []:
        normalized_location_tag = str(location_tag or "").strip()
        if normalized_location_tag:
            entry["locationTags"].add(normalized_location_tag)
    for source_type in item.get("sourceTypes") or []:
        normalized_source_type = str(source_type or "").strip()
        if normalized_source_type:
            entry["sourceTypes"].add(normalized_source_type)
    for source_id in item.get("sourceIds") or []:
        normalized_source_id = str(source_id or "").strip()
        if normalized_source_id:
            entry["sourceIds"].add(normalized_source_id)
    for field in SLOTTED_RESPONSE_FIELDS:
        for value in item.get(field) or []:
            normalized_value = str(value or "").strip()
            if normalized_value:
                entry[field].add(normalized_value)


def merge_canonical_responses(by_text: dict[str, dict[str, Any]], family_id: str, responses: list[dict[str, Any]]) -> None:
    for item in responses:
        entry = ensure_entry(by_text, str(item.get("text") or ""))
        if entry is None:
            continue
        merge_common_fields(entry, item)
        entry["sourceFamilies"].add(family_id)
        entry["canonicalSourceFamilies"].add(family_id)


def merge_legacy_manifest(
    by_text: dict[str, dict[str, Any]],
    family_id: str,
    manifest_path: Path,
    responses: list[dict[str, Any]],
) -> None:
    manifest_ref = display_path(manifest_path)
    served_public = is_served_public_path(manifest_path)
    for item in responses:
        entry = ensure_entry(by_text, str(item.get("text") or ""))
        if entry is None:
            continue
        merge_common_fields(entry, item)
        entry["sourceFamilies"].add(family_id)
        entry["legacyManifestPaths"].add(manifest_ref)
        entry["manifestProvenance"].add(f"{family_id}:{manifest_ref}")
        if served_public:
            entry["servedManifestPaths"].add(manifest_ref)
        status = str(item.get("status") or "").strip()
        if status:
            entry["historicalStatuses"][status] += 1
        for key in ("preferredAudioPath", "mp3Path", "audioPath"):
            value = str(item.get(key) or "").strip()
            if value:
                entry["preferredAudioPaths"].add(value)
        for key in ("preferredAudioUrl", "mp3Url", "audioUrl"):
            value = str(item.get(key) or "").strip()
            if value:
                entry["preferredAudioUrls"].add(value)


def summarize_manifest(path: Path, family_id: str, role: str, responses: list[dict[str, Any]]) -> dict[str, Any]:
    status_counts = Counter(str(item.get("status") or "unknown") for item in responses)
    return {
        "familyId": family_id,
        "role": role,
        "path": display_path(path),
        "servedPublic": is_served_public_path(path),
        "responseCount": len(responses),
        "uniqueTexts": len({str(item.get("text") or "") for item in responses if str(item.get("text") or "")} ),
        "statusCounts": dict(sorted(status_counts.items())),
    }


def finalize_entries(by_text: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    responses: list[dict[str, Any]] = []
    for item in by_text.values():
        response = {
            "id": item["id"],
            "textHash": item["textHash"],
            "text": item["text"],
            "originalTexts": sorted(item["originalTexts"]),
            "routes": sorted(item["routes"]),
            "serviceTags": sorted(item["serviceTags"]),
            "locationTags": sorted(item["locationTags"]),
            "sourceTypes": sorted(item["sourceTypes"]),
            "sourceIds": sorted(item["sourceIds"]),
            "sourceFamilies": sorted(item["sourceFamilies"]),
            "canonicalSourceFamilies": sorted(item["canonicalSourceFamilies"]),
            "legacyManifestPaths": sorted(item["legacyManifestPaths"]),
            "servedManifestPaths": sorted(item["servedManifestPaths"]),
            "manifestProvenance": sorted(item["manifestProvenance"]),
            "preferredAudioPaths": sorted(item["preferredAudioPaths"]),
            "preferredAudioUrls": sorted(item["preferredAudioUrls"]),
            "historicalStatusCounts": dict(sorted(item["historicalStatuses"].items())),
            "legacyOnly": not bool(item["canonicalSourceFamilies"]),
            "hasServedManifest": bool(item["servedManifestPaths"]),
            "hasHistoricalAudioArtifact": bool(item["preferredAudioPaths"] or item["preferredAudioUrls"]),
        }
        for field in SLOTTED_RESPONSE_FIELDS:
            values = sorted(item[field])
            if values:
                response[field] = values
        responses.append(response)
    responses.sort(key=lambda item: item["id"])
    return responses


def build_markdown_report(
    *,
    output_manifest: Path,
    responses: list[dict[str, Any]],
    canonical_source_summaries: list[dict[str, Any]],
    legacy_manifest_summaries: list[dict[str, Any]],
    public_audio_mp3_count: int,
) -> str:
    total_responses = len(responses)
    legacy_only_count = sum(1 for item in responses if item["legacyOnly"])
    served_manifest_count = sum(1 for item in responses if item["hasServedManifest"])
    historical_audio_count = sum(1 for item in responses if item["hasHistoricalAudioArtifact"])
    lines = [
        "# Pregenerated Text Response Inventory",
        "",
        f"Generated at: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        f"Unified manifest: {display_path(output_manifest)}",
        "",
        "## Findings",
        "",
        f"- Unified pregenerated text responses: {total_responses}",
        f"- Legacy-only responses retained from historical manifests: {legacy_only_count}",
        f"- Responses referenced by a served public manifest: {served_manifest_count}",
        f"- Responses with historical audio artifacts or URLs recorded: {historical_audio_count}",
        f"- Public 211 audio directory MP3 files present: {public_audio_mp3_count}",
        "",
        "## Canonical Source Families",
        "",
        "| Family | Canonical responses | DAG | Results |",
        "| --- | ---: | --- | --- |",
    ]
    for summary in canonical_source_summaries:
        lines.append(
            f"| {summary['label']} | {summary['responseCount']} | {summary['dag']} | {summary['results']} |"
        )
    lines.extend(
        [
            "",
            "## Legacy Manifest Coverage",
            "",
            "| Family | Role | Responses | Unique text | Served public | Status counts | Path |",
            "| --- | --- | ---: | ---: | --- | --- | --- |",
        ]
    )
    for summary in legacy_manifest_summaries:
        status_summary = ", ".join(f"{key}:{value}" for key, value in summary["statusCounts"].items()) or "-"
        lines.append(
            f"| {summary['familyId']} | {summary['role']} | {summary['responseCount']} | {summary['uniqueTexts']} | {'yes' if summary['servedPublic'] else 'no'} | {status_summary} | {summary['path']} |"
        )
    lines.extend(
        [
            "",
            "## Next Command",
            "",
            "Use the unified manifest directly for future dry runs or batch generation:",
            "",
            f"`python3 scripts/precompute_indextts_responses.py --response-manifest {display_path(output_manifest)} --dry-run --limit 10`",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> None:
    args = parse_args()
    by_text: dict[str, dict[str, Any]] = {}
    canonical_source_summaries: list[dict[str, Any]] = []
    legacy_manifest_summaries: list[dict[str, Any]] = []

    for family in CANONICAL_SOURCE_FAMILIES:
        responses = load_audio_responses(
            family["dag"],
            family["results"],
            slotted_response_index=args.slotted_response_index,
        )
        merge_canonical_responses(by_text, str(family["id"]), responses)
        canonical_source_summaries.append(
            {
                "id": str(family["id"]),
                "label": str(family["label"]),
                "dag": display_path(Path(family["dag"])),
                "results": display_path(Path(family["results"])),
                "responseCount": len(responses),
            }
        )

        for manifest_path in family["legacyManifests"]:
            path = Path(manifest_path)
            if not path.exists():
                continue
            responses = load_manifest_responses(path)
            merge_legacy_manifest(by_text, str(family["id"]), path, responses)
            role = "served_public_manifest" if is_served_public_path(path) else "legacy_manifest"
            legacy_manifest_summaries.append(summarize_manifest(path, str(family["id"]), role, responses))

        for pattern in family["legacyManifestGlobs"]:
            for path_text in sorted(glob.glob(pattern)):
                path = Path(path_text)
                responses = load_manifest_responses(path)
                merge_legacy_manifest(by_text, str(family["id"]), path, responses)
                legacy_manifest_summaries.append(summarize_manifest(path, str(family["id"]), "historical_batch_manifest", responses))

    responses = finalize_entries(by_text)
    public_audio_dir = REPO_ROOT / "wallet_interface/ui/public/assets/audio/precomputed/211-dag-indextts"
    public_audio_mp3_count = len(list(public_audio_dir.glob("*.mp3"))) if public_audio_dir.exists() else 0
    payload = {
        "schemaVersion": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "purpose": "Unified inventory of pregenerated Abby text responses for review and future audio passes.",
        "slottedResponseIndex": display_path(args.slotted_response_index),
        "summary": {
            "totalUnifiedResponses": len(responses),
            "legacyOnlyResponses": sum(1 for item in responses if item["legacyOnly"]),
            "responsesWithServedManifest": sum(1 for item in responses if item["hasServedManifest"]),
            "responsesWithHistoricalAudioArtifact": sum(1 for item in responses if item["hasHistoricalAudioArtifact"]),
            "public211AudioMp3Files": public_audio_mp3_count,
        },
        "canonicalSourceFamilies": canonical_source_summaries,
        "legacyManifests": legacy_manifest_summaries,
        "responses": responses,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        build_markdown_report(
            output_manifest=args.output,
            responses=responses,
            canonical_source_summaries=canonical_source_summaries,
            legacy_manifest_summaries=legacy_manifest_summaries,
            public_audio_mp3_count=public_audio_mp3_count,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {args.output}")
    print(f"Wrote {args.report}")
    print(f"Unified responses: {len(responses)}")


if __name__ == "__main__":
    main()