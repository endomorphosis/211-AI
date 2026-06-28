from __future__ import annotations

import json
from pathlib import Path

from scripts import geocode_search_repair as repair


def test_extract_candidate_address_strings_parses_title_and_description() -> None:
    text = (
        "1225 HIGHWAY 101, FLORENCE, OR 97439 | RE/MAX "
        "Advantage Dental+, 1225 Highway 101, # U, Florence, OR 97439, US - MapQuest"
    )
    candidates = repair.extract_candidate_address_strings(text)
    assert "1225 HIGHWAY 101, FLORENCE, OR 97439" in candidates


def test_build_query_from_address_string_returns_structured_query() -> None:
    query = repair.build_query_from_address_string("1225 Highway 101, Florence, Oregon 97439")
    assert query is not None
    assert query.street == "1225 Highway 101"
    assert query.city == "Florence"
    assert query.state == "OR"
    assert query.postal_code == "97439"


def test_build_search_queries_deduplicates_values() -> None:
    row = {
        "search_query_quoted": "\"1225 Highway 101\" \"Florence\" OR 97439",
        "search_query": "1225 Highway 101 Florence OR 97439",
        "normalized_address": "1225 Highway 101 Florence, OR 97439",
        "address": "1225 Highway 101 Florence, OR 97439",
    }
    queries = repair.build_search_queries(row)
    assert queries[0] == "\"1225 Highway 101\" \"Florence\" OR 97439"
    assert len(queries) == 3


def test_repair_handoff_batch_updates_cache_and_report(tmp_path: Path, monkeypatch) -> None:
    source_dir = tmp_path / "portal"
    source_dir.mkdir(parents=True, exist_ok=True)
    handoff_path = source_dir / "handoff.json"
    cache_path = source_dir / "cache.json"
    report_path = source_dir / "report.json"
    progress_path = source_dir / "progress.json"

    cache_payload = {
        "row-1": {
            "provider": "nominatim",
            "status": "miss",
            "query": {
                "address": "1225 Highway 101 Florence, OR 97439",
                "street": "1225 Highway",
                "city": "101 Florence",
                "state": "OR",
                "postal_code": "97439",
                "country_code": "us",
            },
        }
    }
    cache_path.write_text(json.dumps(cache_payload), encoding="utf-8")
    handoff_path.write_text(
        json.dumps(
            {
                "rows": [
                    {
                        "cache_key": "row-1",
                        "classification": "likely_provider_or_coverage_miss",
                        "search_query": "1225 Highway 101 Florence OR 97439",
                        "search_query_quoted": "\"1225 Highway 101\" \"Florence\" OR 97439",
                        "normalized_address": "1225 Highway 101 Florence, OR 97439",
                        "address": "1225 Highway 101 Florence, OR 97439",
                        "street": "1225 Highway",
                        "city": "101 Florence",
                        "state": "OR",
                        "postal_code": "97439",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    class FakeSearchClient:
        def search(self, query: str, *, count: int) -> list[dict[str, str]]:
            return [
                {
                    "title": "1225 Highway 101, Florence, OR 97439 - Example",
                    "description": "Primary location 1225 Highway 101, Florence, OR 97439",
                }
            ]

    class FakeGeocoder:
        def geocode(self, query):
            return {
                "provider": "nominatim",
                "status": "ok",
                "lat": 44.0,
                "lon": -124.0,
                "precision": "address_geocode",
                "confidence": 0.9,
                "display_name": "1225 Highway 101, Florence, OR 97439",
                "queried_at": "2026-05-09T00:00:00Z",
                "query": {
                    "address": query.address,
                    "street": query.street,
                    "city": query.city,
                    "state": query.state,
                    "postal_code": query.postal_code,
                    "country_code": query.country_code,
                },
            }

    monkeypatch.setattr(repair, "BraveSearchRepairClient", lambda **_: FakeSearchClient())
    monkeypatch.setattr(repair, "NominatimGeocoder", lambda **_: FakeGeocoder())
    monkeypatch.setattr(repair, "enrich_service_addresses", lambda **_: {"service_geo_count": 1, "location_geo_count": 1})
    monkeypatch.setattr(
        repair,
        "build_search_handoff",
        lambda source_dir, cache_path: {
            "miss_count": 0,
            "classification_counts": {},
            "search_handoff_json": str(source_dir / "handoff.json"),
            "search_handoff_parquet": str(source_dir / "handoff.parquet"),
        },
    )

    report = repair.repair_handoff_batch(
        source_dir=source_dir,
        cache_path=cache_path,
        handoff_json_path=handoff_path,
        report_path=report_path,
        max_rows=1,
        progress_path=progress_path,
    )

    assert report["repaired_rows"] == 1
    updated_cache = json.loads(cache_path.read_text())
    assert updated_cache["row-1"]["status"] == "ok"
    assert updated_cache["row-1"]["repair_strategy"] == "search_extract"
    assert report_path.exists()
    progress = json.loads(progress_path.read_text(encoding="utf-8"))
    assert progress["status"] == "completed"
    assert progress["attempted_rows"] == 1
    assert progress["repaired_rows"] == 1
