#!/usr/bin/env python3
"""Build reusable audio vocabulary and GraphRAG prerender candidates.

This planner extends the current shell/slot-value audio manifests with two more
sources of composable audio units:

1. High-reuse BM25 bag-of-words terms from the browser GraphRAG corpus.
2. GraphRAG-backed entity, phone, and normalized-address candidates that are
   likely to be reused across slotted responses.

The output manifest is intentionally shaped like the existing precompute input
manifests so it can be rendered with the same IndexTTS pipeline later.
"""
from __future__ import annotations

import argparse
import functools
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.precompute_indextts_responses import (  # noqa: E402
    _digits_to_words,
    normalize_indextts_spoken_text,
    normalize_slot_value_text,
    stable_id,
)

try:  # noqa: E402
    from scraper.enrich_service_addresses import normalized_query_address_text
except Exception:  # pragma: no cover - fallback for lean environments
    def normalized_query_address_text(address: str) -> str:
        return re.sub(r"\s+", " ", str(address or "")).strip()


DEFAULT_AUDIO_PLAN = REPO_ROOT / "docs" / "pregenerated_text_audio_slot_plan.json"
DEFAULT_BROWSER_CORPUS_DIR = REPO_ROOT / "wallet_interface" / "ui" / "public" / "corpus" / "211-info" / "current"
DEFAULT_VOCAB_INVENTORY = REPO_ROOT / "docs" / "pregenerated_text_audio_vocabulary_inventory.json"
DEFAULT_VOCAB_MANIFEST = REPO_ROOT / "docs" / "pregenerated_text_audio_vocabulary_manifest.json"
DEFAULT_BM25_MANIFEST = REPO_ROOT / "docs" / "pregenerated_text_audio_bm25_manifest.json"
DEFAULT_GRAPHRAG_CANDIDATES = REPO_ROOT / "docs" / "graphrag_audio_prerender_candidates.json"
DEFAULT_REPORT = REPO_ROOT / "docs" / "PREGENERATED_TEXT_AUDIO_VOCABULARY.md"

STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "how",
    "i",
    "in",
    "is",
    "it",
    "near",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
}
GENERIC_BM25_TERMS = {
    "address",
    "addresses",
    "amp",
    "apply",
    "aspx",
    "assistance",
    "call",
    "click",
    "com",
    "contact",
    "details",
    "email",
    "gethelp",
    "gov",
    "help",
    "html",
    "hours",
    "http",
    "https",
    "inc",
    "information",
    "llc",
    "location",
    "locations",
    "main",
    "org",
    "pdf",
    "per",
    "php",
    "print",
    "number",
    "numbers",
    "office",
    "phone",
    "program",
    "programs",
    "provider",
    "providers",
    "service",
    "services",
    "share",
    "use",
    "visit",
    "website",
    "www",
}

BM25_ALLOWED_ALPHANUMERIC_TERMS = {
    "dd214",
    "lgbtq2",
    "lgbtqia2s",
}

BM25_SPELLED_TOKENS = {
    "caf",
    "cco",
    "dd214",
    "dhs",
    "ebt",
    "fpl",
    "ged",
    "hiv",
    "hud",
    "id",
    "lgbtq",
    "lgbtq2",
    "lgbtqia",
    "lgbtqia2s",
    "nara",
    "nw",
    "ohp",
    "snap",
    "ssdi",
    "ssi",
    "tanf",
    "va",
    "wic",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio-plan", type=Path, default=DEFAULT_AUDIO_PLAN)
    parser.add_argument("--browser-corpus-dir", type=Path, default=DEFAULT_BROWSER_CORPUS_DIR)
    parser.add_argument("--vocab-inventory", type=Path, default=DEFAULT_VOCAB_INVENTORY)
    parser.add_argument("--vocab-manifest", type=Path, default=DEFAULT_VOCAB_MANIFEST)
    parser.add_argument("--bm25-manifest", type=Path, default=DEFAULT_BM25_MANIFEST)
    parser.add_argument("--graphrag-candidates", type=Path, default=DEFAULT_GRAPHRAG_CANDIDATES)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--doc-type", action="append", default=["service"], help="GraphRAG document type(s) to consider.")
    parser.add_argument("--top-bm25-terms", type=int, default=0, help="Maximum BM25 terms to retain. Use 0 for no limit.")
    parser.add_argument("--top-slot-values", type=int, default=240)
    parser.add_argument("--top-entity-names", type=int, default=180)
    parser.add_argument("--top-phones", type=int, default=180)
    parser.add_argument("--top-addresses", type=int, default=180)
    parser.add_argument("--min-bm25-document-frequency", type=int, default=2)
    parser.add_argument("--min-graph-occurrence", type=int, default=2)
    parser.add_argument("--min-slot-observed", type=int, default=2)
    parser.add_argument("--top-report-items", type=int, default=20)
    return parser.parse_args()


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def listify(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if hasattr(value, "tolist"):
        converted = value.tolist()
        if isinstance(converted, list):
            return converted
    return []


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_phone_key(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    ext_match = re.search(r"(?:x|ext\.?)\s*(\d+)", value or "", re.IGNORECASE)
    ext = ext_match.group(1) if ext_match else ""
    return f"{digits}x{ext}" if ext else digits


def spell_bm25_token_for_speech(value: str) -> str:
    compact = re.sub(r"[^A-Za-z0-9]+", "", str(value or ""))
    parts: list[str] = []
    for chunk in re.findall(r"[A-Za-z]+|\d+", compact):
        if chunk.isdigit():
            parts.append(_digits_to_words(chunk))
        else:
            parts.append(" ".join(char.upper() for char in chunk.upper()))
    return " ".join(part for part in parts if part)


def normalize_bm25_spoken_term(raw_value: str) -> str:
    cleaned = normalize_text(raw_value)
    compact = re.sub(r"[^A-Za-z0-9]+", "", cleaned)
    if not compact:
        return cleaned
    if compact.casefold() in BM25_SPELLED_TOKENS:
        return spell_bm25_token_for_speech(compact)
    return cleaned


@functools.lru_cache(maxsize=32768)
def normalized_candidate_value(kind: str, raw_value: str) -> str:
    normalized_kind = str(kind or "").strip().lower()
    cleaned = normalize_text(raw_value)
    if not cleaned:
        return ""
    if normalized_kind == "phone":
        return normalize_phone_key(cleaned)
    if normalized_kind == "address":
        return normalize_text(normalized_query_address_text(cleaned)).casefold()
    if normalized_kind == "bm25_term":
        term = re.sub(r"[^a-z0-9]+", " ", cleaned.lower()).strip()
        return re.sub(r"\s+", " ", term)
    return cleaned.casefold()


@functools.lru_cache(maxsize=32768)
def spoken_candidate_text(kind: str, raw_value: str) -> str:
    normalized_kind = str(kind or "").strip().lower()
    cleaned = normalize_text(raw_value)
    if not cleaned:
        return ""
    if normalized_kind == "bm25_term":
        return " ".join(normalize_indextts_spoken_text(normalize_bm25_spoken_term(cleaned)).split())
    spoken = normalize_slot_value_text(normalized_kind, cleaned)
    return spoken or " ".join(normalize_indextts_spoken_text(cleaned).split())


def is_useful_bm25_term(term: str, *, minimum_document_frequency: int, document_frequency: int) -> bool:
    normalized = normalized_candidate_value("bm25_term", term)
    compact = re.sub(r"[^a-z0-9]+", "", normalized)
    if not normalized:
        return False
    if normalized in STOP_WORDS or normalized in GENERIC_BM25_TERMS or compact in STOP_WORDS or compact in GENERIC_BM25_TERMS:
        return False
    if document_frequency < minimum_document_frequency:
        return False
    if normalized.isdigit():
        return False
    if re.fullmatch(r"\d{1,2}\s*(?:am|pm)", normalized):
        return False
    if re.search(r"\d", compact) and compact not in BM25_ALLOWED_ALPHANUMERIC_TERMS:
        return False
    if len(normalized) < 3:
        return False
    if not re.search(r"[a-z]", normalized):
        return False
    return True


def apply_limit(items: list[dict[str, Any]], limit: int | None) -> list[dict[str, Any]]:
    if limit is None:
        return items
    if int(limit) <= 0:
        return items
    return items[: int(limit)]


def build_bm25_term_candidates(payload: Mapping[str, Any], args: argparse.Namespace) -> list[dict[str, Any]]:
    allowed_doc_types = {str(item or "").strip() for item in args.doc_type if str(item or "").strip()}
    document_frequency = payload.get("documentFrequency") or {}
    aggregates: dict[str, dict[str, Any]] = {}
    for document in payload.get("documents") or []:
        doc_type = str(document.get("doc_type") or "")
        if allowed_doc_types and doc_type not in allowed_doc_types:
            continue
        doc_id = str(document.get("doc_id") or "")
        term_idf = document.get("term_idf") or {}
        for raw_term, raw_tf in (document.get("terms") or {}).items():
            term = normalize_text(raw_term)
            df = int(document_frequency.get(raw_term) or document_frequency.get(term) or 0)
            if not is_useful_bm25_term(term, minimum_document_frequency=args.min_bm25_document_frequency, document_frequency=df):
                continue
            normalized_value = normalized_candidate_value("bm25_term", term)
            spoken_text = spoken_candidate_text("bm25_term", normalized_value)
            if not spoken_text:
                continue
            tf = float(raw_tf or 0.0)
            idf = float(term_idf.get(raw_term) or term_idf.get(term) or 0.0)
            entry = aggregates.setdefault(
                normalized_value,
                {
                    "candidateKind": "bm25_term",
                    "slotKind": "term",
                    "normalizedValue": normalized_value,
                    "spokenText": spoken_text,
                    "rawVariants": set(),
                    "sourceIds": set(),
                    "sourceTypes": {"graphrag.bm25_term"},
                    "observedCount": 0,
                    "bm25DocumentFrequency": df,
                    "matchedDocumentCount": 0,
                    "bm25TotalTermFrequency": 0.0,
                    "bm25TotalScore": 0.0,
                    "priorityScore": 0.0,
                },
            )
            entry["rawVariants"].add(term)
            if doc_id and doc_id not in entry["sourceIds"]:
                entry["sourceIds"].add(doc_id)
                entry["matchedDocumentCount"] += 1
                entry["observedCount"] += 1
            entry["bm25DocumentFrequency"] = max(int(entry["bm25DocumentFrequency"]), df)
            entry["bm25TotalTermFrequency"] += tf
            entry["bm25TotalScore"] += tf * idf
    candidates = []
    for entry in aggregates.values():
        entry["priorityScore"] = float(entry["bm25TotalScore"])
        candidates.append(
            {
                **entry,
                "rawVariants": sorted(entry["rawVariants"]),
                "sourceIds": sorted(entry["sourceIds"]),
                "sourceTypes": sorted(entry["sourceTypes"]),
            }
        )
    candidates.sort(
        key=lambda item: (
            -float(item.get("bm25TotalScore") or 0.0),
            -int(item.get("matchedDocumentCount") or 0),
            -int(item.get("bm25DocumentFrequency") or 0),
            str(item.get("normalizedValue") or ""),
        )
    )
    return apply_limit(candidates, args.top_bm25_terms)


def build_audio_plan_slot_value_candidates(plan: Mapping[str, Any], args: argparse.Namespace) -> list[dict[str, Any]]:
    aggregates: dict[tuple[str, str], dict[str, Any]] = {}
    for family in plan.get("families") or []:
        family_key = stable_id(str(family.get("canonicalTemplate") or json.dumps(family, sort_keys=True, default=str)))
        family_kind = str(family.get("familyKind") or "")
        source_families = {str(item or "").strip() for item in family.get("sourceFamilies") or [] if str(item or "").strip()}
        for slot_kind, values in (family.get("topSlotValues") or {}).items():
            normalized_kind = str(slot_kind or "").strip().lower()
            if not normalized_kind:
                continue
            for raw_value, raw_count in values or []:
                observed_count = int(raw_count or 0)
                if observed_count < args.min_slot_observed:
                    continue
                raw_text = normalize_text(raw_value)
                normalized_value = normalized_candidate_value(normalized_kind, raw_text)
                spoken_text = spoken_candidate_text(normalized_kind, raw_text)
                if not normalized_value or not spoken_text:
                    continue
                key = (normalized_kind, normalized_value)
                entry = aggregates.setdefault(
                    key,
                    {
                        "candidateKind": "audio_plan_slot_value",
                        "slotKind": normalized_kind,
                        "normalizedValue": normalized_value,
                        "spokenText": spoken_text,
                        "rawVariants": set(),
                        "sourceIds": set(),
                        "sourceTypes": {"audio_plan.slot_value"},
                        "sourceFamilies": set(),
                        "familyKinds": Counter(),
                        "observedCount": 0,
                        "priorityScore": 0.0,
                    },
                )
                entry["rawVariants"].add(raw_text)
                entry["sourceIds"].add(f"audio-plan::{normalized_kind}::{family_key}")
                entry["sourceFamilies"].update(source_families)
                if family_kind:
                    entry["familyKinds"][family_kind] += 1
                entry["observedCount"] += observed_count
                entry["priorityScore"] += float(observed_count)
    candidates = []
    for entry in aggregates.values():
        candidates.append(
            {
                **entry,
                "rawVariants": sorted(entry["rawVariants"]),
                "sourceIds": sorted(entry["sourceIds"]),
                "sourceTypes": sorted(entry["sourceTypes"]),
                "sourceFamilies": sorted(entry["sourceFamilies"]),
                "familyKinds": dict(sorted(entry["familyKinds"].items())),
            }
        )
    candidates.sort(
        key=lambda item: (
            -int(item.get("observedCount") or 0),
            str(item.get("slotKind") or ""),
            str(item.get("spokenText") or ""),
        )
    )
    return candidates[: max(0, int(args.top_slot_values or 0))]


def candidate_display_name(document: Mapping[str, Any]) -> list[str]:
    provider = normalize_text(document.get("provider_name"))
    program = normalize_text(document.get("program_name"))
    title = normalize_text(document.get("title"))
    values: list[str] = []
    if provider:
        values.append(provider)
    if program and program.casefold() not in {value.casefold() for value in values}:
        values.append(program)
    if not values and title:
        values.append(title)
    return values


def build_graphrag_prerender_candidates(documents: Iterable[Mapping[str, Any]], args: argparse.Namespace) -> dict[str, list[dict[str, Any]]]:
    allowed_doc_types = {str(item or "").strip() for item in args.doc_type if str(item or "").strip()}

    def make_entry(candidate_kind: str, slot_kind: str, normalized_value: str, spoken_text: str) -> dict[str, Any]:
        return {
            "candidateKind": candidate_kind,
            "slotKind": slot_kind,
            "normalizedValue": normalized_value,
            "spokenText": spoken_text,
            "rawVariants": set(),
            "sourceIds": set(),
            "sourceTypes": {candidate_kind.replace("_", ".")},
            "sourceDocTypes": set(),
            "observedCount": 0,
            "priorityScore": 0.0,
        }

    names: dict[str, dict[str, Any]] = {}
    phones: dict[str, dict[str, Any]] = {}
    addresses: dict[str, dict[str, Any]] = {}

    for document in documents:
        doc_type = str(document.get("doc_type") or "")
        if allowed_doc_types and doc_type not in allowed_doc_types:
            continue
        doc_id = str(document.get("doc_id") or "")

        for raw_name in candidate_display_name(document):
            normalized_value = normalized_candidate_value("entity", raw_name)
            spoken_text = spoken_candidate_text("entity", raw_name)
            if not normalized_value or not spoken_text:
                continue
            entry = names.setdefault(normalized_value, make_entry("graphrag_entity_name", "entity", normalized_value, spoken_text))
            entry["rawVariants"].add(raw_name)
            entry["sourceDocTypes"].add(doc_type)
            if doc_id and doc_id not in entry["sourceIds"]:
                entry["sourceIds"].add(doc_id)
                entry["observedCount"] += 1

        for phone in listify(document.get("phones")):
            if not isinstance(phone, Mapping):
                continue
            raw_phone = normalize_text(phone.get("value") or phone.get("label") or "")
            normalized_value = normalized_candidate_value("phone", raw_phone)
            spoken_text = spoken_candidate_text("phone", raw_phone)
            digits = re.sub(r"\D", "", normalized_value.split("x", 1)[0])
            if len(digits) < 10 or not spoken_text:
                continue
            entry = phones.setdefault(normalized_value, make_entry("graphrag_phone", "phone", normalized_value, spoken_text))
            entry["rawVariants"].add(raw_phone)
            entry["sourceDocTypes"].add(doc_type)
            if doc_id and doc_id not in entry["sourceIds"]:
                entry["sourceIds"].add(doc_id)
                entry["observedCount"] += 1

        for address in listify(document.get("addresses")):
            if not isinstance(address, Mapping):
                continue
            raw_address = normalize_text(address.get("address") or "")
            if not raw_address:
                parts = [
                    normalize_text(address.get("street") or ""),
                    normalize_text(address.get("city") or ""),
                    normalize_text(address.get("state") or ""),
                    normalize_text(address.get("postal_code") or ""),
                ]
                raw_address = normalize_text(" ".join(part for part in parts if part))
            normalized_value = normalized_candidate_value("address", raw_address)
            spoken_text = spoken_candidate_text("address", raw_address)
            if not normalized_value or not spoken_text:
                continue
            entry = addresses.setdefault(normalized_value, make_entry("graphrag_address", "address", normalized_value, spoken_text))
            entry["rawVariants"].add(raw_address)
            entry["sourceDocTypes"].add(doc_type)
            if doc_id and doc_id not in entry["sourceIds"]:
                entry["sourceIds"].add(doc_id)
                entry["observedCount"] += 1

    def finalize(entries: Mapping[str, dict[str, Any]], limit: int) -> list[dict[str, Any]]:
        finalized: list[dict[str, Any]] = []
        for entry in entries.values():
            if int(entry["observedCount"]) < args.min_graph_occurrence:
                continue
            entry["priorityScore"] = float(entry["observedCount"])
            finalized.append(
                {
                    **entry,
                    "rawVariants": sorted(entry["rawVariants"]),
                    "sourceIds": sorted(entry["sourceIds"]),
                    "sourceTypes": sorted(entry["sourceTypes"]),
                    "sourceDocTypes": sorted(entry["sourceDocTypes"]),
                }
            )
        finalized.sort(
            key=lambda item: (
                -int(item.get("observedCount") or 0),
                str(item.get("spokenText") or ""),
            )
        )
        return finalized[: max(0, limit)]

    return {
        "entityNames": finalize(names, args.top_entity_names),
        "phones": finalize(phones, args.top_phones),
        "addresses": finalize(addresses, args.top_addresses),
    }


def merge_candidates(*sections: Iterable[dict[str, Any]]) -> dict[str, Any]:
    merged: dict[str, dict[str, Any]] = {}
    for section in sections:
        for candidate in section:
            spoken_text = normalize_text(candidate.get("spokenText") or "")
            if not spoken_text:
                continue
            key = spoken_text.casefold()
            text_hash = stable_id(spoken_text)
            entry = merged.setdefault(
                key,
                {
                    "id": f"abby-tts-vocab-{text_hash}",
                    "textHash": text_hash,
                    "text": spoken_text,
                    "displayTexts": set(),
                    "originalTexts": set(),
                    "routes": [],
                    "serviceTags": [],
                    "locationTags": [],
                    "sourceTypes": set(),
                    "sourceIds": set(),
                    "sourceFamilies": set(),
                    "slotKinds": set(),
                    "candidateKinds": set(),
                    "sourceDocTypes": set(),
                    "normalizedValues": defaultdict(set),
                    "observedCount": 0,
                    "bm25DocumentFrequency": 0,
                    "bm25MatchedDocumentCount": 0,
                    "bm25TotalScore": 0.0,
                    "priorityScore": 0.0,
                },
            )
            entry["candidateKinds"].add(str(candidate.get("candidateKind") or ""))
            if candidate.get("slotKind"):
                entry["slotKinds"].add(str(candidate.get("slotKind") or ""))
                entry["normalizedValues"][str(candidate.get("slotKind") or "")].add(str(candidate.get("normalizedValue") or ""))
            entry["displayTexts"].update(candidate.get("rawVariants") or [])
            entry["originalTexts"].update(item for item in (candidate.get("rawVariants") or []) if normalize_text(item) != spoken_text)
            entry["sourceTypes"].update(candidate.get("sourceTypes") or [])
            entry["sourceIds"].update(candidate.get("sourceIds") or [])
            entry["sourceFamilies"].update(candidate.get("sourceFamilies") or [])
            entry["sourceDocTypes"].update(candidate.get("sourceDocTypes") or [])
            entry["observedCount"] += int(candidate.get("observedCount") or 0)
            entry["bm25DocumentFrequency"] = max(int(entry["bm25DocumentFrequency"]), int(candidate.get("bm25DocumentFrequency") or 0))
            entry["bm25MatchedDocumentCount"] = max(int(entry["bm25MatchedDocumentCount"]), int(candidate.get("matchedDocumentCount") or 0))
            entry["bm25TotalScore"] += float(candidate.get("bm25TotalScore") or 0.0)
            entry["priorityScore"] += float(candidate.get("priorityScore") or 0.0)

    responses: list[dict[str, Any]] = []
    candidate_kind_counts: Counter[str] = Counter()
    source_type_counts: Counter[str] = Counter()
    for entry in merged.values():
        candidate_kind_counts.update(entry["candidateKinds"])
        source_type_counts.update(entry["sourceTypes"])
        responses.append(
            {
                "id": entry["id"],
                "textHash": entry["textHash"],
                "text": entry["text"],
                "displayTexts": sorted(item for item in entry["displayTexts"] if item),
                "originalTexts": sorted(item for item in entry["originalTexts"] if item),
                "routes": entry["routes"],
                "serviceTags": entry["serviceTags"],
                "locationTags": entry["locationTags"],
                "sourceTypes": sorted(entry["sourceTypes"]),
                "sourceIds": sorted(entry["sourceIds"]),
                "sourceFamilies": sorted(entry["sourceFamilies"]),
                "slotKinds": sorted(entry["slotKinds"]),
                "candidateKinds": sorted(entry["candidateKinds"]),
                "sourceDocTypes": sorted(entry["sourceDocTypes"]),
                "normalizedValues": {
                    key: sorted(value for value in values if value)
                    for key, values in sorted(entry["normalizedValues"].items())
                    if any(value for value in values)
                },
                "observedCount": int(entry["observedCount"]),
                "bm25DocumentFrequency": int(entry["bm25DocumentFrequency"]),
                "bm25MatchedDocumentCount": int(entry["bm25MatchedDocumentCount"]),
                "bm25TotalScore": round(float(entry["bm25TotalScore"]), 4),
                "priorityScore": round(float(entry["priorityScore"]), 4),
            }
        )
    responses.sort(
        key=lambda item: (
            -float(item.get("priorityScore") or 0.0),
            -int(item.get("observedCount") or 0),
            str(item.get("text") or ""),
        )
    )
    for index, response in enumerate(responses, start=1):
        response["priorityRank"] = index

    return {
        "schemaVersion": 1,
        "purpose": "Reusable audio vocabulary and GraphRAG prerender candidates for composable response synthesis.",
        "summary": {
            "responseCount": len(responses),
            "candidateKindCounts": dict(sorted(candidate_kind_counts.items())),
            "sourceTypeCounts": dict(sorted(source_type_counts.items())),
            "topResponses": [
                {
                    "text": item["text"],
                    "priorityScore": item["priorityScore"],
                    "candidateKinds": item["candidateKinds"],
                    "slotKinds": item["slotKinds"],
                }
                for item in responses[:20]
            ],
        },
        "responses": responses,
    }


def build_inventory(
    audio_plan_values: list[dict[str, Any]],
    bm25_terms: list[dict[str, Any]],
    graphrag_candidates: Mapping[str, list[dict[str, Any]]],
    manifest: Mapping[str, Any],
    bm25_manifest: Mapping[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "sources": {
            "audioPlan": str(args.audio_plan),
            "browserCorpusDir": str(args.browser_corpus_dir),
        },
        "summary": {
            "audioPlanValueCount": len(audio_plan_values),
            "bm25TermCount": len(bm25_terms),
            "bm25ManifestCount": len(bm25_manifest.get("responses") or []),
            "graphragEntityNameCount": len(graphrag_candidates.get("entityNames") or []),
            "graphragPhoneCount": len(graphrag_candidates.get("phones") or []),
            "graphragAddressCount": len(graphrag_candidates.get("addresses") or []),
            "combinedManifestCount": len(manifest.get("responses") or []),
        },
        "audioPlanValues": audio_plan_values,
        "bm25Terms": bm25_terms,
        "graphRagCandidates": dict(graphrag_candidates),
    }


def build_report(
    inventory: Mapping[str, Any],
    manifest: Mapping[str, Any],
    args: argparse.Namespace,
) -> str:
    summary = inventory.get("summary") or {}
    lines = [
        "# Pregenerated Text Audio Vocabulary",
        "",
        f"Audio plan input: {args.audio_plan.relative_to(REPO_ROOT)}",
        f"Browser corpus input: {args.browser_corpus_dir.relative_to(REPO_ROOT)}",
        f"Vocabulary inventory: {args.vocab_inventory.relative_to(REPO_ROOT)}",
        f"Vocabulary manifest: {args.vocab_manifest.relative_to(REPO_ROOT)}",
        f"BM25-only manifest: {args.bm25_manifest.relative_to(REPO_ROOT)}",
        f"GraphRAG candidates: {args.graphrag_candidates.relative_to(REPO_ROOT)}",
        "",
        "## Summary",
        "",
        f"- Audio-plan normalized values considered: {summary.get('audioPlanValueCount', 0)}",
        f"- BM25 reuse terms retained: {summary.get('bm25TermCount', 0)}",
        f"- BM25-only precompute entries: {summary.get('bm25ManifestCount', 0)}",
        f"- GraphRAG entity-name candidates retained: {summary.get('graphragEntityNameCount', 0)}",
        f"- GraphRAG phone candidates retained: {summary.get('graphragPhoneCount', 0)}",
        f"- GraphRAG address candidates retained: {summary.get('graphragAddressCount', 0)}",
        f"- Combined precompute-ready vocabulary entries: {summary.get('combinedManifestCount', 0)}",
        "",
        "## Top Combined Candidates",
        "",
    ]
    for item in (manifest.get("responses") or [])[: args.top_report_items]:
        lines.append(
            f"- {item.get('text')}: priority={item.get('priorityScore')}, candidate_kinds={', '.join(item.get('candidateKinds') or []) or 'none'}, slot_kinds={', '.join(item.get('slotKinds') or []) or 'none'}"
        )
    lines.extend(["", "## Top BM25 Terms", ""])
    for item in (inventory.get("bm25Terms") or [])[: args.top_report_items]:
        lines.append(
            f"- {item.get('spokenText')}: bm25_score={round(float(item.get('bm25TotalScore') or 0.0), 3)}, matched_docs={item.get('matchedDocumentCount')}, df={item.get('bm25DocumentFrequency')}"
        )
    lines.extend(["", "## Top GraphRAG Entity Names", ""])
    for item in (inventory.get("graphRagCandidates") or {}).get("entityNames") or []:
        if len(lines) >= 1000:
            break
        lines.append(f"- {item.get('spokenText')}: observed_in_docs={item.get('observedCount')}")
        if len(lines) >= 21 + args.top_report_items:
            break
    lines.extend(["", "## Top GraphRAG Phones", ""])
    for item in ((inventory.get("graphRagCandidates") or {}).get("phones") or [])[: args.top_report_items]:
        lines.append(f"- {item.get('spokenText')}: observed_in_docs={item.get('observedCount')}")
    lines.extend(["", "## Top GraphRAG Addresses", ""])
    for item in ((inventory.get("graphRagCandidates") or {}).get("addresses") or [])[: args.top_report_items]:
        lines.append(f"- {item.get('spokenText')}: observed_in_docs={item.get('observedCount')}")
    return "\n".join(lines) + "\n"


def build_outputs(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    audio_plan = load_json(args.audio_plan)
    generated_dir = args.browser_corpus_dir / "generated"
    bm25_payload = load_json(generated_dir / "bm25-documents.json")
    documents_frame = pd.read_parquet(generated_dir / "documents.parquet").fillna("")
    allowed_doc_types = {str(item or "").strip() for item in args.doc_type if str(item or "").strip()}
    if allowed_doc_types and "doc_type" in documents_frame.columns:
        documents_frame = documents_frame[documents_frame["doc_type"].astype(str).isin(sorted(allowed_doc_types))]
    documents = documents_frame.to_dict(orient="records")

    audio_plan_values = build_audio_plan_slot_value_candidates(audio_plan, args)
    bm25_terms = build_bm25_term_candidates(bm25_payload, args)
    graphrag_candidates = build_graphrag_prerender_candidates(documents, args)
    manifest = merge_candidates(
        audio_plan_values,
        bm25_terms,
        graphrag_candidates.get("entityNames") or [],
        graphrag_candidates.get("phones") or [],
        graphrag_candidates.get("addresses") or [],
    )
    bm25_manifest = {
        "schemaVersion": 1,
        "purpose": "BM25-only reusable audio vocabulary for batched IndexTTS precompute.",
        "summary": {
            "responseCount": 0,
            "sourceTypeCounts": {"graphrag.bm25_term": 0},
            "candidateKindCounts": {"bm25_term": 0},
            "topResponses": [],
        },
        "responses": [],
    }
    bm25_responses = [
        response
        for response in (manifest.get("responses") or [])
        if "graphrag.bm25_term" in set(response.get("sourceTypes") or [])
    ]
    for index, response in enumerate(bm25_responses, start=1):
        bm25_manifest["responses"].append({**response, "priorityRank": index})
    bm25_manifest["summary"] = {
        "responseCount": len(bm25_manifest["responses"]),
        "sourceTypeCounts": {"graphrag.bm25_term": len(bm25_manifest["responses"])},
        "candidateKindCounts": {"bm25_term": len(bm25_manifest["responses"])},
        "topResponses": [
            {
                "text": item["text"],
                "priorityScore": item["priorityScore"],
                "candidateKinds": item["candidateKinds"],
                "slotKinds": item["slotKinds"],
            }
            for item in bm25_manifest["responses"][:20]
        ],
    }
    inventory = build_inventory(audio_plan_values, bm25_terms, graphrag_candidates, manifest, bm25_manifest, args)
    graphrag_inventory = {
        "schemaVersion": 1,
        "sourceBrowserCorpusDir": str(args.browser_corpus_dir),
        "summary": {
            "entityNameCount": len(graphrag_candidates.get("entityNames") or []),
            "phoneCount": len(graphrag_candidates.get("phones") or []),
            "addressCount": len(graphrag_candidates.get("addresses") or []),
        },
        **graphrag_candidates,
    }
    return inventory, manifest, bm25_manifest, graphrag_inventory


def main() -> None:
    args = parse_args()
    inventory, manifest, bm25_manifest, graphrag_inventory = build_outputs(args)

    args.vocab_inventory.parent.mkdir(parents=True, exist_ok=True)
    args.vocab_inventory.write_text(json.dumps(inventory, indent=2), encoding="utf-8")
    args.vocab_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.vocab_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    args.bm25_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.bm25_manifest.write_text(json.dumps(bm25_manifest, indent=2), encoding="utf-8")
    args.graphrag_candidates.parent.mkdir(parents=True, exist_ok=True)
    args.graphrag_candidates.write_text(json.dumps(graphrag_inventory, indent=2), encoding="utf-8")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(build_report(inventory, manifest, args), encoding="utf-8")

    print(
        json.dumps(
            {
                "vocabInventory": str(args.vocab_inventory),
                "vocabManifest": str(args.vocab_manifest),
                "bm25Manifest": str(args.bm25_manifest),
                "graphragCandidates": str(args.graphrag_candidates),
                "report": str(args.report),
                "summary": {
                    "audioPlanValueCount": inventory.get("summary", {}).get("audioPlanValueCount", 0),
                    "bm25TermCount": inventory.get("summary", {}).get("bm25TermCount", 0),
                    "bm25ManifestCount": inventory.get("summary", {}).get("bm25ManifestCount", 0),
                    "graphRagEntityNameCount": inventory.get("summary", {}).get("graphragEntityNameCount", 0),
                    "graphRagPhoneCount": inventory.get("summary", {}).get("graphragPhoneCount", 0),
                    "graphRagAddressCount": inventory.get("summary", {}).get("graphragAddressCount", 0),
                    "combinedManifestCount": inventory.get("summary", {}).get("combinedManifestCount", 0),
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()