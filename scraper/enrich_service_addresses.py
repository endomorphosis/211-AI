from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd

from .build_service_portal_package import compact_json, utc_now
from .utils import clean_text, setup_logging


logger = setup_logging()

DEFAULT_PORTAL_DIR = Path("data/portal")
DEFAULT_CACHE_PATH = DEFAULT_PORTAL_DIR / "service_address_geocode_cache.json"
DEFAULT_NOMINATIM_URL = "https://nominatim.openstreetmap.org"
DEFAULT_COUNTRY_CODE = "us"
DEFAULT_USER_AGENT = "211-AI/1.0 (service-address-enrichment; github.com/211-ai/211-ai.github.io)"
ROUTE_STREET_PATTERN = r"(?:Highway|Hwy|US|Route)\s+\d+[A-Za-z]?"
STREET_SUFFIX_PATTERN = (
    r"(?:Avenue|Ave|Street|St|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Court|Ct|Place|Pl|Way|"
    r"Highway|Hwy|Circle|Cir|Parkway|Pkwy|Terrace|Ter)"
)
STREET_CORE_RE = re.compile(
    rf"^.+?(?:\b{ROUTE_STREET_PATTERN}\b|\b{STREET_SUFFIX_PATTERN}\b\.?)(?!\s+\b{STREET_SUFFIX_PATTERN}\b)"
    rf"(?:\s+(?:(?:NE|NW|SE|SW|North|South|East|West|N|S|E|W)\b))?"
    rf"(?:\s+(?:Suite|Ste\.?|Unit|Rm\.?|Room|#)\s*[A-Za-z0-9/-]+)?",
    re.IGNORECASE,
)
CITY_DIRECTION_PREFIX_RE = re.compile(r"^(?:NE|NW|SE|SW|N|S|E|W)\b[\s,]+", re.IGNORECASE)
CITY_UNIT_PREFIX_RE = re.compile(
    r"^(?:Suite|Ste\.?|Unit|Rm\.?|Room|Bldg\.?|Building)\b(?:\s*[#A-Za-z0-9/-]+)?[\s,]+",
    re.IGNORECASE,
)
CITY_FLOOR_PREFIX_RE = re.compile(r"^(?:\d+(?:st|nd|rd|th)\s+Floor|Floor\s*\d+|Fl\.?\s*\d+)\b[\s,]+", re.IGNORECASE)
CITY_HASH_PREFIX_RE = re.compile(r"^#[A-Za-z0-9/-]+\b[\s,]+", re.IGNORECASE)
CITY_LEVEL_PREFIX_RE = re.compile(r"^(?:Basement(?:\s+Level)?|Lower\s+Level|Upper\s+Level|Lobby)\b[\s,]+", re.IGNORECASE)
CITY_CONJUNCTION_PREFIX_RE = re.compile(r"^(?:and|&)\b[\s,]+", re.IGNORECASE)
CITY_MAILSTOP_PREFIX_RE = re.compile(r"^(?:MSC|Mail\s*Stop|Mailstop)\s*[A-Za-z0-9-]+\b[\s,]*", re.IGNORECASE)
CITY_NUMERIC_PREFIX_RE = re.compile(r"^\d+\s+", re.IGNORECASE)
CITY_FRAGMENT_RE = re.compile(r"^(?:City|Grove|Junction)$", re.IGNORECASE)
CITY_NOISE_PREFIX_RE = re.compile(
    r"^(?:PO\s+Box\s+\d+|Department\s+\d+|Dept\.?\s*\d+|Number\s+\d+|Klondike\s+Room\s+\d+|Room\s+[A-Za-z0-9-]+|Rm\.?\s*[A-Za-z0-9-]+|Gymnasium|Clairmont\s+Hall|Marquam\s+Hill\s+Campus|Campus|Curbside\s+Bus\s+Stop)\b[\s,]*",
    re.IGNORECASE,
)
CITY_VENUE_KEYWORD_RE = re.compile(
    r"\b(?:PO\s+Box|Department|Dept\.?|Number|Room|Rm\.?|Hall|Campus|Gymnasium|Curbside\s+Bus\s+Stop)\b",
    re.IGNORECASE,
)
LEADING_BOILERPLATE_RE = re.compile(
    r"^(?:[A-Za-z][^.]{0,60}|\d{1,3}\s+[A-Za-z][^.]{0,60})\.\s*(?=\d)",
    re.IGNORECASE,
)
STREET_SUITE_GLUE_RE = re.compile(rf"(\b{STREET_SUFFIX_PATTERN}\b\.?)(?=(?:Suite|Ste\.?|Unit|Rm\.?|Room|#))", re.IGNORECASE)
HOUSE_NUMBER_START_RE = re.compile(r"\b\d{1,6}[A-Za-z]?\s+")
SECONDARY_UNIT_SUFFIX_RE = re.compile(
    r"\s+(?:Suite|Ste\.?|Unit|Rm\.?|Room|Floor|Fl\.?|#)\s*[A-Za-z0-9/-]+\b.*$",
    re.IGNORECASE,
)
STATE_POSTAL_SUFFIX_RE = re.compile(r",?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?$", re.IGNORECASE)


@dataclass(frozen=True)
class AddressQuery:
    address: str
    street: str
    city: str
    state: str
    postal_code: str
    country_code: str = DEFAULT_COUNTRY_CODE

    @property
    def key(self) -> str:
        return compact_json(
            {
                "address": self.address,
                "street": self.street,
                "city": self.city,
                "state": self.state,
                "postal_code": self.postal_code,
                "country_code": self.country_code,
            }
        )

    @property
    def display(self) -> str:
        return clean_text(" ".join(part for part in [self.address, self.city, self.state, self.postal_code] if part))


class AddressGeocoder(Protocol):
    provider_name: str

    def geocode(self, query: AddressQuery) -> dict[str, Any]:
        ...


class NominatimGeocoder:
    provider_name = "nominatim"

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_NOMINATIM_URL,
        user_agent: str = DEFAULT_USER_AGENT,
        email: str = "",
        min_delay_seconds: float = 1.1,
        timeout_seconds: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent.strip() or DEFAULT_USER_AGENT
        self.email = email.strip()
        self.min_delay_seconds = max(0.0, float(min_delay_seconds))
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self.max_retries = max(1, int(max_retries))
        self._last_request_at = 0.0

    def geocode(self, query: AddressQuery) -> dict[str, Any]:
        attempts = build_nominatim_search_attempts(query, email=self.email)
        last_miss: dict[str, Any] | None = None
        last_error = ""
        for params in attempts:
            url = f"{self.base_url}/search?{urlencode({key: value for key, value in params.items() if value})}"
            attempt_error = ""
            for attempt in range(1, self.max_retries + 1):
                self._respect_rate_limit()
                request = Request(
                    url,
                    headers={
                        "Accept": "application/json",
                        "User-Agent": self.user_agent,
                    },
                )
                try:
                    with urlopen(request, timeout=self.timeout_seconds) as response:
                        payload = json.loads(response.read().decode("utf-8"))
                    record = build_nominatim_cache_record(query, payload, search_params=params)
                    if record.get("status") == "ok":
                        return record
                    last_miss = record
                    break
                except HTTPError as exc:
                    attempt_error = f"http_{exc.code}"
                    if exc.code in {429, 500, 502, 503, 504} and attempt < self.max_retries:
                        time.sleep(max(self.min_delay_seconds, 2.0) * attempt)
                        continue
                    break
                except URLError as exc:
                    attempt_error = f"url_error:{exc.reason}"
                    if attempt < self.max_retries:
                        time.sleep(max(self.min_delay_seconds, 2.0) * attempt)
                        continue
                    break
                except Exception as exc:  # pragma: no cover - defensive
                    attempt_error = f"{type(exc).__name__}:{exc}"
                    break
            if attempt_error:
                last_error = attempt_error

        if last_miss is not None:
            if last_error and not last_miss.get("error"):
                last_miss["error"] = last_error
            return last_miss

        return build_error_cache_record(query, last_error or "request_failed", search_params=attempts[-1] if attempts else {})

    def _respect_rate_limit(self) -> None:
        if self.min_delay_seconds <= 0:
            self._last_request_at = time.monotonic()
            return
        now = time.monotonic()
        wait_seconds = self.min_delay_seconds - (now - self._last_request_at)
        if wait_seconds > 0:
            time.sleep(wait_seconds)
        self._last_request_at = time.monotonic()


def normalized_query_city(city: str) -> str:
    value = clean_text(city)
    previous = None
    while value and value != previous:
        previous = value
        value = clean_text(CITY_DIRECTION_PREFIX_RE.sub("", value))
        value = clean_text(CITY_UNIT_PREFIX_RE.sub("", value))
        value = clean_text(CITY_FLOOR_PREFIX_RE.sub("", value))
        value = clean_text(CITY_HASH_PREFIX_RE.sub("", value))
        value = clean_text(CITY_LEVEL_PREFIX_RE.sub("", value))
        value = clean_text(CITY_CONJUNCTION_PREFIX_RE.sub("", value))
        value = clean_text(CITY_MAILSTOP_PREFIX_RE.sub("", value))
    return _strip_city_noise(value)


def _strip_city_noise(value: str) -> str:
    cleaned = clean_text(value)
    previous = None
    while cleaned and cleaned != previous:
        previous = cleaned
        cleaned = clean_text(CITY_NUMERIC_PREFIX_RE.sub("", cleaned))
        cleaned = clean_text(CITY_NOISE_PREFIX_RE.sub("", cleaned))
    words = cleaned.split()
    if len(words) >= 2:
        midpoint = len(words) // 2
        if words[:midpoint] == words[midpoint:]:
            cleaned = " ".join(words[:midpoint])
    return cleaned


def _address_body_without_state_postal(address: str) -> str:
    return clean_text(STATE_POSTAL_SUFFIX_RE.sub("", clean_text(address)))


def _city_looks_suspicious(city: str) -> bool:
    value = clean_text(city)
    return bool(
        value
        and (
            CITY_NUMERIC_PREFIX_RE.match(value)
            or CITY_FRAGMENT_RE.fullmatch(value)
            or CITY_VENUE_KEYWORD_RE.search(value)
        )
    )


def normalized_query_city_with_context(address: str, street: str, city: str) -> str:
    normalized_city = _strip_city_noise(normalized_query_city(city))
    if not _city_looks_suspicious(city) and normalized_city:
        return normalized_city

    body = _address_body_without_state_postal(address or street)
    street_candidate = normalized_query_street(address, street, normalized_city or city, normalize_city=False)
    if body and street_candidate and body.lower().startswith(street_candidate.lower()):
        city_tail = _strip_city_noise(body[len(street_candidate) :].strip(" ,"))
        if city_tail:
            return city_tail
    return normalized_city


def normalized_query_address_text(address: str) -> str:
    value = clean_text(address)
    value = clean_text(LEADING_BOILERPLATE_RE.sub("", value))
    value = clean_text(STREET_SUITE_GLUE_RE.sub(r"\1 ", value))
    house_number_matches = list(HOUSE_NUMBER_START_RE.finditer(value))
    for match in reversed(house_number_matches):
        candidate = clean_text(value[match.start() :])
        if STREET_CORE_RE.search(candidate):
            value = candidate
            break
    return value


def normalized_query_street(address: str, street: str, city: str, *, normalize_city: bool = True) -> str:
    normalized_address = normalized_query_address_text(address or street)
    normalized_city = normalized_query_city_with_context(address, street, city) if normalize_city else _strip_city_noise(normalized_query_city(city))
    body = _address_body_without_state_postal(normalized_address)
    city_lower = normalized_city.lower()
    if city_lower and body.lower().endswith(city_lower):
        body = clean_text(body[: -len(normalized_city)].rstrip(","))
    street_candidate = body or clean_text(street) or normalized_address
    match = STREET_CORE_RE.search(street_candidate)
    if match:
        street_candidate = clean_text(match.group(0))
    return street_candidate


def normalized_query_street_without_unit(address: str, street: str, city: str) -> str:
    street_with_unit = normalized_query_street(address, street, city)
    stripped = clean_text(SECONDARY_UNIT_SUFFIX_RE.sub("", street_with_unit))
    return stripped or street_with_unit


def build_nominatim_search_attempts(query: AddressQuery, *, email: str = "") -> list[dict[str, str]]:
    normalized_city = normalized_query_city_with_context(query.address, query.street, query.city)
    normalized_street = normalized_query_street(query.address, query.street, normalized_city or query.city)
    normalized_street_without_unit = normalized_query_street_without_unit(query.address, query.street, normalized_city or query.city)
    normalized_display = clean_text(
        ", ".join(
            part
            for part in [
                normalized_street_without_unit or normalized_street,
                normalized_city,
                clean_text(query.state),
                clean_text(query.postal_code),
            ]
            if part
        )
    )
    raw_display = clean_text(
        ", ".join(
            part
            for part in [
                clean_text(query.address or query.street),
                clean_text(query.city),
                clean_text(query.state),
                clean_text(query.postal_code),
            ]
            if part
        )
    )

    variants: list[dict[str, str]] = []
    seen: set[str] = set()

    def add_variant(params: dict[str, str]) -> None:
        filtered = {key: clean_text(value) for key, value in params.items() if clean_text(value)}
        if not filtered:
            return
        filtered["format"] = "jsonv2"
        filtered["limit"] = "1"
        filtered["addressdetails"] = "1"
        filtered["countrycodes"] = query.country_code
        if email:
            filtered["email"] = email
        signature = compact_json(filtered)
        if signature in seen:
            return
        seen.add(signature)
        variants.append(filtered)

    if normalized_display:
        add_variant({"q": normalized_display})
    add_variant(
        {
            "street": normalized_street_without_unit or normalized_street or clean_text(query.street or query.address),
            "city": normalized_city or clean_text(query.city),
            "state": clean_text(query.state),
            "postalcode": clean_text(query.postal_code),
        }
    )
    if normalized_street and normalized_street != normalized_street_without_unit:
        add_variant({"q": clean_text(f"{normalized_street}, {normalized_city}, {query.state}, {query.postal_code}")})
        add_variant(
            {
                "street": normalized_street,
                "city": normalized_city or clean_text(query.city),
                "state": clean_text(query.state),
                "postalcode": clean_text(query.postal_code),
            }
        )
    if raw_display and raw_display != normalized_display:
        add_variant({"q": raw_display})
    if normalized_street_without_unit and normalized_city:
        add_variant({"q": clean_text(f"{normalized_street_without_unit}, {normalized_city}, {query.state}")})
    if normalized_street and normalized_city:
        add_variant({"q": clean_text(f"{normalized_street}, {normalized_city}, {query.state}")})
    return variants


def build_error_cache_record(query: AddressQuery, error: str, *, search_params: dict[str, Any]) -> dict[str, Any]:
    return {
        "provider": "nominatim",
        "status": "error",
        "error": error,
        "lat": None,
        "lon": None,
        "precision": "error",
        "confidence": 0.0,
        "display_name": "",
        "queried_at": utc_now(),
        "query": {
            "address": query.address,
            "street": query.street,
            "city": query.city,
            "state": query.state,
            "postal_code": query.postal_code,
            "country_code": query.country_code,
        },
        "search_params": search_params,
    }


def build_nominatim_cache_record(query: AddressQuery, payload: Any, *, search_params: dict[str, Any]) -> dict[str, Any]:
    rows = payload if isinstance(payload, list) else []
    first = rows[0] if rows and isinstance(rows[0], dict) else None
    if not first:
        return {
            "provider": "nominatim",
            "status": "miss",
            "lat": None,
            "lon": None,
            "precision": "miss",
            "confidence": 0.0,
            "display_name": "",
            "queried_at": utc_now(),
            "query": {
                "address": query.address,
                "street": query.street,
                "city": query.city,
                "state": query.state,
                "postal_code": query.postal_code,
                "country_code": query.country_code,
            },
            "search_params": search_params,
        }

    lat = first.get("lat")
    lon = first.get("lon")
    return {
        "provider": "nominatim",
        "status": "ok" if lat is not None and lon is not None else "miss",
        "lat": float(lat) if lat is not None else None,
        "lon": float(lon) if lon is not None else None,
        "precision": "address_geocode" if lat is not None and lon is not None else "miss",
        "confidence": float(first.get("importance") or 0.95),
        "display_name": str(first.get("display_name") or ""),
        "osm_type": str(first.get("osm_type") or ""),
        "osm_id": str(first.get("osm_id") or ""),
        "place_id": str(first.get("place_id") or ""),
        "class": str(first.get("class") or ""),
        "type": str(first.get("type") or ""),
        "queried_at": utc_now(),
        "query": {
            "address": query.address,
            "street": query.street,
            "city": query.city,
            "state": query.state,
            "postal_code": query.postal_code,
            "country_code": query.country_code,
        },
        "search_params": search_params,
    }


def load_cache(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("could not parse geocode cache at %s; starting fresh", path)
        return {}
    if not isinstance(payload, dict):
        return {}
    return {str(key): value for key, value in payload.items() if isinstance(value, dict)}


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp_path.replace(path)


def write_parquet_atomic(path: Path, frame: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    frame.to_parquet(temp_path, index=False)
    temp_path.replace(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_cid_for_bytes(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def safe_cid_for_obj(payload: Any) -> str:
    return safe_cid_for_bytes(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def artifact_record_local(path: Path, *, row_count: int) -> dict[str, Any]:
    return {
        "path": path.name,
        "size_bytes": int(path.stat().st_size),
        "row_count": int(row_count),
        "cid": safe_cid_for_bytes(path.read_bytes()),
        "sha256": sha256_file(path),
    }


def build_query_from_location_row(row: dict[str, Any]) -> AddressQuery | None:
    address = clean_text(str(row.get("address") or ""))
    street = clean_text(str(row.get("street") or ""))
    city = clean_text(str(row.get("city") or ""))
    state = clean_text(str(row.get("state") or ""))
    postal_code = clean_text(str(row.get("postal_code") or ""))
    if not any([address, street]) or not city or not state:
        return None
    return AddressQuery(
        address=address or street,
        street=street or address,
        city=city,
        state=state,
        postal_code=postal_code,
    )


def detect_street_direction_suite_artifact(query: AddressQuery) -> bool:
    raw_street = clean_text(query.street)
    if not raw_street:
        return False
    normalized_street = normalized_query_street(query.address, query.street, query.city)
    if normalized_street == raw_street:
        return False
    if not re.search(r"\b(?:Suite|Ste\.?|Unit|Rm\.?|Room|#)\b", query.address, re.IGNORECASE):
        return False
    if not normalized_street.startswith(raw_street):
        return False
    suffix = clean_text(normalized_street[len(raw_street) :])
    return suffix in {"N", "S", "E", "W", "NE", "NW", "SE", "SW"}


def diagnose_address_query(query: AddressQuery) -> dict[str, Any]:
    raw_address = clean_text(query.address)
    raw_street = clean_text(query.street)
    raw_city = clean_text(query.city)
    normalized_address = normalized_query_address_text(raw_address)
    normalized_city = normalized_query_city_with_context(raw_address, raw_street, raw_city)
    normalized_street = normalized_query_street(raw_address, raw_street, raw_city)
    normalized_street_without_unit = normalized_query_street_without_unit(raw_address, raw_street, raw_city)

    issue_tags: list[str] = []
    if CITY_UNIT_PREFIX_RE.match(raw_city):
        issue_tags.append("city_unit_prefix")
    if CITY_DIRECTION_PREFIX_RE.match(raw_city):
        issue_tags.append("city_direction_prefix")
    if CITY_FLOOR_PREFIX_RE.match(raw_city):
        issue_tags.append("city_floor_prefix")
    if CITY_HASH_PREFIX_RE.match(raw_city):
        issue_tags.append("city_hash_prefix")
    if CITY_LEVEL_PREFIX_RE.match(raw_city):
        issue_tags.append("city_level_prefix")
    if CITY_NUMERIC_PREFIX_RE.match(raw_city):
        issue_tags.append("city_numeric_prefix")
    if CITY_FRAGMENT_RE.fullmatch(raw_city):
        issue_tags.append("city_fragment")
    if CITY_VENUE_KEYWORD_RE.search(raw_city):
        issue_tags.append("city_embedded_venue")
    if LEADING_BOILERPLATE_RE.match(raw_address):
        issue_tags.append("address_leading_boilerplate")
    if STREET_SUITE_GLUE_RE.search(raw_address) or STREET_SUITE_GLUE_RE.search(raw_street):
        issue_tags.append("street_suite_glued")
    if normalized_city != raw_city:
        issue_tags.append("city_normalized_changed")
    if normalized_address != raw_address:
        issue_tags.append("address_normalized_changed")
    if normalized_street != raw_street:
        issue_tags.append("street_normalized_changed")
    if normalized_street_without_unit != raw_street:
        issue_tags.append("street_unit_removed_or_changed")
    if detect_street_direction_suite_artifact(query):
        issue_tags.append("street_direction_suite_artifact")

    malformed_tags = {
        "city_unit_prefix",
        "city_direction_prefix",
        "city_floor_prefix",
        "city_hash_prefix",
        "city_level_prefix",
        "city_numeric_prefix",
        "city_fragment",
        "city_embedded_venue",
        "address_leading_boilerplate",
        "street_suite_glued",
    }

    classification = "likely_provider_or_coverage_miss"
    if "street_direction_suite_artifact" in issue_tags:
        classification = "likely_normalization_damage"
    elif malformed_tags.intersection(issue_tags):
        classification = "likely_malformed_input"
    elif "street_unit_removed_or_changed" in issue_tags and re.search(r"\b(?:Suite|Ste\.?|Unit|Rm\.?|Room|Floor|Fl\.?|#)\b", raw_address, re.IGNORECASE):
        classification = "likely_malformed_input"

    return {
        "cache_key": query.key,
        "address": raw_address,
        "street": raw_street,
        "city": raw_city,
        "state": clean_text(query.state),
        "postal_code": clean_text(query.postal_code),
        "normalized_address": normalized_address,
        "normalized_street": normalized_street,
        "normalized_street_without_unit": normalized_street_without_unit,
        "normalized_city": normalized_city,
        "issue_tags": issue_tags,
        "classification": classification,
    }


def classify_geocode_miss_record(record: dict[str, Any]) -> dict[str, Any]:
    query_payload = record.get("query") if isinstance(record.get("query"), dict) else {}
    query = AddressQuery(
        address=clean_text(str(query_payload.get("address") or "")),
        street=clean_text(str(query_payload.get("street") or "")),
        city=clean_text(str(query_payload.get("city") or "")),
        state=clean_text(str(query_payload.get("state") or "")),
        postal_code=clean_text(str(query_payload.get("postal_code") or "")),
        country_code=clean_text(str(query_payload.get("country_code") or DEFAULT_COUNTRY_CODE)) or DEFAULT_COUNTRY_CODE,
    )
    diagnosis = diagnose_address_query(query)
    diagnosis.update(
        {
            "status": str(record.get("status") or ""),
            "provider": str(record.get("provider") or ""),
            "precision": str(record.get("precision") or ""),
            "display_name": str(record.get("display_name") or ""),
            "queried_at": str(record.get("queried_at") or ""),
            "search_params": record.get("search_params") if isinstance(record.get("search_params"), dict) else {},
        }
    )
    return diagnosis


def build_repaired_query_for_miss_record(record: dict[str, Any]) -> AddressQuery | None:
    diagnosis = classify_geocode_miss_record(record)
    if diagnosis.get("classification") != "likely_malformed_input":
        return None

    street = clean_text(str(diagnosis.get("normalized_street_without_unit") or diagnosis.get("normalized_street") or ""))
    city = clean_text(str(diagnosis.get("normalized_city") or ""))
    state = clean_text(str(diagnosis.get("state") or ""))
    postal_code = clean_text(str(diagnosis.get("postal_code") or ""))
    if not street or not city or not state:
        return None

    original_query = record.get("query") if isinstance(record.get("query"), dict) else {}
    original_street = clean_text(str(original_query.get("street") or ""))
    original_city = clean_text(str(original_query.get("city") or ""))
    if street == original_street and city == original_city:
        return None

    country_code = clean_text(str(original_query.get("country_code") or DEFAULT_COUNTRY_CODE)) or DEFAULT_COUNTRY_CODE
    return AddressQuery(
        address=street,
        street=street,
        city=city,
        state=state,
        postal_code=postal_code,
        country_code=country_code,
    )


def build_geocode_miss_diagnostics_report(
    *,
    cache_path: Path,
    output_json_path: Path | None = None,
    output_parquet_path: Path | None = None,
) -> dict[str, Any]:
    cache = load_cache(cache_path)
    rows: list[dict[str, Any]] = []
    classification_counts: dict[str, int] = {}
    issue_tag_counts: dict[str, int] = {}

    for record in cache.values():
        status = str(record.get("status") or "")
        if status not in {"miss", "error"}:
            continue
        diagnosis = classify_geocode_miss_record(record)
        rows.append(diagnosis)
        classification = diagnosis["classification"]
        classification_counts[classification] = classification_counts.get(classification, 0) + 1
        for tag in diagnosis["issue_tags"]:
            issue_tag_counts[tag] = issue_tag_counts.get(tag, 0) + 1

    rows.sort(key=lambda row: (row["classification"], row["city"], row["street"], row["postal_code"]))
    report = {
        "generated_at": utc_now(),
        "cache_path": str(cache_path),
        "miss_count": len(rows),
        "classification_counts": classification_counts,
        "issue_tag_counts": issue_tag_counts,
        "rows": rows,
    }

    if output_json_path is not None:
        write_json_atomic(output_json_path, report)
    if output_parquet_path is not None:
        parquet_rows = []
        for row in rows:
            payload = dict(row)
            payload["issue_tags_json"] = compact_json(row["issue_tags"])
            payload["search_params_json"] = compact_json(row["search_params"])
            payload.pop("issue_tags", None)
            payload.pop("search_params", None)
            parquet_rows.append(payload)
        write_parquet_atomic(output_parquet_path, pd.DataFrame(parquet_rows))
    return report


def parse_json_value(value: Any, default: Any) -> Any:
    if value in ("", None):
        return default
    if isinstance(value, (list, dict)):
        return value
    try:
        parsed = json.loads(str(value))
    except Exception:
        return default
    return parsed if parsed is not None else default


def cache_record_to_geo_payload(record: dict[str, Any]) -> dict[str, Any]:
    lat = record.get("lat")
    lon = record.get("lon")
    return {
        "lat": float(lat) if lat is not None else None,
        "lon": float(lon) if lon is not None else None,
        "precision": str(record.get("precision") or "none"),
        "source": str(record.get("provider") or ""),
        "display_name": str(record.get("display_name") or ""),
        "confidence": float(record.get("confidence") or 0.0),
    }


def update_location_frame(
    frame: pd.DataFrame,
    cache: dict[str, dict[str, Any]],
) -> tuple[pd.DataFrame, dict[str, dict[str, Any]], int]:
    updated_rows: list[dict[str, Any]] = []
    location_geo_by_id: dict[str, dict[str, Any]] = {}
    geocoded_count = 0

    for row in frame.to_dict(orient="records"):
        query = build_query_from_location_row(row)
        existing_geo = parse_json_value(row.get("geo_json"), {"lat": None, "lon": None, "precision": "none"})
        if query:
            cache_record = cache.get(query.key)
            if cache_record and cache_record.get("status") == "ok":
                existing_geo = cache_record_to_geo_payload(cache_record)
        if isinstance(existing_geo, dict) and existing_geo.get("lat") is not None and existing_geo.get("lon") is not None:
            geocoded_count += 1
        row["geo_json"] = compact_json(existing_geo)
        location_id = str(row.get("location_id") or "")
        if location_id:
            location_geo_by_id[location_id] = existing_geo if isinstance(existing_geo, dict) else {"lat": None, "lon": None, "precision": "none"}
        updated_rows.append(row)

    return pd.DataFrame(updated_rows), location_geo_by_id, geocoded_count


def update_service_frame(
    frame: pd.DataFrame,
    *,
    location_geo_by_id: dict[str, dict[str, Any]],
) -> tuple[pd.DataFrame, int]:
    updated_rows: list[dict[str, Any]] = []
    geocoded_service_count = 0
    now = utc_now()

    for row in frame.to_dict(orient="records"):
        addresses = parse_json_value(row.get("addresses"), [])
        field_confidence = parse_json_value(row.get("field_confidence"), {})
        current_geo = parse_json_value(row.get("geo"), {"lat": None, "lon": None, "precision": "none"})
        changed = False

        if isinstance(addresses, list):
            for address in addresses:
                if not isinstance(address, dict):
                    continue
                location_id = str(address.get("location_id") or "")
                geo_payload = location_geo_by_id.get(location_id)
                if not geo_payload:
                    continue
                if address.get("geo") != geo_payload:
                    address["geo"] = geo_payload
                    changed = True

        top_geo = next(
            (
                address.get("geo")
                for address in addresses
                if isinstance(address, dict)
                and isinstance(address.get("geo"), dict)
                and address["geo"].get("lat") is not None
                and address["geo"].get("lon") is not None
            ),
            current_geo,
        )
        if top_geo != current_geo:
            row["geo"] = compact_json(top_geo)
            changed = True
        elif not isinstance(row.get("geo"), str):
            row["geo"] = compact_json(top_geo)

        row["addresses"] = compact_json(addresses)
        if isinstance(top_geo, dict) and top_geo.get("lat") is not None and top_geo.get("lon") is not None:
            geocoded_service_count += 1
            next_confidence = max(float(field_confidence.get("geo") or 0.0), float(top_geo.get("confidence") or 0.95))
            if float(field_confidence.get("geo") or 0.0) != next_confidence:
                field_confidence["geo"] = round(next_confidence, 6)
                changed = True

        if changed:
            row["updated_at"] = now
        row["field_confidence"] = compact_json(field_confidence)
        updated_rows.append(row)

    return pd.DataFrame(updated_rows), geocoded_service_count


def refresh_portal_metadata(
    *,
    output_dir: Path,
    services_frame: pd.DataFrame,
    locations_frame: pd.DataFrame,
) -> None:
    coverage_report_path = output_dir / "extraction_coverage_report.json"
    manifest_path = output_dir / "service_portal_manifest.json"
    extraction_manifest_path = output_dir / "extraction_manifest.json"
    existing_manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}

    service_count = int(len(services_frame))
    location_count = int(len(locations_frame))
    geo_service_count = count_service_geo_rows(services_frame)
    geo_location_count = count_location_geo_rows(locations_frame)

    coverage = dict(existing_manifest.get("coverage") or {})
    coverage["geo"] = {
        "count": geo_service_count,
        "pct": float(geo_service_count / service_count) if service_count else 0.0,
    }
    coverage["location_geo"] = {
        "count": geo_location_count,
        "pct": float(geo_location_count / location_count) if location_count else 0.0,
    }
    coverage_report = {
        "service_count": service_count,
        "coverage": coverage,
    }
    write_json_atomic(coverage_report_path, coverage_report)

    artifact_row_counts = {
        "services.parquet": len(services_frame),
        "documents.portal.parquet": len(services_frame),
        "service_locations.parquet": len(locations_frame),
        "service_contacts.parquet": int(existing_manifest.get("contact_count", 0)),
        "service_hours.parquet": int(existing_manifest.get("hours_count", 0)),
        "service_requirements.parquet": int(existing_manifest.get("requirement_count", 0)),
        "service_actions.parquet": int(existing_manifest.get("action_count", 0)),
        "extraction_coverage_report.json": service_count,
    }

    artifacts: list[dict[str, Any]] = []
    for filename, row_count in artifact_row_counts.items():
        path = output_dir / filename
        if path.exists():
            artifacts.append(artifact_record_local(path, row_count=row_count))

    manifest = dict(existing_manifest)
    manifest["generated_at"] = utc_now()
    manifest["service_count"] = service_count
    manifest["location_count"] = location_count
    manifest["coverage"] = coverage
    manifest["artifacts"] = artifacts
    manifest["portal_manifest_cid"] = safe_cid_for_obj(manifest)
    write_json_atomic(manifest_path, manifest)
    write_json_atomic(extraction_manifest_path, manifest)


def count_service_geo_rows(frame: pd.DataFrame) -> int:
    count = 0
    for value in frame["geo"].tolist():
        geo = parse_json_value(value, {})
        if isinstance(geo, dict) and geo.get("lat") is not None and geo.get("lon") is not None:
            count += 1
    return count


def count_location_geo_rows(frame: pd.DataFrame) -> int:
    count = 0
    for value in frame["geo_json"].tolist():
        geo = parse_json_value(value, {})
        if isinstance(geo, dict) and geo.get("lat") is not None and geo.get("lon") is not None:
            count += 1
    return count


def build_geocoder(
    *,
    provider: str,
    nominatim_url: str,
    user_agent: str,
    email: str,
    min_delay_seconds: float,
    timeout_seconds: float,
    max_retries: int,
) -> AddressGeocoder:
    provider_name = provider.strip().lower()
    if provider_name == "nominatim":
        return NominatimGeocoder(
            base_url=nominatim_url,
            user_agent=user_agent,
            email=email,
            min_delay_seconds=min_delay_seconds,
            timeout_seconds=timeout_seconds,
            max_retries=max_retries,
        )
    raise ValueError(f"unsupported geocoder provider: {provider}")


def enrich_service_addresses(
    *,
    source_dir: Path = DEFAULT_PORTAL_DIR,
    cache_path: Path = DEFAULT_CACHE_PATH,
    provider: str = "nominatim",
    nominatim_url: str = DEFAULT_NOMINATIM_URL,
    user_agent: str = DEFAULT_USER_AGENT,
    email: str = "",
    min_delay_seconds: float = 1.1,
    timeout_seconds: float = 30.0,
    max_retries: int = 3,
    max_queries: int = 0,
    refresh_only: bool = False,
    retry_misses: bool = False,
    repair_malformed_retries: bool = True,
    overwrite: bool = False,
    geocoder: AddressGeocoder | None = None,
) -> dict[str, Any]:
    services_path = source_dir / "services.parquet"
    portal_path = source_dir / "documents.portal.parquet"
    locations_path = source_dir / "service_locations.parquet"
    if not services_path.exists() or not portal_path.exists() or not locations_path.exists():
        raise FileNotFoundError(f"expected portal artifacts in {source_dir}")

    geocoder = geocoder or build_geocoder(
        provider=provider,
        nominatim_url=nominatim_url,
        user_agent=user_agent,
        email=email,
        min_delay_seconds=min_delay_seconds,
        timeout_seconds=timeout_seconds,
        max_retries=max_retries,
    )
    cache = load_cache(cache_path)
    logger.info("loaded %d cached geocode entries from %s", len(cache), cache_path)

    locations_frame = pd.read_parquet(locations_path).fillna("")
    services_frame = pd.read_parquet(services_path).fillna("")

    unique_queries: dict[str, AddressQuery] = {}
    for row in locations_frame.to_dict(orient="records"):
        query = build_query_from_location_row(row)
        if not query:
            continue
        if not overwrite:
            existing_geo = parse_json_value(row.get("geo_json"), {"lat": None, "lon": None})
            if isinstance(existing_geo, dict) and existing_geo.get("lat") is not None and existing_geo.get("lon") is not None:
                continue
        unique_queries.setdefault(query.key, query)

    def query_priority(key: str) -> tuple[int, str]:
        record = cache.get(key)
        if retry_misses and isinstance(record, dict) and record.get("status") in {"miss", "error"}:
            return (0, key)
        if key not in cache:
            return (1, key)
        return (2, key)

    query_keys = sorted(unique_queries.keys(), key=query_priority)

    fetched = 0
    hits = 0
    misses = 0
    errors = 0
    reused = 0
    repaired_retry_queries = 0
    if not refresh_only:
        for key in query_keys:
            existing_record = cache.get(key)
            should_retry_miss = retry_misses and isinstance(existing_record, dict) and existing_record.get("status") in {"miss", "error"}
            if existing_record is not None and not overwrite and not should_retry_miss:
                reused += 1
                continue
            if max_queries > 0 and fetched >= max_queries:
                reused += 1
                continue
            geocode_query = unique_queries[key]
            if should_retry_miss and repair_malformed_retries and isinstance(existing_record, dict):
                repaired_query = build_repaired_query_for_miss_record(existing_record)
                if repaired_query is not None:
                    geocode_query = repaired_query
                    repaired_retry_queries += 1
            record = geocoder.geocode(geocode_query)
            if geocode_query != unique_queries[key]:
                original_payload = existing_record.get("query") if isinstance(existing_record, dict) and isinstance(existing_record.get("query"), dict) else {
                    "address": unique_queries[key].address,
                    "street": unique_queries[key].street,
                    "city": unique_queries[key].city,
                    "state": unique_queries[key].state,
                    "postal_code": unique_queries[key].postal_code,
                    "country_code": unique_queries[key].country_code,
                }
                record["query"] = original_payload
                record["repair_query"] = {
                    "address": geocode_query.address,
                    "street": geocode_query.street,
                    "city": geocode_query.city,
                    "state": geocode_query.state,
                    "postal_code": geocode_query.postal_code,
                    "country_code": geocode_query.country_code,
                }
                record["repair_strategy"] = "normalized_structured_repair"
            cache[key] = record
            fetched += 1
            if record.get("status") == "ok":
                hits += 1
            elif record.get("status") == "miss":
                misses += 1
            else:
                errors += 1
            logger.info(
                "geocode %d/%s status=%s query=%s",
                fetched,
                max_queries if max_queries > 0 else len(query_keys),
                record.get("status") or "unknown",
                geocode_query.display,
            )
            write_json_atomic(cache_path, cache)

    updated_locations_frame, location_geo_by_id, geocoded_location_count = update_location_frame(locations_frame, cache)
    updated_services_frame, geocoded_service_count = update_service_frame(
        services_frame,
        location_geo_by_id=location_geo_by_id,
    )

    write_parquet_atomic(locations_path, updated_locations_frame)
    write_parquet_atomic(services_path, updated_services_frame)
    write_parquet_atomic(portal_path, updated_services_frame)
    refresh_portal_metadata(output_dir=source_dir, services_frame=updated_services_frame, locations_frame=updated_locations_frame)

    return {
        "source_dir": str(source_dir),
        "provider": geocoder.provider_name,
        "cache_path": str(cache_path),
        "unique_queries": len(unique_queries),
        "fetched_queries": fetched,
        "cache_hits_reused": reused,
        "repaired_retry_queries": repaired_retry_queries,
        "geocode_hits": hits,
        "geocode_misses": misses,
        "geocode_errors": errors,
        "service_geo_count": geocoded_service_count,
        "location_geo_count": geocoded_location_count,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Enrich portal service addresses with cached geocoded coordinates")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_PORTAL_DIR)
    parser.add_argument("--cache-path", type=Path, default=DEFAULT_CACHE_PATH)
    parser.add_argument("--provider", default="nominatim")
    parser.add_argument("--nominatim-url", default=DEFAULT_NOMINATIM_URL)
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    parser.add_argument("--email", default="")
    parser.add_argument("--min-delay-seconds", type=float, default=1.1)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--max-queries", type=int, default=0, help="Optional cap for actual network lookups in a resumable partial run; 0 means no cap")
    parser.add_argument("--refresh-only", action="store_true", help="Skip network geocoding and only rewrite parquet/manifest outputs from cache")
    parser.add_argument("--retry-misses", action="store_true", help="Retry cached miss/error entries with the current query normalization logic")
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    result = enrich_service_addresses(
        source_dir=args.source_dir,
        cache_path=args.cache_path,
        provider=args.provider,
        nominatim_url=args.nominatim_url,
        user_agent=args.user_agent,
        email=args.email,
        min_delay_seconds=args.min_delay_seconds,
        timeout_seconds=args.timeout_seconds,
        max_retries=args.max_retries,
        max_queries=args.max_queries,
        refresh_only=args.refresh_only,
        retry_misses=args.retry_misses,
        overwrite=args.overwrite,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
