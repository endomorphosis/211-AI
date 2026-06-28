#!/usr/bin/env python3
"""Review NER-driven slotting opportunities across all pregenerated text responses."""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(REPO_ROOT))

from scripts.deduplicate_voice_response_chunks import build_analysis  # noqa: E402
from scripts.suggest_slot_friendly_voice_rewrites import (  # noqa: E402
    build_rewrite_opportunities_from_dedupe,
    canonical_rewrite_template,
)

SLOT_PATTERN = __import__("re").compile(r"\{(?P<kind>[a-z_]+)_\d+\}")


DEFAULT_MANIFEST = REPO_ROOT / "docs" / "pregenerated_text_response_manifest.json"
DEFAULT_DEDUPE_OUTPUT = REPO_ROOT / "docs" / "pregenerated_text_chunk_dedupe.json"
DEFAULT_OPPORTUNITIES_OUTPUT = REPO_ROOT / "docs" / "pregenerated_text_rewrite_opportunities.json"
DEFAULT_AUDIO_PLAN_OUTPUT = REPO_ROOT / "docs" / "pregenerated_text_audio_slot_plan.json"
DEFAULT_REPORT_OUTPUT = REPO_ROOT / "docs" / "PREGENERATED_TEXT_SLOTTING_REVIEW.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--dedupe-output", type=Path, default=DEFAULT_DEDUPE_OUTPUT)
    parser.add_argument("--opportunities-output", type=Path, default=DEFAULT_OPPORTUNITIES_OUTPUT)
    parser.add_argument("--audio-plan-output", type=Path, default=DEFAULT_AUDIO_PLAN_OUTPUT)
    parser.add_argument("--report-output", type=Path, default=DEFAULT_REPORT_OUTPUT)
    parser.add_argument("--max-chunk-chars", type=int, default=220)
    parser.add_argument("--top", type=int, default=60)
    parser.add_argument("--top-slot-values", type=int, default=8)
    parser.add_argument("--top-opportunities", type=int, default=80)
    parser.add_argument("--min-reuse", type=int, default=3)
    parser.add_argument("--min-unique-chunks", type=int, default=3)
    parser.add_argument("--examples-per-family", type=int, default=6)
    parser.add_argument("--max-source-templates", type=int, default=12)
    parser.add_argument("--top-entity-phrases", type=int, default=25)
    parser.add_argument("--top-report-opportunities", type=int, default=20)
    parser.add_argument("--top-slot-values-per-kind", type=int, default=20)
    return parser.parse_args()


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_manifest_response_map(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    response_map: dict[str, dict[str, Any]] = {}
    for item in manifest.get("responses") or []:
        response_id = str(item.get("id") or "").strip()
        if response_id:
            response_map[response_id] = item
    return response_map


def build_chunk_family_map(
    analysis: dict[str, Any],
    manifest_response_map: dict[str, dict[str, Any]],
) -> tuple[dict[str, list[str]], dict[str, list[str]], dict[str, list[str]]]:
    chunk_families: dict[str, list[str]] = {}
    template_families: dict[str, list[str]] = {}
    canonical_template_families: dict[str, set[str]] = {}
    for chunk in analysis.get("chunks") or []:
        families: set[str] = set()
        for response_id in chunk.get("sourceResponseIds") or []:
            response = manifest_response_map.get(str(response_id or ""), {})
            for family in response.get("sourceFamilies") or []:
                normalized = str(family or "").strip()
                if normalized:
                    families.add(normalized)
        chunk_families[str(chunk.get("id") or "")] = sorted(families)
    for template in analysis.get("maskedTemplates") or []:
        families: set[str] = set()
        for chunk_id in template.get("chunkIds") or []:
            families.update(chunk_families.get(str(chunk_id or ""), []))
        masked_text = str(template.get("maskedText") or "")
        template_families[masked_text] = sorted(families)
        canonical = canonical_rewrite_template(masked_text)
        canonical_template_families.setdefault(canonical, set()).update(families)
    return chunk_families, template_families, {key: sorted(value) for key, value in canonical_template_families.items()}


def slim_analysis_payload(analysis: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": analysis.get("schemaVersion"),
        "inputs": analysis.get("inputs"),
        "summary": analysis.get("summary"),
        "topRepeatedChunks": analysis.get("topRepeatedChunks"),
        "topMaskedTemplates": analysis.get("topMaskedTemplates"),
        "properNounPhraseCounts": analysis.get("properNounPhraseCounts"),
        "namedEntityPhraseCounts": analysis.get("namedEntityPhraseCounts"),
    }


def build_augmented_opportunities(
    opportunities: dict[str, Any],
    template_families: dict[str, list[str]],
    canonical_template_families: dict[str, list[str]],
) -> dict[str, Any]:
    augmented = {**opportunities}
    items: list[dict[str, Any]] = []
    family_counts: Counter[str] = Counter()
    for item in opportunities.get("opportunities") or []:
        families: set[str] = set(canonical_template_families.get(str(item.get("canonicalTemplate") or ""), []))
        if not families:
            for template in item.get("sourceMaskedTemplates") or []:
                families.update(template_families.get(str(template or ""), []))
        family_list = sorted(families)
        for family in family_list:
            family_counts[family] += 1
        items.append({**item, "sourceFamilies": family_list})
    augmented["summary"] = {
        **dict(opportunities.get("summary") or {}),
        "sourceFamilyOpportunityCounts": dict(sorted(family_counts.items())),
    }
    augmented["opportunities"] = items
    return augmented


def ordered_slot_kinds(template: str) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for match in SLOT_PATTERN.finditer(template):
        kind = str(match.group("kind") or "").strip()
        if kind and kind not in seen:
            seen.add(kind)
            ordered.append(kind)
    return ordered


def static_segments(template: str) -> list[str]:
    segments = [segment.strip() for segment in SLOT_PATTERN.sub("{SLOT}", template).split("{SLOT}")]
    return [segment for segment in segments if segment]


def slot_value_map_from_template(template: dict[str, Any]) -> dict[str, Counter[str]]:
    slot_values: dict[str, Counter[str]] = {}
    for kind, values in (template.get("topSlotValues") or {}).items():
        counter = slot_values.setdefault(str(kind or ""), Counter())
        for value, count in values or []:
            normalized_value = str(value or "").strip()
            if normalized_value:
                counter[normalized_value] += int(count or 0)
    return slot_values


def build_audio_asset_plan(
    analysis: dict[str, Any],
    opportunities: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    template_details = {
        str(item.get("maskedText") or ""): item
        for item in analysis.get("maskedTemplates") or []
        if str(item.get("maskedText") or "")
    }
    family_slot_values: dict[str, dict[str, Counter[str]]] = {}
    family_source_templates: dict[str, set[str]] = {}
    for masked_text, template in template_details.items():
        canonical = canonical_rewrite_template(masked_text)
        family_slot_values.setdefault(canonical, {})
        family_source_templates.setdefault(canonical, set()).add(masked_text)
        for kind, counter in slot_value_map_from_template(template).items():
            family_slot_values[canonical].setdefault(kind, Counter()).update(counter)

    plan_items: list[dict[str, Any]] = []
    for item in opportunities.get("opportunities") or []:
        canonical = str(item.get("canonicalTemplate") or "")
        kinds = ordered_slot_kinds(canonical)
        slot_values = {kind: family_slot_values.get(canonical, {}).get(kind, Counter()) for kind in kinds}
        segments = static_segments(canonical)
        plan_items.append(
            {
                "canonicalTemplate": canonical,
                "familyKind": item.get("familyKind"),
                "sourceFamilies": item.get("sourceFamilies") or [],
                "uniqueChunkCount": int(item.get("uniqueChunkCount") or 0),
                "estimatedSavedChunkCalls": int(item.get("estimatedSavedChunkCalls") or 0),
                "staticSegments": segments,
                "staticSegmentCount": len(segments),
                "slotKindsInOrder": kinds,
                "slotValueCounts": {kind: sum(counter.values()) for kind, counter in sorted(slot_values.items())},
                "uniqueSlotValueCounts": {kind: len(counter) for kind, counter in sorted(slot_values.items())},
                "topSlotValues": {
                    kind: counter.most_common(args.top_slot_values_per_kind)
                    for kind, counter in sorted(slot_values.items())
                },
                "sourceTemplateCount": len(family_source_templates.get(canonical, set())),
                "suggestedSynthesisStrategy": suggested_synthesis_strategy(str(item.get("familyKind") or ""), kinds),
                "examples": item.get("examples") or [],
            }
        )
    summary = {
        "familyCount": len(plan_items),
        "estimatedSavedChunkCallsAll": sum(item["estimatedSavedChunkCalls"] for item in plan_items),
        "familiesByKind": dict(Counter(str(item.get("familyKind") or "") for item in plan_items)),
        "totalStaticSegments": sum(item["staticSegmentCount"] for item in plan_items),
        "totalUniqueSlotKinds": sum(len(item["slotKindsInOrder"]) for item in plan_items),
    }
    return {
        "schemaVersion": 1,
        "inputManifest": str(args.manifest),
        "sourceDedupe": str(args.dedupe_output),
        "sourceOpportunities": str(args.opportunities_output),
        "summary": summary,
        "families": plan_items,
    }


def suggested_synthesis_strategy(family_kind: str, slot_kinds: list[str]) -> str:
    if family_kind == "phone_or_number":
        return "compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first"
    if family_kind == "named_entity":
        return "compose a reusable shell with provider or program entity audio"
    if family_kind == "location":
        return "compose a reusable shell with location slot audio"
    if family_kind in {"211_phrase", "emergency_phrase", "static_phrase"}:
        return "synthesize once as a static reusable chunk"
    if slot_kinds:
        return "compose reusable shell segments with slot audio"
    return "synthesize as a static reusable chunk"


def build_markdown_report(
    manifest: dict[str, Any],
    analysis: dict[str, Any],
    opportunities: dict[str, Any],
    audio_plan: dict[str, Any],
    args: argparse.Namespace,
) -> str:
    manifest_summary = manifest.get("summary") or {}
    analysis_summary = analysis.get("summary") or {}
    opportunity_summary = opportunities.get("summary") or {}
    audio_plan_summary = audio_plan.get("summary") or {}
    family_counts = Counter()
    for item in manifest.get("responses") or []:
        for family in item.get("sourceFamilies") or []:
            family_counts[str(family or "").strip()] += 1

    lines = [
        "# Pregenerated Text Slotting Review",
        "",
        f"Input manifest: {args.manifest.relative_to(REPO_ROOT)}",
        f"Dedupe summary JSON: {args.dedupe_output.relative_to(REPO_ROOT)}",
        f"Rewrite opportunities JSON: {args.opportunities_output.relative_to(REPO_ROOT)}",
        "",
        "## Coverage",
        "",
        f"- Unified pregenerated responses reviewed: {manifest_summary.get('totalUnifiedResponses', 0)}",
        f"- Unique sentence chunks after splitting: {analysis_summary.get('uniqueSentenceChunks', 0)}",
        f"- Reusable sentence chunks: {analysis_summary.get('reusableSentenceChunks', 0)}",
        f"- Unique masked templates: {analysis_summary.get('uniqueMaskedTemplates', 0)}",
        f"- Reusable masked templates: {analysis_summary.get('reusableMaskedTemplates', 0)}",
        f"- Estimated chunk reuse ratio: {analysis_summary.get('estimatedChunkReuseRatio', 0)}",
        f"- Estimated masked-template reuse ratio: {analysis_summary.get('estimatedMaskedTemplateReuseRatio', 0)}",
        "",
        "## Source Families",
        "",
    ]
    for family, count in sorted(family_counts.items()):
        lines.append(f"- {family}: {count}")

    lines.extend(
        [
            "",
            "## Top Named Entities",
            "",
        ]
    )
    for phrase, count in (analysis.get("namedEntityPhraseCounts") or [])[: args.top_entity_phrases]:
        lines.append(f"- {phrase}: {count}")

    lines.extend(
        [
            "",
            "## Opportunity Summary",
            "",
            f"- Rewrite opportunity families found: {opportunity_summary.get('opportunityCount', 0)}",
            f"- Estimated saved chunk calls across all opportunities: {opportunity_summary.get('estimatedSavedChunkCallsAll', 0)}",
            f"- Estimated saved chunk calls in reported top set: {opportunity_summary.get('estimatedSavedChunkCallsTop', 0)}",
            f"- Opportunity family kinds: {json.dumps(opportunity_summary.get('familyKindCounts') or {}, sort_keys=True)}",
            f"- Opportunity source-family counts: {json.dumps(opportunity_summary.get('sourceFamilyOpportunityCounts') or {}, sort_keys=True)}",
            f"- Audio plan static segments across all reusable families: {audio_plan_summary.get('totalStaticSegments', 0)}",
            f"- Audio plan slot-kind count across all reusable families: {audio_plan_summary.get('totalUniqueSlotKinds', 0)}",
            "",
            "## Highest-Value Candidates",
            "",
        ]
    )
    for item in (opportunities.get("opportunities") or [])[: args.top_report_opportunities]:
        lines.append(
            f"- {item.get('canonicalTemplate')}: kind={item.get('familyKind')}, unique_chunks={item.get('uniqueChunkCount')}, estimated_saved={item.get('estimatedSavedChunkCalls')}, families={', '.join(item.get('sourceFamilies') or []) or 'unknown'}"
        )
        examples = item.get("examples") or []
        if examples:
            lines.append(f"  Example: {examples[0]}")

    lines.extend(
        [
            "",
            "## Audio Composition Plan",
            "",
        ]
    )
    for item in (audio_plan.get("families") or [])[: min(12, args.top_report_opportunities)]:
        lines.append(
            f"- {item.get('canonicalTemplate')}: strategy={item.get('suggestedSynthesisStrategy')}, static_segments={item.get('staticSegmentCount')}, slot_kinds={', '.join(item.get('slotKindsInOrder') or []) or 'none'}"
        )
        top_slot_values = item.get("topSlotValues") or {}
        if top_slot_values:
            first_kind = next(iter(top_slot_values))
            first_values = ", ".join(value for value, _count in (top_slot_values.get(first_kind) or [])[:3])
            if first_values:
                lines.append(f"  Top {first_kind} values: {first_values}")

    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "- Phone and numeric prompts are still the largest slotting surface, so number-specific chunk composition remains the biggest direct GPU savings lever.",
            "- Named provider and program entities remain frequent enough to justify more reusable entity-slot frames beyond the current slotted DAG coverage.",
            "- Location-bearing prompts are common enough to benefit from more canonical location-slot frames, especially where the surrounding sentence shell is stable.",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> None:
    args = parse_args()
    manifest = load_manifest(args.manifest)
    manifest_response_map = build_manifest_response_map(manifest)

    analysis_args = SimpleNamespace(
        dag=None,
        results=None,
        response_manifest=args.manifest,
        output=args.dedupe_output,
        max_chunk_chars=args.max_chunk_chars,
        top=args.top,
        top_slot_values=args.top_slot_values,
        assistant_responses_only=False,
        voice_responses_only=False,
        include_details=True,
    )
    analysis = build_analysis(analysis_args)
    _chunk_families, template_families, canonical_template_families = build_chunk_family_map(analysis, manifest_response_map)

    rewrite_args = SimpleNamespace(
        dedupe=args.dedupe_output,
        output=args.opportunities_output,
        top=args.top_opportunities,
        min_reuse=args.min_reuse,
        min_unique_chunks=args.min_unique_chunks,
        examples_per_family=args.examples_per_family,
        max_source_templates=args.max_source_templates,
    )
    opportunities = build_rewrite_opportunities_from_dedupe(analysis, rewrite_args)
    augmented_opportunities = build_augmented_opportunities(opportunities, template_families, canonical_template_families)
    audio_plan = build_audio_asset_plan(analysis, augmented_opportunities, args)

    args.dedupe_output.parent.mkdir(parents=True, exist_ok=True)
    args.dedupe_output.write_text(json.dumps(slim_analysis_payload(analysis), indent=2), encoding="utf-8")
    args.opportunities_output.parent.mkdir(parents=True, exist_ok=True)
    args.opportunities_output.write_text(json.dumps(augmented_opportunities, indent=2), encoding="utf-8")
    args.audio_plan_output.parent.mkdir(parents=True, exist_ok=True)
    args.audio_plan_output.write_text(json.dumps(audio_plan, indent=2), encoding="utf-8")
    args.report_output.parent.mkdir(parents=True, exist_ok=True)
    args.report_output.write_text(
        build_markdown_report(manifest, analysis, augmented_opportunities, audio_plan, args),
        encoding="utf-8",
    )

    print(json.dumps({
        "dedupeOutput": str(args.dedupe_output),
        "opportunitiesOutput": str(args.opportunities_output),
        "audioPlanOutput": str(args.audio_plan_output),
        "reportOutput": str(args.report_output),
        "summary": {
            "manifestResponses": manifest.get("summary", {}).get("totalUnifiedResponses", 0),
            "uniqueSentenceChunks": analysis.get("summary", {}).get("uniqueSentenceChunks", 0),
            "reusableMaskedTemplates": analysis.get("summary", {}).get("reusableMaskedTemplates", 0),
            "opportunityCount": augmented_opportunities.get("summary", {}).get("opportunityCount", 0),
            "estimatedSavedChunkCallsAll": augmented_opportunities.get("summary", {}).get("estimatedSavedChunkCallsAll", 0),
            "audioPlanFamilyCount": audio_plan.get("summary", {}).get("familyCount", 0),
        },
    }, indent=2))


if __name__ == "__main__":
    main()