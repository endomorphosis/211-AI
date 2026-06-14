#!/usr/bin/env python3
"""Audit RAG records for text that would sound bad when sent to IndexTTS."""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from precompute_indextts_responses import normalize_indextts_spoken_text


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DOCUMENTS = REPO_ROOT / "wallet_interface/ui/public/corpus/211-info/current/generated/documents.parquet"
DEFAULT_REPORT = REPO_ROOT / "docs/211_indextts_rag_record_audit.json"

SKIPPED_KEYS = {
    "apple_maps_url",
    "confidence",
    "contact_id",
    "geo_url",
    "geo",
    "google_maps_url",
    "lat",
    "location_id",
    "lon",
    "maps_query",
    "sms_url",
    "source_content_cid",
    "source_page_cid",
    "source_span_end",
    "source_span_start",
    "source_url",
    "tel_url",
}

TEXT_COLUMNS = [
    "doc_id",
    "title",
    "provider_name",
    "program_name",
    "categories",
    "phones",
    "websites",
    "addresses",
    "hours",
    "eligibility",
    "intake_steps",
    "required_documents",
    "fees",
    "languages",
    "travel_info",
    "area_served",
]

PATTERNS = {
    "url": re.compile(r"https?://|www\.", re.IGNORECASE),
    "email": re.compile(r"\b[\w.+-]+@[\w.-]+\.\w+\b"),
    "cid": re.compile(r"\bbaf[ykre][a-z0-9]{20,}|\bQm[1-9A-HJ-NP-Za-km-z]{30,}\b"),
    "raw_phone": re.compile(r"\(\d{3}\)\s*\d{3}-\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b|\b\d{10}\b"),
    "raw_zip_not_address_number": re.compile(
        r"(?<![\d-])\d{5}(?:-\d{4})?(?![\d-])"
        r"(?!(?:\s+(?:North|South|East|West|North East|North West|South East|South West)\b"
        r"|\s+[A-Z][A-Za-z'.-]+\s+(?:Street|Avenue|Road|Drive|Boulevard|Highway|Lane|Parkway|Place|Court|Terrace|Way)\b))"
    ),
    "raw_state_zip": re.compile(r"\b[A-Z]{2}\s+\d{5}\b"),
    "coordinate": re.compile(r"\b(?:lat|latitude|lon|longitude|lng)\b|-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}", re.IGNORECASE),
    "raw_addr_compass": re.compile(
        r"\b\d{1,6}\s+(?:N|S|E|W|NE|NW|SE|SW)\s+"
        r"|\b(?:Street|Avenue|Road|Drive|Boulevard|Highway|Lane|Parkway|Place|Court|Terrace|Way)\s+(?:N|S|E|W|NE|NW|SE|SW)\b"
    ),
    "raw_ordinal": re.compile(r"\b\d{1,3}(?:st|nd|rd|th)\b", re.IGNORECASE),
    "percent": re.compile(r"\d+(?:\.\d+)?%"),
    "currency": re.compile(r"\$\d"),
    "time_range": re.compile(r"\b\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?\s*[-–]\s*\d{1,2}:\d{2}"),
    "bullet_artifact": re.compile(r"(?:^|\s)-[A-Za-z]|•|\*"),
    "slashy": re.compile(r"\b\w+/\w+"),
    "long_all_caps": re.compile(r"\b[A-Z]{4,}\b"),
}


def scalar_values(value: Any, prefix: str = "") -> list[tuple[str, str]]:
    if value is None:
        return []
    if isinstance(value, str):
        return [(prefix, value)]
    if isinstance(value, (int, float, bool)):
        return [(prefix, str(value))]
    if isinstance(value, list):
        output: list[tuple[str, str]] = []
        for item in value:
            output.extend(scalar_values(item, prefix))
        return output
    if isinstance(value, dict):
        output = []
        for key, item in value.items():
            if key in SKIPPED_KEYS:
                continue
            child_prefix = f"{prefix}.{key}" if prefix else key
            output.extend(scalar_values(item, child_prefix))
        return output
    return []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--documents", type=Path, default=DEFAULT_DOCUMENTS)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--max-rows", type=int, default=2500)
    parser.add_argument("--max-values", type=int, default=30000)
    parser.add_argument("--examples-per-pattern", type=int, default=12)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    table = pq.read_table(args.documents, columns=TEXT_COLUMNS)
    rows = table.to_pylist()
    if args.max_rows > 0:
        rows = rows[: args.max_rows]

    counts: Counter[str] = Counter()
    field_counts: Counter[str] = Counter()
    examples: dict[str, list[dict[str, str]]] = defaultdict(list)
    normalized_values = 0

    for row in rows:
        for column in TEXT_COLUMNS[1:]:
            for field, raw in scalar_values(row.get(column), column):
                raw_text = " ".join(str(raw or "").split())
                if len(raw_text) < 2:
                    continue
                normalized_values += 1
                spoken = normalize_indextts_spoken_text(raw_text)
                for name, pattern in PATTERNS.items():
                    if not pattern.search(spoken):
                        continue
                    counts[name] += 1
                    field_counts[f"{name}:{field}"] += 1
                    if len(examples[name]) < args.examples_per_pattern:
                        examples[name].append(
                            {
                                "field": field,
                                "raw": raw_text[:400],
                                "spoken": spoken[:400],
                            }
                        )
                if args.max_values > 0 and normalized_values >= args.max_values:
                    break
            if args.max_values > 0 and normalized_values >= args.max_values:
                break
        if args.max_values > 0 and normalized_values >= args.max_values:
            break

    payload = {
        "schemaVersion": 1,
        "documents": str(args.documents),
        "rowsScanned": len(rows),
        "valuesScanned": normalized_values,
        "patternCounts": dict(counts.most_common()),
        "topFieldCounts": dict(field_counts.most_common(80)),
        "examples": examples,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"rowsScanned {payload['rowsScanned']}")
    print(f"valuesScanned {payload['valuesScanned']}")
    for name, count in counts.most_common():
        print(f"{name} {count}")
    print(f"wrote {args.report}")


if __name__ == "__main__":
    main()
