#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from huggingface_hub import HfApi


REPO_ROOT = Path(__file__).resolve().parents[1]
PRECOMPUTE_SCRIPT = REPO_ROOT / "scripts" / "precompute_indextts_responses.py"
DEFAULT_REPO_ID = os.getenv("ABBY_TTS_HF_REPO_ID", "Publicus/211-abby-tts")
DEFAULT_REMOTE_PREFIX = "audio/abby-tts/current"
DEFAULT_STAGE_DIR = REPO_ROOT / "tmp_assets" / "hf-abby-tts-dataset"
DEFAULT_AUDIO_ROOTS = (
    REPO_ROOT / "wallet_interface" / "ui" / "public" / "assets" / "audio" / "precomputed",
)
DEFAULT_MANIFEST_GLOBS = (
    "docs/211_indextts_precompute_manifest.json",
    "docs/pregenerated_text_audio*_manifest.json",
    "docs/pregenerated_text_audio*_public_manifest.json",
    "docs/pregenerated_text_audio*_precompute_manifest.json",
    "docs/pregenerated_text_audio_*_batches/*.json",
)
DEFAULT_PROVENANCE_GLOBS = (
    "docs/211_indextts_precompute_manifest.json",
    "docs/pregenerated_text_audio*_manifest.json",
    "docs/pregenerated_text_audio*_public_manifest.json",
    "docs/pregenerated_text_audio*_precompute_manifest.json",
    "docs/pregenerated_text_audio*_batch_state.json",
    "docs/pregenerated_text_audio_*_batches/*.json",
)
LIST_FIELDS = (
    "originalTexts",
    "routes",
    "slottedIntentIds",
    "slottedCanonicalQueryTemplates",
    "slottedResponseFrameIds",
    "slottedResponseSignatures",
    "slottedEdgeIds",
    "serviceTags",
    "locationTags",
    "sourceTypes",
    "sourceIds",
    "manifestIds",
    "manifestPaths",
    "manifestKinds",
    "statuses",
    "manifestAudioPaths",
    "preferredManifestAudioPaths",
    "audioLocalPaths",
    "audioMimeTypes",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def collapse_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def ordered_unique(values: Iterable[Any]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        collapsed = collapse_text(value)
        if not collapsed or collapsed in seen:
            continue
        seen.add(collapsed)
        result.append(collapsed)
    return result


def merge_list_field(record: dict[str, Any], field: str, values: Iterable[Any]) -> None:
    record[field] = ordered_unique([*(record.get(field) or []), *values])


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative_path(path: Path, root: Path) -> str:
    resolved_path = path.resolve()
    resolved_root = root.resolve()
    try:
        return resolved_path.relative_to(resolved_root).as_posix()
    except ValueError:
        return resolved_path.as_posix()


def load_secret_env() -> None:
    load_indextts_secret_env = None
    if PRECOMPUTE_SCRIPT.exists():
        try:
            spec = importlib.util.spec_from_file_location("upload_hf_abby_tts_precompute", PRECOMPUTE_SCRIPT)
            if spec is not None and spec.loader is not None:
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                candidate = getattr(module, "load_secret_env", None)
                if callable(candidate):
                    load_indextts_secret_env = candidate
        except Exception:
            load_indextts_secret_env = None

    if load_indextts_secret_env is not None:
        load_indextts_secret_env()
        return

    secrets_path = Path(os.path.expanduser("~/.ipfs_datasets/secrets.json"))
    if not secrets_path.exists():
        return
    try:
        payload = json.loads(secrets_path.read_text(encoding="utf-8"))
    except Exception:
        return
    api_tokens = payload.get("api_tokens") if isinstance(payload, Mapping) else None
    if isinstance(api_tokens, Mapping):
        for key in (
            "HF_TOKEN",
            "HUGGINGFACEHUB_API_TOKEN",
            "IPFS_DATASETS_PY_HF_API_TOKEN",
            "HUGGINGFACE_API_TOKEN",
            "HUGGINGFACE_HUB_TOKEN",
        ):
            value = collapse_text(api_tokens.get(key))
            if value and not os.getenv(key):
                os.environ[key] = value


def hf_token() -> str | None:
    load_secret_env()
    return (
        os.getenv("HF_TOKEN")
        or os.getenv("HUGGINGFACE_TOKEN")
        or os.getenv("HUGGINGFACEHUB_API_TOKEN")
        or os.getenv("IPFS_DATASETS_PY_HF_API_TOKEN")
        or None
    )


def iter_globbed_files(repo_root: Path, patterns: Sequence[str]) -> list[Path]:
    seen: set[Path] = set()
    results: list[Path] = []
    for pattern in patterns:
        for path in repo_root.glob(pattern):
            if not path.is_file():
                continue
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            results.append(resolved)
    return sorted(results)


def extract_text_hash(*, raw_id: Any = "", text_hash: Any = "", text: Any = "", path: Path | None = None) -> str:
    collapsed_hash = collapse_text(text_hash).lower()
    if re.fullmatch(r"[0-9a-f]{20}", collapsed_hash):
        return collapsed_hash

    collapsed_id = collapse_text(raw_id)
    match = re.search(r"([0-9a-f]{20})$", collapsed_id, flags=re.IGNORECASE)
    if match:
        return match.group(1).lower()

    if path is not None:
        match = re.search(r"([0-9a-f]{20})$", path.stem, flags=re.IGNORECASE)
        if match:
            return match.group(1).lower()

    collapsed_text_value = collapse_text(text)
    if collapsed_text_value:
        return sha256_text(collapsed_text_value)
    return ""


def manifest_kind(path: Path) -> str:
    name = path.name
    if name.endswith("_public_manifest.json"):
        return "public-manifest"
    if name.endswith("_precompute_manifest.json"):
        return "precompute-manifest"
    if "_batches" in path.as_posix():
        return "batch-manifest"
    if name.endswith("_manifest.json"):
        return "manifest"
    return "json"


def initial_record(text_hash: str, raw_id: str = "") -> dict[str, Any]:
    canonical_id = f"abby-tts-{text_hash}" if text_hash else collapse_text(raw_id)
    return {
        "id": canonical_id,
        "textHash": text_hash,
        "text": "",
        "originalTexts": [],
        "routes": [],
        "slottedIntentIds": [],
        "slottedCanonicalQueryTemplates": [],
        "slottedResponseFrameIds": [],
        "slottedResponseSignatures": [],
        "slottedEdgeIds": [],
        "serviceTags": [],
        "locationTags": [],
        "sourceTypes": [],
        "sourceIds": [],
        "manifestIds": ordered_unique([raw_id]),
        "manifestPaths": [],
        "manifestKinds": [],
        "statuses": [],
        "manifestAudioPaths": [],
        "preferredManifestAudioPaths": [],
        "audioLocalPaths": [],
        "audioMimeTypes": [],
        "priorityScore": 0.0,
        "priorityRank": None,
        "latencyMs": None,
        "preferredMimeType": "",
        "audioAvailable": False,
        "audioCandidateCount": 0,
        "audioExtension": "",
        "audioBytes": 0,
        "audioSha256": "",
        "datasetAudioPath": "",
        "datasetAudioUrl": "",
        "searchText": "",
    }


def iter_manifest_responses(payload: Any) -> list[Mapping[str, Any]]:
    if isinstance(payload, Mapping) and isinstance(payload.get("responses"), list):
        return [item for item in payload["responses"] if isinstance(item, Mapping)]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, Mapping)]
    return []


def load_manifest_records(repo_root: Path, manifest_paths: Sequence[Path]) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for manifest_path in manifest_paths:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_path_text = safe_relative_path(manifest_path, repo_root)
        kind = manifest_kind(manifest_path)
        responses = iter_manifest_responses(payload)
        for response in responses:
            text_hash = extract_text_hash(
                raw_id=response.get("id"),
                text_hash=response.get("textHash"),
                text=response.get("text"),
            )
            if not text_hash:
                continue
            raw_id = collapse_text(response.get("id"))
            record = records.setdefault(text_hash, initial_record(text_hash, raw_id))
            record["id"] = record.get("id") or f"abby-tts-{text_hash}"
            if raw_id:
                merge_list_field(record, "manifestIds", [raw_id])
            text = collapse_text(response.get("text"))
            if text and not record.get("text"):
                record["text"] = text
            merge_list_field(record, "originalTexts", response.get("originalTexts") or [])
            merge_list_field(record, "routes", response.get("routes") or [])
            merge_list_field(record, "slottedIntentIds", response.get("slottedIntentIds") or [])
            merge_list_field(
                record,
                "slottedCanonicalQueryTemplates",
                response.get("slottedCanonicalQueryTemplates") or [],
            )
            merge_list_field(record, "slottedResponseFrameIds", response.get("slottedResponseFrameIds") or [])
            merge_list_field(record, "slottedResponseSignatures", response.get("slottedResponseSignatures") or [])
            merge_list_field(record, "slottedEdgeIds", response.get("slottedEdgeIds") or [])
            merge_list_field(record, "serviceTags", response.get("serviceTags") or [])
            merge_list_field(record, "locationTags", response.get("locationTags") or [])
            merge_list_field(record, "sourceTypes", response.get("sourceTypes") or [])
            merge_list_field(record, "sourceIds", response.get("sourceIds") or [])
            merge_list_field(record, "manifestPaths", [manifest_path_text])
            merge_list_field(record, "manifestKinds", [kind])
            merge_list_field(record, "statuses", [response.get("status")])
            merge_list_field(
                record,
                "manifestAudioPaths",
                [response.get("audioPath"), response.get("mp3Path"), response.get("preferredAudioPath")],
            )
            merge_list_field(record, "preferredManifestAudioPaths", [response.get("preferredAudioPath")])
            merge_list_field(record, "audioMimeTypes", [response.get("mimeType"), response.get("mp3MimeType"), response.get("preferredMimeType")])

            priority_score = response.get("priorityScore")
            if priority_score is not None:
                record["priorityScore"] = max(float(record.get("priorityScore") or 0.0), float(priority_score))
            priority_rank = response.get("priorityRank")
            if priority_rank is not None and collapse_text(priority_rank):
                current_rank = record.get("priorityRank")
                parsed_rank = int(priority_rank)
                if current_rank is None or parsed_rank < int(current_rank):
                    record["priorityRank"] = parsed_rank
            latency_ms = response.get("latencyMs")
            if latency_ms is not None and collapse_text(latency_ms):
                current_latency = record.get("latencyMs")
                parsed_latency = int(latency_ms)
                if current_latency is None or parsed_latency < int(current_latency):
                    record["latencyMs"] = parsed_latency
            preferred_mime = collapse_text(response.get("preferredMimeType") or response.get("mp3MimeType") or response.get("mimeType"))
            if preferred_mime and not record.get("preferredMimeType"):
                record["preferredMimeType"] = preferred_mime
            for path_text in record["manifestAudioPaths"]:
                candidate = repo_root / path_text
                if candidate.exists() and candidate.is_file():
                    merge_list_field(record, "audioLocalPaths", [safe_relative_path(candidate, repo_root)])
    return records


def scan_audio_files(repo_root: Path, audio_roots: Sequence[Path], records: dict[str, dict[str, Any]]) -> None:
    for audio_root in audio_roots:
        if not audio_root.exists() or not audio_root.is_dir():
            continue
        for path in sorted(audio_root.rglob("abby-tts-*")):
            if not path.is_file() or path.suffix.lower() not in {".mp3", ".wav"}:
                continue
            text_hash = extract_text_hash(path=path)
            if not text_hash:
                continue
            record = records.setdefault(text_hash, initial_record(text_hash, path.stem))
            merge_list_field(record, "audioLocalPaths", [safe_relative_path(path, repo_root)])
            if path.suffix.lower() == ".mp3" and not record.get("preferredMimeType"):
                record["preferredMimeType"] = "audio/mpeg"
            if path.suffix.lower() == ".wav" and not record.get("preferredMimeType"):
                record["preferredMimeType"] = "audio/wav"


def resolve_existing_audio_paths(repo_root: Path, values: Iterable[Any]) -> list[Path]:
    resolved: list[Path] = []
    seen: set[Path] = set()
    for value in values:
        candidate_text = collapse_text(value)
        if not candidate_text:
            continue
        candidate = (repo_root / candidate_text).resolve()
        if not candidate.exists() or not candidate.is_file() or candidate in seen:
            continue
        seen.add(candidate)
        resolved.append(candidate)
    return resolved


def choose_audio_file(repo_root: Path, record: Mapping[str, Any]) -> Path | None:
    preferred = resolve_existing_audio_paths(repo_root, record.get("preferredManifestAudioPaths") or [])
    local = resolve_existing_audio_paths(repo_root, record.get("audioLocalPaths") or [])
    candidates = ordered_unique([path.as_posix() for path in [*preferred, *local]])
    if not candidates:
        return None
    ordered_candidates = [Path(value) for value in candidates]
    ordered_candidates.sort(key=lambda path: (path.suffix.lower() != ".mp3", path.as_posix()))
    return ordered_candidates[0]


def record_search_text(record: Mapping[str, Any]) -> str:
    parts: list[Any] = [record.get("text")]
    for field in (
        "originalTexts",
        "routes",
        "slottedIntentIds",
        "slottedCanonicalQueryTemplates",
        "slottedResponseFrameIds",
        "slottedResponseSignatures",
        "slottedEdgeIds",
        "serviceTags",
        "locationTags",
        "sourceTypes",
        "sourceIds",
        "manifestIds",
        "statuses",
    ):
        parts.extend(record.get(field) or [])
    return " | ".join(ordered_unique(parts))


def write_json(path: Path, payload: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def materialize_file(source_path: Path, destination_path: Path) -> Path:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if destination_path.exists():
        destination_path.unlink()
    try:
        os.link(source_path, destination_path)
    except OSError:
        shutil.copy2(source_path, destination_path)
    return destination_path


def write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


def flat_parquet_rows(records: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for record in records:
        row: dict[str, Any] = {
            "id": record.get("id"),
            "textHash": record.get("textHash"),
            "text": record.get("text"),
            "audioAvailable": bool(record.get("audioAvailable")),
            "datasetAudioPath": record.get("datasetAudioPath"),
            "datasetAudioUrl": record.get("datasetAudioUrl"),
            "preferredMimeType": record.get("preferredMimeType"),
            "audioBytes": int(record.get("audioBytes") or 0),
            "audioSha256": record.get("audioSha256"),
            "audioCandidateCount": int(record.get("audioCandidateCount") or 0),
            "priorityScore": float(record.get("priorityScore") or 0.0),
            "priorityRank": record.get("priorityRank"),
            "latencyMs": record.get("latencyMs"),
            "searchText": record.get("searchText"),
        }
        for field in LIST_FIELDS:
            values = record.get(field) or []
            row[f"{field}Json"] = json.dumps(values, ensure_ascii=False)
            row[f"{field}Joined"] = " | ".join(values)
        rows.append(row)
    return rows


def write_parquet(path: Path, records: Sequence[Mapping[str, Any]]) -> Path | None:
    try:
        import pandas as pd
    except Exception:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(flat_parquet_rows(records)).to_parquet(path, index=False)
    return path


def build_query_index(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    by_text_hash: dict[str, str] = {}
    by_text: dict[str, list[str]] = {}
    by_field: dict[str, dict[str, list[str]]] = {
        "byRoute": {},
        "byServiceTag": {},
        "byLocationTag": {},
        "bySourceType": {},
        "byManifest": {},
        "byStatus": {},
    }
    by_id: dict[str, dict[str, Any]] = {}
    for record in records:
        record_id = str(record.get("id") or "")
        text_hash = str(record.get("textHash") or "")
        text = collapse_text(record.get("text"))
        if text_hash:
            by_text_hash[text_hash] = record_id
        if text:
            by_text.setdefault(text, []).append(record_id)
        by_id[record_id] = {
            "textHash": text_hash,
            "text": text,
            "originalTexts": record.get("originalTexts") or [],
            "routes": record.get("routes") or [],
            "slottedIntentIds": record.get("slottedIntentIds") or [],
            "slottedCanonicalQueryTemplates": record.get("slottedCanonicalQueryTemplates") or [],
            "slottedResponseFrameIds": record.get("slottedResponseFrameIds") or [],
            "slottedResponseSignatures": record.get("slottedResponseSignatures") or [],
            "slottedEdgeIds": record.get("slottedEdgeIds") or [],
            "datasetAudioPath": record.get("datasetAudioPath") or "",
            "datasetAudioUrl": record.get("datasetAudioUrl") or "",
            "audioAvailable": bool(record.get("audioAvailable")),
        }
        field_mapping = {
            "byRoute": record.get("routes") or [],
            "byServiceTag": record.get("serviceTags") or [],
            "byLocationTag": record.get("locationTags") or [],
            "bySourceType": record.get("sourceTypes") or [],
            "byManifest": record.get("manifestPaths") or [],
            "byStatus": record.get("statuses") or [],
        }
        for field, values in field_mapping.items():
            for value in values:
                by_field[field].setdefault(value, []).append(record_id)
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "recordCount": len(records),
        "byId": by_id,
        "byTextHash": by_text_hash,
        "byText": {key: ordered_unique(value) for key, value in by_text.items()},
        **{field: {key: ordered_unique(value) for key, value in mapping.items()} for field, mapping in by_field.items()},
    }


def build_runtime_manifest(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    responses: list[dict[str, Any]] = []
    for record in records:
        if not record.get("audioAvailable"):
            continue
        preferred_audio_url = collapse_text(record.get("datasetAudioUrl"))
        if not preferred_audio_url:
            continue
        preferred_mime_type = collapse_text(record.get("preferredMimeType")) or "audio/mpeg"
        entry = {
            "id": record.get("id"),
            "text": record.get("text") or "",
            "originalTexts": record.get("originalTexts") or [],
            "routes": record.get("routes") or [],
            "slottedIntentIds": record.get("slottedIntentIds") or [],
            "slottedCanonicalQueryTemplates": record.get("slottedCanonicalQueryTemplates") or [],
            "slottedResponseFrameIds": record.get("slottedResponseFrameIds") or [],
            "slottedResponseSignatures": record.get("slottedResponseSignatures") or [],
            "slottedEdgeIds": record.get("slottedEdgeIds") or [],
            "status": (record.get("statuses") or [""])[0] or "generated",
            "preferredAudioUrl": preferred_audio_url,
            "preferredMimeType": preferred_mime_type,
        }
        if preferred_mime_type == "audio/mpeg":
            entry["mp3Url"] = preferred_audio_url
        else:
            entry["audioUrl"] = preferred_audio_url
        responses.append(entry)
    responses.sort(key=lambda entry: str(entry.get("id") or ""))
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "responseCount": len(responses),
        "responses": responses,
    }


def render_dataset_card(summary: Mapping[str, Any]) -> str:
    return "\n".join(
        [
            "---",
            "license: mit",
            "pretty_name: Abby TTS Assets",
            "task_categories:",
            "- text-to-speech",
            "- audio-classification",
            "size_categories:",
            f"- {summary.get('recordCount', 0)}<n<100K",
            "---",
            "",
            "# Abby TTS Assets",
            "",
            "This dataset mirrors locally generated Abby IndexTTS assets that are ignored in git and staged for Hugging Face distribution.",
            "",
            "## Layout",
            "",
            "- `audio/`: canonical audio objects named by `abby-tts-{textHash}`.",
            "- `metadata/abby_tts_runtime_manifest.json`: browser-sized audio-backed manifest for Abby prerender lookup.",
            "- `metadata/abby_tts_responses.jsonl`: full-fidelity searchable response records.",
            "- `metadata/abby_tts_responses.parquet`: flattened table for fast filtering when pandas/pyarrow is available.",
            "- `metadata/abby_tts_query_index.json`: exact-match indexes by text hash, route, tags, source type, status, and manifest.",
            "- `metadata/summary.json`: aggregate counts and source coverage.",
            "- `provenance/`: raw manifests used to build the dataset rows.",
            "",
            "## Summary",
            "",
            f"- Records: {summary.get('recordCount', 0)}",
            f"- Audio-backed records: {summary.get('audioAvailableCount', 0)}",
            f"- Planned-only records: {summary.get('plannedOnlyCount', 0)}",
            f"- Manifest files copied: {summary.get('manifestCount', 0)}",
            "",
            "## Core Fields",
            "",
            "- `id`: canonical `abby-tts-{textHash}` identifier.",
            "- `textHash`: first 20 hex chars of the SHA-256 of the spoken normalized text.",
            "- `text`: normalized spoken text used to synthesize the clip.",
            "- `datasetAudioPath` / `datasetAudioUrl`: dataset-relative and Hub-resolved audio locations.",
            "- `routes`, `serviceTags`, `locationTags`, `sourceTypes`, `sourceIds`: lookup facets inherited from the source manifests.",
            "- `manifestIds`, `manifestPaths`, `manifestKinds`, `statuses`: provenance for reconstruction and debugging.",
            "- `searchText`: flattened exact-text query surface.",
            "",
        ]
    )


def copy_provenance_files(repo_root: Path, provenance_paths: Sequence[Path], stage_dir: Path) -> list[str]:
    copied: list[str] = []
    for source_path in provenance_paths:
        relative = safe_relative_path(source_path, repo_root)
        destination = stage_dir / "provenance" / relative
        materialize_file(source_path, destination)
        copied.append(destination.relative_to(stage_dir).as_posix())
    return copied


def stage_abby_tts_dataset(
    *,
    repo_root: Path,
    manifest_paths: Sequence[Path],
    provenance_paths: Sequence[Path],
    audio_roots: Sequence[Path],
    stage_dir: Path,
    repo_id: str,
    remote_prefix: str,
    write_parquet_files: bool,
) -> dict[str, Any]:
    records = load_manifest_records(repo_root, manifest_paths)
    scan_audio_files(repo_root, audio_roots, records)

    if stage_dir.exists():
        shutil.rmtree(stage_dir)
    (stage_dir / "audio").mkdir(parents=True, exist_ok=True)
    (stage_dir / "metadata").mkdir(parents=True, exist_ok=True)

    record_rows: list[dict[str, Any]] = []
    manifest_counter: Counter[str] = Counter()
    source_type_counter: Counter[str] = Counter()

    for text_hash in sorted(records):
        record = records[text_hash]
        chosen_audio = choose_audio_file(repo_root, record)
        if chosen_audio is not None:
            destination_name = f"{record['id']}{chosen_audio.suffix.lower()}"
            destination = stage_dir / "audio" / destination_name
            materialize_file(chosen_audio, destination)
            record["audioAvailable"] = True
            record["audioExtension"] = chosen_audio.suffix.lower()
            record["audioBytes"] = int(chosen_audio.stat().st_size)
            record["audioSha256"] = sha256_file(chosen_audio)
            record["datasetAudioPath"] = destination.relative_to(stage_dir).as_posix()
            record["datasetAudioUrl"] = (
                f"https://huggingface.co/datasets/{repo_id}/resolve/main/{remote_prefix.strip('/')}/{record['datasetAudioPath']}"
            )
        record["audioCandidateCount"] = len(record.get("audioLocalPaths") or [])
        record["searchText"] = record_search_text(record)
        record_rows.append(record)
        manifest_counter.update(record.get("manifestPaths") or [])
        source_type_counter.update(record.get("sourceTypes") or [])

    summary = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "repoRoot": str(repo_root.resolve()),
        "repoId": repo_id,
        "remotePrefix": remote_prefix.strip("/"),
        "recordCount": len(record_rows),
        "audioAvailableCount": sum(1 for record in record_rows if record.get("audioAvailable")),
        "plannedOnlyCount": sum(1 for record in record_rows if not record.get("audioAvailable")),
        "manifestCount": len(manifest_paths),
        "provenanceFileCount": len(provenance_paths),
        "audioRootCount": len(audio_roots),
        "sourceTypeCounts": dict(sorted(source_type_counter.items())),
        "manifestRecordCounts": dict(sorted(manifest_counter.items())),
    }
    runtime_manifest = build_runtime_manifest(record_rows)

    write_jsonl(stage_dir / "metadata" / "abby_tts_responses.jsonl", record_rows)
    parquet_path = write_parquet(stage_dir / "metadata" / "abby_tts_responses.parquet", record_rows) if write_parquet_files else None
    write_json(stage_dir / "metadata" / "abby_tts_runtime_manifest.json", runtime_manifest)
    write_json(stage_dir / "metadata" / "abby_tts_query_index.json", build_query_index(record_rows))
    write_json(stage_dir / "metadata" / "summary.json", summary)
    copied_provenance = copy_provenance_files(repo_root, provenance_paths, stage_dir)
    (stage_dir / "README.md").write_text(render_dataset_card(summary), encoding="utf-8")

    return {
        **summary,
        "stageDir": str(stage_dir.resolve()),
        "parquetWritten": parquet_path is not None,
        "runtimeManifestResponseCount": runtime_manifest["responseCount"],
        "copiedProvenance": copied_provenance,
    }


def upload_staged_dataset(
    *,
    repo_id: str,
    remote_prefix: str,
    stage_dir: Path,
    private: bool,
    force_upload: bool,
) -> dict[str, Any]:
    token = hf_token()
    if not token:
        raise RuntimeError("HF_TOKEN is not set; unable to upload Abby TTS dataset")
    api = HfApi(token=token)
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=private, exist_ok=True)
    delete_patterns = [f"{remote_prefix.strip('/')}/**"] if force_upload else None
    api.upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        folder_path=str(stage_dir),
        path_in_repo=remote_prefix.strip("/"),
        delete_patterns=delete_patterns,
        commit_message="Upload Abby TTS audio assets and search metadata",
    )
    return {
        "repoId": repo_id,
        "remotePrefix": remote_prefix.strip("/"),
        "forceUpload": force_upload,
        "uploadPath": f"https://huggingface.co/datasets/{repo_id}/tree/main/{remote_prefix.strip('/')}",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage and upload Abby TTS assets to a Hugging Face dataset")
    parser.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    parser.add_argument("--remote-prefix", default=DEFAULT_REMOTE_PREFIX)
    parser.add_argument("--stage-dir", type=Path, default=DEFAULT_STAGE_DIR)
    parser.add_argument("--manifest-glob", action="append", dest="manifest_globs", default=[])
    parser.add_argument("--provenance-glob", action="append", dest="provenance_globs", default=[])
    parser.add_argument("--audio-root", type=Path, action="append", dest="audio_roots", default=[])
    parser.add_argument("--skip-parquet", action="store_true")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--force-upload", action="store_true")
    parser.add_argument("--private", action="store_true", help="Create the dataset repo as private if it does not exist.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest_globs = tuple(args.manifest_globs or DEFAULT_MANIFEST_GLOBS)
    provenance_globs = tuple(args.provenance_globs or DEFAULT_PROVENANCE_GLOBS)
    audio_roots = [path if path.is_absolute() else (REPO_ROOT / path) for path in (args.audio_roots or list(DEFAULT_AUDIO_ROOTS))]
    manifest_paths = iter_globbed_files(REPO_ROOT, manifest_globs)
    provenance_paths = iter_globbed_files(REPO_ROOT, provenance_globs)
    if not manifest_paths:
        raise FileNotFoundError(f"No Abby TTS manifests matched: {manifest_globs}")

    stage_result = stage_abby_tts_dataset(
        repo_root=REPO_ROOT,
        manifest_paths=manifest_paths,
        provenance_paths=provenance_paths,
        audio_roots=audio_roots,
        stage_dir=args.stage_dir if args.stage_dir.is_absolute() else (REPO_ROOT / args.stage_dir),
        repo_id=args.repo_id,
        remote_prefix=args.remote_prefix,
        write_parquet_files=not bool(args.skip_parquet),
    )
    payload: dict[str, Any] = {"stage": stage_result}
    if args.upload or args.force_upload:
        payload["upload"] = upload_staged_dataset(
            repo_id=args.repo_id,
            remote_prefix=args.remote_prefix,
            stage_dir=args.stage_dir if args.stage_dir.is_absolute() else (REPO_ROOT / args.stage_dir),
            private=bool(args.private),
            force_upload=bool(args.force_upload),
        )
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()