#!/usr/bin/env python3
"""Normalize pregenerated audio manifest response text in place."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(REPO_ROOT))

from scripts.precompute_indextts_responses import normalize_manifest_record_text  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path, help="Manifest files or directories to normalize.")
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing files.")
    return parser.parse_args()


def iter_manifest_paths(paths: Iterable[Path]) -> list[Path]:
    discovered: list[Path] = []
    for path in paths:
        if path.is_dir():
            discovered.extend(sorted(candidate for candidate in path.rglob("*.json") if candidate.is_file()))
        elif path.is_file():
            discovered.append(path)
    seen: set[Path] = set()
    ordered: list[Path] = []
    for path in discovered:
        resolved = path.resolve()
        if resolved not in seen:
            seen.add(resolved)
            ordered.append(path)
    return ordered


def collapse_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def normalize_response_record(record: dict[str, Any]) -> bool:
    raw_text = collapse_text(record.get("text") or "")
    if not raw_text:
        return False

    normalized_text = normalize_manifest_record_text(raw_text, record)
    if not normalized_text:
        return False

    changed = False
    original_texts: list[str] = []
    seen_originals: set[str] = set()
    for original in record.get("originalTexts") or []:
        collapsed = collapse_text(original)
        if collapsed and collapsed not in seen_originals and collapsed != normalized_text:
            seen_originals.add(collapsed)
            original_texts.append(collapsed)
    if raw_text != normalized_text and raw_text not in seen_originals:
        original_texts.insert(0, raw_text)
        seen_originals.add(raw_text)

    if record.get("text") != normalized_text:
        record["text"] = normalized_text
        changed = True
    if list(record.get("originalTexts") or []) != original_texts:
        record["originalTexts"] = original_texts
        changed = True
    return changed


def normalize_manifest(path: Path, *, dry_run: bool) -> tuple[int, int]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        responses = payload.get("responses")
        if not isinstance(responses, list):
            return 0, 0
    elif isinstance(payload, list):
        responses = payload
    else:
        return 0, 0

    changed_records = 0
    total_records = 0
    for record in responses:
        if not isinstance(record, dict):
            continue
        if "text" not in record:
            continue
        total_records += 1
        if normalize_response_record(record):
            changed_records += 1

    if changed_records and not dry_run:
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return total_records, changed_records


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def main() -> None:
    args = parse_args()
    manifest_paths = iter_manifest_paths(args.paths)
    if not manifest_paths:
        raise SystemExit("No manifest files found.")

    files_changed = 0
    records_changed = 0
    for path in manifest_paths:
        total_records, changed_records = normalize_manifest(path, dry_run=args.dry_run)
        if changed_records:
            files_changed += 1
            records_changed += changed_records
            print(f"{display_path(path)}: normalized {changed_records} of {total_records} response(s)")

    summary = {
        "filesScanned": len(manifest_paths),
        "filesChanged": files_changed,
        "responsesChanged": records_changed,
        "dryRun": bool(args.dry_run),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()