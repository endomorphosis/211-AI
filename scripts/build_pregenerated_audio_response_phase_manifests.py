#!/usr/bin/env python3
"""Build post-slot duplicate and residual Abby TTS response manifests."""
from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(REPO_ROOT))

from scripts.precompute_indextts_responses import (  # noqa: E402
    display_path,
    load_audio_responses_from_manifest,
    normalize_indextts_spoken_text,
)


DEFAULT_INPUT_MANIFEST = REPO_ROOT / "docs" / "pregenerated_text_response_manifest.json"
DEFAULT_AUDIO_PLAN = REPO_ROOT / "docs" / "pregenerated_text_audio_slot_plan.json"
DEFAULT_SOURCE_OPPORTUNITIES = REPO_ROOT / "docs" / "pregenerated_text_rewrite_opportunities.json"
DEFAULT_SLOT_VALUE_MANIFEST_DIR = REPO_ROOT / "docs" / "pregenerated_text_audio_slot_value_manifests"
DEFAULT_DUPLICATE_MANIFEST = REPO_ROOT / "docs" / "pregenerated_text_audio_duplicate_response_manifest.json"
DEFAULT_RESIDUAL_MANIFEST = REPO_ROOT / "docs" / "pregenerated_text_audio_residual_response_manifest.json"
DEFAULT_REPORT = REPO_ROOT / "docs" / "PREGENERATED_TEXT_AUDIO_RESPONSE_PHASES.md"

PLACEHOLDER_RE = re.compile(r"\{(?P<kind>[a-z_]+)_(?P<index>\d+)\}")


@dataclass(frozen=True)
class FamilyMatcher:
    canonical_template: str
    family_kind: str
    estimated_saved_chunk_calls: int
    source_families: tuple[str, ...]
    pattern: re.Pattern[str]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-manifest", type=Path, default=DEFAULT_INPUT_MANIFEST)
    parser.add_argument("--audio-plan", type=Path, default=DEFAULT_AUDIO_PLAN)
    parser.add_argument("--source-opportunities", type=Path, default=DEFAULT_SOURCE_OPPORTUNITIES)
    parser.add_argument("--slot-value-manifest-dir", type=Path, default=DEFAULT_SLOT_VALUE_MANIFEST_DIR)
    parser.add_argument("--duplicate-manifest", type=Path, default=DEFAULT_DUPLICATE_MANIFEST)
    parser.add_argument("--residual-manifest", type=Path, default=DEFAULT_RESIDUAL_MANIFEST)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--min-duplicate-source-refs", type=int, default=2)
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def collapse_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def response_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, Mapping):
        rows = payload.get("responses") or []
    elif isinstance(payload, list):
        rows = payload
    else:
        rows = []
    return [dict(item) for item in rows if isinstance(item, Mapping)]


def unique_strings(values: Iterable[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        collapsed = collapse_text(value)
        if not collapsed or collapsed in seen:
            continue
        seen.add(collapsed)
        result.append(collapsed)
    return result


def flex_literal_pattern(text: str) -> str:
    if not text:
        return ""
    return re.sub(r"(?:\\ )+", r"\\s+", re.escape(text))


def flex_value_pattern(text: str) -> str:
    collapsed = collapse_text(text)
    if not collapsed:
        return ""
    return flex_literal_pattern(collapsed)


def load_slot_value_sets(manifest_dir: Path) -> dict[str, set[str]]:
    by_kind: dict[str, set[str]] = {}
    for path in sorted(manifest_dir.glob("*.json")):
        if not path.is_file():
            continue
        payload = load_json(path)
        raw_kind = collapse_text(payload.get("slotKind")) or path.stem.replace("-", "_")
        normalized_kind = raw_kind.replace("-", "_").lower()
        responses = load_audio_responses_from_manifest(path)
        values = {collapse_text(item.get("text")) for item in responses if collapse_text(item.get("text"))}
        if values:
            by_kind[normalized_kind] = values
    return by_kind


def compile_slot_value_pattern(values: Sequence[str]) -> str:
    ordered = sorted({collapse_text(value) for value in values if collapse_text(value)}, key=lambda value: (-len(value), value))
    return "(?:" + "|".join(flex_value_pattern(value) for value in ordered) + ")"


def clean_template_markup(template: str) -> str:
    return collapse_text(str(template or "").replace("`", "").replace("*", ""))


def matcher_specs(
    audio_plan: Mapping[str, Any],
    source_opportunities: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    if source_opportunities:
        opportunities = [item for item in (source_opportunities.get("opportunities") or []) if isinstance(item, Mapping)]
        opportunities.sort(
            key=lambda item: (
                -int(item.get("estimatedSavedChunkCalls") or 0),
                -int(item.get("uniqueChunkCount") or 0),
                collapse_text(item.get("canonicalTemplate")),
            )
        )
        specs: list[dict[str, Any]] = []
        for item in opportunities:
            canonical_template = clean_template_markup(item.get("canonicalTemplate"))
            raw_templates = list(item.get("sourceMaskedTemplates") or [])
            if canonical_template:
                raw_templates.append(canonical_template)
            template_variants = unique_strings(clean_template_markup(template) for template in raw_templates)
            for template_variant in template_variants:
                specs.append(
                    {
                        "canonicalTemplate": canonical_template or template_variant,
                        "templateVariant": template_variant,
                        "familyKind": collapse_text(item.get("familyKind")) or "unknown",
                        "estimatedSavedChunkCalls": int(item.get("estimatedSavedChunkCalls") or 0),
                        "uniqueChunkCount": int(item.get("uniqueChunkCount") or 0),
                        "sourceFamilies": unique_strings(item.get("sourceFamilies") or []),
                    }
                )
        if specs:
            return specs

    families = [item for item in (audio_plan.get("families") or []) if isinstance(item, Mapping)]
    families.sort(
        key=lambda item: (
            -int(item.get("estimatedSavedChunkCalls") or 0),
            -int(item.get("uniqueChunkCount") or 0),
            collapse_text(item.get("canonicalTemplate")),
        )
    )
    return [
        {
            "canonicalTemplate": clean_template_markup(item.get("canonicalTemplate")),
            "templateVariant": clean_template_markup(item.get("canonicalTemplate")),
            "familyKind": collapse_text(item.get("familyKind")) or "unknown",
            "estimatedSavedChunkCalls": int(item.get("estimatedSavedChunkCalls") or 0),
            "uniqueChunkCount": int(item.get("uniqueChunkCount") or 0),
            "sourceFamilies": unique_strings(item.get("sourceFamilies") or []),
        }
        for item in families
        if clean_template_markup(item.get("canonicalTemplate"))
    ]


def build_family_matchers(
    audio_plan: Mapping[str, Any],
    source_opportunities: Mapping[str, Any] | None,
    slot_value_sets: Mapping[str, set[str]],
) -> list[FamilyMatcher]:
    slot_patterns = {kind: compile_slot_value_pattern(sorted(values)) for kind, values in slot_value_sets.items() if values}
    matchers: list[FamilyMatcher] = []
    for spec in matcher_specs(audio_plan, source_opportunities):
        template = collapse_text(spec.get("templateVariant"))
        if not template:
            continue
        parts: list[str] = []
        position = 0
        missing_slot_pattern = False
        for match in PLACEHOLDER_RE.finditer(template):
            literal = template[position : match.start()]
            if literal:
                parts.append(flex_literal_pattern(literal))
            slot_kind = match.group("kind").replace("-", "_").lower()
            slot_pattern = slot_patterns.get(slot_kind)
            if not slot_pattern:
                missing_slot_pattern = True
                break
            parts.append(slot_pattern)
            position = match.end()
        if missing_slot_pattern:
            continue
        trailing = template[position:]
        if trailing:
            parts.append(flex_literal_pattern(trailing))
        pattern = re.compile(rf"^{''.join(parts)}$")
        matchers.append(
            FamilyMatcher(
                canonical_template=collapse_text(spec.get("canonicalTemplate")) or template,
                family_kind=collapse_text(spec.get("familyKind")) or "unknown",
                estimated_saved_chunk_calls=int(spec.get("estimatedSavedChunkCalls") or 0),
                source_families=tuple(unique_strings(spec.get("sourceFamilies") or [])),
                pattern=pattern,
            )
        )
    return matchers


def source_ref_count(record: Mapping[str, Any]) -> int:
    return len(unique_strings(record.get("sourceIds") or []))


def match_phase2_family(text: str, matchers: Sequence[FamilyMatcher]) -> FamilyMatcher | None:
    normalized_text = collapse_text(text)
    if not normalized_text:
        return None
    for matcher in matchers:
        if matcher.pattern.fullmatch(normalized_text):
            return matcher
    return None


def sort_phase_rows(rows: list[dict[str, Any]]) -> None:
    rows.sort(
        key=lambda item: (
            -int(item.get("canonicalSourceRefCount") or 0),
            -float(item.get("priorityScore") or 0.0),
            int(item.get("priorityRank") or 10**9),
            collapse_text(item.get("id")),
        )
    )


def build_phase_manifest(
    *,
    purpose: str,
    phase: str,
    input_manifest: Path,
    audio_plan: Path,
    source_opportunities: Path | None,
    slot_value_manifest_dir: Path,
    min_duplicate_source_refs: int,
    input_response_count: int,
    phase2_composable_count: int,
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "purpose": purpose,
        "inputs": {
            "inputManifest": display_path(input_manifest),
            "audioPlan": display_path(audio_plan),
            "sourceOpportunities": display_path(source_opportunities) if source_opportunities else "",
            "slotValueManifestDir": display_path(slot_value_manifest_dir),
            "minDuplicateSourceRefs": min_duplicate_source_refs,
        },
        "summary": {
            "phase": phase,
            "inputResponseCount": input_response_count,
            "phase2ComposableExcludedCount": phase2_composable_count,
            "responseCount": len(rows),
        },
        "responses": rows,
    }


def build_markdown_report(
    *,
    input_manifest: Path,
    audio_plan: Path,
    source_opportunities: Path | None,
    slot_value_manifest_dir: Path,
    total_input_count: int,
    phase2_composable_count: int,
    duplicate_rows: list[dict[str, Any]],
    residual_rows: list[dict[str, Any]],
    family_counter: Counter[str],
    family_meta: Mapping[str, tuple[str, int]],
    min_duplicate_source_refs: int,
) -> str:
    lines = [
        "# Pregenerated Text Audio Response Phases",
        "",
        f"Generated at: {utc_now()}",
        f"Input manifest: {display_path(input_manifest)}",
        f"Audio plan: {display_path(audio_plan)}",
        f"Source opportunities: {display_path(source_opportunities) if source_opportunities else '(fallback to audio plan only)'}",
        f"Slot value manifests: {display_path(slot_value_manifest_dir)}",
        "",
        "## Summary",
        "",
        f"- Input responses reviewed: {total_input_count}",
        f"- Phase-2 composable responses excluded: {phase2_composable_count}",
        f"- Duplicate full responses retained: {len(duplicate_rows)}",
        f"- Residual full responses retained: {len(residual_rows)}",
        f"- Duplicate threshold: {min_duplicate_source_refs} canonical source refs",
        "",
        "## Top Phase-2 Coverage Families",
        "",
    ]
    if family_counter:
        for canonical_template, count in family_counter.most_common(20):
            family_kind, estimated_saved = family_meta.get(canonical_template, ("unknown", 0))
            lines.append(
                f"- {canonical_template}: matched_responses={count}, family_kind={family_kind}, estimated_saved_chunk_calls={estimated_saved}"
            )
    else:
        lines.append("- None")
    lines.extend(
        [
            "",
            "## Top Duplicate Responses",
            "",
        ]
    )
    if duplicate_rows:
        for row in duplicate_rows[:20]:
            lines.append(
                f"- {row.get('text')}: canonical_source_refs={row.get('canonicalSourceRefCount', 0)}, priority_score={row.get('priorityScore', 0.0)}"
            )
    else:
        lines.append("- None")
    lines.extend(
        [
            "",
            "## Top Residual Responses",
            "",
        ]
    )
    if residual_rows:
        for row in residual_rows[:20]:
            lines.append(
                f"- {row.get('text')}: canonical_source_refs={row.get('canonicalSourceRefCount', 0)}, priority_score={row.get('priorityScore', 0.0)}"
            )
    else:
        lines.append("- None")
    return "\n".join(lines) + "\n"


def build_outputs(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], str]:
    input_payload = load_json(args.input_manifest)
    input_rows = response_records(input_payload)
    audio_plan = load_json(args.audio_plan)
    source_opportunities_path = getattr(args, "source_opportunities", DEFAULT_SOURCE_OPPORTUNITIES)
    source_opportunities = None
    if source_opportunities_path is not None:
        source_opportunities_path = Path(source_opportunities_path)
        if source_opportunities_path.exists():
            source_opportunities = load_json(source_opportunities_path)
    slot_value_sets = load_slot_value_sets(args.slot_value_manifest_dir)
    family_matchers = build_family_matchers(audio_plan, source_opportunities, slot_value_sets)

    duplicate_rows: list[dict[str, Any]] = []
    residual_rows: list[dict[str, Any]] = []
    phase2_family_counter: Counter[str] = Counter()
    family_meta: dict[str, tuple[str, int]] = {
        matcher.canonical_template: (matcher.family_kind, matcher.estimated_saved_chunk_calls) for matcher in family_matchers
    }
    phase2_composable_count = 0

    for record in input_rows:
        text = collapse_text(record.get("text"))
        if not text:
            continue
        normalized_text = normalize_indextts_spoken_text(text)
        matched_family = match_phase2_family(normalized_text, family_matchers)
        if matched_family is not None:
            phase2_composable_count += 1
            phase2_family_counter[matched_family.canonical_template] += 1
            continue

        row = dict(record)
        row["text"] = normalized_text
        row["canonicalSourceRefCount"] = source_ref_count(record)
        if row["canonicalSourceRefCount"] >= int(args.min_duplicate_source_refs):
            row["phase"] = "duplicate_full_response"
            duplicate_rows.append(row)
        else:
            row["phase"] = "residual_full_response"
            residual_rows.append(row)

    sort_phase_rows(duplicate_rows)
    sort_phase_rows(residual_rows)

    duplicate_manifest = build_phase_manifest(
        purpose="Full pregenerated Abby responses that are not phase-2 composable and still repeat across canonical sources.",
        phase="duplicate_full_response",
        input_manifest=args.input_manifest,
        audio_plan=args.audio_plan,
        source_opportunities=source_opportunities_path if source_opportunities is not None else None,
        slot_value_manifest_dir=args.slot_value_manifest_dir,
        min_duplicate_source_refs=int(args.min_duplicate_source_refs),
        input_response_count=len(input_rows),
        phase2_composable_count=phase2_composable_count,
        rows=duplicate_rows,
    )
    residual_manifest = build_phase_manifest(
        purpose="Full pregenerated Abby responses that are not phase-2 composable and do not repeat enough to justify the duplicate-response pass.",
        phase="residual_full_response",
        input_manifest=args.input_manifest,
        audio_plan=args.audio_plan,
        source_opportunities=source_opportunities_path if source_opportunities is not None else None,
        slot_value_manifest_dir=args.slot_value_manifest_dir,
        min_duplicate_source_refs=int(args.min_duplicate_source_refs),
        input_response_count=len(input_rows),
        phase2_composable_count=phase2_composable_count,
        rows=residual_rows,
    )
    report = build_markdown_report(
        input_manifest=args.input_manifest,
        audio_plan=args.audio_plan,
        source_opportunities=source_opportunities_path if source_opportunities is not None else None,
        slot_value_manifest_dir=args.slot_value_manifest_dir,
        total_input_count=len(input_rows),
        phase2_composable_count=phase2_composable_count,
        duplicate_rows=duplicate_rows,
        residual_rows=residual_rows,
        family_counter=phase2_family_counter,
        family_meta=family_meta,
        min_duplicate_source_refs=int(args.min_duplicate_source_refs),
    )
    return duplicate_manifest, residual_manifest, report


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.tmp")
    temp_path.write_text(content, encoding="utf-8")
    temp_path.replace(path)


def write_outputs(args: argparse.Namespace, duplicate_manifest: dict[str, Any], residual_manifest: dict[str, Any], report: str) -> None:
    atomic_write_text(args.duplicate_manifest, json.dumps(duplicate_manifest, indent=2))
    atomic_write_text(args.residual_manifest, json.dumps(residual_manifest, indent=2))
    atomic_write_text(args.report, report)


def main() -> None:
    args = parse_args()
    duplicate_manifest, residual_manifest, report = build_outputs(args)
    write_outputs(args, duplicate_manifest, residual_manifest, report)
    print(f"Wrote {display_path(args.duplicate_manifest)}")
    print(f"Wrote {display_path(args.residual_manifest)}")
    print(f"Wrote {display_path(args.report)}")
    print(
        "Filtered responses: "
        f"duplicates={duplicate_manifest['summary']['responseCount']} "
        f"residual={residual_manifest['summary']['responseCount']} "
        f"phase2_excluded={duplicate_manifest['summary']['phase2ComposableExcludedCount']}"
    )


if __name__ == "__main__":
    main()