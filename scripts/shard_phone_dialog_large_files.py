#!/usr/bin/env python3
"""Shard large phone-dialog artifacts into smaller JSON/JSONL files.

This script keeps source files intact locally while creating shard directories
that are safer to version and transfer.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DOCS_DIR = REPO_ROOT / "docs" / "phone_dialog_generation"
DEFAULT_OUTPUT_ROOT = DEFAULT_DOCS_DIR / "phone_dialog_large_shards"

DEFAULT_JSON_FILES = [
    DEFAULT_DOCS_DIR / "phone_dialog_memory.json",
    DEFAULT_DOCS_DIR / "phone_dialog_results.json",
    DEFAULT_DOCS_DIR / "voice_response_chunk_dedupe.json",
]

DEFAULT_JSONL_FILES = [
    DEFAULT_DOCS_DIR / "phone_dialog_results.jsonl",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help="Root directory for shard outputs.",
    )
    parser.add_argument(
        "--max-shard-bytes",
        type=int,
        default=8 * 1024 * 1024,
        help="Approximate maximum serialized bytes per shard.",
    )
    parser.add_argument(
        "--max-items-per-shard",
        type=int,
        default=400,
        help="Hard cap on array items per shard.",
    )
    parser.add_argument(
        "--max-lines-per-shard",
        type=int,
        default=300,
        help="Hard cap on JSONL lines per shard.",
    )
    parser.add_argument(
        "--json-file",
        dest="json_files",
        action="append",
        type=Path,
        default=None,
        help="Additional or replacement JSON file to shard (can be repeated).",
    )
    parser.add_argument(
        "--jsonl-file",
        dest="jsonl_files",
        action="append",
        type=Path,
        default=None,
        help="Additional or replacement JSONL file to shard (can be repeated).",
    )
    return parser.parse_args()


def _relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _stable_json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=True, separators=(",", ":")))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def shard_list_items(
    items: list[Any],
    *,
    max_shard_bytes: int,
    max_items_per_shard: int,
) -> list[list[Any]]:
    shards: list[list[Any]] = []
    current: list[Any] = []
    current_bytes = 2

    for item in items:
        item_bytes = _stable_json_size(item)
        projected = current_bytes + item_bytes + (1 if current else 0)
        if current and (projected > max_shard_bytes or len(current) >= max_items_per_shard):
            shards.append(current)
            current = []
            current_bytes = 2
        current.append(item)
        current_bytes += item_bytes + (1 if len(current) > 1 else 0)

    if current:
        shards.append(current)
    return shards


def shard_json_file(
    source_path: Path,
    output_root: Path,
    *,
    max_shard_bytes: int,
    max_items_per_shard: int,
) -> dict[str, Any]:
    with source_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    if not isinstance(payload, dict):
        payload = {"items": payload}

    stem_dir = output_root / f"{source_path.stem}_shards"
    stem_dir.mkdir(parents=True, exist_ok=True)

    metadata: dict[str, Any] = {}
    list_fields: dict[str, list[Any]] = {}
    for key, value in payload.items():
        if isinstance(value, list):
            list_fields[key] = value
        else:
            metadata[key] = value

    field_manifests: dict[str, Any] = {}
    for field_name, items in list_fields.items():
        field_dir = stem_dir / field_name
        field_dir.mkdir(parents=True, exist_ok=True)

        shards = shard_list_items(
            items,
            max_shard_bytes=max_shard_bytes,
            max_items_per_shard=max_items_per_shard,
        )

        shard_records: list[dict[str, Any]] = []
        for idx, shard_items in enumerate(shards, start=1):
            shard_name = f"{field_name}-{idx:05d}.json"
            shard_path = field_dir / shard_name
            shard_payload = {
                "sourceFile": _relative(source_path),
                "field": field_name,
                "shardIndex": idx,
                "shardCount": len(shards),
                "itemCount": len(shard_items),
                "items": shard_items,
            }
            _write_json(shard_path, shard_payload)
            shard_records.append(
                {
                    "path": _relative(shard_path),
                    "itemCount": len(shard_items),
                    "bytes": shard_path.stat().st_size,
                }
            )

        field_manifests[field_name] = {
            "itemCount": len(items),
            "shardCount": len(shards),
            "shards": shard_records,
        }

    index_payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceFile": _relative(source_path),
        "sourceBytes": source_path.stat().st_size,
        "maxShardBytes": max_shard_bytes,
        "maxItemsPerShard": max_items_per_shard,
        "metadata": metadata,
        "listFields": field_manifests,
    }
    index_path = stem_dir / "index.json"
    _write_json(index_path, index_payload)

    return {
        "type": "json",
        "source": _relative(source_path),
        "output": _relative(stem_dir),
        "index": _relative(index_path),
        "fieldCount": len(field_manifests),
    }


def shard_jsonl_file(
    source_path: Path,
    output_root: Path,
    *,
    max_shard_bytes: int,
    max_lines_per_shard: int,
) -> dict[str, Any]:
    stem_dir = output_root / f"{source_path.stem}_shards"
    stem_dir.mkdir(parents=True, exist_ok=True)

    shards: list[dict[str, Any]] = []
    current_lines: list[str] = []
    current_bytes = 0

    def flush_shard() -> None:
        nonlocal current_lines, current_bytes
        if not current_lines:
            return
        shard_index = len(shards) + 1
        shard_name = f"lines-{shard_index:05d}.jsonl"
        shard_path = stem_dir / shard_name
        shard_path.write_text("".join(current_lines), encoding="utf-8")
        shards.append(
            {
                "path": _relative(shard_path),
                "lineCount": len(current_lines),
                "bytes": shard_path.stat().st_size,
            }
        )
        current_lines = []
        current_bytes = 0

    with source_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line_bytes = len(line.encode("utf-8"))
            if current_lines and (
                current_bytes + line_bytes > max_shard_bytes
                or len(current_lines) >= max_lines_per_shard
            ):
                flush_shard()
            current_lines.append(line)
            current_bytes += line_bytes

    flush_shard()

    index_payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceFile": _relative(source_path),
        "sourceBytes": source_path.stat().st_size,
        "maxShardBytes": max_shard_bytes,
        "maxLinesPerShard": max_lines_per_shard,
        "shardCount": len(shards),
        "shards": shards,
    }
    index_path = stem_dir / "index.json"
    _write_json(index_path, index_payload)

    return {
        "type": "jsonl",
        "source": _relative(source_path),
        "output": _relative(stem_dir),
        "index": _relative(index_path),
        "shardCount": len(shards),
    }


def main() -> None:
    args = parse_args()
    output_root = args.output_root
    output_root.mkdir(parents=True, exist_ok=True)

    json_files = args.json_files if args.json_files is not None else DEFAULT_JSON_FILES
    jsonl_files = args.jsonl_files if args.jsonl_files is not None else DEFAULT_JSONL_FILES

    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "outputRoot": _relative(output_root),
        "json": [],
        "jsonl": [],
    }

    for source_path in json_files:
        if not source_path.exists():
            continue
        result = shard_json_file(
            source_path,
            output_root,
            max_shard_bytes=args.max_shard_bytes,
            max_items_per_shard=args.max_items_per_shard,
        )
        manifest["json"].append(result)

    for source_path in jsonl_files:
        if not source_path.exists():
            continue
        result = shard_jsonl_file(
            source_path,
            output_root,
            max_shard_bytes=args.max_shard_bytes,
            max_lines_per_shard=args.max_lines_per_shard,
        )
        manifest["jsonl"].append(result)

    manifest_path = output_root / "manifest.json"
    _write_json(manifest_path, manifest)
    print(json.dumps({"manifest": _relative(manifest_path)}, indent=2))


if __name__ == "__main__":
    main()
