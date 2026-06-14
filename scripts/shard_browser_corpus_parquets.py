#!/usr/bin/env python3
"""Shard browser GraphRAG parquet artifacts into smaller browser-friendly files."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


DEFAULT_CORPUS_DIR = Path("wallet_interface/ui/public/corpus/211-info/current")
DEFAULT_MAX_ROWS = 400


SHARD_SPECS = {
    "documents": {
        "path": "generated/documents.parquet",
        "key_fields": ["doc_id", "source_content_cid", "source_page_cid"],
        "cluster_field": "geo_cluster_id",
        "doc_id_field": "doc_id",
        "role": "documents",
    },
    "bm25": {
        "path": "generated/bm25-documents.parquet",
        "key_fields": ["doc_id", "source_content_cid", "source_page_cid"],
        "cluster_field": "geo_cluster_id",
        "doc_id_field": "doc_id",
        "role": "retrieval",
    },
    "embeddings": {
        "path": "generated/embeddings.parquet",
        "key_fields": ["doc_id", "source_content_cid", "source_page_cid"],
        "cluster_field": "geo_cluster_id",
        "doc_id_field": "doc_id",
        "role": "retrieval",
    },
    "documentCommunities": {
        "path": "generated/document-communities.parquet",
        "key_fields": ["doc_id", "source_content_cid", "source_page_cid", "community_id"],
        "cluster_field": "geo_cluster_id",
        "doc_id_field": "doc_id",
        "role": "graph",
    },
    "graphCommunities": {
        "path": "generated/graph-communities.parquet",
        "key_fields": ["community_id"],
        "cluster_field": "geo_cluster_id",
        "doc_id_field": "",
        "role": "graph",
    },
    "serviceLocations": {
        "path": "generated/service-locations.parquet",
        "key_fields": ["service_doc_id", "location_id", "source_content_cid", "source_page_cid"],
        "cluster_field": "geo_cluster_id",
        "doc_id_field": "service_doc_id",
        "role": "geo",
    },
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-dir", type=Path, default=DEFAULT_CORPUS_DIR)
    parser.add_argument("--max-rows", type=int, default=DEFAULT_MAX_ROWS)
    args = parser.parse_args()
    manifest = shard_browser_corpus_parquets(args.corpus_dir, max_rows=args.max_rows)
    print(json.dumps({"manifest": manifest["path"], "shardCount": manifest["shardCount"]}, indent=2))


def shard_browser_corpus_parquets(corpus_dir: Path, *, max_rows: int = DEFAULT_MAX_ROWS) -> dict[str, Any]:
    corpus_dir = corpus_dir.resolve()
    generated_dir = corpus_dir / "generated"
    shard_root = generated_dir / "parquet-shards"
    if shard_root.exists():
        shutil.rmtree(shard_root)
    shard_root.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "maxRowsPerShard": max(1, max_rows),
        "basePath": "generated/parquet-shards",
        "artifacts": {},
        "shardCount": 0,
    }
    artifact_records: list[dict[str, Any]] = []

    for name, spec in SHARD_SPECS.items():
        source_path = corpus_dir / str(spec["path"])
        if not source_path.exists():
            continue
        artifact_manifest, records = shard_parquet_artifact(
            corpus_dir=corpus_dir,
            source_path=source_path,
            shard_dir=shard_root / name,
            artifact_name=name,
            spec=spec,
            max_rows=max(1, max_rows),
        )
        manifest["artifacts"][name] = artifact_manifest
        manifest["shardCount"] += int(artifact_manifest["shardCount"])
        artifact_records.extend(records)

    manifest_path = generated_dir / "parquet-shards.json"
    write_json(manifest_path, manifest)
    manifest_record = relative_record(corpus_dir, manifest_path, "metadata")
    artifact_records.insert(0, manifest_record)
    upsert_artifact_manifest(corpus_dir / "artifacts.manifest.json", artifact_records)
    upsert_generated_manifest(generated_dir / "generated-manifest.json", manifest, artifact_records)
    return {**manifest_record, "shardCount": manifest["shardCount"]}


def shard_parquet_artifact(
    *,
    corpus_dir: Path,
    source_path: Path,
    shard_dir: Path,
    artifact_name: str,
    spec: dict[str, Any],
    max_rows: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    shard_dir.mkdir(parents=True, exist_ok=True)
    parquet_file = pq.ParquetFile(source_path)
    shard_records: list[dict[str, Any]] = []
    artifact_records: list[dict[str, Any]] = []
    doc_id_to_shard_ids: dict[str, set[str]] = defaultdict(set)
    content_cid_to_shard_ids: dict[str, set[str]] = defaultdict(set)
    page_cid_to_shard_ids: dict[str, set[str]] = defaultdict(set)
    cluster_id_to_shard_ids: dict[str, set[str]] = defaultdict(set)
    service_doc_id_to_shard_ids: dict[str, set[str]] = defaultdict(set)
    community_id_to_shard_ids: dict[str, set[str]] = defaultdict(set)

    shard_number = 0
    for row_group_index in range(parquet_file.num_row_groups):
        table = parquet_file.read_row_group(row_group_index)
        row_count = table.num_rows
        for offset in range(0, row_count, max_rows):
            shard_table = table.slice(offset, max_rows)
            if shard_table.num_rows == 0:
                continue
            shard_id = f"{artifact_name}-{shard_number:04d}"
            shard_path = shard_dir / f"{shard_id}.parquet"
            pq.write_table(shard_table, shard_path, compression="zstd", use_dictionary=True)
            rows = shard_table.to_pylist()
            record = build_shard_record(
                corpus_dir=corpus_dir,
                shard_path=shard_path,
                shard_id=shard_id,
                source_path=source_path,
                source_row_group_index=row_group_index,
                source_row_offset=offset,
                rows=rows,
                spec=spec,
            )
            shard_records.append(record)
            artifact_records.append(relative_record(corpus_dir, shard_path, str(spec["role"])))
            add_reverse_indexes(
                rows,
                shard_id,
                spec,
                doc_id_to_shard_ids,
                content_cid_to_shard_ids,
                page_cid_to_shard_ids,
                cluster_id_to_shard_ids,
                service_doc_id_to_shard_ids,
                community_id_to_shard_ids,
            )
            shard_number += 1

    artifact_manifest = {
        "sourcePath": relative_path(corpus_dir, source_path),
        "shardCount": len(shard_records),
        "shards": shard_records,
        "docIdToShardIds": stringify_set_map(doc_id_to_shard_ids),
        "contentCidToShardIds": stringify_set_map(content_cid_to_shard_ids),
        "pageCidToShardIds": stringify_set_map(page_cid_to_shard_ids),
        "clusterIdToShardIds": stringify_set_map(cluster_id_to_shard_ids),
        "serviceDocIdToShardIds": stringify_set_map(service_doc_id_to_shard_ids),
        "communityIdToShardIds": stringify_set_map(community_id_to_shard_ids),
    }
    return artifact_manifest, artifact_records


def build_shard_record(
    *,
    corpus_dir: Path,
    shard_path: Path,
    shard_id: str,
    source_path: Path,
    source_row_group_index: int,
    source_row_offset: int,
    rows: list[dict[str, Any]],
    spec: dict[str, Any],
) -> dict[str, Any]:
    record = {
        "shardId": shard_id,
        "path": relative_path(corpus_dir, shard_path),
        "bytes": shard_path.stat().st_size,
        "cid": cid_for_file(shard_path),
        "sourcePath": relative_path(corpus_dir, source_path),
        "sourceRowGroupIndex": source_row_group_index,
        "sourceRowOffset": source_row_offset,
        "rowCount": len(rows),
        "clusterIds": sorted(
            {
                int(row[spec["cluster_field"]])
                for row in rows
                if spec.get("cluster_field") in row and is_int_like(row.get(spec["cluster_field"]))
            }
        ),
    }
    for field in spec.get("key_fields", []):
        values = sorted({string_value(row.get(field)) for row in rows if string_value(row.get(field))})
        if values:
            record[f"{field}Count"] = len(values)
            record[f"first{camel_field(field)}"] = values[0]
            record[f"last{camel_field(field)}"] = values[-1]
    return record


def add_reverse_indexes(
    rows: Iterable[dict[str, Any]],
    shard_id: str,
    spec: dict[str, Any],
    doc_id_to_shard_ids: dict[str, set[str]],
    content_cid_to_shard_ids: dict[str, set[str]],
    page_cid_to_shard_ids: dict[str, set[str]],
    cluster_id_to_shard_ids: dict[str, set[str]],
    service_doc_id_to_shard_ids: dict[str, set[str]],
    community_id_to_shard_ids: dict[str, set[str]],
) -> None:
    for row in rows:
        doc_field = str(spec.get("doc_id_field") or "")
        if doc_field:
            add_index_value(doc_id_to_shard_ids, row.get(doc_field), shard_id)
        add_index_value(content_cid_to_shard_ids, row.get("source_content_cid"), shard_id)
        add_index_value(page_cid_to_shard_ids, row.get("source_page_cid"), shard_id)
        add_index_value(service_doc_id_to_shard_ids, row.get("service_doc_id"), shard_id)
        add_index_value(community_id_to_shard_ids, row.get("community_id"), shard_id)
        cluster_field = spec.get("cluster_field")
        if cluster_field and is_int_like(row.get(cluster_field)):
            add_index_value(cluster_id_to_shard_ids, int(row[cluster_field]), shard_id)


def add_index_value(index: dict[str, set[str]], value: Any, shard_id: str) -> None:
    key = string_value(value)
    if key:
        index[key].add(shard_id)


def upsert_artifact_manifest(path: Path, records: list[dict[str, Any]]) -> None:
    manifest = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schemaVersion": 1, "artifacts": []}
    replacement_paths = {record["path"] for record in records}
    manifest["artifacts"] = [
        artifact
        for artifact in manifest.get("artifacts", [])
        if artifact.get("path") not in replacement_paths and not str(artifact.get("path", "")).startswith("generated/parquet-shards/")
    ]
    manifest["artifacts"].extend(records)
    write_json(path, manifest)


def upsert_generated_manifest(path: Path, parquet_manifest: dict[str, Any], records: list[dict[str, Any]]) -> None:
    manifest = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schemaVersion": 1, "files": []}
    replacement_paths = {record["path"] for record in records}
    manifest["parquetShardCount"] = int(parquet_manifest["shardCount"])
    manifest["parquetShardsPath"] = "generated/parquet-shards.json"
    manifest["parquetShardArtifacts"] = {
        name: {
            "sourcePath": artifact["sourcePath"],
            "shardCount": artifact["shardCount"],
        }
        for name, artifact in parquet_manifest.get("artifacts", {}).items()
    }
    manifest["files"] = [
        artifact
        for artifact in manifest.get("files", [])
        if artifact.get("path") not in replacement_paths and not str(artifact.get("path", "")).startswith("generated/parquet-shards/")
    ]
    manifest["files"].extend(records)
    write_json(path, manifest)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def relative_record(root: Path, path: Path, role: str) -> dict[str, Any]:
    return {
        "path": relative_path(root, path),
        "bytes": path.stat().st_size,
        "cid": cid_for_file(path),
        "role": role,
    }


def relative_path(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def cid_for_file(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def stringify_set_map(values: dict[str, set[str]]) -> dict[str, list[str]]:
    return {key: sorted(items) for key, items in sorted(values.items())}


def string_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and pd.isna(value):
        return ""
    return str(value)


def is_int_like(value: Any) -> bool:
    if value in ("", None):
        return False
    try:
        return int(value) == float(value)
    except Exception:
        return False


def camel_field(value: str) -> str:
    return "".join(part.capitalize() for part in value.split("_") if part)


if __name__ == "__main__":
    main()
