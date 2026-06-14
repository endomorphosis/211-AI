#!/usr/bin/env python3
"""Deduplicate Abby voice responses and reusable sentence chunks.

This is an analysis/precompute helper for deciding what should be rendered by
TTS. It deduplicates whole responses, splits responses into sentence-like
chunks, deduplicates those chunks, and then builds a second template view where
likely named entities and variable values are masked into reusable slots.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.precompute_indextts_responses import (  # noqa: E402
    DEFAULT_DAG,
    DEFAULT_RESULTS,
    load_audio_responses,
    load_audio_responses_from_manifest,
    normalize_indextts_spoken_text,
    stable_id,
)

DEFAULT_OUTPUT = REPO_ROOT / "docs" / "phone_dialog_generation" / "voice_response_chunk_dedupe.json"

SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=(?:[\"'(\[])?[A-Z0-9])")
TOKEN_PATTERN = re.compile(r"[A-Za-z][A-Za-z'.-]*|\d+(?:[-\s]\d+)*")
PHONEISH_PATTERN = re.compile(
    r"\b(?:zero|one|two|three|four|five|six|seven|eight|nine|\d)"
    r"(?:[\s,.-]+(?:zero|one|two|three|four|five|six|seven|eight|nine|\d)){6,}\b",
    re.IGNORECASE,
)
ZIP_WORD_PATTERN = re.compile(
    r"\bZIP code (?:zero|one|two|three|four|five|six|seven|eight|nine)"
    r"(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){4}(?: dash (?:zero|one|two|three|four|five|six|seven|eight|nine)(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){3})?\b",
    re.IGNORECASE,
)
NUMBER_PATTERN = re.compile(r"\b\d{2,}\b")
TITLE_TOKEN = re.compile(r"^(?:[A-Z][A-Za-z'.-]*|[A-Z]{2,}|[A-Z][A-Z0-9&.-]+)$")

ENTITY_STOPWORDS = {
    "A",
    "Again",
    "Also",
    "And",
    "Another",
    "Are",
    "Backup",
    "Before",
    "Call",
    "Do",
    "First",
    "For",
    "Good",
    "Hi",
    "I",
    "If",
    "In",
    "It",
    "Let",
    "Main",
    "Most",
    "Next",
    "No",
    "Okay",
    "One",
    "Please",
    "Say",
    "Short",
    "Slowly",
    "So",
    "That",
    "The",
    "They",
    "This",
    "What",
    "When",
    "Yes",
    "You",
}

LOCATION_WORDS = {
    "Albany",
    "Beaverton",
    "Bend",
    "Clackamas",
    "Eugene",
    "Gresham",
    "Hillsboro",
    "Medford",
    "Multnomah",
    "Oregon",
    "Portland",
    "Salem",
    "Washington",
}

ADDRESS_HINT_WORDS = {
    "Alley",
    "Avenue",
    "Boulevard",
    "Circle",
    "Court",
    "Drive",
    "Highway",
    "Lane",
    "Loop",
    "North",
    "Parkway",
    "Place",
    "Road",
    "South",
    "Street",
    "Terrace",
    "Trail",
    "Way",
}

ENTITY_CUE_PATTERN = re.compile(
    r"\b(?:call|contact|ask for|choose|open|try|reach|text|email|visit|go to|"
    r"the(?: best| closest| nearest)?(?: match| option| program| provider| agency| clinic| shelter| pantry)? is|"
    r"i found|i have|a(?: likely| grounded)? match is|another option is|backup option is)"
    r"\s+(?P<entity>[A-Z][A-Za-z0-9&'.-]*(?:\s+(?:of|for|and|the|[A-Z][A-Za-z0-9&'.-]*)){0,8})",
    re.IGNORECASE,
)
TITLECASE_SEQUENCE_PATTERN = re.compile(
    r"\b[A-Z][A-Za-z0-9&'.-]*(?:\s+(?:of|for|and|the|[A-Z][A-Za-z0-9&'.-]*)){1,8}\b"
)
ACRONYM_PATTERN = re.compile(r"\b[A-Z]{2,}(?:[- ][A-Z0-9]{2,})*\b")
LOCATION_PHRASE_PATTERN = re.compile(r"\b(?:" + "|".join(sorted(map(re.escape, LOCATION_WORDS), key=len, reverse=True)) + r")\b")

NER_ENTITY_STOP_PHRASES = {
    "Call",
    "Call Two",
    "Call Nine",
    "I",
    "I Found",
    "The",
    "You",
}


def looks_like_slot_candidate(phrase: str) -> bool:
    cleaned = compact_entity_phrase(phrase)
    if not cleaned or cleaned in NER_ENTITY_STOP_PHRASES:
        return False
    lowered = cleaned.lower()
    if lowered in {"two one one", "nine one one", "call two one one", "call nine one one"}:
        return False
    if cleaned in ENTITY_STOPWORDS:
        return False
    if any(token in LOCATION_WORDS for token in cleaned.split()):
        return True
    if any(token in ADDRESS_HINT_WORDS for token in cleaned.split()):
        return True
    if ACRONYM_PATTERN.fullmatch(cleaned):
        return True
    tokens = [token for token in cleaned.split() if token.lower() not in {"of", "for", "and", "the"}]
    if len(tokens) >= 2 and any(TITLE_TOKEN.match(token) for token in tokens):
        return True
    if len(tokens) == 1:
        token = tokens[0]
        return bool(token.isupper() or re.search(r"[a-z][A-Z]", token))
    return False


def compact_entity_phrase(phrase: str) -> str:
    cleaned = re.sub(r"\s+", " ", str(phrase or "")).strip(" .,;:!?()[]{}\"'")
    cleaned = re.split(r"[.;!?]", cleaned, maxsplit=1)[0].strip(" .,;:!?()[]{}\"'")
    cleaned = re.sub(
        r"^(?:call|contact|ask for|choose|open|try|reach|text|email|visit|go to)\s+",
        "",
        cleaned,
        flags=re.IGNORECASE,
    ).strip()
    cleaned = re.sub(r"\b(?:now|today|first|instead|please|right away)$", "", cleaned, flags=re.IGNORECASE).strip()
    cleaned = re.sub(
        r"\s+\b(?:and|or|but|with|near|in|at|by|because|if|when|then|before|after|for|about|so)\b.*$",
        "",
        cleaned,
    ).strip(" .,;:!?()[]{}\"'")
    return cleaned


def collect_ner_phrase_counts(chunks: Iterable[str]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for chunk in chunks:
        for phrase, _kind in detect_named_entity_phrases(chunk, Counter()):
            counts[phrase] += 1
    return counts


def detect_named_entity_phrases(text: str, phrase_counts: Counter[str]) -> list[tuple[str, str]]:
    """Return lightweight NER-style phrase candidates and slot kinds.

    This intentionally avoids heavyweight model downloads. It recognizes the
    shapes most common in generated 211 phone responses: provider/program names,
    locations, acronyms, and address fragments.
    """

    found: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(raw: str, kind: str | None = None) -> None:
        phrase = compact_entity_phrase(raw)
        if not looks_like_slot_candidate(phrase):
            return
        resolved = kind or classify_phrase(phrase, phrase_counts)
        if not resolved:
            resolved = "entity"
        key = phrase.lower()
        if key in seen:
            return
        seen.add(key)
        found.append((phrase, resolved))

    for match in LOCATION_PHRASE_PATTERN.finditer(text):
        add(match.group(0), "location")
    for match in ENTITY_CUE_PATTERN.finditer(text):
        add(match.group("entity"))
    for match in TITLECASE_SEQUENCE_PATTERN.finditer(text):
        add(match.group(0))
    for match in ACRONYM_PATTERN.finditer(text):
        add(match.group(0), "entity")

    return sorted(found, key=lambda item: (-len(item[0]), item[0].lower()))


def split_sentence_chunks(text: str, *, max_chars: int = 220) -> list[str]:
    normalized = " ".join(str(text or "").split())
    if not normalized:
        return []
    raw_parts = [part.strip() for part in SENTENCE_BOUNDARY.split(normalized) if part.strip()]
    chunks: list[str] = []
    for part in raw_parts:
        if len(part) <= max_chars:
            chunks.append(part)
            continue
        chunks.extend(split_long_sentence(part, max_chars=max_chars))
    return chunks


def split_long_sentence(sentence: str, *, max_chars: int) -> list[str]:
    pieces = [piece.strip() for piece in re.split(r"(?<=,)\s+|\s+(?=(?:Another number|Backup number|If |Say:|Tell them:))", sentence) if piece.strip()]
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current} {piece}".strip()
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = piece
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def collect_phrase_counts(chunks: Iterable[str]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for chunk in chunks:
        for phrase in candidate_entity_phrases(chunk):
            counts[phrase] += 1
    return counts


def candidate_entity_phrases(text: str) -> list[str]:
    tokens = list(TOKEN_PATTERN.finditer(text))
    phrases: list[str] = []
    current: list[str] = []
    for token_match in tokens:
        token = token_match.group(0)
        if is_entity_token(token):
            current.append(token)
            continue
        if current:
            add_entity_phrase(phrases, current)
            current = []
    if current:
        add_entity_phrase(phrases, current)
    return phrases


def is_entity_token(token: str) -> bool:
    bare = token.strip(".,;:!?()[]{}\"'")
    if not bare or bare in ENTITY_STOPWORDS:
        return False
    if bare in LOCATION_WORDS or bare in ADDRESS_HINT_WORDS:
        return True
    if TITLE_TOKEN.match(bare) and bare.lower() not in {"the", "and", "or"}:
        return True
    return False


def add_entity_phrase(phrases: list[str], tokens: list[str]) -> None:
    cleaned = [token.strip(".,;:!?()[]{}\"'") for token in tokens if token.strip(".,;:!?()[]{}\"'")]
    cleaned = [token for token in cleaned if token not in ENTITY_STOPWORDS]
    if not cleaned:
        return
    if (
        len(cleaned) == 1
        and cleaned[0] not in LOCATION_WORDS
        and not cleaned[0].isupper()
        and not re.search(r"[a-z][A-Z]", cleaned[0])
    ):
        return
    phrase = " ".join(cleaned)
    if len(phrase) >= 3:
        phrases.append(phrase)


def mask_chunk(text: str, phrase_counts: Counter[str]) -> dict[str, Any]:
    slots: list[dict[str, str]] = []
    masked = str(text or "")

    def slot(kind: str, value: str) -> str:
        index = len(slots) + 1
        name = f"{kind}_{index}"
        slots.append({"slot": name, "kind": kind, "value": value})
        return "{" + name + "}"

    def replace_zip(match: re.Match[str]) -> str:
        return slot("zip", match.group(0))

    def replace_phone(match: re.Match[str]) -> str:
        return slot("phone", match.group(0))

    masked = ZIP_WORD_PATTERN.sub(replace_zip, masked)
    masked = PHONEISH_PATTERN.sub(replace_phone, masked)
    masked = NUMBER_PATTERN.sub(lambda match: slot("number", match.group(0)), masked)

    for phrase, kind in detect_named_entity_phrases(masked, phrase_counts):
        pattern = re.compile(rf"(?<![\w{{]){re.escape(phrase)}(?![\w}}])")
        masked = pattern.sub(lambda match, k=kind: slot(k, match.group(0)), masked)

    phrases = sorted(candidate_entity_phrases(masked), key=lambda value: (-len(value), value.lower()))
    seen: set[str] = set()
    for phrase in phrases:
        if phrase in seen:
            continue
        seen.add(phrase)
        kind = classify_phrase(phrase, phrase_counts)
        if not kind:
            continue
        pattern = re.compile(rf"(?<![\w{{]){re.escape(phrase)}(?![\w}}])")
        masked = pattern.sub(lambda match, k=kind: slot(k, match.group(0)), masked)
    masked = re.sub(r"\s+", " ", masked).strip()
    return {"maskedText": masked, "maskedHash": stable_id(masked), "slots": slots}


def classify_phrase(phrase: str, phrase_counts: Counter[str]) -> str:
    tokens = phrase.split()
    if any(token in ADDRESS_HINT_WORDS for token in tokens):
        return "address_part"
    if any(token in LOCATION_WORDS for token in tokens):
        return "location"
    if len(tokens) >= 2:
        return "entity"
    if phrase.isupper() and len(phrase) >= 2:
        return "entity"
    if re.search(r"[a-z][A-Z]", phrase):
        return "entity"
    if phrase_counts.get(phrase, 0) >= 2 and phrase not in ENTITY_STOPWORDS:
        return "entity"
    return ""


def load_response_items(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.response_manifest is not None:
        responses = load_audio_responses_from_manifest(args.response_manifest)
        if args.voice_responses_only:
            return [item for item in responses if "dag.voiceResponse" in set(item.get("sourceTypes") or [])]
        if args.assistant_responses_only:
            return [item for item in responses if "simulation.assistant" in set(item.get("sourceTypes") or [])]
        return responses
    return load_audio_responses(
        args.dag,
        args.results,
        include_assistant=not args.voice_responses_only,
        include_voice=not args.assistant_responses_only,
    )


def build_analysis(args: argparse.Namespace) -> dict[str, Any]:
    responses = load_response_items(args)
    response_by_id = {item["id"]: item for item in responses}
    chunk_sources: dict[str, dict[str, Any]] = {}
    response_chunk_refs: dict[str, list[str]] = {}

    for response in responses:
        chunks = split_sentence_chunks(response["text"], max_chars=args.max_chunk_chars)
        refs: list[str] = []
        for index, chunk in enumerate(chunks, start=1):
            chunk_hash = stable_id(chunk)
            chunk_id = f"abby-tts-chunk-{chunk_hash}"
            refs.append(chunk_id)
            item = chunk_sources.setdefault(
                chunk,
                {
                    "id": chunk_id,
                    "chunkHash": chunk_hash,
                    "text": chunk,
                    "sourceResponseIds": [],
                    "routes": set(),
                    "serviceTags": set(),
                    "locationTags": set(),
                    "positions": [],
                },
            )
            if response["id"] not in item["sourceResponseIds"]:
                item["sourceResponseIds"].append(response["id"])
            item["routes"].update(response.get("routes", []))
            item["serviceTags"].update(response.get("serviceTags", []))
            item["locationTags"].update(response.get("locationTags", []))
            item["positions"].append({"responseId": response["id"], "chunkIndex": index})
        response_chunk_refs[response["id"]] = refs

    phrase_counts = collect_phrase_counts(chunk_sources)
    ner_phrase_counts = collect_ner_phrase_counts(chunk_sources)
    combined_phrase_counts = phrase_counts + ner_phrase_counts
    template_sources: dict[str, dict[str, Any]] = {}
    chunks: list[dict[str, Any]] = []
    for item in chunk_sources.values():
        masked = mask_chunk(item["text"], combined_phrase_counts)
        chunk_payload = {
            **item,
            "routes": sorted(item["routes"]),
            "serviceTags": sorted(item["serviceTags"]),
            "locationTags": sorted(item["locationTags"]),
            "maskedText": masked["maskedText"],
            "maskedHash": masked["maskedHash"],
            "slots": masked["slots"],
        }
        chunks.append(chunk_payload)
        template = template_sources.setdefault(
            masked["maskedText"],
            {
                "id": f"abby-tts-template-{masked['maskedHash']}",
                "maskedHash": masked["maskedHash"],
                "maskedText": masked["maskedText"],
                "chunkIds": [],
                "slotKinds": Counter(),
                "slotValues": defaultdict(Counter),
            },
        )
        template["chunkIds"].append(item["id"])
        for slot in masked["slots"]:
            template["slotKinds"][slot["kind"]] += 1
            template["slotValues"][slot["kind"]][slot["value"]] += 1

    chunks.sort(key=lambda item: (-len(item["sourceResponseIds"]), item["id"]))
    templates = []
    for item in template_sources.values():
        templates.append(
            {
                "id": item["id"],
                "maskedHash": item["maskedHash"],
                "maskedText": item["maskedText"],
                "chunkIds": sorted(item["chunkIds"]),
                "reuseCount": len(item["chunkIds"]),
                "slotKinds": dict(sorted(item["slotKinds"].items())),
                "topSlotValues": {
                    kind: values.most_common(args.top_slot_values)
                    for kind, values in sorted(item["slotValues"].items())
                },
            }
        )
    templates.sort(key=lambda item: (-item["reuseCount"], item["id"]))

    reusable_chunks = sum(1 for item in chunks if len(item["sourceResponseIds"]) > 1)
    reusable_templates = sum(1 for item in templates if item["reuseCount"] > 1)
    full_response_source_count = sum(len(item.get("sourceIds", [])) for item in responses)
    chunk_source_count = sum(len(item["positions"]) for item in chunks)

    response_payload = []
    for response in responses:
        response_payload.append(
            {
                **response,
                "chunkIds": response_chunk_refs.get(response["id"], []),
                "chunkCount": len(response_chunk_refs.get(response["id"], [])),
            }
        )

    return {
        "schemaVersion": 1,
        "inputs": {
            "dag": "" if args.response_manifest is not None else str(args.dag),
            "results": "" if args.response_manifest is not None else str(args.results),
            "responseManifest": str(args.response_manifest) if args.response_manifest is not None else "",
            "includeAssistantResponses": not args.voice_responses_only,
            "includeVoiceResponses": not args.assistant_responses_only,
            "maxChunkChars": args.max_chunk_chars,
            "namedEntityRecognition": "local-cue-titlecase-acronym-location",
        },
        "summary": {
            "uniqueFullResponses": len(responses),
            "fullResponseSourceRefs": full_response_source_count,
            "uniqueSentenceChunks": len(chunks),
            "sentenceChunkSourceRefs": chunk_source_count,
            "reusableSentenceChunks": reusable_chunks,
            "uniqueMaskedTemplates": len(templates),
            "reusableMaskedTemplates": reusable_templates,
            "estimatedChunkReuseRatio": round(1 - (len(chunks) / max(chunk_source_count, 1)), 4),
            "estimatedMaskedTemplateReuseRatio": round(1 - (len(templates) / max(len(chunks), 1)), 4),
        },
        "topRepeatedChunks": [
            {
                "id": item["id"],
                "text": item["text"],
                "reuseCount": len(item["sourceResponseIds"]),
                "routes": item["routes"],
            }
            for item in chunks[: args.top]
            if len(item["sourceResponseIds"]) > 1
        ],
        "topMaskedTemplates": templates[: args.top],
        "properNounPhraseCounts": phrase_counts.most_common(args.top),
        "namedEntityPhraseCounts": ner_phrase_counts.most_common(args.top),
        "responses": response_payload if args.include_details else [],
        "chunks": chunks if args.include_details else [],
        "maskedTemplates": templates if args.include_details else [],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dag", type=Path, default=DEFAULT_DAG)
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--response-manifest", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--max-chunk-chars", type=int, default=220)
    parser.add_argument("--top", type=int, default=40)
    parser.add_argument("--top-slot-values", type=int, default=8)
    parser.add_argument("--assistant-responses-only", action="store_true")
    parser.add_argument("--voice-responses-only", action="store_true")
    parser.add_argument("--include-details", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.assistant_responses_only and args.voice_responses_only:
        raise SystemExit("Choose at most one of --assistant-responses-only or --voice-responses-only")
    analysis = build_analysis(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(analysis, indent=2), encoding="utf-8")
    summary = analysis["summary"]
    print(json.dumps({"output": str(args.output), "summary": summary}, indent=2))


if __name__ == "__main__":
    main()
