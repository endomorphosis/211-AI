#!/usr/bin/env python3
"""Build a compact browser index from the slotted response DAG."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = REPO_ROOT / "docs" / "phone_dialog_generation" / "slotted_response_dag.json"
DEFAULT_OUTPUT = REPO_ROOT / "wallet_interface" / "ui" / "public" / "assets" / "rag" / "slotted-response-index.json"


def compact_examples(examples: list[dict[str, Any]], limit: int) -> list[dict[str, str]]:
    compacted: list[dict[str, str]] = []
    for example in examples[: max(0, limit)]:
        item: dict[str, str] = {}
        for key in ("recordId", "user", "assistant"):
            value = str(example.get(key) or "").strip()
            if value:
                item[key] = value[:900]
        if item:
            compacted.append(item)
    return compacted


def top_dict_values(values: dict[str, int], limit: int) -> dict[str, int]:
    return dict(sorted(values.items(), key=lambda item: (-item[1], item[0]))[:limit])


def select_edges(dag_edges: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    by_source: dict[str, list[dict[str, Any]]] = {}
    selected_ids: set[str] = set()
    selected: list[dict[str, Any]] = []
    for edge in dag_edges:
        source = str(edge.get("source") or "")
        by_source.setdefault(source, []).append(edge)
        if bool(edge.get("reusable")) or int(edge.get("reuseCount") or len(edge.get("recordIds") or [])) >= args.min_reuse_count:
            edge_id = str(edge.get("id") or "")
            if edge_id not in selected_ids:
                selected.append(edge)
                selected_ids.add(edge_id)

    for source, edges in by_source.items():
        ranked = sorted(
            edges,
            key=lambda item: (
                not bool(item.get("reusable")),
                -(int(item.get("reuseCount") or len(item.get("recordIds") or []))),
                str(item.get("route") or ""),
                str(item.get("id") or ""),
            ),
        )
        for edge in ranked[: args.edges_per_intent]:
            edge_id = str(edge.get("id") or "")
            if edge_id not in selected_ids:
                selected.append(edge)
                selected_ids.add(edge_id)
    return selected


def build_index(args: argparse.Namespace) -> dict[str, Any]:
    dag = json.loads(args.input.read_text(encoding="utf-8"))
    intents_by_id: dict[str, dict[str, Any]] = {}
    all_frames_by_id: dict[str, dict[str, Any]] = {}
    frames_by_id: dict[str, dict[str, Any]] = {}

    for intent in dag.get("nodes", {}).get("intents", []):
        routes = top_dict_values(intent.get("routes") or {}, args.route_limit)
        intents_by_id[str(intent["id"])] = {
            "id": intent["id"],
            "canonicalQueryTemplate": intent.get("canonicalQueryTemplate", ""),
            "reuseCount": len(intent.get("recordIds") or []),
            "routes": routes,
            "querySlotKinds": top_dict_values(intent.get("querySlotKinds") or intent.get("querySlots") or {}, 8),
            "evidenceDocIds": (intent.get("evidenceDocIds") or [])[: args.evidence_limit],
            "examples": compact_examples(intent.get("examples") or [], args.examples_per_node),
            "embedding": intent.get("embedding") or {},
        }

    for frame in dag.get("nodes", {}).get("responseFrames", []):
        all_frames_by_id[str(frame["id"])] = {
            "id": frame["id"],
            "responseSignature": frame.get("responseSignature", ""),
            "reuseCount": frame.get("reuseCount") or len(frame.get("recordIds") or []),
            "routes": top_dict_values(frame.get("routes") or {}, args.route_limit),
            "responseSlotKinds": top_dict_values(frame.get("responseSlotKinds") or {}, 8),
            "evidenceDocIds": (frame.get("evidenceDocIds") or [])[: args.evidence_limit],
            "examples": compact_examples(frame.get("examples") or [], args.examples_per_node),
        }

    selected_dag_edges = select_edges(dag.get("edges", []), args)
    for edge in selected_dag_edges:
        target = str(edge.get("target") or "")
        frame = all_frames_by_id.get(target)
        if frame:
            frames_by_id[target] = frame

    edges: list[dict[str, Any]] = []
    for edge in selected_dag_edges:
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        if source not in intents_by_id or target not in frames_by_id:
            continue
        edges.append(
            {
                "id": edge.get("id"),
                "source": source,
                "target": target,
                "route": edge.get("route"),
                "reuseCount": edge.get("reuseCount") or len(edge.get("recordIds") or []),
                "reusable": bool(edge.get("reusable")),
                "evidenceDocIds": (edge.get("evidenceDocIds") or [])[: args.evidence_limit],
                "examples": compact_examples(edge.get("examples") or [], args.examples_per_edge),
            }
        )

    return {
        "schemaVersion": 1,
        "sourceGeneratedAt": dag.get("generatedAt"),
        "purpose": "Compact slotted response DAG index for browser-side RAG response-frame retrieval.",
        "embedding": dag.get("embedding") or {},
        "summary": {
            **(dag.get("summary") or {}),
            "publicIntentCount": len(intents_by_id),
            "publicResponseFrameCount": len(frames_by_id),
            "publicEdgeCount": len(edges),
        },
        "slotFillPolicy": dag.get("slotFillPolicy") or {},
        "intents": list(intents_by_id.values()),
        "responseFrames": list(frames_by_id.values()),
        "edges": sorted(edges, key=lambda item: (-(item.get("reuseCount") or 0), item.get("id") or "")),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--examples-per-node", type=int, default=2)
    parser.add_argument("--examples-per-edge", type=int, default=1)
    parser.add_argument("--evidence-limit", type=int, default=12)
    parser.add_argument("--edges-per-intent", type=int, default=1)
    parser.add_argument("--min-reuse-count", type=int, default=2)
    parser.add_argument("--route-limit", type=int, default=8)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    index = build_index(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {args.output} ({args.output.stat().st_size:,} bytes)")
    print(json.dumps(index["summary"], indent=2))


if __name__ == "__main__":
    main()
