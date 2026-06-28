#!/usr/bin/env python3
"""Precompute Abby IndexTTS audio for conversation DAG voice responses."""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import difflib
import hashlib
import importlib.util
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib import parse as urllib_parse
from urllib import request as urllib_request

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ipfs_accelerate_py.hf_space_inference import HFSpaceClient

IPFS_DATASETS_SECRETS_MODULE = REPO_ROOT / "ipfs_datasets_py" / "ipfs_datasets_py" / "utils" / "secrets.py"
DEFAULT_DAG = REPO_ROOT / "docs/211_conversation_dag.json"
DEFAULT_RESULTS = REPO_ROOT / "docs/211_chatbot_simulation_results.json"
DEFAULT_REFERENCE = REPO_ROOT / "tmp_assets/abby-reference.wav"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "wallet_interface/ui/public/assets/audio/precomputed/211-dag-indextts"
DEFAULT_MANIFEST = REPO_ROOT / "docs/211_indextts_precompute_manifest.json"
DEFAULT_PUBLIC_MANIFEST = DEFAULT_OUTPUT_DIR / "manifest.json"
DEFAULT_SLOTTED_RESPONSE_INDEX = REPO_ROOT / "wallet_interface/ui/public/assets/rag/slotted-response-index.json"
SLOTTED_RESPONSE_FIELDS = (
    "slottedIntentIds",
    "slottedCanonicalQueryTemplates",
    "slottedResponseFrameIds",
    "slottedResponseSignatures",
    "slottedEdgeIds",
)


class IndexTTSQuotaExceededError(RuntimeError):
    def __init__(self, message: str, *, retry_after: str = "") -> None:
        super().__init__(message)
        self.retry_after = retry_after


def indextts_retry_after_hint(value: Any) -> str:
    match = re.search(r"Try again in (?P<retry>\d{1,2}:\d{2}:\d{2})", str(value or ""), flags=re.IGNORECASE)
    return match.group("retry") if match else ""


def is_indextts_quota_exceeded_error(value: Any) -> bool:
    text = str(value or "")
    lowered = text.casefold()
    return (
        "zerogpu quota exceeded" in lowered
        or ("zerogpu quota" in lowered and "exceed" in lowered)
        or ("quota exceeded" in lowered and "try again in" in lowered)
    )


def raise_if_indextts_quota_exceeded(value: Any) -> None:
    if not is_indextts_quota_exceeded_error(value):
        return
    retry_after = indextts_retry_after_hint(value)
    message = str(value or "IndexTTS ZeroGPU quota exceeded")
    raise IndexTTSQuotaExceededError(message, retry_after=retry_after)


def is_indextts_transient_worker_error(value: Any) -> bool:
    text = str(value or "")
    lowered = text.casefold()
    return any(
        marker in lowered
        for marker in (
            "zerogpu worker error",
            "acceleratorerror",
            "queue full",
            "queue_full",
            "temporarily unavailable",
            "service unavailable",
            "bad gateway",
            "gateway timeout",
            "timed out",
            "connection reset",
            "remote disconnected",
        )
    )


def batch_failure_result(
    error: Exception,
    *,
    batch_mode: str,
    fallback_reason: str,
    requested_batch_size: int,
    executed_batch_size: int,
    split_depth: int,
) -> dict[str, Any]:
    retry_after = indextts_retry_after_hint(error)
    return {
        "error": f"{type(error).__name__}: {error}",
        "retriable": is_indextts_transient_worker_error(error) or bool(retry_after),
        **({"retryAfter": retry_after} if retry_after else {}),
        "batchMode": batch_mode,
        "batchFallbackReason": fallback_reason,
        "batchRequestedSize": requested_batch_size,
        "batchExecutedSize": executed_batch_size,
        "batchSplitDepth": split_depth,
    }


def stable_id(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]


_ADDRESS_DIRECTION_WORDS = {
    "n": "North",
    "s": "South",
    "e": "East",
    "w": "West",
    "ne": "North East",
    "nw": "North West",
    "se": "South East",
    "sw": "South West",
}

_STREET_SUFFIX_WORDS = {
    "aly": "Alley",
    "allee": "Alley",
    "aly.": "Alley",
    "ave": "Avenue",
    "ave.": "Avenue",
    "aven": "Avenue",
    "avenu": "Avenue",
    "avenue": "Avenue",
    "blvd": "Boulevard",
    "blvd.": "Boulevard",
    "boul": "Boulevard",
    "boulevard": "Boulevard",
    "cir": "Circle",
    "cir.": "Circle",
    "circle": "Circle",
    "ct": "Court",
    "ct.": "Court",
    "court": "Court",
    "dr": "Drive",
    "dr.": "Drive",
    "drive": "Drive",
    "hwy": "Highway",
    "hwy.": "Highway",
    "highway": "Highway",
    "ln": "Lane",
    "ln.": "Lane",
    "lane": "Lane",
    "loop": "Loop",
    "pkwy": "Parkway",
    "pkwy.": "Parkway",
    "parkway": "Parkway",
    "pl": "Place",
    "pl.": "Place",
    "place": "Place",
    "rd": "Road",
    "rd.": "Road",
    "road": "Road",
    "st": "Street",
    "st.": "Street",
    "street": "Street",
    "ter": "Terrace",
    "ter.": "Terrace",
    "terrace": "Terrace",
    "trl": "Trail",
    "trl.": "Trail",
    "trail": "Trail",
    "way": "Way",
}

_UNIT_WORDS = {
    "apt": "Apartment",
    "apt.": "Apartment",
    "bldg": "Building",
    "bldg.": "Building",
    "fl": "Floor",
    "fl.": "Floor",
    "ste": "Suite",
    "ste.": "Suite",
    "suite": "Suite",
    "unit": "Unit",
}

_STATE_WORDS = {
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "DC": "District of Columbia",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
}

_OMITTED_VOICE_FIELDS = (
    "source",
    "source url",
    "url",
    "website",
    "link",
    "cid",
    "ipfs cid",
    "hash",
    "bundle hash",
    "record id",
    "schema",
    "metadata",
)

_RESOLVE_SECRET = None


def _number_to_words(value: int) -> str:
    if value < 0 or value > 9999:
        return str(value)
    ones = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ]
    tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
    if value < 20:
        return ones[value]
    if value < 100:
        return tens[value // 10] if value % 10 == 0 else f"{tens[value // 10]} {ones[value % 10]}"
    if value < 1000:
        rest = value % 100
        return f"{ones[value // 100]} hundred" + (f" {_number_to_words(rest)}" if rest else "")
    rest = value % 1000
    return f"{_number_to_words(value // 1000)} thousand" + (f" {_number_to_words(rest)}" if rest else "")


def _ordinal_to_words(value: int) -> str:
    if value <= 0:
        return "zero"
    irregular = {
        1: "first",
        2: "second",
        3: "third",
        4: "fourth",
        5: "fifth",
        6: "sixth",
        7: "seventh",
        8: "eighth",
        9: "ninth",
        10: "tenth",
        11: "eleventh",
        12: "twelfth",
        13: "thirteenth",
        14: "fourteenth",
        15: "fifteenth",
        16: "sixteenth",
        17: "seventeenth",
        18: "eighteenth",
        19: "nineteenth",
    }
    tens_ordinals = {
        20: "twentieth",
        30: "thirtieth",
        40: "fortieth",
        50: "fiftieth",
        60: "sixtieth",
        70: "seventieth",
        80: "eightieth",
        90: "ninetieth",
    }
    if value in irregular:
        return irregular[value]
    if value in tens_ordinals:
        return tens_ordinals[value]
    if value < 100:
        return f"{_number_to_words(value - value % 10)} {_ordinal_to_words(value % 10)}"
    if value < 10000:
        base = _number_to_words(value - value % 100)
        rest = value % 100
        return f"{base} {_ordinal_to_words(rest)}" if rest else f"{base}th"
    return str(value)


def _normalize_direction_token(token: str) -> str:
    compact = re.sub(r"[^A-Za-z]", "", token).lower()
    return _ADDRESS_DIRECTION_WORDS.get(compact, token)


def _normalize_suffix_token(token: str) -> str:
    return _STREET_SUFFIX_WORDS.get(token.lower(), token)


def _digits_to_words(value: str) -> str:
    digit_words = {
        "0": "zero",
        "1": "one",
        "2": "two",
        "3": "three",
        "4": "four",
        "5": "five",
        "6": "six",
        "7": "seven",
        "8": "eight",
        "9": "nine",
    }
    return " ".join(digit_words.get(char, char) for char in value)


def _normalize_zip_codes(text: str) -> str:
    def replace_state_zip(match: re.Match[str]) -> str:
        if match.group("state") != match.group("state").upper():
            return match.group(0)
        state = _STATE_WORDS.get(match.group("state").upper(), match.group("state"))
        zip_code = _digits_to_words(match.group("zip"))
        plus_four = match.group("plus4")
        if plus_four:
            zip_code = f"{zip_code} dash {_digits_to_words(plus_four)}"
        return f"{state} {zip_code}"

    normalized = re.sub(
        r"\b(?P<state>AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+(?P<zip>\d{5})(?:-(?P<plus4>\d{4}))?\b",
        replace_state_zip,
        text,
        flags=re.IGNORECASE,
    )
    direction_pattern = r"(?:N|S|E|W|NE|NW|SE|SW|N\.E\.|N\.W\.|S\.E\.|S\.W\.|North|South|East|West|North East|North West|South East|South West)"
    suffix_pattern = "|".join(sorted((re.escape(value) for value in set(_STREET_SUFFIX_WORDS) | set(_STREET_SUFFIX_WORDS.values())), key=len, reverse=True))
    return re.sub(
        rf"(?<![\d-])(?P<zip>\d{{5}})(?:-(?P<plus4>\d{{4}}))?(?![\d-])(?!(?:\s+(?:{direction_pattern})\b|\s+[A-Z][A-Za-z'.-]+\s+(?:{suffix_pattern})\b))",
        lambda match: (
            f"{_digits_to_words(match.group('zip'))}"
            + (f" dash {_digits_to_words(match.group('plus4'))}" if match.group("plus4") else "")
        ),
        normalized,
    )


def _normalize_address_directions_and_highways(text: str) -> str:
    direction_pattern = r"(?:N|S|E|W|NE|NW|SE|SW|N\.E\.|N\.W\.|S\.E\.|S\.W\.)"
    suffix_pattern = "|".join(sorted((re.escape(value) for value in set(_STREET_SUFFIX_WORDS) | set(_STREET_SUFFIX_WORDS.values())), key=len, reverse=True))

    def replace_numbered_or_named_street(match: re.Match[str]) -> str:
        street = match.group("street")
        numbered = re.fullmatch(r"\d{1,3}(?:st|nd|rd|th)?", street, flags=re.IGNORECASE)
        street_words = _ordinal_to_words(int(re.sub(r"\D", "", street))) if numbered else street
        return (
            f"{match.group('number')} "
            f"{_normalize_direction_token(match.group('direction'))} "
            f"{street_words} "
            f"{_normalize_suffix_token(match.group('suffix'))}"
        )

    normalized = re.sub(
        rf"\b(?P<number>\d{{1,6}})\s+(?P<direction>{direction_pattern})\s+(?P<street>\d{{1,3}}(?:st|nd|rd|th)?|[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){{0,4}})\s+(?P<suffix>{suffix_pattern})\b",
        replace_numbered_or_named_street,
        text,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        rf"\b(?P<number>\d{{1,6}})\s+(?P<direction>{direction_pattern})\s+(?P<street>[A-Z][A-Za-z'.-]+)\b(?=\s+(?:Suite|Room|Floor|Unit|Apartment|Building)\b)",
        lambda match: f"{match.group('number')} {_normalize_direction_token(match.group('direction'))} {match.group('street')}",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        rf"\b(?P<number>\d{{1,6}})\s+(?P<direction>{direction_pattern})\s+(?P<street>[A-Z][A-Za-z'.-]+)\b(?=\s+(?:[A-Z][a-z]+,?\s+)?(?:OR|WA|CA|CO|Oregon|Washington|California|Colorado)\b|$)",
        lambda match: f"{match.group('number')} {_normalize_direction_token(match.group('direction'))} {match.group('street')}",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        rf"\b(?P<suffix>{suffix_pattern})\s+(?P<direction>{direction_pattern})\b",
        lambda match: f"{_normalize_suffix_token(match.group('suffix'))} {_normalize_direction_token(match.group('direction'))}",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r"\bHighway\s+(?P<number>\d{1,3})(?:\s+(?P<direction>N|S|E|W))?\b",
        lambda match: (
            f"Highway {_number_to_words(int(match.group('number')))}"
            + (f" {_normalize_direction_token(match.group('direction'))}" if match.group("direction") else "")
        ),
        normalized,
        flags=re.IGNORECASE,
    )
    return normalized


def _domain_to_spoken_site(url: str) -> str:
    parsed = urllib_parse.urlparse(url if re.match(r"^[a-z][a-z0-9+.-]*://", url, re.IGNORECASE) else f"https://{url}")
    host = (parsed.netloc or parsed.path.split("/", 1)[0]).lower()
    host = host.removeprefix("www.")
    if not host:
        return "the website"
    if host in {"211info.org", "gethelp.211info.org"}:
        return "the two one one info website"
    first_label = host.split(".", 1)[0].replace("-", " ").strip()
    return f"the {first_label} website" if first_label else "the website"


def _strip_unspoken_fields(text: str) -> str:
    spoken = str(text or "")
    omitted_pattern = "|".join(re.escape(field) for field in sorted(_OMITTED_VOICE_FIELDS, key=len, reverse=True))
    spoken = re.sub(
        r"(?i)\b(?:phone|eligibility|address|location|hours|email|website)\s*:\s*[^.;]*(?:not listed|not available|unavailable|not provided)[^.;]*(?=$|[.;])",
        " ",
        spoken,
    )
    spoken = re.sub(
        rf"(?i)(?:^|[\s.;])(?:{omitted_pattern})\s*:\s*(?:https?://\S+|www\.\S+|[^\n.;]+)(?=$|[\n.;])",
        " ",
        spoken,
    )
    spoken = re.sub(
        r"(?i)(?:^|[.!?]\s+)[^.!?]*(?:not listed|not available|unavailable|not provided) in this record[^.!?]*[.!?]?",
        " ",
        spoken,
    )
    return re.sub(r"\s*([.;,])\s*(?:[.;,]\s*)+", r"\1 ", spoken)


def _normalize_urls_for_speech(text: str) -> str:
    url_pattern = r"(?i)\b(?:https?://|www\.)[^\s<>)\]]+|\b[A-Za-z0-9][A-Za-z0-9.-]*\.(?:org|com|gov|net|edu)(?:/[^\s<>)\]]*)?"

    def replace_url(match: re.Match[str]) -> str:
        raw_url = match.group(0).rstrip(".,;:")
        trailing = match.group(0)[len(raw_url) :]
        return f"{_domain_to_spoken_site(raw_url)}{trailing}"

    return re.sub(url_pattern, replace_url, text)


def _strip_scraped_page_chrome(text: str) -> str:
    cleaned = str(text or "")
    cleaned = re.sub(r"(?i)\bEmail\s+(?:\(\d{3}\)\s*)?\d{3}[-.]\d{4}\s+Get Directions\s+Visit Website\s+More Details\s+", " ", cleaned)
    cleaned = re.sub(r"(?i)\b(?:Email|Get Directions|Visit Website|More Details|Print\s*&\s*Share|Print PDF)\b", " ", cleaned)
    cleaned = re.sub(r"\bX\s+Print\s*&\s*Share\b", " ", cleaned)
    cleaned = re.sub(r"\bX\b", " ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def _normalize_phone_numbers(text: str) -> str:
    def replace_phone(match: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        if len(digits) == 11 and digits.startswith("1"):
            digits = digits[1:]
        if len(digits) != 10:
            return match.group(0)
        return f"{_digits_to_words(digits[:3])}, {_digits_to_words(digits[3:6])}, {_digits_to_words(digits[6:])}"

    return re.sub(
        r"(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b",
        replace_phone,
        text,
    )


def _normalize_phone_extensions(text: str) -> str:
    return re.sub(
        r"\b(?:ext\.?|extension|x)\s*#?\s*(?P<extension>\d{1,6})\b",
        lambda match: f"extension {_digits_to_words(match.group('extension'))}",
        text,
        flags=re.IGNORECASE,
    )


def _title_case_program_name(value: str) -> str:
    acronyms = {
        "CAF",
        "DHS",
        "EBT",
        "HIV",
        "HUD",
        "ID",
        "LGBTQ",
        "LGBTQIA",
        "NARA",
        "NW",
        "SNAP",
        "SSDI",
        "SSI",
        "VA",
        "WIC",
    }
    small_words = {"and", "or", "of", "for", "to", "the", "a", "an", "in", "on", "at", "by", "with"}
    tokens = re.split(r"(\s+|-)", value.strip())
    output: list[str] = []
    word_index = 0
    for token in tokens:
        if not token or token.isspace() or token == "-":
            output.append(token)
            continue
        bare = re.sub(r"[^A-Za-z0-9]", "", token)
        if not bare:
            output.append(token)
            continue
        upper = bare.upper()
        lower = token.lower()
        if upper in acronyms:
            replacement = token.replace(bare, upper)
        elif word_index > 0 and lower in small_words:
            replacement = lower
        elif "'" in token:
            replacement = "'".join(part.capitalize() for part in lower.split("'"))
        else:
            replacement = lower.capitalize()
        replacement = replacement.replace("Peerplus", "Peer Plus")
        replacement = replacement.replace("Sbhc", "school based health center")
        replacement = replacement.replace("Chruch", "Church")
        output.append(replacement)
        word_index += 1
    return re.sub(r"\s+and$", "", "".join(output), flags=re.IGNORECASE)


def _normalize_phone_list_prosody(text: str) -> str:
    digit_word = r"(?:zero|one|two|three|four|five|six|seven|eight|nine)"
    phone = rf"{digit_word}(?: {digit_word}){{2}}, {digit_word}(?: {digit_word}){{2}}, {digit_word}(?: {digit_word}){{3}}"

    def replace_pair(match: re.Match[str]) -> str:
        first = match.group("first")
        second = match.group("second")
        second_extension = match.group("second_extension") or ""
        trailing = match.group("trailing")
        if first == second and second_extension:
            return f"You can call {first}, {second_extension}{trailing}"
        return f"You can call {first}. Another number is {second}{second_extension}{trailing}"

    return re.sub(
        rf"\bPhone:\s*(?P<first>{phone}),\s*(?P<second>{phone})(?P<second_extension>\s+extension\s+(?:{digit_word}\s*){{1,6}})?(?P<trailing>[.;])",
        replace_pair,
        text,
        flags=re.IGNORECASE,
    )


def _normalize_address_prosody(text: str) -> str:
    suffix_pattern = "|".join(sorted((re.escape(value) for value in set(_STREET_SUFFIX_WORDS.values())), key=len, reverse=True))
    state_pattern = "|".join(sorted((re.escape(value) for value in set(_STATE_WORDS.values())), key=len, reverse=True))
    normalized = re.sub(
        rf"\b(?P<street>{suffix_pattern})\s+(?P<city>(?!(?:North|South|East|West)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){{0,2}}),?\s+(?P<state>{state_pattern})\b",
        lambda match: f"{match.group('street')}, {match.group('city')}, {match.group('state')}",
        text,
    )
    normalized = re.sub(
        r"\b(?P<street>Street|Avenue|Road|Boulevard|Drive|Lane|Loop|Parkway|Court|Way)\s+(?P<unit>[A-Z])(?P<number>\d{1,4})(?=\s+[A-Z][a-z]+,\s+(?:Oregon|Washington|California|Colorado)\b)",
        lambda match: f"{match.group('street')}, building {match.group('unit')} {_number_to_words(int(match.group('number')))}",
        normalized,
    )
    normalized = re.sub(
        r"\b(?P<label>Suite|Unit|Apartment|Building|Floor)\s+(?P<unit>[A-Za-z0-9-]+)\s+(?=[A-Z][A-Za-z]+,?\s+(?:Oregon|Washington|California|Colorado)\b)",
        lambda match: f"{match.group('label')} {match.group('unit')}, ",
        normalized,
    )
    normalized = re.sub(
        r"\b(?P<street>Street|Avenue|Road|Boulevard|Drive|Lane|Loop|Parkway|Court|Way)\s+(?P<direction>North|South|East|West|North East|North West|South East|South West)\s+(?=[A-Z][a-z]+,?\s+(?:Oregon|Washington|California|Colorado)\b)",
        lambda match: f"{match.group('street')} {match.group('direction')}, ",
        normalized,
    )
    return normalized


def _prefer_primary_voice_contact(text: str) -> str:
    state_pattern = "|".join(sorted((re.escape(value) for value in set(_STATE_WORDS.values())), key=len, reverse=True))
    zip_words = r"(?:zero|one|two|three|four|five|six|seven|eight|nine)(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){4}(?: dash (?:zero|one|two|three|four|five|six|seven|eight|nine)(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){3})?"
    address_stop = re.compile(r",\s+(?=\d{2,6}\s+)")

    def replace_address(match: re.Match[str]) -> str:
        address = match.group("address")
        remainder = match.group("remainder")
        split = address_stop.search(address)
        if not split:
            return match.group(0)
        primary = address[: split.start()].strip(" ,")
        return f"The address is {primary}. There may be more locations in the service details.{remainder}"

    spoken = re.sub(
        rf"The address is (?P<address>.*?\b(?:{state_pattern}) {zip_words})(?P<remainder>\. (?:You can call|Phone number:))",
        replace_address,
        text,
    )
    return spoken


def _normalize_sentence_prosody(text: str) -> str:
    spoken = re.sub(
        r"\bI found (?P<name>[A-Z][A-Z0-9 &'(),/-]{3,})\.",
        lambda match: f"I found {_title_case_program_name(match.group('name'))}.",
        text,
    )
    spoken = re.sub(
        r"\bI found (?P<name>[A-Z][A-Z0-9 &'(),/-]{3,})\s+(?=Phone:|Phone number:|Eligibility:|The address is\b)",
        lambda match: f"I found {_title_case_program_name(match.group('name'))}. ",
        spoken,
    )
    spoken = re.sub(
        r"\bI found (VA [^.]*? Community Resource and Referral Center)\s+VA Community Resource and Referral Center\.",
        r"I found \1.",
        spoken,
    )
    spoken = re.sub(
        r"\bI found Saint (?P<name>[A-Z][A-Z0-9 &'(),/-]{3,})\.",
        lambda match: f"I found Saint {_title_case_program_name(match.group('name'))}.",
        spoken,
    )
    spoken = _normalize_phone_list_prosody(spoken)
    spoken = re.sub(
        r"\bAges?\s+(?P<start>\d{1,3})\s*-\s*(?P<end>\d{1,3})\b",
        lambda match: f"Ages {_number_to_words(int(match.group('start')))} to {_number_to_words(int(match.group('end')))}",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        r"\bage\s+(?P<age>\d{1,3})\b",
        lambda match: f"age {_number_to_words(int(match.group('age')))}",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = _normalize_address_prosody(spoken)
    spoken = _prefer_primary_voice_contact(spoken)
    spoken = spoken.replace("&", "and")
    spoken = re.sub(
        r"\bConfirm details before traveling, since service availability can change\.",
        "Please confirm details before you go, since service availability can change.",
        spoken,
    )
    spoken = re.sub(r"\bPhone:\s*", "You can call ", spoken)
    spoken = re.sub(r"\bPhone number:\s*", "You can call ", spoken)
    spoken = re.sub(r"\bAlternate phone number:\s*", "Another number is ", spoken)
    spoken = re.sub(r"\bAges ([^.]+?) All other\b", r"Ages \1. Other eligibility rules may apply", spoken)
    spoken = re.sub(r"\bI found Need Help Finding Child Care\?\s*Call two one one\.", "For help finding child care, call two one one.", spoken)
    spoken = re.sub(r"\bEligibility:\s*Unrestricted\.\s*anyone\b", "Eligibility: anyone", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*Unrestricted[.;]\s*Varies by program\.", "Eligibility varies by program.", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*(?P<body>[^.]+?\.)\s*Unrestricted[.;]", r"Eligibility: \g<body>", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*Unrestricted[.;]", "Eligibility is unrestricted.", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*None\.\s*", "Eligibility: ", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*", "Eligibility: ", spoken)
    spoken = re.sub(r"\bEligibility:\s*Individuals and families with minor children in substance use disorder recovery\.", "Eligibility: individuals and families with minor children who are in substance use disorder recovery.", spoken)
    spoken = re.sub(r"\bFPL\b", "federal poverty level", spoken)
    spoken = re.sub(r"\bFederal Poverty Level\b", "federal poverty level", spoken)
    spoken = re.sub(r"\s*\(federal poverty level\)", "", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bFamiles\b", "Families", spoken)
    spoken = re.sub(r"\s+(Veteran must\b)", r". \1", spoken)
    spoken = re.sub(r"\s+(Any discharge\b)", r". \1", spoken)
    spoken = re.sub(r"\s+(Household must\b)", r". \1", spoken)
    spoken = re.sub(r"\s+(Documentation may\b)", r". \1", spoken)
    spoken = re.sub(
        r"\bschool based health center\s+School Based Health Center\b",
        "school-based health center",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(r"\bschool based health center\b", "school-based health center", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bMen'S\b", "Men's", spoken)
    spoken = re.sub(r"\s*;\s*", ". ", spoken)
    spoken = _shorten_long_eligibility_for_voice(spoken)
    state_pattern = "|".join(sorted((re.escape(value) for value in set(_STATE_WORDS.values())), key=len, reverse=True))
    zip_words = r"(?:zero|one|two|three|four|five|six|seven|eight|nine)(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){4}(?: dash (?:zero|one|two|three|four|five|six|seven|eight|nine)(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){3})?"
    spoken = re.sub(rf"\b(?P<state>{state_pattern}) (?P<zip>{zip_words})\b", r"\g<state>. ZIP code \g<zip>", spoken)
    spoken = re.sub(r"\s+([.,;:!?])", r"\1", spoken)
    return re.sub(r"([.!?])\s*(?=(?:You can call|Another number|Eligibility|Please confirm)\b)", r"\1 ", spoken)


def _shorten_long_eligibility_for_voice(text: str) -> str:
    match = re.search(r"\bEligibility(?: is|:)\s+(?P<body>.*?)(?=\s+Before traveling\b|$)", text)
    if not match:
        return text
    body = match.group("body").strip()
    if len(body) <= 220:
        return text
    first_clause = re.split(r"(?<=[.!?])\s+|(?:\s+[A-Z][a-z]+:)", body, maxsplit=1)[0].strip()
    if len(first_clause) > 180:
        first_clause = first_clause[:180].rsplit(" ", 1)[0].strip() + "."
    replacement = f"Eligibility: {first_clause} More eligibility details may be in the service details."
    return f"{text[:match.start()]}{replacement}{text[match.end():]}"


def _normalize_percentages_and_currency(text: str) -> str:
    def numberish_to_words(value: str) -> str:
        if "." in value:
            left, right = value.split(".", 1)
            return f"{_number_to_words(int(left))} point {_digits_to_words(right)}"
        return _number_to_words(int(value))

    normalized = re.sub(
        r"\b(?P<start>\d{1,3})(?:\.\d+)?\s*-\s*(?P<end>\d{1,3}(?:\.\d+)?)%",
        lambda match: f"{numberish_to_words(match.group('start'))} to {numberish_to_words(match.group('end'))} percent",
        text,
    )
    normalized = re.sub(
        r"\b(?P<value>\d{1,3}(?:\.\d+)?)%",
        lambda match: f"{numberish_to_words(match.group('value'))} percent",
        normalized,
    )
    return re.sub(
        r"\$(?P<amount>\d{1,4})(?:\.(?P<cents>\d{2}))?",
        lambda match: (
            f"{_number_to_words(int(match.group('amount')))} dollars"
            + (f" and {_number_to_words(int(match.group('cents')))} cents" if match.group("cents") else "")
        ),
        normalized,
    )


def _normalize_hours_and_separators(text: str) -> str:
    day_names = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
    text = re.sub(r"\s*[-–]\s*211info\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*\*\s*", " for ", text)
    text = re.sub(r"\s+/\s+", ", ", text)
    normalized = re.sub(rf"\b({day_names})(?:/({day_names}))+\b", lambda match: match.group(0).replace("/", ", "), text)
    normalized = re.sub(r"\b([A-Za-z]+)/([A-Za-z]+)\b", r"\1 and \2", normalized)
    normalized = re.sub(r"(?m)(^|\s)-(?=[A-Za-z])", r"\1", normalized)
    normalized = re.sub(r"\s+-\s*", " to ", normalized)
    normalized = re.sub(r"(?<=\d)(am|pm)\b", lambda match: f" {match.group(1).upper()}", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"(?<=\b(?:AM|PM))\s*-\s*(?=\d)", " to ", normalized)
    normalized = re.sub(r"\b9/11\b", "September eleventh", normalized)
    return normalized


def _strip_coordinates(text: str) -> str:
    if re.fullmatch(r"\s*-?\d{1,3}\.\d{3,}\s*", str(text or "")):
        return ""
    cleaned = re.sub(r"(?i)\b(?:lat(?:itude)?|lon(?:gitude)?|lng)\s*[:=]?\s*-?\d+(?:\.\d+)?", " ", text)
    cleaned = re.sub(r"\b-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b", " ", cleaned)
    return cleaned


def _normalize_record_list_sentence(text: str) -> str:
    direction_pattern = r"(?:N|S|E|W|NE|NW|SE|SW|N\.E\.|N\.W\.|S\.E\.|S\.W\.)"
    suffix_pattern = "|".join(sorted((re.escape(key) for key in _STREET_SUFFIX_WORDS), key=len, reverse=True))
    address_start = re.compile(
        rf"\b\d{{1,6}}\s+(?:(?:{direction_pattern})\s+)?(?:\d{{1,3}}(?:st|nd|rd|th)?|[A-Za-z][A-Za-z'.-]+)\s+(?:{suffix_pattern})\b",
        re.IGNORECASE,
    )

    def replace_record_list(match: re.Match[str]) -> str:
        listed = _strip_coordinates(match.group("listed"))
        if re.search(r"(?i)\b(?:not listed|not available|unavailable|not provided)\b", listed):
            return " "
        listed = re.sub(r"(?i)\b\d+\s*(?:minute|minutes|min|mins)\b\.?\s*", " ", listed)
        listed = re.sub(r"\s+", " ", listed).strip(" ;,.")
        address_match = address_start.search(listed)
        if address_match:
            listed = listed[address_match.start() :].strip(" ;,.")
        if not listed:
            return " "
        return f"The address is {listed}."

    return re.sub(
        r"(?i)\bThe record lists\s+(?P<listed>.*?)(?=\s+(?:Phone|Eligibility|Source|Confirm)\s*:| Confirm\b|$)",
        replace_record_list,
        text,
    )


def normalize_indextts_spoken_text(text: str) -> str:
    spoken = _strip_scraped_page_chrome(text)
    spoken = re.sub(r"\*\*(.*?)\*\*", r"\1", spoken)
    spoken = re.sub(r"__(.*?)__", r"\1", spoken)
    spoken = _strip_unspoken_fields(spoken)
    spoken = _strip_coordinates(spoken)
    spoken = _normalize_record_list_sentence(spoken)
    spoken = _normalize_urls_for_speech(spoken)
    spoken = _normalize_phone_numbers(spoken)
    spoken = _normalize_phone_extensions(spoken)
    spoken = _normalize_percentages_and_currency(spoken)
    spoken = _normalize_hours_and_separators(spoken)
    spoken = re.sub(r"\bST\s+(?=[A-Z])", "Saint ", spoken)
    spoken = re.sub(r"(?i)\ba grounded\s+211\s+match\s+is\b", "I found", spoken)
    spoken = re.sub(r"(?i)\ba grounded\s+two one one\s+match\s+is\b", "I found", spoken)
    spoken = re.sub(r"(?i)\bgrounded detail\b", "detail", spoken)
    spoken = re.sub(r"(?i)\b211[\s-]?ai\b", "two one one AI", spoken)
    spoken = re.sub(r"(?i)\b211[\s-]?info\b", "two one one info", spoken)
    spoken = re.sub(r"(?<!\d)9\s*-\s*1\s*-\s*1(?!\d)", "nine one one", spoken)
    spoken = re.sub(r"(?<!\d)2\s*-\s*1\s*-\s*1(?!\d)", "two one one", spoken)
    spoken = re.sub(r"(?<!\d)911(?!\d)", "nine one one", spoken)
    spoken = re.sub(r"(?<!\d)211(?!\d)", "two one one", spoken)
    spoken = re.sub(r"\b(?P<tens>\d)\s+(?P<ones>\d)(?P<suffix>st|nd|rd|th)\b", r"\g<tens>\g<ones>\g<suffix>", spoken, flags=re.IGNORECASE)

    direction_pattern = r"(?:N|S|E|W|NE|NW|SE|SW|N\.E\.|N\.W\.|S\.E\.|S\.W\.)"
    suffix_pattern = "|".join(sorted((re.escape(key) for key in _STREET_SUFFIX_WORDS), key=len, reverse=True))

    spoken = re.sub(
        rf"\b(?P<direction>{direction_pattern})\s+(?P<number>\d{{1,3}})(?:st|nd|rd|th)?\s+(?P<suffix>{suffix_pattern})\b",
        lambda match: (
            f"{_normalize_direction_token(match.group('direction'))} "
            f"{_ordinal_to_words(int(match.group('number')))} "
            f"{_normalize_suffix_token(match.group('suffix'))}"
        ),
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        rf"\b(?P<number>\d{{1,3}})(?:st|nd|rd|th)?\s+(?P<suffix>{suffix_pattern})\b",
        lambda match: f"{match.group('number')} {_normalize_suffix_token(match.group('suffix'))}"
        if match.group("suffix").lower().rstrip(".") in {"hwy", "highway"}
        else f"{_ordinal_to_words(int(match.group('number')))} {_normalize_suffix_token(match.group('suffix'))}",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        rf"\b(?P<direction>{direction_pattern})\b(?=\s+\d)",
        lambda match: _normalize_direction_token(match.group("direction")),
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = _normalize_address_directions_and_highways(spoken)
    spoken = re.sub(
        rf"\b(?P<suffix>{suffix_pattern})\b",
        lambda match: match.group("suffix")
        if match.group("suffix").isupper()
        else _normalize_suffix_token(match.group("suffix")),
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        r"\b(?P<label>apt\.?|ste\.?|suite|unit|bldg\.?|fl\.?)\s+#?\s*(?P<unit>[A-Za-z0-9-]+)\b",
        lambda match: f"{_UNIT_WORDS.get(match.group('label').lower(), match.group('label'))} {match.group('unit')}",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        r"\b(?P<number>\d{1,3})(?:st|nd|rd|th)\b",
        lambda match: match.group(0)
        if re.search(r"(?:Suite|Room|Floor|Unit|Building|Apartment)\s+$", spoken[max(0, match.start() - 24) : match.start()], re.IGNORECASE)
        else _ordinal_to_words(int(match.group("number"))),
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = _normalize_zip_codes(spoken)
    spoken = _normalize_sentence_prosody(spoken)
    spoken = re.sub(r"\s+([.,;:!?])", r"\1", spoken)
    spoken = re.sub(r"(?:\.\s*){2,}", ". ", spoken)
    spoken = re.sub(r"\s+", " ", spoken).strip(" ;,")
    return spoken.lstrip(".,; ")


def normalize_numeric_sequence(value: str) -> str:
    normalized = re.sub(r"(\d)[-](\d)", r"\1 \2", str(value or ""))
    normalized = re.sub(r"\b\d+\b", lambda match: _digits_to_words(match.group(0)), normalized)
    normalized = re.sub(r"\s*,\s*", ", ", normalized)
    normalized = re.sub(r"\s*;\s*", "; ", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip(" ,;")


def normalize_slot_value_text(kind: str, value: str) -> str:
    raw_value = " ".join(str(value or "").split())
    if not raw_value:
        return ""

    digits_only = re.sub(r"\D", "", raw_value)
    spoken = raw_value
    normalized_kind = str(kind or "").strip().lower()

    if normalized_kind == "phone" and digits_only:
        if len(digits_only) == 11 and digits_only.startswith("1"):
            digits_only = digits_only[1:]
        if len(digits_only) == 10:
            spoken = f"{_digits_to_words(digits_only[:3])}, {_digits_to_words(digits_only[3:6])}, {_digits_to_words(digits_only[6:])}"
        else:
            spoken = normalize_numeric_sequence(raw_value)
    elif normalized_kind == "zip" and digits_only:
        if len(digits_only) == 9:
            spoken = f"{_digits_to_words(digits_only[:5])} dash {_digits_to_words(digits_only[5:])}"
        elif len(digits_only) == 5:
            spoken = _digits_to_words(digits_only)
        else:
            spoken = normalize_numeric_sequence(raw_value)
    elif normalized_kind == "number" and digits_only:
        if re.fullmatch(r"\d{1,4}", raw_value):
            spoken = _number_to_words(int(raw_value))
        else:
            spoken = normalize_numeric_sequence(raw_value)
    elif normalized_kind == "address":
        spoken = normalize_indextts_spoken_text(raw_value)
        spoken = re.sub(r"^\d{1,6}\b", lambda match: _digits_to_words(match.group(0)), spoken)
        return " ".join(spoken.split())
    elif re.search(r"\d", raw_value):
        spoken = normalize_numeric_sequence(raw_value)

    return " ".join(normalize_indextts_spoken_text(spoken).split())


def infer_slot_kinds_from_record(record: Mapping[str, Any]) -> list[str]:
    slot_kinds = {
        str(item or "").strip().lower()
        for item in (record.get("slotKinds") or [])
        if str(item or "").strip()
    }
    for source_id in record.get("sourceIds") or []:
        match = re.match(r"audio-slot::(?P<kind>[^:]+)::", str(source_id or "").strip())
        if match:
            slot_kinds.add(match.group("kind").strip().lower())
    preferred_order = ["phone", "zip", "number"]
    ordered = [kind for kind in preferred_order if kind in slot_kinds]
    ordered.extend(sorted(slot_kinds - set(ordered)))
    return ordered


def normalize_manifest_record_text(raw_text: str, record: Mapping[str, Any]) -> str:
    for slot_kind in infer_slot_kinds_from_record(record):
        normalized = normalize_slot_value_text(slot_kind, raw_text)
        if normalized:
            return normalized
    return normalize_indextts_spoken_text(raw_text)


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def audio_url_for(path_text: str) -> str:
    if not path_text:
        return ""
    path = Path(path_text)
    return f"/assets/audio/precomputed/211-dag-indextts/{path.name}"


def resolve_repo_path(path_text: str) -> Path:
    path = Path(str(path_text or "").strip())
    if path.is_absolute():
        return path
    return REPO_ROOT / path


_WHISPER_MODELS: dict[tuple[str, str], Any] = {}


def prefer_system_torch_installation() -> None:
    user_site = Path.home() / ".local" / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
    system_site = Path("/usr/local/lib") / f"python{sys.version_info.major}.{sys.version_info.minor}" / "dist-packages"
    user_torch_global_deps = user_site / "torch" / "lib" / "libtorch_global_deps.so"
    system_torch_global_deps = system_site / "torch" / "lib" / "libtorch_global_deps.so"
    if user_torch_global_deps.exists() or not system_torch_global_deps.exists():
        return

    loaded_torch = sys.modules.get("torch")
    loaded_torch_file = Path(str(getattr(loaded_torch, "__file__", "") or "")).resolve() if loaded_torch is not None else None
    if loaded_torch_file is not None and system_site in loaded_torch_file.parents:
        return

    user_site_text = str(user_site)
    system_site_text = str(system_site)
    if system_site_text in sys.path:
        sys.path.remove(system_site_text)
    if user_site_text in sys.path:
        insert_at = sys.path.index(user_site_text)
        sys.path.insert(insert_at, system_site_text)
    else:
        sys.path.insert(0, system_site_text)

    for module_name in list(sys.modules):
        if module_name == "torch" or module_name.startswith("torch."):
            sys.modules.pop(module_name, None)


def whisper_cuda_available() -> bool:
    prefer_system_torch_installation()
    try:
        import torch  # type: ignore
    except ImportError:
        return False
    return bool(torch.cuda.is_available())


def resolve_whisper_device(requested_device: str) -> str:
    normalized = str(requested_device or "auto").strip().lower()
    if normalized in {"", "auto"}:
        return "cuda" if whisper_cuda_available() else "cpu"
    if normalized == "cuda" and not whisper_cuda_available():
        raise RuntimeError("Transcript validation requested CUDA, but torch.cuda.is_available() is false on this host.")
    if normalized not in {"cpu", "cuda"}:
        raise ValueError(f"Unsupported transcript validation device: {requested_device}")
    return normalized


def load_whisper_model(model_name: str, *, device: str) -> Any:
    cache_key = (device, model_name)
    model = _WHISPER_MODELS.get(cache_key)
    if model is not None:
        return model

    prefer_system_torch_installation()
    try:
        import whisper  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "Transcript validation requires the 'whisper' package. Install it with 'python3 -m pip install openai-whisper'."
        ) from exc

    model = whisper.load_model(model_name, device=device)
    _WHISPER_MODELS[cache_key] = model
    return model


def transcribe_audio_file(audio_path: Path, *, model_name: str, language: str, device: str) -> tuple[str, str, bool]:
    resolved_device = resolve_whisper_device(device)
    model = load_whisper_model(model_name, device=resolved_device)
    use_fp16 = resolved_device == "cuda"
    result = model.transcribe(
        str(audio_path),
        language=language,
        task="transcribe",
        fp16=use_fp16,
        verbose=False,
        condition_on_previous_text=False,
    )
    return " ".join(str(result.get("text") or "").split()), resolved_device, use_fp16


def normalize_transcript_comparison_text(text: str, record: Mapping[str, Any]) -> str:
    normalized = normalize_manifest_record_text(text, record).lower()
    normalized = re.sub(r"\band\b", " ", normalized)
    normalized = re.sub(r"[^a-z0-9 ]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def validate_audio_manifest_entries(
    entries: list[dict[str, Any]],
    *,
    limit: int,
    model_name: str,
    language: str,
    device: str,
    similarity_threshold: float,
) -> dict[str, Any]:
    validated_count = 0
    failures: list[dict[str, Any]] = []

    for entry in entries:
        if validated_count >= limit:
            break
        preferred_path_text = str(entry.get("preferredAudioPath") or entry.get("mp3Path") or entry.get("audioPath") or "").strip()
        if not preferred_path_text:
            continue
        audio_path = resolve_repo_path(preferred_path_text)
        if not audio_path.exists():
            continue

        expected_text = normalize_transcript_comparison_text(str(entry.get("text") or ""), entry)
        transcript_text, resolved_device, use_fp16 = transcribe_audio_file(
            audio_path,
            model_name=model_name,
            language=language,
            device=device,
        )
        normalized_transcript = normalize_transcript_comparison_text(transcript_text, entry)
        similarity = round(difflib.SequenceMatcher(None, expected_text, normalized_transcript).ratio(), 4)
        passed = similarity >= similarity_threshold
        validation_payload = {
            "model": model_name,
            "language": language,
            "device": resolved_device,
            "fp16": use_fp16,
            "audioPath": display_path(audio_path),
            "transcript": transcript_text,
            "normalizedTranscript": normalized_transcript,
            "normalizedExpectedText": expected_text,
            "similarity": similarity,
            "threshold": similarity_threshold,
            "passed": passed,
        }
        entry["transcriptValidation"] = validation_payload
        validated_count += 1

        print(
            f"transcript validation [{validated_count}/{limit}] {entry.get('id', 'unknown')}: "
            f"{'pass' if passed else 'FAIL'} device={resolved_device} fp16={use_fp16} "
            f"similarity={similarity:.4f} transcript={transcript_text!r}"
        )
        if not passed:
            failures.append({
                "id": entry.get("id", "unknown"),
                "audioPath": display_path(audio_path),
                "expected": expected_text,
                "transcript": transcript_text,
                "normalizedTranscript": normalized_transcript,
                "similarity": similarity,
            })

    if limit > 0 and validated_count == 0:
        raise RuntimeError("Transcript validation was requested, but no generated or cached audio files were available to validate.")

    return {
        "enabled": True,
        "validatedCount": validated_count,
        "failureCount": len(failures),
        "model": model_name,
        "language": language,
        "device": resolve_whisper_device(device),
        "similarityThreshold": similarity_threshold,
        "failures": failures,
    }


def convert_wav_to_mp3(wav_path: Path, mp3_path: Path, *, bitrate: str = "64k", force: bool = False) -> None:
    if mp3_path.exists() and not force and mp3_path.stat().st_mtime >= wav_path.stat().st_mtime:
        return
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(wav_path),
        "-codec:a",
        "libmp3lame",
        "-b:a",
        bitrate,
        str(mp3_path),
    ]
    subprocess.run(command, check=True)


def maybe_delete_wav(wav_path: Path, mp3_path: Path, *, delete_wav: bool) -> bool:
    if not delete_wav:
        return False
    if not mp3_path.exists() or mp3_path.stat().st_size <= 0:
        return False
    wav_path.unlink(missing_ok=True)
    return True


def load_resolve_secret() -> Any:
    global _RESOLVE_SECRET
    if _RESOLVE_SECRET is not None:
        return _RESOLVE_SECRET
    if not IPFS_DATASETS_SECRETS_MODULE.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location(
            "ipfs_datasets_py_utils_secrets",
            IPFS_DATASETS_SECRETS_MODULE,
        )
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        resolve_secret = getattr(module, "resolve_secret", None)
        if callable(resolve_secret):
            _RESOLVE_SECRET = resolve_secret
            return resolve_secret
    except Exception:
        return None
    return None


def load_secret_env() -> None:
    """Best-effort load HF token/billing env from ~/.ipfs_datasets/secrets.json."""
    resolve_secret = load_resolve_secret()
    if resolve_secret:
        token = (
            resolve_secret(
                "WALLET_INDEXTTS_HF_TOKEN",
                "HF_TOKEN",
                "HUGGINGFACEHUB_API_TOKEN",
                "IPFS_DATASETS_PY_HF_API_TOKEN",
                "HUGGINGFACE_API_TOKEN",
                "HUGGINGFACE_HUB_TOKEN",
            )
            or ""
        ).strip()
        if token and not os.getenv("HF_TOKEN"):
            os.environ["HF_TOKEN"] = token

    path = Path(os.path.expanduser("~/.ipfs_datasets/secrets.json"))
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        billing = data.get("billing") if isinstance(data, Mapping) else None
        if isinstance(billing, Mapping):
            for key in ("WALLET_INDEXTTS_HF_BILL_TO", "IPFS_DATASETS_PY_HF_BILL_TO"):
                value = billing.get(key)
                if value and not os.getenv(key):
                    os.environ[key] = str(value)


def indextts_base_url() -> str:
    return os.getenv("WALLET_INDEXTTS_SPACE_URL", "https://indexteam-indextts-2-demo.hf.space").strip().rstrip("/")


def indextts_timeout() -> float:
    try:
        return max(30.0, float(os.getenv("WALLET_INDEXTTS_TIMEOUT_SECONDS", "900")))
    except ValueError:
        return 900.0


def indextts_headers(*, accept: str = "application/json") -> dict[str, str]:
    headers = {
        "Accept": accept,
        "User-Agent": "211-ai-indextts-precompute/1.0",
    }
    token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACEHUB_API_TOKEN") or os.getenv("IPFS_DATASETS_PY_HF_API_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    bill_to = os.getenv("WALLET_INDEXTTS_HF_BILL_TO") or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO") or "publicus"
    if bill_to:
        headers["X-HF-Bill-To"] = bill_to
    return headers


def describe_indextts_auth() -> str:
    headers = indextts_headers()
    auth = headers.get("Authorization", "")
    bill_to = headers.get("X-HF-Bill-To", "")
    return f"hf_auth={'yes' if auth.startswith('Bearer ') else 'no'} hf_token_chars={max(0, len(auth) - len('Bearer '))} hf_bill_to={bill_to or 'unset'}"


_INDEXTTS_SPACE_CLIENT: HFSpaceClient | None = None
_INDEXTTS_SPACE_CLIENT_KEY = ""


def indextts_space_client() -> HFSpaceClient:
    global _INDEXTTS_SPACE_CLIENT
    global _INDEXTTS_SPACE_CLIENT_KEY
    cache_key = "|".join(
        (
            indextts_base_url(),
            str(indextts_timeout()),
            str(os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACEHUB_API_TOKEN") or os.getenv("IPFS_DATASETS_PY_HF_API_TOKEN") or ""),
            str(os.getenv("WALLET_INDEXTTS_HF_BILL_TO") or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO") or "publicus"),
        )
    )
    if _INDEXTTS_SPACE_CLIENT is not None and cache_key == _INDEXTTS_SPACE_CLIENT_KEY:
        return _INDEXTTS_SPACE_CLIENT
    _INDEXTTS_SPACE_CLIENT = HFSpaceClient(
        indextts_base_url(),
        timeout_seconds=indextts_timeout(),
        headers_factory=lambda: indextts_headers(),
    )
    _INDEXTTS_SPACE_CLIENT_KEY = cache_key
    return _INDEXTTS_SPACE_CLIENT


def bucket_sync_targets(bucket_uri: str) -> dict[str, str]:
    base = str(bucket_uri or "").strip().rstrip("/")
    if not base:
        return {}
    return {
        "bucketUri": base,
        "audioUri": f"{base}/audio",
        "metadataUri": f"{base}/metadata",
    }


def hf_cli_executable() -> str:
    configured = str(os.getenv("HF_CLI_BIN") or "hf").strip() or "hf"
    if os.path.sep in configured:
        if not Path(configured).exists():
            raise RuntimeError(f"HF CLI executable was not found at {configured}")
        return configured
    resolved = shutil.which(configured)
    if not resolved:
        raise RuntimeError("HF CLI executable was not found on PATH. Install it or set HF_CLI_BIN.")
    return resolved


def run_hf_sync(local_path: Path, remote_uri: str) -> dict[str, str]:
    load_secret_env()
    command = [hf_cli_executable(), "sync", str(local_path), str(remote_uri)]
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        check=False,
    )
    output = "\n".join(part for part in (completed.stdout.strip(), completed.stderr.strip()) if part).strip()
    if completed.returncode != 0:
        raise RuntimeError(f"hf sync failed for {display_path(local_path)} -> {remote_uri}: {output or 'unknown error'}")
    return {
        "localPath": display_path(local_path),
        "remoteUri": str(remote_uri),
        **({"output": output} if output else {}),
    }


def sync_generated_outputs_to_bucket(
    output_dir: Path,
    manifest_path: Path,
    public_manifest_path: Path,
    bucket_uri: str,
) -> dict[str, Any]:
    targets = bucket_sync_targets(bucket_uri)
    if not targets:
        return {}
    if not output_dir.exists():
        raise FileNotFoundError(output_dir)
    with tempfile.TemporaryDirectory(prefix="abby-tts-bucket-sync-") as tmpdir:
        metadata_dir = Path(tmpdir) / "metadata"
        metadata_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(manifest_path, metadata_dir / manifest_path.name)
        shutil.copy2(public_manifest_path, metadata_dir / public_manifest_path.name)
        audio_sync = run_hf_sync(output_dir, targets["audioUri"])
        metadata_sync = run_hf_sync(metadata_dir, targets["metadataUri"])
    return {
        **targets,
        "audioSync": audio_sync,
        "metadataSync": metadata_sync,
    }


def http_json(method: str, url: str, payload: Any | None = None) -> Any:
    base_url = indextts_base_url().rstrip("/")
    if str(url).startswith(base_url):
        path = str(url)[len(base_url) :].lstrip("/")
        return indextts_space_client().request_json(method, path, payload)
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = indextts_headers()
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib_request.Request(url, data=data, headers=headers, method=method)
    with urllib_request.urlopen(request, timeout=indextts_timeout()) as response:
        return json.loads(response.read().decode("utf-8"))


def upload_reference(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    safe_name = path.name or "abby-reference.wav"
    mime_type = mimetypes.guess_type(str(path))[0] or "audio/wav"
    parsed = indextts_space_client().upload_file(safe_name, data, mime_type)
    upload_path = first_upload_path(parsed)
    if not upload_path:
        raise RuntimeError("IndexTTS upload did not return a reference path")
    return {"path": upload_path, "meta": {"_type": "gradio.FileData"}, "orig_name": safe_name}


def first_upload_path(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        for item in value:
            found = first_upload_path(item)
            if found:
                return found
    if isinstance(value, Mapping):
        for key in ("path", "name"):
            item = value.get(key)
            if isinstance(item, str) and item.strip():
                return item.strip()
        for item in value.values():
            found = first_upload_path(item)
            if found:
                return found
    return ""


def indextts_config() -> dict[str, Any]:
    config = indextts_space_client().get_config()
    return dict(config)


def indextts_fn_index(config: Mapping[str, Any]) -> int:
    api_name = os.getenv("WALLET_INDEXTTS_API_NAME", "/gen_single")
    try:
        return int(
            indextts_space_client().resolve_fn_index(
                api_name,
                config,
                fallback_markers=("tts", "synth", "generate", "infer", "predict"),
            )
        )
    except Exception as exc:
        raise RuntimeError(f"IndexTTS api_name {api_name!r} was not found") from exc


def indextts_batch_api_name() -> str:
    return os.getenv("WALLET_INDEXTTS_BATCH_API_NAME", "/gen_batch").strip()


def lookup_dependency_id_by_api_name(config: Mapping[str, Any], api_name: str) -> int | None:
    try:
        return int(indextts_space_client().resolve_fn_index(api_name, config))
    except Exception:
        return None


def lookup_dependency_input_count(config: Mapping[str, Any], dependency_id: int) -> int | None:
    return indextts_space_client().lookup_dependency_input_count(int(dependency_id), config)


def dependency_api_names(config: Mapping[str, Any]) -> list[str]:
    return indextts_space_client().dependency_api_names(config)


def indextts_contract_name(input_count: int | None) -> str:
    if input_count is None:
        return "unknown"
    if input_count >= 25:
        return "segments-bucket-25-field"
    if input_count == 24:
        return "legacy-24-field"
    return f"{input_count}-field"


def indextts_contract_summary(config: Mapping[str, Any], single_fn_index: int | None = None) -> dict[str, Any]:
    resolved_single_fn_index = int(single_fn_index if single_fn_index is not None else indextts_fn_index(config))
    single_input_count = lookup_dependency_input_count(config, resolved_single_fn_index)
    batch_api_name = indextts_batch_api_name()
    batch_fn_index = lookup_dependency_id_by_api_name(config, batch_api_name)
    batch_input_count = lookup_dependency_input_count(config, batch_fn_index) if batch_fn_index is not None else None
    summary: dict[str, Any] = {
        "singleApiName": os.getenv("WALLET_INDEXTTS_API_NAME", "/gen_single").strip() or "/gen_single",
        "singleFnIndex": resolved_single_fn_index,
        "singleInputCount": single_input_count,
        "singleContract": indextts_contract_name(single_input_count),
        "batchApiName": batch_api_name,
        "batchRegistered": batch_fn_index is not None,
        "batchFnIndex": batch_fn_index,
        "batchInputCount": batch_input_count,
        "batchContract": indextts_contract_name(batch_input_count),
        "registeredApiNames": dependency_api_names(config),
    }
    if batch_fn_index is None:
        summary["recommendedMode"] = "parallel-gen-single"
        summary["deploymentDriftReason"] = (
            f"Configured batch api_name {batch_api_name!r} is not registered by the live Space dependencies"
        )
    else:
        summary["recommendedMode"] = "gen_batch"
    return summary


def indextts_batch_available(config: Mapping[str, Any]) -> bool:
    return lookup_dependency_id_by_api_name(config, indextts_batch_api_name()) is not None


def indextts_batch_fn_index(config: Mapping[str, Any]) -> int:
    raw = os.getenv("WALLET_INDEXTTS_BATCH_FN_INDEX", "").strip()
    if raw:
        return int(raw)
    api_name = indextts_batch_api_name()
    value = lookup_dependency_id_by_api_name(config, api_name)
    if value is not None:
        return value
    raise RuntimeError(f"IndexTTS batch api_name {api_name!r} was not found")


def request_data(
    text: str,
    reference_audio: Mapping[str, Any],
    voice_description: str,
    *,
    input_count: int | None = None,
) -> list[Any]:
    data = [
        "Same as the voice reference",
        reference_audio,
        text,
        None,
        0.8,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        voice_description,
        False,
        120,
    ]
    if input_count is None:
        input_count = 24
    if input_count >= 25:
        data.append(0)
    data.extend(
        [
            True,
            0.8,
            30,
            0.8,
            0.0,
            3,
            10.0,
            1500,
        ]
    )
    return data


def batch_request_data(
    texts: Sequence[str],
    reference_audio: Mapping[str, Any],
    voice_description: str,
    *,
    input_count: int | None = None,
) -> list[Any]:
    text_list = [str(text) for text in texts]
    raw_template = os.getenv("WALLET_INDEXTTS_BATCH_DATA_TEMPLATE", "").strip()
    if raw_template:
        rendered = (
            raw_template.replace("{texts}", json.dumps(text_list))
            .replace("{text}", json.dumps(json.dumps(text_list)))
            .replace("{voice_description}", json.dumps(voice_description))
            .replace("{reference_audio}", json.dumps(reference_audio))
        )
        parsed = json.loads(rendered)
        if not isinstance(parsed, list):
            raise RuntimeError("WALLET_INDEXTTS_BATCH_DATA_TEMPLATE must render to a JSON array")
        return parsed
    if input_count is None:
        input_count = 25
    data = [
        "Same as the voice reference",
        reference_audio,
        json.dumps(text_list),
        None,
        0.8,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        voice_description,
        False,
        120,
    ]
    if input_count >= 25:
        # The newer batch-capable Gradio contract inserts segments_bucket_max_size
        # before the decoding arguments.
        data.append(len(text_list) if len(text_list) > 1 else 0)
    data.extend(
        [
            True,
            0.8,
            30,
            0.8,
            0.0,
            3,
            10.0,
            1500,
        ]
    )
    return data


def wait_for_result(session_hash: str) -> dict[str, Any]:
    try:
        return indextts_space_client().wait_for_queue_result(
            session_hash,
            timeout_seconds=indextts_timeout(),
            poll_interval_seconds=0.5,
        )
    except Exception as exc:
        raise_if_indextts_quota_exceeded(exc)
        raise


def find_audio_reference(value: Any) -> Any:
    if isinstance(value, Mapping):
        if str(value.get("mime_type") or value.get("mimeType") or "").startswith("audio/"):
            return value
        if any(key in value for key in ("path", "url", "name")) and not value.get("is_stream"):
            pathish = str(value.get("path") or value.get("url") or value.get("name") or "")
            if pathish and (pathish.endswith((".wav", ".mp3", ".flac", ".ogg")) or "/file=" in pathish or "/gradio_api/file=" in pathish):
                return value
        for item in value.values():
            found = find_audio_reference(item)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = find_audio_reference(item)
            if found:
                return found
    return None


def find_audio_references(value: Any) -> list[Any]:
    refs: list[Any] = []
    seen: set[str] = set()

    def visit(item: Any) -> None:
        if isinstance(item, Mapping):
            direct = find_audio_reference(item)
            if direct is item:
                key = json.dumps(item, sort_keys=True, default=str)
                if key not in seen:
                    seen.add(key)
                    refs.append(item)
                return
            for child in item.values():
                visit(child)
            return
        if isinstance(item, list):
            for child in item:
                visit(child)

    visit(value)
    return refs


def gradio_update_value(value: Any) -> Any:
    if isinstance(value, Mapping) and value.get("__type__") == "update":
        return value.get("value")
    return value


def gradio_output_values(result: Mapping[str, Any]) -> list[Any]:
    data = result.get("data")
    if isinstance(data, list):
        return [gradio_update_value(item) for item in data]
    return []


def gradio_file_key(reference: Any) -> str:
    if isinstance(reference, Mapping):
        return str(reference.get("url") or reference.get("path") or reference.get("name") or json.dumps(reference, sort_keys=True, default=str))
    return str(reference)


def dedupe_gradio_references(references: Sequence[Any]) -> list[Any]:
    deduped: list[Any] = []
    seen: set[str] = set()
    for reference in references:
        key = gradio_file_key(reference)
        if key and key not in seen:
            seen.add(key)
            deduped.append(reference)
    return deduped


def find_file_reference(value: Any, *, suffixes: Sequence[str]) -> Any:
    suffix_tuple = tuple(suffix.lower() for suffix in suffixes)
    if isinstance(value, Mapping):
        if any(key in value for key in ("path", "url", "name")) and not value.get("is_stream"):
            pathish = str(value.get("path") or value.get("url") or value.get("name") or "").lower()
            if pathish.endswith(suffix_tuple) or any(f"/file=" in pathish and suffix in pathish for suffix in suffix_tuple):
                return value
        for item in value.values():
            found = find_file_reference(item, suffixes=suffix_tuple)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = find_file_reference(item, suffixes=suffix_tuple)
            if found:
                return found
    if isinstance(value, str) and value.lower().endswith(suffix_tuple):
        return value
    return None


def extract_audio_files_from_zip(data: bytes) -> list[dict[str, Any]]:
    extracted: list[dict[str, Any]] = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name in sorted(archive.namelist()):
            if name.endswith("/") or not name.lower().endswith((".wav", ".mp3", ".flac", ".ogg")):
                continue
            extracted.append({"name": name, "_inline_bytes": archive.read(name)})
    return extracted


def batch_audio_references(result: Mapping[str, Any]) -> list[Any]:
    outputs = gradio_output_values(result)
    if len(outputs) >= 2:
        generated_files = find_audio_references(outputs[1])
        if generated_files:
            return dedupe_gradio_references(generated_files)
    if len(outputs) >= 3:
        zip_ref = find_file_reference(outputs[2], suffixes=(".zip",))
        if zip_ref:
            try:
                archive, _mime_type = fetch_gradio_file(zip_ref)
                extracted = extract_audio_files_from_zip(archive)
                if extracted:
                    return extracted
            except Exception:
                pass
    return dedupe_gradio_references(find_audio_references(result))


def fetch_gradio_file(ref: Any) -> tuple[bytes, str]:
    if isinstance(ref, Mapping) and isinstance(ref.get("_inline_bytes"), (bytes, bytearray)):
        name = str(ref.get("name") or ref.get("path") or "")
        return bytes(ref["_inline_bytes"]), mimetypes.guess_type(name)[0] or "audio/wav"
    if isinstance(ref, Mapping):
        mime_type = str(ref.get("mime_type") or ref.get("mimeType") or "")
    else:
        mime_type = ""
    data, resolved_mime_type = indextts_space_client().fetch_file(ref)
    return data, mime_type or resolved_mime_type or "audio/wav"


def synthesize(text: str, config: Mapping[str, Any], fn_index: int, reference_audio: Mapping[str, Any], voice_description: str) -> dict[str, Any]:
    start = time.perf_counter()
    input_count = lookup_dependency_input_count(config, fn_index)
    session_hash = indextts_space_client().queue_join(
        int(fn_index),
        request_data(text, reference_audio, voice_description, input_count=input_count),
    )
    result = wait_for_result(session_hash)
    audio_ref = find_audio_reference(result)
    if not audio_ref:
        raise RuntimeError("IndexTTS completed without an audio file")
    audio, mime_type = fetch_gradio_file(audio_ref)
    return {
        "audio": audio,
        "mimeType": "audio/wav" if audio.startswith(b"RIFF") and b"WAVE" in audio[:16] else mime_type,
        "latencyMs": int((time.perf_counter() - start) * 1000),
    }


def direct_batch_synthesis(
    texts: Sequence[str],
    config: Mapping[str, Any],
    reference_audio: Mapping[str, Any],
    voice_description: str,
) -> list[dict[str, Any]]:
    text_list = [str(text) for text in texts]
    if not text_list:
        return []
    start = time.perf_counter()
    batch_fn_index = indextts_batch_fn_index(config)
    batch_input_count = lookup_dependency_input_count(config, batch_fn_index)
    session_hash = indextts_space_client().queue_join(
        int(batch_fn_index),
        batch_request_data(
            text_list,
            reference_audio,
            voice_description,
            input_count=batch_input_count,
        ),
    )
    result = wait_for_result(session_hash)
    audio_refs = batch_audio_references(result)
    if len(audio_refs) < len(text_list):
        raise RuntimeError(f"IndexTTS batch returned {len(audio_refs)} audio files for {len(text_list)} texts")
    batch_latency_ms = int((time.perf_counter() - start) * 1000)
    outputs: list[dict[str, Any]] = []
    for ref in audio_refs[: len(text_list)]:
        audio, mime_type = fetch_gradio_file(ref)
        outputs.append(
            {
                "audio": audio,
                "mimeType": "audio/wav" if audio.startswith(b"RIFF") and b"WAVE" in audio[:16] else mime_type,
                "latencyMs": batch_latency_ms,
                "batchLatencyMs": batch_latency_ms,
                "batchMode": "batch",
            }
        )
    return outputs


def annotate_split_batch_outputs(
    outputs: Sequence[Mapping[str, Any]],
    *,
    root_batch_size: int,
    executed_batch_size: int,
    split_depth: int,
    fallback_reason: str,
) -> list[dict[str, Any]]:
    annotated: list[dict[str, Any]] = []
    for output in outputs:
        item = dict(output)
        base_mode = str(item.get("batchMode") or "batch")
        if split_depth > 0:
            if base_mode.endswith("-split-fallback"):
                item["batchMode"] = base_mode
            elif base_mode == "batch":
                item["batchMode"] = "batch-split-fallback"
            elif base_mode in {"sequential", "sequential-fallback"}:
                item["batchMode"] = "sequential-split-fallback"
            elif base_mode in {"parallel", "parallel-fallback"}:
                item["batchMode"] = "parallel-split-fallback"
            else:
                item["batchMode"] = f"{base_mode}-split-fallback"
            item["batchRequestedSize"] = root_batch_size
            item["batchExecutedSize"] = executed_batch_size
            item["batchSplitDepth"] = split_depth
        if fallback_reason:
            existing_reason = str(item.get("batchFallbackReason") or "").strip()
            item["batchFallbackReason"] = fallback_reason if not existing_reason else f"{fallback_reason} | {existing_reason}"
        annotated.append(item)
    return annotated


def adaptive_split_batch_synthesis(
    texts: Sequence[str],
    config: Mapping[str, Any],
    single_fn_index: int,
    reference_audio: Mapping[str, Any],
    voice_description: str,
    *,
    require_batch: bool,
    root_batch_size: int | None = None,
    split_depth: int = 0,
    fallback_reason: str = "",
) -> list[dict[str, Any]]:
    text_list = [str(text) for text in texts]
    if not text_list:
        return []
    requested_batch_size = root_batch_size or len(text_list)
    try:
        outputs = direct_batch_synthesis(text_list, config, reference_audio, voice_description)
        if split_depth > 0:
            outputs = annotate_split_batch_outputs(
                outputs,
                root_batch_size=requested_batch_size,
                executed_batch_size=len(text_list),
                split_depth=split_depth,
                fallback_reason=fallback_reason,
            )
        return outputs
    except Exception as exc:
        if isinstance(exc, IndexTTSQuotaExceededError):
            raise
        failure_reason = f"{type(exc).__name__}: {exc}"
        inherited_reason = fallback_reason or failure_reason
        if len(text_list) > 1 and is_indextts_transient_worker_error(exc):
            midpoint = max(1, len(text_list) // 2)
            left = adaptive_split_batch_synthesis(
                text_list[:midpoint],
                config,
                single_fn_index,
                reference_audio,
                voice_description,
                require_batch=require_batch,
                root_batch_size=requested_batch_size,
                split_depth=split_depth + 1,
                fallback_reason=inherited_reason,
            )
            right = adaptive_split_batch_synthesis(
                text_list[midpoint:],
                config,
                single_fn_index,
                reference_audio,
                voice_description,
                require_batch=require_batch,
                root_batch_size=requested_batch_size,
                split_depth=split_depth + 1,
                fallback_reason=inherited_reason,
            )
            return [*left, *right]
        if require_batch:
            return [
                batch_failure_result(
                    exc,
                    batch_mode="batch-failed",
                    fallback_reason=inherited_reason,
                    requested_batch_size=requested_batch_size,
                    executed_batch_size=len(text_list),
                    split_depth=split_depth,
                )
                for _text in text_list
            ]
        output = {
            **synthesize(text_list[0], config, single_fn_index, reference_audio, voice_description),
            "batchMode": "sequential-split-fallback",
        }
        return annotate_split_batch_outputs(
            [output],
            root_batch_size=requested_batch_size,
            executed_batch_size=1,
            split_depth=max(1, split_depth),
            fallback_reason=inherited_reason,
        )


def synthesize_batch(
    texts: Sequence[str],
    config: Mapping[str, Any],
    single_fn_index: int,
    reference_audio: Mapping[str, Any],
    voice_description: str,
    *,
    parallel_workers: int = 1,
) -> list[dict[str, Any]]:
    text_list = [str(text) for text in texts]
    if not text_list:
        return []
    batch_enabled = os.getenv("WALLET_INDEXTTS_BATCH_ENABLED", "1").strip().lower() not in {"0", "false", "no"}
    require_batch = os.getenv("WALLET_INDEXTTS_REQUIRE_BATCH", "").strip().lower() in {"1", "true", "yes"}
    attempted_batch = bool(batch_enabled)
    batch_available = indextts_batch_available(config)
    batch_fallback_reason = ""
    if batch_enabled and not batch_available:
        batch_fallback_reason = f"IndexTTS batch api_name {indextts_batch_api_name()!r} was not found in the live Space config"
        if require_batch:
            raise RuntimeError(batch_fallback_reason)
        batch_enabled = False
    if batch_enabled:
        try:
            return adaptive_split_batch_synthesis(
                text_list,
                config,
                single_fn_index,
                reference_audio,
                voice_description,
                require_batch=require_batch,
                root_batch_size=len(text_list),
            )
        except Exception as exc:
            batch_fallback_reason = f"{type(exc).__name__}: {exc}"
            if require_batch:
                raise

    worker_count = max(1, min(int(parallel_workers or 1), len(text_list)))
    fallback_mode = "parallel-fallback" if attempted_batch else "parallel"
    if worker_count > 1:
        with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = [
                executor.submit(synthesize, text, config, single_fn_index, reference_audio, voice_description)
                for text in text_list
            ]
            return [
                {
                    **future.result(),
                    "batchMode": fallback_mode,
                    **({"batchFallbackReason": batch_fallback_reason} if batch_fallback_reason else {}),
                }
                for future in futures
            ]

    return [
        {
            **synthesize(text, config, single_fn_index, reference_audio, voice_description),
            "batchMode": "sequential-fallback" if attempted_batch else "sequential",
            **({"batchFallbackReason": batch_fallback_reason} if batch_fallback_reason else {}),
        }
        for text in text_list
    ]


def add_response_source(
    by_text: dict[str, dict[str, Any]],
    *,
    text: str,
    source: str,
    source_id: str,
    route: str = "",
    service_tag: str = "",
    location_tag: str = "",
) -> None:
    raw_text = " ".join(str(text or "").split())
    if not raw_text:
        return
    normalized = normalize_indextts_spoken_text(raw_text)
    if not normalized:
        return
    text_hash = stable_id(normalized)
    item = by_text.setdefault(
        normalized,
        {
            "id": f"abby-tts-{text_hash}",
            "textHash": text_hash,
            "text": normalized,
            "originalTexts": [],
            "routes": set(),
            "serviceTags": set(),
            "locationTags": set(),
            "sourceTypes": set(),
            "sourceIds": [],
        },
    )
    if raw_text != normalized and raw_text not in item["originalTexts"]:
        item["originalTexts"].append(raw_text)
    if route:
        item["routes"].add(route)
    if service_tag:
        item["serviceTags"].add(service_tag)
    if location_tag:
        item["locationTags"].add(location_tag)
    item["sourceTypes"].add(source)
    if source_id and source_id not in item["sourceIds"]:
        item["sourceIds"].append(source_id)


def add_response_record(
    by_text: dict[str, dict[str, Any]],
    record: Mapping[str, Any],
    *,
    default_source: str = "manifest.response",
) -> None:
    raw_text = " ".join(str(record.get("text") or "").split())
    if not raw_text:
        return
    normalized = normalize_manifest_record_text(raw_text, record)
    if not normalized:
        return
    text_hash = stable_id(normalized)
    item = by_text.setdefault(
        normalized,
        {
            "id": f"abby-tts-{text_hash}",
            "textHash": text_hash,
            "text": normalized,
            "originalTexts": [],
            "routes": set(),
            "serviceTags": set(),
            "locationTags": set(),
            "sourceTypes": set(),
            "sourceIds": [],
            "priorityScore": 0.0,
            "priorityRank": None,
        },
    )
    priority_score = float(record.get("priorityScore") or 0.0)
    if priority_score > float(item.get("priorityScore") or 0.0):
        item["priorityScore"] = priority_score
    raw_priority_rank = record.get("priorityRank")
    if raw_priority_rank is not None and str(raw_priority_rank).strip() != "":
        priority_rank = int(raw_priority_rank)
        current_rank = item.get("priorityRank")
        if current_rank is None or priority_rank < int(current_rank):
            item["priorityRank"] = priority_rank
    if raw_text != normalized and raw_text not in item["originalTexts"]:
        item["originalTexts"].append(raw_text)
    for original_text in record.get("originalTexts") or []:
        collapsed = " ".join(str(original_text or "").split())
        if collapsed and collapsed != normalized and collapsed not in item["originalTexts"]:
            item["originalTexts"].append(collapsed)
    for route in record.get("routes") or []:
        normalized_route = str(route or "").strip()
        if normalized_route:
            item["routes"].add(normalized_route)
    for service_tag in record.get("serviceTags") or []:
        normalized_service_tag = str(service_tag or "").strip()
        if normalized_service_tag:
            item["serviceTags"].add(normalized_service_tag)
    for location_tag in record.get("locationTags") or []:
        normalized_location_tag = str(location_tag or "").strip()
        if normalized_location_tag:
            item["locationTags"].add(normalized_location_tag)
    source_types = [str(source or "").strip() for source in (record.get("sourceTypes") or [])]
    if not any(source_types):
        source_types = [default_source]
    for source_type in source_types:
        if source_type:
            item["sourceTypes"].add(source_type)
    for source_id in record.get("sourceIds") or []:
        normalized_source_id = str(source_id or "").strip()
        if normalized_source_id and normalized_source_id not in item["sourceIds"]:
            item["sourceIds"].append(normalized_source_id)
    for field in SLOTTED_RESPONSE_FIELDS:
        values = [str(value or "").strip() for value in (record.get(field) or [])]
        normalized_values = {value for value in values if value}
        if not normalized_values:
            continue
        existing = item.setdefault(field, set())
        if not isinstance(existing, set):
            existing = set(existing)
            item[field] = existing
        existing.update(normalized_values)


def empty_slotted_annotation() -> dict[str, set[str]]:
    return {
        "slottedIntentIds": set(),
        "slottedCanonicalQueryTemplates": set(),
        "slottedResponseFrameIds": set(),
        "slottedResponseSignatures": set(),
        "slottedEdgeIds": set(),
    }


def add_slotted_annotation(
    annotation: dict[str, set[str]],
    *,
    intent_id: str = "",
    canonical_query_template: str = "",
    response_frame_id: str = "",
    response_signature: str = "",
    edge_id: str = "",
) -> None:
    if intent_id:
        annotation["slottedIntentIds"].add(intent_id)
    if canonical_query_template:
        annotation["slottedCanonicalQueryTemplates"].add(canonical_query_template)
    if response_frame_id:
        annotation["slottedResponseFrameIds"].add(response_frame_id)
    if response_signature:
        annotation["slottedResponseSignatures"].add(response_signature)
    if edge_id:
        annotation["slottedEdgeIds"].add(edge_id)


def merge_slotted_annotation(target: dict[str, set[str]], source: Mapping[str, Sequence[str]] | None) -> None:
    if not source:
        return
    for key in target:
        for value in source.get(key, ()):
            normalized = str(value or "").strip()
            if normalized:
                target[key].add(normalized)


def slotted_annotation_payload(annotation: dict[str, set[str]]) -> dict[str, list[str]]:
    return {key: sorted(values) for key, values in annotation.items() if values}


def normalize_slotted_audio_lookup_text(text: str) -> str:
    collapsed = " ".join(str(text or "").split())
    if not collapsed:
        return ""
    return normalize_indextts_spoken_text(collapsed)


def load_slotted_response_annotations(index_path: Path) -> dict[str, dict[str, dict[str, set[str]]]]:
    if not index_path.exists():
        return {"byRecordId": {}, "byNormalizedAssistantText": {}}

    payload = json.loads(index_path.read_text(encoding="utf-8"))
    intents = payload.get("intents") or []
    response_frames = payload.get("responseFrames") or []
    edges = payload.get("edges") or []
    intents_by_id = {str(intent.get("id") or ""): intent for intent in intents}
    response_frames_by_id = {str(frame.get("id") or ""): frame for frame in response_frames}
    by_record_id: dict[str, dict[str, set[str]]] = {}
    by_normalized_assistant_text: dict[str, dict[str, set[str]]] = {}

    def ensure_record_annotation(record_id: str) -> dict[str, set[str]]:
        return by_record_id.setdefault(record_id, empty_slotted_annotation())

    def ensure_text_annotation(text: str) -> dict[str, set[str]]:
        return by_normalized_assistant_text.setdefault(text, empty_slotted_annotation())

    def annotate_example(
        *,
        record_id: str,
        assistant_text: str = "",
        intent_id: str = "",
        canonical_query_template: str = "",
        response_frame_id: str = "",
        response_signature: str = "",
        edge_id: str = "",
    ) -> None:
        if record_id:
            add_slotted_annotation(
                ensure_record_annotation(record_id),
                intent_id=intent_id,
                canonical_query_template=canonical_query_template,
                response_frame_id=response_frame_id,
                response_signature=response_signature,
                edge_id=edge_id,
            )
        normalized_assistant_text = normalize_slotted_audio_lookup_text(assistant_text)
        if normalized_assistant_text:
            add_slotted_annotation(
                ensure_text_annotation(normalized_assistant_text),
                intent_id=intent_id,
                canonical_query_template=canonical_query_template,
                response_frame_id=response_frame_id,
                response_signature=response_signature,
                edge_id=edge_id,
            )

    for intent in intents:
        intent_id = str(intent.get("id") or "")
        canonical_query_template = str(intent.get("canonicalQueryTemplate") or "")
        for example in intent.get("examples") or []:
            annotate_example(
                record_id=str(example.get("recordId") or ""),
                intent_id=intent_id,
                canonical_query_template=canonical_query_template,
            )

    for frame in response_frames:
        response_frame_id = str(frame.get("id") or "")
        response_signature = str(frame.get("responseSignature") or "")
        for example in frame.get("examples") or []:
            annotate_example(
                record_id=str(example.get("recordId") or ""),
                assistant_text=str(example.get("assistant") or ""),
                response_frame_id=response_frame_id,
                response_signature=response_signature,
            )

    for edge in edges:
        edge_id = str(edge.get("id") or "")
        intent = intents_by_id.get(str(edge.get("source") or ""), {})
        response_frame = response_frames_by_id.get(str(edge.get("target") or ""), {})
        intent_id = str(intent.get("id") or "")
        canonical_query_template = str(intent.get("canonicalQueryTemplate") or "")
        response_frame_id = str(response_frame.get("id") or "")
        response_signature = str(response_frame.get("responseSignature") or "")
        for example in edge.get("examples") or []:
            annotate_example(
                record_id=str(example.get("recordId") or ""),
                assistant_text=str(example.get("assistant") or ""),
                intent_id=intent_id,
                canonical_query_template=canonical_query_template,
                response_frame_id=response_frame_id,
                response_signature=response_signature,
                edge_id=edge_id,
            )

    return {
        "byRecordId": by_record_id,
        "byNormalizedAssistantText": by_normalized_assistant_text,
    }


def annotate_audio_responses_with_slotted_metadata(
    responses: list[dict[str, Any]],
    index_path: Path | None,
) -> None:
    if index_path is None:
        return
    annotations = load_slotted_response_annotations(index_path)
    by_record_id = annotations.get("byRecordId") or {}
    by_normalized_assistant_text = annotations.get("byNormalizedAssistantText") or {}
    if not by_record_id and not by_normalized_assistant_text:
        return

    for item in responses:
        annotation = empty_slotted_annotation()
        for field in SLOTTED_RESPONSE_FIELDS:
            for value in item.get(field) or []:
                normalized_value = str(value or "").strip()
                if normalized_value:
                    annotation[field].add(normalized_value)
        for source_id in item.get("sourceIds") or []:
            merge_slotted_annotation(annotation, by_record_id.get(str(source_id or "")))
        merge_slotted_annotation(annotation, by_normalized_assistant_text.get(str(item.get("text") or "")))
        for original_text in item.get("originalTexts") or []:
            normalized_original = normalize_slotted_audio_lookup_text(str(original_text or ""))
            if normalized_original:
                merge_slotted_annotation(annotation, by_normalized_assistant_text.get(normalized_original))
        item.update(slotted_annotation_payload(annotation))


def finalize_audio_responses(by_text: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    responses: list[dict[str, Any]] = []
    for item in by_text.values():
        response = {
            "id": str(item.get("id") or ""),
            "textHash": str(item.get("textHash") or ""),
            "text": str(item.get("text") or ""),
            "originalTexts": list(item.get("originalTexts") or []),
            "routes": sorted(item.get("routes") or []),
            "serviceTags": sorted(item.get("serviceTags") or []),
            "locationTags": sorted(item.get("locationTags") or []),
            "sourceTypes": sorted(item.get("sourceTypes") or []),
            "sourceIds": list(item.get("sourceIds") or []),
        }
        priority_score = float(item.get("priorityScore") or 0.0)
        if priority_score:
            response["priorityScore"] = priority_score
        priority_rank = item.get("priorityRank")
        if priority_rank is not None:
            response["priorityRank"] = int(priority_rank)
        for field in SLOTTED_RESPONSE_FIELDS:
            values = item.get(field) or []
            if values:
                response[field] = sorted(values)
        responses.append(response)
    responses.sort(
        key=lambda item: (
            -float(item.get("priorityScore") or 0.0),
            int(item.get("priorityRank") or 10**9),
            str(item["id"]),
        )
    )
    return responses


def load_audio_responses(
    dag_path: Path,
    results_path: Path,
    *,
    include_assistant: bool = True,
    include_voice: bool = True,
    slotted_response_index: Path | None = None,
) -> list[dict[str, Any]]:
    by_text: dict[str, dict[str, Any]] = {}
    if include_voice:
        dag = json.loads(dag_path.read_text(encoding="utf-8"))
        for node in dag.get("nodes", []):
            add_response_source(
                by_text,
                text=str(node.get("voiceResponse") or ""),
                source="dag.voiceResponse",
                source_id=str(node.get("id") or ""),
                route=str(node.get("route") or ""),
                service_tag=str(node.get("serviceTag") or ""),
                location_tag=str(node.get("locationTag") or ""),
            )
    if include_assistant:
        results = json.loads(results_path.read_text(encoding="utf-8"))
        for result in results.get("results", []):
            scenario_id = str(result.get("id") or "")
            for turn_index, turn in enumerate(result.get("turns", []), start=1):
                add_response_source(
                    by_text,
                    text=str(turn.get("assistant") or ""),
                    source="simulation.assistant",
                    source_id=f"{scenario_id}#turn-{turn_index}",
                    route=str(turn.get("route") or ""),
                )
    responses = finalize_audio_responses(by_text)
    annotate_audio_responses_with_slotted_metadata(responses, slotted_response_index)
    return responses


def load_audio_responses_from_manifest(
    manifest_path: Path,
    *,
    slotted_response_index: Path | None = None,
) -> list[dict[str, Any]]:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    response_records = payload if isinstance(payload, list) else payload.get("responses") or []
    by_text: dict[str, dict[str, Any]] = {}
    for record in response_records:
        if isinstance(record, Mapping):
            add_response_record(by_text, record)
    responses = finalize_audio_responses(by_text)
    annotate_audio_responses_with_slotted_metadata(responses, slotted_response_index)
    return responses


def write_progress(path: Path | None, entries: list[dict[str, Any]], total: int, started_at: float) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    status_counts = Counter(str(entry.get("status") or "unknown") for entry in entries)
    payload = {
        "schemaVersion": 1,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsedSeconds": round(time.time() - started_at, 3),
        "completed": len(entries),
        "total": total,
        "statusCounts": dict(sorted(status_counts.items())),
        "lastResponse": entries[-1] if entries else None,
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--space-url",
        default="",
        help="Override the IndexTTS Space base URL for this invocation.",
    )
    parser.add_argument("--dag", type=Path, default=DEFAULT_DAG)
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument(
        "--response-manifest",
        type=Path,
        default=None,
        help="Load deduplicated pregenerated text responses from a manifest instead of --dag/--results.",
    )
    parser.add_argument("--reference-audio", type=Path, default=DEFAULT_REFERENCE)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--public-manifest", type=Path, default=DEFAULT_PUBLIC_MANIFEST)
    parser.add_argument("--slotted-response-index", type=Path, default=DEFAULT_SLOTTED_RESPONSE_INDEX)
    parser.add_argument("--voice-description", default="Same as the voice reference")
    parser.add_argument("--offset", type=int, default=0, help="Skip this many deduplicated responses before applying --limit.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--mp3", dest="write_mp3", action="store_true", default=True)
    parser.add_argument("--no-mp3", dest="write_mp3", action="store_false")
    parser.add_argument("--mp3-bitrate", default="64k")
    parser.add_argument(
        "--remote-batch-size",
        type=int,
        default=int(os.getenv("WALLET_INDEXTTS_REMOTE_BATCH_SIZE", "1") or "1"),
        help="Send this many uncached responses to the IndexTTS batch endpoint at once when available.",
    )
    parser.add_argument(
        "--parallel-workers",
        type=int,
        default=int(os.getenv("WALLET_INDEXTTS_PARALLEL_WORKERS", "1") or "1"),
        help="Use this many concurrent gen_single requests when the batch endpoint is unavailable or disabled.",
    )
    parser.add_argument("--delete-wav-after-mp3", action="store_true", default=True)
    parser.add_argument("--keep-wav", dest="delete_wav_after_mp3", action="store_false")
    parser.add_argument("--stop-on-error", action="store_true")
    parser.add_argument(
        "--max-runtime-seconds",
        type=float,
        default=None,
        help="Stop starting new synthesis jobs after this many seconds. Existing cached MP3s are still recorded in the manifest.",
    )
    parser.add_argument("--progress-json", type=Path, default=None, help="Write resumable progress after every response.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--voice-responses-only", action="store_true")
    parser.add_argument("--assistant-responses-only", action="store_true")
    parser.add_argument(
        "--validate-transcripts",
        action="store_true",
        help="Transcribe generated or cached audio with Whisper and compare it to the expected normalized spoken text.",
    )
    parser.add_argument(
        "--transcript-validation-limit",
        type=int,
        default=1,
        help="Validate up to this many generated or cached audio files when --validate-transcripts is enabled.",
    )
    parser.add_argument(
        "--transcript-validation-model",
        default=os.getenv("WALLET_INDEXTTS_TRANSCRIPTION_MODEL", "tiny.en"),
        help="Whisper model name to use for transcript validation.",
    )
    parser.add_argument(
        "--transcript-validation-language",
        default=os.getenv("WALLET_INDEXTTS_TRANSCRIPTION_LANGUAGE", "en"),
        help="Language hint passed to Whisper for transcript validation.",
    )
    parser.add_argument(
        "--transcript-validation-device",
        default=os.getenv("WALLET_INDEXTTS_TRANSCRIPTION_DEVICE", "auto"),
        help="Whisper device for transcript validation: auto, cpu, or cuda.",
    )
    parser.add_argument(
        "--transcript-validation-threshold",
        type=float,
        default=0.72,
        help="Minimum normalized transcript similarity required for validation to pass.",
    )
    parser.add_argument(
        "--transcript-validation-soft-fail",
        action="store_true",
        help="Record transcript validation failures in the manifest but still exit successfully.",
    )
    parser.add_argument(
        "--print-indextts-contract",
        action="store_true",
        help="Fetch the live IndexTTS Gradio config, print the detected single/batch contract summary, and exit.",
    )
    parser.add_argument(
        "--bucket-uri",
        default=os.getenv("WALLET_INDEXTTS_BUCKET_URI", "").strip(),
        help="If set, sync generated audio to <bucket-uri>/audio and local manifests to <bucket-uri>/metadata using the hf CLI.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if str(args.space_url or "").strip():
        os.environ["WALLET_INDEXTTS_SPACE_URL"] = str(args.space_url).strip()
    started_at = time.time()
    include_assistant = not args.voice_responses_only
    include_voice = not args.assistant_responses_only
    if args.response_manifest is not None and (args.voice_responses_only or args.assistant_responses_only):
        raise ValueError("--response-manifest cannot be combined with --voice-responses-only or --assistant-responses-only")
    if args.validate_transcripts and args.transcript_validation_limit < 1:
        raise ValueError("--transcript-validation-limit must be at least 1 when --validate-transcripts is enabled")
    if not 0.0 <= args.transcript_validation_threshold <= 1.0:
        raise ValueError("--transcript-validation-threshold must be between 0.0 and 1.0")
    if args.parallel_workers < 1:
        raise ValueError("--parallel-workers must be at least 1")
    if args.validate_transcripts:
        resolve_whisper_device(args.transcript_validation_device)
    if args.print_indextts_contract:
        load_secret_env()
        print(f"IndexTTS auth: {describe_indextts_auth()}")
        config = indextts_config()
        fn_index = indextts_fn_index(config)
        print(json.dumps(indextts_contract_summary(config, fn_index), indent=2))
        return
    if args.response_manifest is not None:
        responses = load_audio_responses_from_manifest(
            args.response_manifest,
            slotted_response_index=args.slotted_response_index,
        )
    else:
        responses = load_audio_responses(
            args.dag,
            args.results,
            include_assistant=include_assistant,
            include_voice=include_voice,
            slotted_response_index=args.slotted_response_index,
        )
    if args.offset:
        responses = responses[max(0, args.offset) :]
    if args.limit is not None:
        responses = responses[: max(0, args.limit)]
    args.output_dir.mkdir(parents=True, exist_ok=True)

    manifest_entries: list[dict[str, Any]] = []
    fatal_exception: Exception | None = None
    if args.dry_run:
        for item in responses:
            manifest_entries.append({**item, "status": "planned", "audioPath": "", "mp3Path": ""})
    else:
        config: dict[str, Any] | None = None
        fn_index: int | None = None
        reference: Any | None = None
        contract_summary: dict[str, Any] | None = None
        remote_batch_size = max(1, int(args.remote_batch_size or 1))
        pending: list[tuple[int, dict[str, Any], Path, Path]] = []

        def ensure_remote_client() -> tuple[dict[str, Any], int, Any]:
            nonlocal config, fn_index, reference, contract_summary
            if config is not None and fn_index is not None and reference is not None:
                return config, fn_index, reference
            load_secret_env()
            if not args.reference_audio.exists():
                raise FileNotFoundError(args.reference_audio)
            print(f"IndexTTS auth: {describe_indextts_auth()}")
            config = indextts_config()
            fn_index = indextts_fn_index(config)
            contract_summary = indextts_contract_summary(config, fn_index)
            if contract_summary.get("deploymentDriftReason"):
                print(f"IndexTTS batch drift: {contract_summary['deploymentDriftReason']}")
            reference = upload_reference(args.reference_audio)
            return config, fn_index, reference

        def flush_pending() -> None:
            if not pending:
                return
            batch = list(pending)
            pending.clear()
            texts = [item["text"] for _, item, _, _ in batch]
            try:
                active_config, active_fn_index, active_reference = ensure_remote_client()
                print(f"processing remote chunk of {len(batch)} response(s)")
                results = synthesize_batch(
                    texts,
                    active_config,
                    active_fn_index,
                    active_reference,
                    args.voice_description,
                    parallel_workers=args.parallel_workers,
                )
                if len(results) != len(batch):
                    raise RuntimeError(f"IndexTTS batch returned {len(results)} result(s) for {len(batch)} response(s)")
                for (index, item, audio_path, mp3_path), result in zip(batch, results):
                    if result.get("error"):
                        entry = {
                            **item,
                            "status": "failed",
                            "audioPath": "",
                            "mp3Path": "",
                            "error": str(result.get("error") or "Unknown batch failure"),
                            "batchMode": result.get("batchMode", "batch" if len(batch) > 1 else "single"),
                        }
                        for key in ("batchFallbackReason", "batchRequestedSize", "batchExecutedSize", "batchSplitDepth", "retryAfter"):
                            if result.get(key) is not None:
                                entry[key] = result[key]
                        if result.get("retriable"):
                            entry["retriable"] = True
                        manifest_entries.append(entry)
                        print(f"[{index}/{len(responses)}] failed {item['id']}: {entry['error']}")
                        write_progress(args.progress_json, manifest_entries, len(responses), started_at)
                        continue
                    audio_path.write_bytes(result["audio"])
                    if args.write_mp3:
                        convert_wav_to_mp3(audio_path, mp3_path, bitrate=args.mp3_bitrate, force=True)
                    wav_deleted = maybe_delete_wav(audio_path, mp3_path, delete_wav=args.write_mp3 and args.delete_wav_after_mp3)
                    entry = {
                        **item,
                        "status": "generated_mp3" if wav_deleted else "generated",
                        "audioPath": "" if wav_deleted else display_path(audio_path),
                        "mimeType": "" if wav_deleted else result["mimeType"],
                        "audioBytes": 0 if wav_deleted else file_size(audio_path),
                        "latencyMs": result["latencyMs"],
                        "batchMode": result.get("batchMode", "batch" if len(batch) > 1 else "single"),
                        "wavDeprecated": bool(wav_deleted),
                    }
                    if result.get("batchLatencyMs") is not None:
                        entry["batchLatencyMs"] = result["batchLatencyMs"]
                    if result.get("batchFallbackReason"):
                        entry["batchFallbackReason"] = result["batchFallbackReason"]
                    for key in ("batchRequestedSize", "batchExecutedSize", "batchSplitDepth"):
                        if result.get(key) is not None:
                            entry[key] = result[key]
                    if args.write_mp3 and mp3_path.exists():
                        entry.update(
                            {
                                "mp3Path": display_path(mp3_path),
                                "mp3MimeType": "audio/mpeg",
                                "mp3Bytes": file_size(mp3_path),
                                "preferredAudioPath": display_path(mp3_path),
                                "preferredMimeType": "audio/mpeg",
                            }
                        )
                    else:
                        entry.update({"mp3Path": "", "preferredAudioPath": display_path(audio_path), "preferredMimeType": result["mimeType"]})
                    manifest_entries.append(entry)
                    print(f"[{index}/{len(responses)}] generated {mp3_path.name if mp3_path.exists() else audio_path.name}")
                    write_progress(args.progress_json, manifest_entries, len(responses), started_at)
            except Exception as exc:
                retry_after = exc.retry_after if isinstance(exc, IndexTTSQuotaExceededError) else indextts_retry_after_hint(exc)
                for index, item, _audio_path, _mp3_path in batch:
                    print(f"[{index}/{len(responses)}] failed {item['id']}: {exc}")
                    manifest_entries.append(
                        {
                            **item,
                            "status": "failed",
                            "audioPath": "",
                            "mp3Path": "",
                            "error": f"{type(exc).__name__}: {exc}",
                            **({"retriable": True, "retryAfter": retry_after} if retry_after else {}),
                        }
                    )
                    write_progress(args.progress_json, manifest_entries, len(responses), started_at)
                if isinstance(exc, IndexTTSQuotaExceededError) or args.stop_on_error:
                    raise

        for index, item in enumerate(responses, start=1):
            if args.max_runtime_seconds is not None and time.time() - started_at >= args.max_runtime_seconds:
                print(f"[{index}/{len(responses)}] stopping before new work: max runtime reached")
                break
            audio_path = args.output_dir / f"{item['id']}.wav"
            mp3_path = args.output_dir / f"{item['id']}.mp3"
            if not args.force:
                if mp3_path.exists() and file_size(mp3_path) == 0:
                    mp3_path.unlink(missing_ok=True)
                    print(f"[{index}/{len(responses)}] dropped invalid zero-byte cache {mp3_path.name}")
                if audio_path.exists() and file_size(audio_path) == 0:
                    audio_path.unlink(missing_ok=True)
                    print(f"[{index}/{len(responses)}] dropped invalid zero-byte cache {audio_path.name}")
            if not audio_path.exists() and mp3_path.exists() and not args.force:
                manifest_entries.append(
                    {
                        **item,
                        "status": "cached_mp3",
                        "audioPath": "",
                        "mimeType": "",
                        "audioBytes": 0,
                        "mp3Path": display_path(mp3_path),
                        "mp3MimeType": "audio/mpeg",
                        "mp3Bytes": file_size(mp3_path),
                        "preferredAudioPath": display_path(mp3_path),
                        "preferredMimeType": "audio/mpeg",
                        "wavDeprecated": True,
                    }
                )
                print(f"[{index}/{len(responses)}] cached {mp3_path.name}")
                write_progress(args.progress_json, manifest_entries, len(responses), started_at)
                continue
            if audio_path.exists() and not args.force:
                if args.write_mp3:
                    convert_wav_to_mp3(audio_path, mp3_path, bitrate=args.mp3_bitrate, force=False)
                wav_deleted = maybe_delete_wav(audio_path, mp3_path, delete_wav=args.write_mp3 and args.delete_wav_after_mp3)
                entry = {
                    **item,
                    "status": "cached_mp3" if wav_deleted else "cached",
                    "audioPath": "" if wav_deleted else display_path(audio_path),
                    "mimeType": "" if wav_deleted else "audio/wav",
                    "audioBytes": 0 if wav_deleted else file_size(audio_path),
                    "wavDeprecated": bool(wav_deleted),
                }
                if args.write_mp3 and mp3_path.exists():
                    entry.update(
                        {
                            "mp3Path": display_path(mp3_path),
                            "mp3MimeType": "audio/mpeg",
                            "mp3Bytes": file_size(mp3_path),
                            "preferredAudioPath": display_path(mp3_path),
                            "preferredMimeType": "audio/mpeg",
                        }
                    )
                else:
                    entry.update({"mp3Path": "", "preferredAudioPath": display_path(audio_path), "preferredMimeType": "audio/wav"})
                manifest_entries.append(entry)
                print(f"[{index}/{len(responses)}] cached {audio_path.name}")
                write_progress(args.progress_json, manifest_entries, len(responses), started_at)
                continue
            print(f"[{index}/{len(responses)}] queued {item['id']}: {item['text']}")
            pending.append((index, item, audio_path, mp3_path))
            if len(pending) >= remote_batch_size:
                try:
                    flush_pending()
                except Exception as exc:
                    fatal_exception = exc
                    break
        if pending:
            try:
                flush_pending()
            except Exception as exc:
                fatal_exception = exc

    payload = {
        "schemaVersion": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "provider": "IndexTeam/IndexTTS-2-Demo",
        "spaceUrl": indextts_base_url(),
        "referenceAudio": str(args.reference_audio),
        "voiceDescription": args.voice_description,
        "responseCount": len(manifest_entries),
        "sources": {
            "dag": "" if args.response_manifest is not None else str(args.dag),
            "results": "" if args.response_manifest is not None else str(args.results),
            "responseManifest": str(args.response_manifest) if args.response_manifest is not None else "",
            "slottedResponseIndex": str(args.slotted_response_index) if args.slotted_response_index.exists() else "",
            "includeAssistantResponses": include_assistant,
            "includeVoiceResponses": include_voice,
            "idScheme": "abby-tts-{sha256(spoken_normalized_text)[:20]}",
        },
        "normalization": {
            "emergencyNumbers": {
                "211": "two one one",
                "911": "nine one one",
            },
            "addresses": {
                "directions": _ADDRESS_DIRECTION_WORDS,
                "streetSuffixes": _STREET_SUFFIX_WORDS,
                "unitLabels": _UNIT_WORDS,
                "numberedStreetOrdinals": True,
            },
        },
        "mp3": {
            "enabled": bool(args.write_mp3),
            "bitrate": args.mp3_bitrate,
            "preferred": bool(args.write_mp3),
            "wavDeprecated": bool(args.write_mp3 and args.delete_wav_after_mp3),
        },
        "batchInference": {
            "remoteBatchSize": max(1, int(args.remote_batch_size or 1)),
            "parallelWorkers": max(1, int(args.parallel_workers or 1)),
            "batchApiName": indextts_batch_api_name(),
            "enabled": os.getenv("WALLET_INDEXTTS_BATCH_ENABLED", "1").strip().lower() not in {"0", "false", "no"},
            "requiresBatch": os.getenv("WALLET_INDEXTTS_REQUIRE_BATCH", "").strip().lower() in {"1", "true", "yes"},
        },
        "responses": manifest_entries,
    }
    bucket_targets = bucket_sync_targets(args.bucket_uri)
    if bucket_targets:
        payload["bucketUpload"] = {
            **bucket_targets,
            "enabled": True,
            "tool": "hf sync",
        }
    if isinstance(fatal_exception, IndexTTSQuotaExceededError):
        payload["batchInference"]["rateLimitDetected"] = {
            "type": type(fatal_exception).__name__,
            "message": str(fatal_exception),
            "retryAfter": fatal_exception.retry_after,
        }
    if not args.dry_run and 'contract_summary' in locals() and contract_summary is not None:
        payload["batchInference"]["contract"] = contract_summary
    if args.validate_transcripts:
        payload["transcriptValidation"] = validate_audio_manifest_entries(
            manifest_entries,
            limit=args.transcript_validation_limit,
            model_name=args.transcript_validation_model,
            language=args.transcript_validation_language,
            device=args.transcript_validation_device,
            similarity_threshold=args.transcript_validation_threshold,
        )
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    args.public_manifest.parent.mkdir(parents=True, exist_ok=True)
    public_payload = {
        **payload,
        "referenceAudio": "abby-reference.wav",
        "responses": [
            {
                **entry,
                "audioUrl": audio_url_for(str(entry.get("audioPath") or "")),
                "mp3Url": audio_url_for(str(entry.get("mp3Path") or "")),
                "preferredAudioUrl": audio_url_for(str(entry.get("preferredAudioPath") or entry.get("audioPath") or "")),
            }
            for entry in manifest_entries
        ],
    }
    args.public_manifest.write_text(json.dumps(public_payload, indent=2), encoding="utf-8")
    print(f"Wrote {args.manifest}")
    print(f"Wrote {args.public_manifest}")
    if bucket_targets and not args.dry_run:
        sync_summary = sync_generated_outputs_to_bucket(args.output_dir, args.manifest, args.public_manifest, args.bucket_uri)
        print(f"Synced generated audio to {sync_summary['audioUri']}")
        print(f"Synced manifests to {sync_summary['metadataUri']}")
    if fatal_exception is not None:
        raise fatal_exception
    if args.validate_transcripts and payload["transcriptValidation"]["failureCount"] and not args.transcript_validation_soft_fail:
        failure_summary = payload["transcriptValidation"]["failures"]
        raise RuntimeError(f"Transcript validation failed for {len(failure_summary)} audio file(s): {failure_summary}")


if __name__ == "__main__":
    try:
        main()
    except IndexTTSQuotaExceededError as exc:
        print(f"IndexTTS quota exhausted: {exc}", file=sys.stderr)
        raise SystemExit(75) from exc
