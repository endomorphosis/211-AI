#!/usr/bin/env python3
"""Find slot-friendly rewrite opportunities from voice chunk dedupe output."""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DEDUPE = REPO_ROOT / "docs" / "phone_dialog_generation" / "voice_response_chunk_dedupe.json"
DEFAULT_OUTPUT = REPO_ROOT / "docs" / "phone_dialog_generation" / "voice_response_rewrite_opportunities.json"

SLOT_PATTERN = re.compile(r"\{(?P<kind>[a-z_]+)_\d+\}")


def normalize_slot_numbers(text: str) -> str:
    counters: Counter[str] = Counter()

    def replace(match: re.Match[str]) -> str:
        kind = match.group("kind")
        counters[kind] += 1
        return "{" + f"{kind}_{counters[kind]}" + "}"

    return SLOT_PATTERN.sub(replace, text)


def compact_spacing(text: str) -> str:
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([.,;:!?])", r"\1", text)
    return text.strip()


def canonical_rewrite_template(masked_text: str) -> str:
    text = normalize_slot_numbers(compact_spacing(masked_text))
    lowered = text.lower()

    if "{phone_1}" in text:
        if re.search(r"\b(again|repeat|once more|say it|slower)\b", lowered):
            return "I’ll repeat: {phone_1}."
        if re.search(r"\b(backup|another number|second number)\b", lowered):
            return "Backup number: {phone_1}."
        if re.search(r"\b(most important|main number|first number)\b", lowered):
            return "Main number: {phone_1}."
        if lowered.startswith("call ") or " call " in lowered or "you can call" in lowered:
            return "Call {phone_1}."
        if "number is" in lowered or lowered.startswith("phone is"):
            return "The number is {phone_1}."
        return "The number is {phone_1}."

    numeric_triplet = "{number_1}" in text and "{number_2}" in text and "{number_3}" in text
    if numeric_triplet:
        if re.search(r"\b(again|repeat|once more|slower)\b", lowered):
            return "I’ll repeat: {number_1}, {number_2}, {number_3}."
        if re.search(r"\b(backup|another number|second number)\b", lowered):
            return "Backup number: {number_1}, {number_2}, {number_3}."
        if lowered.startswith("call ") or " call " in lowered or "you can call" in lowered:
            return "Call {number_1}, {number_2}, {number_3}."
        return "The number is {number_1}, {number_2}, {number_3}."

    if "{entity_1}" in text:
        if re.fullmatch(r"(?:the )?(?:name|program|place)(?: is|:)? \{entity_1\}\.?", lowered):
            return "The name is {entity_1}."
        if re.fullmatch(r"(?:call|ask for|choose|tap|open) \{entity_1\}\.?", lowered):
            return "Call {entity_1}."
        if re.fullmatch(r"\{entity_1\} (?:is in|in|near) \{location_1\}\.?", lowered):
            return "{entity_1} is in {location_1}."
        return text

    if "{location_1}" in text:
        if re.fullmatch(r"(?:in|near|around) \{location_1\}\.?", lowered):
            return "In {location_1}."
        if re.fullmatch(r"(?:say:?\s*)?[\"“]?i[’']?m in \{location_1\}\.?", lowered):
            return "I’m in {location_1}."
        if re.fullmatch(r"\{location_1\}\.?", lowered):
            return "{location_1}."
        return text

    if "nine one one" in lowered or "9-1-1" in lowered:
        if len(text) > 120:
            return text
        if re.fullmatch(r"(?:if (?:you are|you're) in )?immediate danger,? call (?:nine one one|9-1-1)(?: now| right away)?\.?", lowered):
            return "If you are in immediate danger, call nine one one now."
        if re.fullmatch(r"(?:call|dial|hang up and call) (?:nine one one|9-1-1)(?: now| right away)?\.?", lowered):
            return "Call nine one one now."
        return text

    if "two one one" in lowered or "2-1-1" in lowered:
        if len(text) > 100:
            return text
        if re.fullmatch(r"(?:call|dial) (?:two one one|2-1-1)(?: now| first)?\.?", lowered):
            return "Call two one one."
        if re.fullmatch(r"(?:two one one|2-1-1)\.?", lowered):
            return "Two one one."
        return text

    return text


def slot_kinds_for(text: str) -> list[str]:
    return sorted(set(match.group("kind") for match in SLOT_PATTERN.finditer(text)))


def family_kind(canonical: str) -> str:
    kinds = set(slot_kinds_for(canonical))
    lowered = canonical.lower()
    if "phone" in kinds or "number" in kinds:
        return "phone_or_number"
    if "entity" in kinds:
        return "named_entity"
    if "location" in kinds:
        return "location"
    if "nine one one" in lowered:
        return "emergency_phrase"
    if "two one one" in lowered:
        return "211_phrase"
    return "static_phrase"


def load_dedupe(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_rewrite_opportunities_from_dedupe(dedupe: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    templates = dedupe.get("maskedTemplates") or dedupe.get("topMaskedTemplates") or []
    chunks_by_id = {chunk["id"]: chunk for chunk in dedupe.get("chunks", [])}
    families: dict[str, dict[str, Any]] = {}

    for template in templates:
        masked = str(template.get("maskedText") or "")
        if not masked:
            continue
        canonical = canonical_rewrite_template(masked)
        if canonical == masked and int(template.get("reuseCount") or 0) < args.min_reuse:
            continue
        family = families.setdefault(
            canonical,
            {
                "canonicalTemplate": canonical,
                "familyKind": family_kind(canonical),
                "sourceMaskedTemplates": [],
                "chunkIds": set(),
                "sourceChunkRefs": 0,
                "slotKinds": Counter(),
                "examples": [],
            },
        )
        chunk_ids = list(template.get("chunkIds") or [])
        family["sourceMaskedTemplates"].append(masked)
        family["chunkIds"].update(chunk_ids)
        family["sourceChunkRefs"] += max(int(template.get("reuseCount") or 0), len(chunk_ids), 1)
        for kind, count in dict(template.get("slotKinds") or {}).items():
            family["slotKinds"][kind] += int(count)
        for chunk_id in chunk_ids[: args.examples_per_family]:
            chunk = chunks_by_id.get(chunk_id)
            text = str((chunk or {}).get("text") or "")
            if text and text not in family["examples"]:
                family["examples"].append(text)

    opportunities: list[dict[str, Any]] = []
    for family in families.values():
        unique_chunks = len(family["chunkIds"])
        source_templates = sorted(set(family["sourceMaskedTemplates"]))
        if unique_chunks < args.min_unique_chunks and family["sourceChunkRefs"] < args.min_reuse:
            continue
        static_segments = [segment.strip() for segment in SLOT_PATTERN.split(family["canonicalTemplate"]) if segment.strip()]
        opportunities.append(
            {
                "canonicalTemplate": family["canonicalTemplate"],
                "familyKind": family["familyKind"],
                "slotKinds": dict(sorted(family["slotKinds"].items())),
                "uniqueChunkCount": unique_chunks,
                "sourceChunkRefs": family["sourceChunkRefs"],
                "sourceTemplateCount": len(source_templates),
                "estimatedTtsAssets": len(static_segments) + len(slot_kinds_for(family["canonicalTemplate"])),
                "estimatedSavedChunkCalls": max(0, unique_chunks - (len(static_segments) + len(slot_kinds_for(family["canonicalTemplate"])))),
                "sourceMaskedTemplates": source_templates[: args.max_source_templates],
                "examples": family["examples"][: args.examples_per_family],
            }
        )

    opportunities.sort(
        key=lambda item: (
            -int(item["estimatedSavedChunkCalls"]),
            -int(item["uniqueChunkCount"]),
            str(item["canonicalTemplate"]),
        )
    )
    selected = opportunities[: args.top]
    totals = Counter(item["familyKind"] for item in opportunities)
    return {
        "schemaVersion": 1,
        "input": str(args.dedupe),
        "summary": {
            "opportunityCount": len(opportunities),
            "reportedOpportunityCount": len(selected),
            "estimatedSavedChunkCallsTop": sum(int(item["estimatedSavedChunkCalls"]) for item in selected),
            "estimatedSavedChunkCallsAll": sum(int(item["estimatedSavedChunkCalls"]) for item in opportunities),
            "familyKindCounts": dict(sorted(totals.items())),
            "note": "Savings are static-analysis estimates. Slot audio still needs prosody validation before runtime composition.",
        },
        "opportunities": selected,
    }


def build_rewrite_opportunities(args: argparse.Namespace) -> dict[str, Any]:
    dedupe = load_dedupe(args.dedupe)
    return build_rewrite_opportunities_from_dedupe(dedupe, args)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dedupe", type=Path, default=DEFAULT_DEDUPE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--top", type=int, default=80)
    parser.add_argument("--min-reuse", type=int, default=3)
    parser.add_argument("--min-unique-chunks", type=int, default=3)
    parser.add_argument("--examples-per-family", type=int, default=6)
    parser.add_argument("--max-source-templates", type=int, default=12)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = build_rewrite_opportunities(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "summary": report["summary"]}, indent=2))


if __name__ == "__main__":
    main()
