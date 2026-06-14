#!/usr/bin/env python3
"""Build a slotted query/response DAG for low-latency Abby routing.

The output graph is designed for this runtime flow:

1. Slot and canonicalize the live caller query.
2. Vector-search canonical slotted query intent nodes.
3. Follow route/response-frame edges to a reusable response family.
4. Use GraphRAG over the evidence/doc IDs to fill service, location, phone,
   address, provider, and safety slots.
5. Fall back to exact unique exemplars when no reusable family is confident.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.simulate_211_conversations import (  # noqa: E402
    DEFAULT_EMBEDDING_MODEL,
    generate_memory_embeddings,
)
from scripts.precompute_indextts_responses import stable_id  # noqa: E402

DEFAULT_MEMORY = REPO_ROOT / "docs" / "phone_dialog_generation" / "phone_dialog_memory.json"
DEFAULT_SLOT_DEDUPE = REPO_ROOT / "docs" / "phone_dialog_generation" / "query_response_slot_dedupe.json"
DEFAULT_OUTPUT = REPO_ROOT / "docs" / "phone_dialog_generation" / "slotted_response_dag.json"
DEFAULT_PLAN = REPO_ROOT / "docs" / "phone_dialog_generation" / "slotted_response_dag_plan.md"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def top_counts(counter: Counter[str], limit: int = 12) -> dict[str, int]:
    return {key: count for key, count in counter.most_common(limit)}


def compact_examples(values: list[Any], limit: int) -> list[Any]:
    return values[: max(0, limit)]


def build_slotted_dag(args: argparse.Namespace) -> dict[str, Any]:
    memory = load_json(args.memory)
    slot_dedupe = load_json(args.slot_dedupe)
    memory_by_id = {record["id"]: record for record in memory.get("records", [])}
    slotted_records = slot_dedupe.get("records") or []

    intent_groups: dict[str, dict[str, Any]] = {}
    response_groups: dict[str, dict[str, Any]] = {}
    pair_groups: dict[str, dict[str, Any]] = {}
    unique_records: list[dict[str, Any]] = []

    for record in slotted_records:
        record_id = str(record.get("id") or "")
        source = memory_by_id.get(record_id, {})
        intent_text = str(record.get("canonicalQueryTemplate") or record.get("queryMaskedText") or "").strip()
        response_signature = str(record.get("responseSignature") or record.get("responseMaskedText") or "").strip()
        route = str(record.get("route") or source.get("route") or "")
        if not intent_text or not response_signature:
            continue

        intent_id = f"intent-{stable_id(intent_text)}"
        response_id = f"response-frame-{stable_id(response_signature)}"
        pair_key = f"{intent_id}::{response_id}::{route}"

        intent = intent_groups.setdefault(
            intent_text,
            {
                "id": intent_id,
                "type": "intent",
                "canonicalQueryTemplate": intent_text,
                "recordIds": [],
                "routes": Counter(),
                "querySlots": Counter(),
                "querySlotValues": defaultdict(Counter),
                "evidenceDocIds": Counter(),
                "examples": [],
            },
        )
        intent["recordIds"].append(record_id)
        intent["routes"][route] += 1
        for slot in record.get("querySlots") or []:
            kind = str(slot.get("kind") or "")
            value = str(slot.get("value") or "")
            if kind:
                intent["querySlots"][kind] += 1
                if value:
                    intent["querySlotValues"][kind][value] += 1
        for doc_id in source.get("evidenceDocIds") or []:
            if doc_id:
                intent["evidenceDocIds"][str(doc_id)] += 1
        if len(intent["examples"]) < args.examples_per_node:
            intent["examples"].append({"recordId": record_id, "user": source.get("user")})

        response = response_groups.setdefault(
            response_signature,
            {
                "id": response_id,
                "type": "response_frame",
                "responseSignature": response_signature,
                "recordIds": [],
                "routes": Counter(),
                "responseSlots": Counter(),
                "evidenceDocIds": Counter(),
                "examples": [],
            },
        )
        response["recordIds"].append(record_id)
        response["routes"][route] += 1
        for slot in record.get("responseSlots") or []:
            kind = str(slot.get("kind") or "")
            if kind:
                response["responseSlots"][kind] += 1
        for doc_id in source.get("evidenceDocIds") or []:
            if doc_id:
                response["evidenceDocIds"][str(doc_id)] += 1
        if len(response["examples"]) < args.examples_per_node:
            response["examples"].append({"recordId": record_id, "assistant": source.get("assistant")})

        pair = pair_groups.setdefault(
            pair_key,
            {
                "id": f"edge-{stable_id(pair_key)}",
                "type": "intent_to_response_frame",
                "source": intent_id,
                "target": response_id,
                "route": route,
                "recordIds": [],
                "evidenceDocIds": Counter(),
                "examples": [],
            },
        )
        pair["recordIds"].append(record_id)
        for doc_id in source.get("evidenceDocIds") or []:
            if doc_id:
                pair["evidenceDocIds"][str(doc_id)] += 1
        if len(pair["examples"]) < args.examples_per_edge:
            pair["examples"].append({"recordId": record_id, "user": source.get("user"), "assistant": source.get("assistant")})

    # Embed canonical slotted intent nodes. These are service/location agnostic
    # where possible, so “I need shelter in Portland” and “I need food in Salem”
    # land on reusable graph neighborhoods before GraphRAG fills the slots.
    intent_items = sorted(intent_groups.values(), key=lambda item: (-len(item["recordIds"]), item["id"]))
    intent_texts = [item["canonicalQueryTemplate"] for item in intent_items]
    embeddings, embedding_info = generate_memory_embeddings(
        intent_texts,
        provider=args.embedding_provider,
        model_name=args.embedding_model,
        device=args.embedding_device,
        batch_size=args.embedding_batch_size,
    )
    for item, vector in zip(intent_items, embeddings):
        item["embedding"] = vector

    response_items = sorted(response_groups.values(), key=lambda item: (-len(item["recordIds"]), item["id"]))
    pair_items = sorted(pair_groups.values(), key=lambda item: (-len(item["recordIds"]), item["id"]))

    reusable_pair_ids = {item["id"] for item in pair_items if len(item["recordIds"]) > 1}
    for pair in pair_items:
        if len(pair["recordIds"]) > 1:
            continue
        record_id = pair["recordIds"][0]
        source = memory_by_id.get(record_id, {})
        slot_record = next((item for item in slotted_records if item.get("id") == record_id), {})
        unique_records.append(
            {
                "id": f"unique-exemplar-{stable_id(record_id)}",
                "type": "unique_exemplar",
                "recordId": record_id,
                "scenarioId": source.get("scenarioId"),
                "route": source.get("route"),
                "queryMaskedText": slot_record.get("queryMaskedText"),
                "canonicalQueryTemplate": slot_record.get("canonicalQueryTemplate"),
                "responseMaskedText": slot_record.get("responseMaskedText"),
                "responseSignature": slot_record.get("responseSignature"),
                "evidenceDocIds": source.get("evidenceDocIds", []),
                "user": source.get("user"),
                "assistant": source.get("assistant"),
            }
        )

    def finalize_node(item: dict[str, Any]) -> dict[str, Any]:
        payload = {
            key: value
            for key, value in item.items()
            if key not in {"routes", "querySlots", "querySlotValues", "responseSlots", "evidenceDocIds"}
        }
        payload["reuseCount"] = len(item["recordIds"])
        payload["routes"] = top_counts(item.get("routes", Counter()), args.top_counts)
        if "querySlots" in item:
            payload["querySlotKinds"] = top_counts(item["querySlots"], args.top_counts)
            payload["topQuerySlotValues"] = {
                kind: counter.most_common(args.top_slot_values)
                for kind, counter in sorted(item["querySlotValues"].items())
            }
        if "responseSlots" in item:
            payload["responseSlotKinds"] = top_counts(item["responseSlots"], args.top_counts)
        payload["evidenceDocIds"] = list(top_counts(item.get("evidenceDocIds", Counter()), args.top_evidence_docs))
        return payload

    def finalize_edge(item: dict[str, Any]) -> dict[str, Any]:
        payload = {
            key: value
            for key, value in item.items()
            if key not in {"evidenceDocIds"}
        }
        payload["reuseCount"] = len(item["recordIds"])
        payload["reusable"] = item["id"] in reusable_pair_ids
        payload["evidenceDocIds"] = list(top_counts(item.get("evidenceDocIds", Counter()), args.top_evidence_docs))
        return payload

    intent_nodes = [finalize_node(item) for item in intent_items]
    response_nodes = [finalize_node(item) for item in response_items]
    edges = [finalize_edge(item) for item in pair_items]

    route_counts = Counter(record.get("route") for record in slotted_records)
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "purpose": "Slotted query/response DAG for routing live Abby calls to reusable pregenerated response frames, with GraphRAG slot filling from evidence records.",
        "inputs": {
            "memory": str(args.memory),
            "slotDedupe": str(args.slot_dedupe),
        },
        "embedding": {
            **embedding_info,
            "embeddedNodeType": "intent",
            "embeddedText": "canonicalQueryTemplate",
            "slotInvariant": True,
        },
        "summary": {
            "sourceRecordCount": len(slotted_records),
            "intentNodeCount": len(intent_nodes),
            "responseFrameNodeCount": len(response_nodes),
            "edgeCount": len(edges),
            "reusableEdgeCount": sum(1 for item in edges if item["reusable"]),
            "uniqueExemplarCount": len(unique_records),
            "routeCounts": dict(sorted(route_counts.items())),
        },
        "slotFillPolicy": {
            "service": "Extract service need from live query, then use GraphRAG service search to pick current providers and documents.",
            "location": "Extract city/county/ZIP/address from live query, geocode when possible, then constrain GraphRAG retrieval geographically.",
            "entity": "Fill provider/program/person names from retrieved evidence, never from the canonical intent embedding alone.",
            "phone": "Fill phone numbers only from current evidence records or verified provider/contact tools.",
            "address_part": "Fill addresses only from current evidence records; normalize for TTS after retrieval.",
            "safety": "Safety/crisis intents can bypass reusable service slot filling and route to guardrail/live-agent nodes first.",
        },
        "runtimePlan": [
            "Slot and canonicalize incoming user query with the same query NER rules.",
            "Embed the canonical slotted query and vector-search intent nodes.",
            "Filter candidate intent edges by route, confidence, safety flags, and available slot values.",
            "Run GraphRAG retrieval using original user query plus extracted service/location slots.",
            "Fill response-frame slots from current GraphRAG evidence; validate phone/address/provider freshness.",
            "Use unique exemplars only when no reusable response frame clears the confidence threshold.",
        ],
        "nodes": {
            "intents": intent_nodes,
            "responseFrames": response_nodes,
            "uniqueExemplars": unique_records if args.include_unique_exemplars else [],
        },
        "edges": edges,
    }


def write_plan(dag: dict[str, Any], path: Path) -> None:
    summary = dag["summary"]
    lines = [
        "# Slotted Response DAG Deduplication Plan",
        "",
        "## Goal",
        "",
        "Use slotted, embedded user-intent nodes to route many surface forms of a caller request to the same graph neighborhood, then use GraphRAG to fill service/location/provider/phone/address slots from current evidence.",
        "",
        "## Current Artifact",
        "",
    ]
    for key, value in summary.items():
        lines.append(f"- {key}: {value}")
    lines.extend(
        [
            "",
            "## DAG Layers",
            "",
            "- Intent nodes: canonical slotted user query templates with embeddings, for example `I need {service_1} in {location_1}.`",
            "- Response-frame nodes: reusable slotted response signatures, composed from deduplicated TTS-friendly chunks.",
            "- Edges: route-specific intent-to-response-frame transitions with evidence document counts and examples.",
            "- Unique exemplar leaves: wholly unique historical turns kept as fallback examples when no reusable frame is confident.",
            "",
            "## Runtime Matching",
            "",
            "1. Slot the live query using service/location/entity/phone/address NER.",
            "2. Embed the canonical slotted query, not the literal location/service-specific query.",
            "3. Vector-search intent nodes to find the right DAG neighborhood independent of service/location values.",
            "4. Run GraphRAG with the original query plus extracted slots to retrieve fresh local records.",
            "5. Fill response slots from GraphRAG evidence and validate risky values like phones, addresses, and safety instructions.",
            "6. Prefer reusable response frames; fall back to unique exemplars for low-confidence or rare flows.",
            "",
            "## Next Implementation Steps",
            "",
            "- Wire the live voice/text router to compute the same canonical query template before RAG.",
            "- Add a small vector index loader for `slotted_response_dag.json` intent embeddings.",
            "- Add slot-fill validators for service, location, provider name, phone, address, hours, and safety level.",
            "- Pre-render TTS for high-reuse response-frame chunks and variable slot chunks separately.",
            "- Measure match confidence, fallback rate, and slot-fill correctness against the simulated conversation set.",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory", type=Path, default=DEFAULT_MEMORY)
    parser.add_argument("--slot-dedupe", type=Path, default=DEFAULT_SLOT_DEDUPE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--plan-output", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--embedding-provider", default="auto")
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-device", default=None)
    parser.add_argument("--embedding-batch-size", type=int, default=64)
    parser.add_argument("--examples-per-node", type=int, default=4)
    parser.add_argument("--examples-per-edge", type=int, default=3)
    parser.add_argument("--top-counts", type=int, default=12)
    parser.add_argument("--top-slot-values", type=int, default=8)
    parser.add_argument("--top-evidence-docs", type=int, default=12)
    parser.add_argument("--include-unique-exemplars", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dag = build_slotted_dag(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(dag, indent=2), encoding="utf-8")
    write_plan(dag, args.plan_output)
    print(json.dumps({"output": str(args.output), "plan": str(args.plan_output), "summary": dag["summary"], "embedding": dag["embedding"]}, indent=2))


if __name__ == "__main__":
    main()
