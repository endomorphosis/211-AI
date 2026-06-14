#!/usr/bin/env python3
"""Deduplicate slotted caller queries and slotted Abby response pairs."""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.deduplicate_voice_response_chunks import (  # noqa: E402
    collect_ner_phrase_counts,
    collect_phrase_counts,
    detect_named_entity_phrases,
    mask_chunk,
    split_sentence_chunks,
)
from scripts.precompute_indextts_responses import stable_id  # noqa: E402
from scripts.suggest_slot_friendly_voice_rewrites import canonical_rewrite_template  # noqa: E402

DEFAULT_MEMORY = REPO_ROOT / "docs" / "phone_dialog_generation" / "phone_dialog_memory.json"
DEFAULT_OUTPUT = REPO_ROOT / "docs" / "phone_dialog_generation" / "query_response_slot_dedupe.json"
DEFAULT_REVIEW = REPO_ROOT / "docs" / "phone_dialog_generation" / "query_response_slot_friendly_review.md"

LOCATION_ALIASES = {
    "albany": "Albany",
    "beaverton": "Beaverton",
    "bend": "Bend",
    "clackamas": "Clackamas",
    "eugene": "Eugene",
    "gresham": "Gresham",
    "hillsboro": "Hillsboro",
    "lane county": "Lane County",
    "medford": "Medford",
    "multnomah": "Multnomah",
    "multnomah county": "Multnomah County",
    "oregon": "Oregon",
    "oregon city": "Oregon City",
    "portland": "Portland",
    "salem": "Salem",
    "washington county": "Washington County",
}

SERVICE_ALIASES = {
    "benefits": "benefits",
    "case manager": "case manager",
    "child care": "child care",
    "clinic": "clinic",
    "clothes": "clothing",
    "clothing": "clothing",
    "detox": "detox",
    "diaper": "diapers",
    "diapers": "diapers",
    "doctor": "medical care",
    "documents": "documents",
    "food": "food",
    "food box": "food",
    "groceries": "food",
    "housing": "housing",
    "id": "ID",
    "job": "employment",
    "legal": "legal help",
    "meal": "meals",
    "meals": "meals",
    "medicine": "medication",
    "medication": "medication",
    "mental health": "mental health",
    "phone": "phone",
    "pregnant": "pregnancy help",
    "rent": "rent assistance",
    "ride": "transportation",
    "safe place": "safety",
    "shelter": "shelter",
    "snap": "SNAP",
    "suicide": "crisis support",
    "transportation": "transportation",
    "utility": "utilities",
    "utilities": "utilities",
    "wallet": "wallet",
    "warm": "warming center",
}

QUERY_PHONE_PATTERN = re.compile(r"\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}\b")
QUERY_ZIP_PATTERN = re.compile(r"\b\d{5}(?:-\d{4})?\b")


def compact_query(text: str) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text


def replace_aliases(text: str, aliases: dict[str, str], kind: str, slots: list[dict[str, str]]) -> str:
    masked = text
    for raw, value in sorted(aliases.items(), key=lambda item: (-len(item[0]), item[0])):
        pattern = re.compile(rf"\b{re.escape(raw)}\b", re.IGNORECASE)

        def replace(match: re.Match[str]) -> str:
            slot_name = f"{kind}_{len([slot for slot in slots if slot['kind'] == kind]) + 1}"
            slots.append({"slot": slot_name, "kind": kind, "value": value, "source": match.group(0)})
            return "{" + slot_name + "}"

        masked = pattern.sub(replace, masked)
    return masked


def mask_query(text: str, phrase_counts: Counter[str] | None = None) -> dict[str, Any]:
    """Slot a caller query into reusable intent/location/entity form."""

    phrase_counts = phrase_counts or Counter()
    slots: list[dict[str, str]] = []
    masked = compact_query(text)

    def slot(kind: str, value: str) -> str:
        slot_name = f"{kind}_{len([item for item in slots if item['kind'] == kind]) + 1}"
        slots.append({"slot": slot_name, "kind": kind, "value": value})
        return "{" + slot_name + "}"

    masked = QUERY_PHONE_PATTERN.sub(lambda match: slot("phone", match.group(0)), masked)
    masked = QUERY_ZIP_PATTERN.sub(lambda match: slot("zip", match.group(0)), masked)
    masked = replace_aliases(masked, LOCATION_ALIASES, "location", slots)
    masked = replace_aliases(masked, SERVICE_ALIASES, "service", slots)

    for phrase, kind in detect_named_entity_phrases(masked, phrase_counts):
        if kind == "location":
            continue
        pattern = re.compile(rf"(?<![\w{{]){re.escape(phrase)}(?![\w}}])")
        masked = pattern.sub(lambda match, k=kind: slot(k, match.group(0)), masked)

    masked = re.sub(r"\s+", " ", masked).strip()
    masked = re.sub(r"\s+([.,;:!?])", r"\1", masked)
    return {"maskedText": masked, "maskedHash": stable_id(masked), "slots": slots}


def canonical_query_template(masked_text: str) -> str:
    text = re.sub(r"\s+", " ", str(masked_text or "")).strip()
    lowered = text.lower()
    has_service = "{service_" in text
    has_location = "{location_" in text

    if re.search(r"\b(repeat|again|slower|missed|cut out|hard of hearing|say that)\b", lowered):
        if "number" in lowered:
            return "Please repeat the number slowly."
        return "Please repeat that more slowly."
    if re.search(r"\b(borrowed|not my|two percent|battery|call drops|phone might die|might die)\b", lowered):
        return "My phone may die; give me the most important next step."
    if re.search(r"\b(unsafe|danger|hurt|kill myself|suicide|overdose|bleeding|chest pain|threat|hitting|traffick|keeps my|made to work)\b", lowered):
        if has_location:
            return "I may be unsafe in {location_1}; help me now."
        return "I may be unsafe; help me now."
    if re.search(r"\b(what city|where are you|which county|zip|address)\b", lowered):
        return "Clarifying location or address detail."
    if has_service and has_location:
        return "I need {service_1} in {location_1}."
    if has_service:
        return "I need {service_1}."
    if has_location:
        return "I am in {location_1}."
    if re.search(r"\b(wallet|document|proof|file|upload|recover|qr)\b", lowered):
        return "I need help with my wallet or documents."
    if re.search(r"\b(appointment|calendar|reminder|visit|meeting)\b", lowered):
        return "I need help with an appointment or reminder."
    return text


def response_signature(text: str, phrase_counts: Counter[str], *, max_chunks: int = 4) -> dict[str, Any]:
    frames: list[str] = []
    for chunk in split_sentence_chunks(text, max_chars=220):
        masked = mask_chunk(chunk, phrase_counts)
        canonical = canonical_rewrite_template(masked["maskedText"])
        if canonical not in frames:
            frames.append(canonical)
        if len(frames) >= max_chunks:
            break
    signature = " | ".join(frames)
    return {"signature": signature, "hash": stable_id(signature), "frames": frames}


def load_records(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    records = payload.get("records") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        raise ValueError(f"{path} does not contain a records list")
    return [record for record in records if str(record.get("user") or "").strip()]


def build_analysis(args: argparse.Namespace) -> dict[str, Any]:
    records = load_records(args.memory)
    texts = [str(record.get("user") or "") for record in records]
    texts.extend(str(record.get("assistant") or "") for record in records)
    phrase_counts = collect_phrase_counts(texts) + collect_ner_phrase_counts(texts)

    query_templates: dict[str, dict[str, Any]] = {}
    response_templates: dict[str, dict[str, Any]] = {}
    pair_templates: dict[str, dict[str, Any]] = {}
    canonical_query_templates: dict[str, dict[str, Any]] = {}
    canonical_pair_templates: dict[str, dict[str, Any]] = {}
    records_payload: list[dict[str, Any]] = []

    for record in records:
        query = mask_query(str(record.get("user") or ""), phrase_counts)
        response = mask_chunk(str(record.get("assistant") or ""), phrase_counts)
        canonical_query = canonical_query_template(query["maskedText"])
        response_family = response_signature(str(record.get("assistant") or ""), phrase_counts)
        route = str(record.get("route") or "")
        service_tag = str(record.get("serviceTag") or "")
        location_tag = str(record.get("locationTag") or "")

        q_template = query_templates.setdefault(
            query["maskedText"],
            {
                "id": f"abby-query-template-{query['maskedHash']}",
                "maskedHash": query["maskedHash"],
                "maskedText": query["maskedText"],
                "recordIds": [],
                "routes": Counter(),
                "slotKinds": Counter(),
                "slotValues": defaultdict(Counter),
                "examples": [],
            },
        )
        q_template["recordIds"].append(record["id"])
        q_template["routes"][route] += 1
        if len(q_template["examples"]) < args.examples_per_template:
            q_template["examples"].append(str(record.get("user") or ""))
        for item in query["slots"]:
            q_template["slotKinds"][item["kind"]] += 1
            q_template["slotValues"][item["kind"]][item["value"]] += 1

        cq_template = canonical_query_templates.setdefault(
            canonical_query,
            {
                "id": f"abby-canonical-query-template-{stable_id(canonical_query)}",
                "maskedText": canonical_query,
                "recordIds": [],
                "routes": Counter(),
                "sourceQueryTemplates": Counter(),
                "examples": [],
            },
        )
        cq_template["recordIds"].append(record["id"])
        cq_template["routes"][route] += 1
        cq_template["sourceQueryTemplates"][query["maskedText"]] += 1
        if len(cq_template["examples"]) < args.examples_per_template:
            cq_template["examples"].append(str(record.get("user") or ""))

        r_template = response_templates.setdefault(
            response["maskedText"],
            {
                "id": f"abby-response-template-{response['maskedHash']}",
                "maskedHash": response["maskedHash"],
                "maskedText": response["maskedText"],
                "recordIds": [],
                "routes": Counter(),
                "slotKinds": Counter(),
                "examples": [],
            },
        )
        r_template["recordIds"].append(record["id"])
        r_template["routes"][route] += 1
        if len(r_template["examples"]) < args.examples_per_template:
            r_template["examples"].append(str(record.get("assistant") or ""))
        for item in response["slots"]:
            r_template["slotKinds"][item["kind"]] += 1

        pair_key = f"{query['maskedHash']}::{response['maskedHash']}::{route}"
        pair = pair_templates.setdefault(
            pair_key,
            {
                "id": f"abby-query-response-pair-{stable_id(pair_key)}",
                "queryMaskedText": query["maskedText"],
                "responseMaskedText": response["maskedText"],
                "route": route,
                "recordIds": [],
                "querySlotKinds": Counter(),
                "responseSlotKinds": Counter(),
                "examples": [],
            },
        )
        pair["recordIds"].append(record["id"])
        for item in query["slots"]:
            pair["querySlotKinds"][item["kind"]] += 1
        for item in response["slots"]:
            pair["responseSlotKinds"][item["kind"]] += 1
        if len(pair["examples"]) < args.examples_per_template:
            pair["examples"].append({"user": record.get("user"), "assistant": record.get("assistant")})

        canonical_pair_key = f"{stable_id(canonical_query)}::{response_family['hash']}::{route}"
        canonical_pair = canonical_pair_templates.setdefault(
            canonical_pair_key,
            {
                "id": f"abby-canonical-query-response-pair-{stable_id(canonical_pair_key)}",
                "queryTemplate": canonical_query,
                "responseSignature": response_family["signature"],
                "responseFrames": response_family["frames"],
                "route": route,
                "recordIds": [],
                "sourceQueryTemplates": Counter(),
                "examples": [],
            },
        )
        canonical_pair["recordIds"].append(record["id"])
        canonical_pair["sourceQueryTemplates"][query["maskedText"]] += 1
        if len(canonical_pair["examples"]) < args.examples_per_template:
            canonical_pair["examples"].append({"user": record.get("user"), "assistant": record.get("assistant")})

        records_payload.append(
            {
                "id": record["id"],
                "scenarioId": record.get("scenarioId"),
                "turnIndex": record.get("turnIndex"),
                "route": route,
                "serviceTag": service_tag,
                "locationTag": location_tag,
                "queryMaskedText": query["maskedText"],
                "canonicalQueryTemplate": canonical_query,
                "querySlots": query["slots"],
                "responseMaskedText": response["maskedText"],
                "responseSignature": response_family["signature"],
                "responseSlots": response["slots"],
                "pairId": pair["id"],
            }
        )

    def finalize_template(item: dict[str, Any]) -> dict[str, Any]:
        payload = {
            key: value
            for key, value in item.items()
            if key not in {"routes", "slotKinds", "slotValues"}
        }
        payload["reuseCount"] = len(item["recordIds"])
        payload["routes"] = dict(item.get("routes", {}).most_common())
        payload["slotKinds"] = dict(sorted(item.get("slotKinds", {}).items()))
        if "slotValues" in item:
            payload["topSlotValues"] = {
                kind: counter.most_common(args.top_slot_values)
                for kind, counter in sorted(item["slotValues"].items())
            }
        return payload

    query_list = [finalize_template(item) for item in query_templates.values()]
    canonical_query_list = []
    for item in canonical_query_templates.values():
        canonical_query_list.append(
            {
                "id": item["id"],
                "maskedText": item["maskedText"],
                "recordIds": item["recordIds"],
                "reuseCount": len(item["recordIds"]),
                "routes": dict(item["routes"].most_common()),
                "sourceTemplateCount": len(item["sourceQueryTemplates"]),
                "topSourceQueryTemplates": item["sourceQueryTemplates"].most_common(args.top_slot_values),
                "examples": item["examples"],
            }
        )
    response_list = [finalize_template(item) for item in response_templates.values()]
    pair_list = []
    for item in pair_templates.values():
        pair_list.append(
            {
                **{key: value for key, value in item.items() if key not in {"querySlotKinds", "responseSlotKinds"}},
                "reuseCount": len(item["recordIds"]),
                "querySlotKinds": dict(sorted(item["querySlotKinds"].items())),
                "responseSlotKinds": dict(sorted(item["responseSlotKinds"].items())),
            }
        )

    query_list.sort(key=lambda item: (-item["reuseCount"], item["id"]))
    canonical_query_list.sort(key=lambda item: (-item["reuseCount"], item["id"]))
    response_list.sort(key=lambda item: (-item["reuseCount"], item["id"]))
    pair_list.sort(key=lambda item: (-item["reuseCount"], item["id"]))
    canonical_pair_list = []
    for item in canonical_pair_templates.values():
        canonical_pair_list.append(
            {
                "id": item["id"],
                "queryTemplate": item["queryTemplate"],
                "responseSignature": item["responseSignature"],
                "responseFrames": item["responseFrames"],
                "route": item["route"],
                "recordIds": item["recordIds"],
                "reuseCount": len(item["recordIds"]),
                "sourceQueryTemplateCount": len(item["sourceQueryTemplates"]),
                "topSourceQueryTemplates": item["sourceQueryTemplates"].most_common(args.top_slot_values),
                "examples": item["examples"],
            }
        )
    canonical_pair_list.sort(key=lambda item: (-item["reuseCount"], item["id"]))

    record_count = len(records)
    return {
        "schemaVersion": 1,
        "inputs": {"memory": str(args.memory), "namedEntityRecognition": "local-query-ner-service-location-entity"},
        "summary": {
            "recordCount": record_count,
            "uniqueQueryTemplates": len(query_list),
            "reusableQueryTemplates": sum(1 for item in query_list if item["reuseCount"] > 1),
            "uniqueCanonicalQueryTemplates": len(canonical_query_list),
            "reusableCanonicalQueryTemplates": sum(1 for item in canonical_query_list if item["reuseCount"] > 1),
            "uniqueResponseTemplates": len(response_list),
            "reusableResponseTemplates": sum(1 for item in response_list if item["reuseCount"] > 1),
            "uniqueQueryResponsePairs": len(pair_list),
            "reusableQueryResponsePairs": sum(1 for item in pair_list if item["reuseCount"] > 1),
            "uniqueCanonicalQueryResponsePairs": len(canonical_pair_list),
            "reusableCanonicalQueryResponsePairs": sum(1 for item in canonical_pair_list if item["reuseCount"] > 1),
            "estimatedQueryTemplateReuseRatio": round(1 - (len(query_list) / max(record_count, 1)), 4),
            "estimatedCanonicalQueryReuseRatio": round(1 - (len(canonical_query_list) / max(record_count, 1)), 4),
            "estimatedPairReuseRatio": round(1 - (len(pair_list) / max(record_count, 1)), 4),
            "estimatedCanonicalPairReuseRatio": round(1 - (len(canonical_pair_list) / max(record_count, 1)), 4),
        },
        "topQueryTemplates": query_list[: args.top],
        "topCanonicalQueryTemplates": canonical_query_list[: args.top],
        "topResponseTemplates": response_list[: args.top],
        "topQueryResponsePairs": pair_list[: args.top],
        "topCanonicalQueryResponsePairs": canonical_pair_list[: args.top],
        "records": records_payload if args.include_details else [],
    }


def write_review(report: dict[str, Any], output: Path) -> None:
    lines = [
        "# Query-Response Slot Dedupe Review",
        "",
        "## Summary",
        "",
    ]
    for key, value in report["summary"].items():
        lines.append(f"- {key}: {value}")
    lines.extend(["", "## Top User Query Templates", ""])
    lines.append("| Rank | Reuse | Query template | Routes | Examples |")
    lines.append("|---:|---:|---|---|---|")
    for index, item in enumerate(report["topQueryTemplates"][:30], start=1):
        examples = " / ".join(str(value).replace("|", "\\|") for value in item.get("examples", [])[:2])
        query_text = str(item["maskedText"]).replace("|", "\\|")
        lines.append(
            f"| {index} | {item['reuseCount']} | `{query_text}` | {item.get('routes', {})} | {examples} |"
        )
    lines.extend(["", "## Top Canonical User Intent Templates", ""])
    lines.append("| Rank | Reuse | Canonical query template | Source templates | Routes |")
    lines.append("|---:|---:|---|---:|---|")
    for index, item in enumerate(report["topCanonicalQueryTemplates"][:30], start=1):
        query_text = str(item["maskedText"]).replace("|", "\\|")
        lines.append(
            f"| {index} | {item['reuseCount']} | `{query_text}` | {item['sourceTemplateCount']} | {item.get('routes', {})} |"
        )
    lines.extend(["", "## Top Query-Response Pairs", ""])
    lines.append("| Rank | Reuse | Route | Query template | Response template |")
    lines.append("|---:|---:|---|---|---|")
    for index, item in enumerate(report["topQueryResponsePairs"][:30], start=1):
        query_text = str(item["queryMaskedText"]).replace("|", "\\|")
        response_text = str(item["responseMaskedText"]).replace("|", "\\|")
        lines.append(
            f"| {index} | {item['reuseCount']} | {item['route']} | `{query_text}` | `{response_text}` |"
        )
    lines.extend(["", "## Top Canonical Query-Response Families", ""])
    lines.append("| Rank | Reuse | Route | Canonical query | Response frames |")
    lines.append("|---:|---:|---|---|---|")
    for index, item in enumerate(report["topCanonicalQueryResponsePairs"][:30], start=1):
        query_text = str(item["queryTemplate"]).replace("|", "\\|")
        response_text = str(item["responseSignature"]).replace("|", "\\|")
        lines.append(f"| {index} | {item['reuseCount']} | {item['route']} | `{query_text}` | `{response_text}` |")
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory", type=Path, default=DEFAULT_MEMORY)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--review-output", type=Path, default=DEFAULT_REVIEW)
    parser.add_argument("--top", type=int, default=80)
    parser.add_argument("--top-slot-values", type=int, default=8)
    parser.add_argument("--examples-per-template", type=int, default=4)
    parser.add_argument("--include-details", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = build_analysis(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    write_review(report, args.review_output)
    print(json.dumps({"output": str(args.output), "review": str(args.review_output), "summary": report["summary"]}, indent=2))


if __name__ == "__main__":
    main()
