from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from scraper.browser_graphrag_corpus import coerce_service_geo_point
from scraper.enrich_service_addresses import (
    AddressQuery,
    build_geocode_miss_diagnostics_report,
    build_nominatim_search_attempts,
    build_repaired_query_for_miss_record,
    classify_geocode_miss_record,
    diagnose_address_query,
    enrich_service_addresses,
    normalized_query_city,
    normalized_query_street,
    normalized_query_street_without_unit,
)


class FakeGeocoder:
    provider_name = "fake"

    def __init__(self) -> None:
        self.calls: list[str] = []

    def geocode(self, query: AddressQuery) -> dict[str, object]:
        self.calls.append(query.display)
        return {
            "provider": self.provider_name,
            "status": "ok",
            "lat": 45.523064,
            "lon": -122.676483,
            "precision": "address_geocode",
            "confidence": 0.99,
            "display_name": "123 Main St, Portland, OR 97204, USA",
            "queried_at": "2026-05-09T00:00:00+00:00",
            "query": {
                "address": query.address,
                "street": query.street,
                "city": query.city,
                "state": query.state,
                "postal_code": query.postal_code,
                "country_code": query.country_code,
            },
        }


def _write_manifest_files(source_dir: Path, *, service_count: int, location_count: int) -> None:
    manifest = {
        "schemaVersion": 1,
        "generated_at": "2026-05-09T00:00:00+00:00",
        "service_count": service_count,
        "contact_count": 0,
        "location_count": location_count,
        "hours_count": 0,
        "requirement_count": 0,
        "action_count": 0,
        "coverage": {},
        "artifacts": [],
    }
    (source_dir / "service_portal_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (source_dir / "extraction_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (source_dir / "extraction_coverage_report.json").write_text(json.dumps({"service_count": service_count, "coverage": {}}), encoding="utf-8")


def _write_parquet(path: Path, rows: list[dict[str, object]]) -> None:
    pd.DataFrame(rows).to_parquet(path, index=False)


def test_enrich_service_addresses_updates_portal_outputs(tmp_path: Path) -> None:
    source_dir = tmp_path / "portal"
    source_dir.mkdir(parents=True, exist_ok=True)

    services_row = {
        "service_doc_id": "service:abc123",
        "doc_type": "service",
        "title": "Community Pantry",
        "provider_name": "Community Pantry",
        "program_name": "",
        "description": "Food support",
        "categories": "Food",
        "source_url": "https://example.org/service",
        "source_content_cid": "cid-service",
        "source_page_cid": "cid-page",
        "host": "example.org",
        "city": "Portland",
        "state": "OR",
        "addresses": json.dumps(
            [
                {
                    "location_id": "service:abc123:location:0",
                    "address": "123 Main St Portland, OR 97204",
                    "street": "123 Main St",
                    "city": "Portland",
                    "state": "OR",
                    "postal_code": "97204",
                    "geo": {"lat": None, "lon": None, "precision": "address_query"},
                    "maps_query": "123 Main St Portland, OR 97204 Portland OR 97204",
                    "google_maps_url": "https://www.google.com/maps/search/?api=1&query=123+Main+St",
                    "apple_maps_url": "https://maps.apple.com/?q=123+Main+St",
                    "geo_url": "geo:0,0?q=123+Main+St",
                    "confidence": 0.99,
                }
            ],
            separators=(",", ":"),
        ),
        "phones": "[]",
        "emails": "[]",
        "websites": "[]",
        "hours": "[]",
        "eligibility": "[]",
        "intake_steps": "[]",
        "required_documents": "[]",
        "fees": "[]",
        "languages": "[]",
        "accessibility": "[]",
        "geo": json.dumps({"lat": None, "lon": None, "precision": "none"}, separators=(",", ":")),
        "source_extracts": "{}",
        "field_confidence": json.dumps({"geo": 0.0}, separators=(",", ":")),
        "updated_at": "2026-05-09T00:00:00+00:00",
        "travel_info": "[]",
        "area_served": "[]",
    }
    location_row = {
        "service_doc_id": "service:abc123",
        "location_id": "service:abc123:location:0",
        "label": "service_address",
        "address": "123 Main St Portland, OR 97204",
        "street": "123 Main St",
        "city": "Portland",
        "state": "OR",
        "postal_code": "97204",
        "source_url": "https://example.org/service",
        "source_content_cid": "cid-service",
        "source_page_cid": "cid-page",
        "source_text": "123 Main St Portland, OR 97204",
        "source_span_start": 0,
        "source_span_end": 30,
        "source_field": "service_text",
        "extraction_method": "service_metadata",
        "confidence": 0.99,
        "maps_query": "123 Main St Portland, OR 97204 Portland OR 97204",
        "apple_maps_url": "https://maps.apple.com/?q=123+Main+St",
        "google_maps_url": "https://www.google.com/maps/search/?api=1&query=123+Main+St",
        "geo_url": "geo:0,0?q=123+Main+St",
        "geo_json": json.dumps({"lat": None, "lon": None, "precision": "address_query"}, separators=(",", ":")),
    }

    _write_parquet(source_dir / "services.parquet", [services_row])
    _write_parquet(source_dir / "documents.portal.parquet", [services_row])
    _write_parquet(source_dir / "service_locations.parquet", [location_row])

    _write_manifest_files(source_dir, service_count=1, location_count=1)

    geocoder = FakeGeocoder()
    cache_path = source_dir / "cache.json"
    result = enrich_service_addresses(
        source_dir=source_dir,
        cache_path=cache_path,
        geocoder=geocoder,
    )

    assert result["unique_queries"] == 1
    assert result["fetched_queries"] == 1
    assert result["service_geo_count"] == 1
    assert result["location_geo_count"] == 1
    assert geocoder.calls == ["123 Main St Portland, OR 97204 Portland OR 97204"]

    updated_services = pd.read_parquet(source_dir / "services.parquet").to_dict(orient="records")
    updated_locations = pd.read_parquet(source_dir / "service_locations.parquet").to_dict(orient="records")
    updated_portal = pd.read_parquet(source_dir / "documents.portal.parquet").to_dict(orient="records")

    service_geo = json.loads(updated_services[0]["geo"])
    assert service_geo["lat"] == 45.523064
    assert service_geo["lon"] == -122.676483
    assert service_geo["source"] == "fake"

    addresses = json.loads(updated_services[0]["addresses"])
    assert addresses[0]["geo"]["lat"] == 45.523064
    assert addresses[0]["geo"]["precision"] == "address_geocode"
    assert json.loads(updated_locations[0]["geo_json"])["lon"] == -122.676483
    assert json.loads(updated_portal[0]["geo"])["lat"] == 45.523064

    coverage = json.loads((source_dir / "extraction_coverage_report.json").read_text())
    assert coverage["coverage"]["geo"]["count"] == 1
    assert coverage["coverage"]["location_geo"]["count"] == 1

    persisted_cache = json.loads(cache_path.read_text())
    assert len(persisted_cache) == 1


def test_coerce_service_geo_point_prefers_address_level_coordinates() -> None:
    document = {
        "geo": {"lat": None, "lon": None, "precision": "none"},
        "city": "Portland",
        "state": "OR",
        "addresses": [
            {
                "city": "Portland",
                "state": "OR",
                "geo": {
                    "lat": 45.523064,
                    "lon": -122.676483,
                    "precision": "address_geocode",
                    "source": "fake",
                },
            }
        ],
    }
    geo = coerce_service_geo_point(document, {})
    assert geo["lat"] == 45.523064
    assert geo["lon"] == -122.676483
    assert geo["precision"] == "address_geocode"
    assert geo["source"] == "fake"


def test_nominatim_search_attempts_normalize_malformed_city_and_street() -> None:
    query = AddressQuery(
        address="3201 Pacific Boulevard SW Albany, OR 97321",
        street="3201 Pacific Boulevard",
        city="SW Albany",
        state="OR",
        postal_code="97321",
    )

    assert normalized_query_city(query.city) == "Albany"
    assert normalized_query_street(query.address, query.street, query.city) == "3201 Pacific Boulevard SW"

    attempts = build_nominatim_search_attempts(query)
    assert attempts[0]["q"] == "3201 Pacific Boulevard SW, Albany, OR, 97321"
    assert attempts[1]["street"] == "3201 Pacific Boulevard SW"
    assert attempts[1]["city"] == "Albany"


def test_nominatim_search_attempts_strip_boilerplate_and_unit_suffix() -> None:
    query = AddressQuery(
        address="10 high school credits and/or their GED or high school diploma upon completion. 23861 Dodds Road Bend, OR 97701",
        street="10 high school credits and/or their GED or high school diploma upon completion. 23861 Dodds Road",
        city="Bend",
        state="OR",
        postal_code="97701",
    )
    assert normalized_query_street(query.address, query.street, query.city) == "23861 Dodds Road"
    assert normalized_query_street_without_unit(query.address, query.street, query.city) == "23861 Dodds Road"

    suite_query = AddressQuery(
        address="3772 Portland Road NE Suite A Salem, OR 97301",
        street="3772 Portland Road",
        city="NE Suite A Salem",
        state="OR",
        postal_code="97301",
    )
    assert normalized_query_city(suite_query.city) == "Salem"
    assert normalized_query_street(suite_query.address, suite_query.street, suite_query.city) == "3772 Portland Road NE Suite A"
    assert normalized_query_street_without_unit(suite_query.address, suite_query.street, suite_query.city) == "3772 Portland Road NE"

    attempts = build_nominatim_search_attempts(suite_query)
    assert attempts[0]["q"] == "3772 Portland Road NE, Salem, OR, 97301"
    assert attempts[1]["street"] == "3772 Portland Road NE"


def test_normalized_query_street_does_not_treat_suite_as_direction() -> None:
    query = AddressQuery(
        address="1216 Moore Street Suite #214 Brookings, OR 97415",
        street="1216 Moore Street",
        city="Suite #214 Brookings",
        state="OR",
        postal_code="97415",
    )

    assert normalized_query_city(query.city) == "Brookings"
    assert normalized_query_street(query.address, query.street, query.city) == "1216 Moore Street"
    assert normalized_query_street_without_unit(query.address, query.street, query.city) == "1216 Moore Street"


def test_normalizer_recovers_split_highway_number_and_city_from_address() -> None:
    query = AddressQuery(
        address="38952 Highway 226 Scio, OR 97374",
        street="38952 Highway",
        city="226 Scio",
        state="OR",
        postal_code="97374",
    )

    assert normalized_query_city(query.city) == "Scio"
    assert normalized_query_street(query.address, query.street, query.city) == "38952 Highway 226"
    attempts = build_nominatim_search_attempts(query)
    assert attempts[0]["q"] == "38952 Highway 226, Scio, OR, 97374"


def test_normalizer_recovers_split_multiword_city_from_address() -> None:
    query = AddressQuery(
        address="1255 NW US 101 Lincoln City, OR 97367",
        street="1255 NW US 101 Lincoln",
        city="City",
        state="OR",
        postal_code="97367",
    )

    assert normalized_query_street(query.address, query.street, query.city) == "1255 NW US 101"
    attempts = build_nominatim_search_attempts(query)
    assert attempts[0]["q"] == "1255 NW US 101, Lincoln City, OR, 97367"


def test_normalizer_keeps_final_street_suffix_when_name_contains_suffix_word() -> None:
    query = AddressQuery(
        address="500 Court Street Moro, OR 97039",
        street="500 Court Street",
        city="Moro",
        state="OR",
        postal_code="97039",
    )

    assert normalized_query_street(query.address, query.street, query.city) == "500 Court Street"
    assert build_nominatim_search_attempts(query)[0]["q"] == "500 Court Street, Moro, OR, 97039"


def test_classify_geocode_miss_record_identifies_malformed_city_and_normalization_damage() -> None:
    malformed = classify_geocode_miss_record(
        {
            "provider": "nominatim",
            "status": "miss",
            "precision": "miss",
            "query": {
                "address": "1601 E Fourth Plain Boulevard Suite A212 Vancouver, WA 98663",
                "street": "1601 E Fourth Plain Boulevard",
                "city": "Suite A212 Vancouver",
                "state": "WA",
                "postal_code": "98663",
                "country_code": "us",
            },
        }
    )
    assert malformed["classification"] == "likely_malformed_input"
    assert "city_unit_prefix" in malformed["issue_tags"]

    damaged = diagnose_address_query(
        AddressQuery(
            address="1216 Moore Street Suite #214 Brookings, OR 97415",
            street="1216 Moore Street",
            city="Suite #214 Brookings",
            state="OR",
            postal_code="97415",
        )
    )
    assert "street_direction_suite_artifact" not in damaged["issue_tags"]

    split_city = classify_geocode_miss_record(
        {
            "provider": "nominatim",
            "status": "miss",
            "precision": "miss",
            "query": {
                "address": "500 NW 6th Street Department 15 Grants Pass, OR 97526",
                "street": "500 NW 6th Street",
                "city": "Department 15 Grants Pass",
                "state": "OR",
                "postal_code": "97526",
                "country_code": "us",
            },
        }
    )
    assert split_city["classification"] == "likely_malformed_input"
    assert split_city["normalized_city"] == "Grants Pass"
    assert "city_embedded_venue" in split_city["issue_tags"]


def test_city_normalizer_strips_leading_unit_conjunction_and_mailstop_noise() -> None:
    bateman = classify_geocode_miss_record(
        {
            "provider": "nominatim",
            "status": "miss",
            "precision": "miss",
            "query": {
                "address": "40 pounds of food will be provided. 201 Bateman Drive #13 and #14 Central Point, OR 97502",
                "street": "40 pounds of food will be provided. 201 Bateman Drive",
                "city": "#13 and #14 Central Point",
                "state": "OR",
                "postal_code": "97502",
                "country_code": "us",
            },
        }
    )
    assert bateman["normalized_city"] == "Central Point"

    bethesda = classify_geocode_miss_record(
        {
            "provider": "nominatim",
            "status": "miss",
            "precision": "miss",
            "query": {
                "address": "9609 Medical Center Drive Building 9609 MSC 9760 Bethesda, MD 20892",
                "street": "9609 Medical Center Drive",
                "city": "Building 9609 MSC 9760 Bethesda",
                "state": "MD",
                "postal_code": "20892",
                "country_code": "us",
            },
        }
    )
    assert bethesda["normalized_city"] == "Bethesda"


def test_build_repaired_query_for_malformed_miss_uses_normalized_city_and_street() -> None:
    repaired = build_repaired_query_for_miss_record(
        {
            "provider": "nominatim",
            "status": "miss",
            "precision": "miss",
            "query": {
                "address": "3772 Portland Road NE Suite A Salem, OR 97301",
                "street": "3772 Portland Road",
                "city": "NE Suite A Salem",
                "state": "OR",
                "postal_code": "97301",
                "country_code": "us",
            },
        }
    )
    assert repaired is not None
    assert repaired.street == "3772 Portland Road NE"
    assert repaired.city == "Salem"
    assert repaired.postal_code == "97301"


def test_build_geocode_miss_diagnostics_report_writes_summary_and_parquet(tmp_path: Path) -> None:
    cache_path = tmp_path / "cache.json"
    cache_path.write_text(
        json.dumps(
            {
                "malformed": {
                    "provider": "nominatim",
                    "status": "miss",
                    "precision": "miss",
                    "query": {
                        "address": "182 SW Academy Street Suite 302 Dallas, OR 97338",
                        "street": "182 SW Academy Street",
                        "city": "Suite 302 Dallas",
                        "state": "OR",
                        "postal_code": "97338",
                        "country_code": "us",
                    },
                },
                "clean": {
                    "provider": "nominatim",
                    "status": "miss",
                    "precision": "miss",
                    "query": {
                        "address": "840 SW Fourth Avenue Ontario, OR 97914",
                        "street": "840 SW Fourth Avenue",
                        "city": "Ontario",
                        "state": "OR",
                        "postal_code": "97914",
                        "country_code": "us",
                    },
                },
            }
        ),
        encoding="utf-8",
    )

    output_json = tmp_path / "report.json"
    output_parquet = tmp_path / "report.parquet"
    report = build_geocode_miss_diagnostics_report(
        cache_path=cache_path,
        output_json_path=output_json,
        output_parquet_path=output_parquet,
    )

    assert report["miss_count"] == 2
    assert report["classification_counts"]["likely_malformed_input"] == 1
    assert report["classification_counts"]["likely_provider_or_coverage_miss"] == 1
    assert output_json.exists()
    assert output_parquet.exists()


def test_enrich_service_addresses_retries_cached_miss_with_cap(tmp_path: Path) -> None:
    source_dir = tmp_path / "portal"
    source_dir.mkdir(parents=True, exist_ok=True)

    service_row = {
        "service_doc_id": "service:miss123",
        "doc_type": "service",
        "title": "Retry Service",
        "provider_name": "Retry Service",
        "program_name": "",
        "description": "Support",
        "categories": "Housing",
        "source_url": "https://example.org/retry",
        "source_content_cid": "cid-service",
        "source_page_cid": "cid-page",
        "host": "example.org",
        "city": "Salem",
        "state": "OR",
        "addresses": json.dumps(
            [
                {
                    "location_id": "service:miss123:location:0",
                    "address": "3772 Portland Road NE Suite A Salem, OR 97301",
                    "street": "3772 Portland Road",
                    "city": "NE Suite A Salem",
                    "state": "OR",
                    "postal_code": "97301",
                    "geo": {"lat": None, "lon": None, "precision": "address_query"},
                }
            ],
            separators=(",", ":"),
        ),
        "phones": "[]",
        "emails": "[]",
        "websites": "[]",
        "hours": "[]",
        "eligibility": "[]",
        "intake_steps": "[]",
        "required_documents": "[]",
        "fees": "[]",
        "languages": "[]",
        "accessibility": "[]",
        "geo": json.dumps({"lat": None, "lon": None, "precision": "none"}, separators=(",", ":")),
        "source_extracts": "{}",
        "field_confidence": json.dumps({"geo": 0.0}, separators=(",", ":")),
        "updated_at": "2026-05-09T00:00:00+00:00",
        "travel_info": "[]",
        "area_served": "[]",
    }
    location_row = {
        "service_doc_id": "service:miss123",
        "location_id": "service:miss123:location:0",
        "label": "service_address",
        "address": "3772 Portland Road NE Suite A Salem, OR 97301",
        "street": "3772 Portland Road",
        "city": "NE Suite A Salem",
        "state": "OR",
        "postal_code": "97301",
        "source_url": "https://example.org/retry",
        "source_content_cid": "cid-service",
        "source_page_cid": "cid-page",
        "source_text": "3772 Portland Road NE Suite A Salem, OR 97301",
        "source_span_start": 0,
        "source_span_end": 44,
        "source_field": "service_text",
        "extraction_method": "service_metadata",
        "confidence": 0.99,
        "maps_query": "3772 Portland Road NE Suite A Salem, OR 97301 Salem OR 97301",
        "apple_maps_url": "https://maps.apple.com/?q=3772+Portland+Road",
        "google_maps_url": "https://www.google.com/maps/search/?api=1&query=3772+Portland+Road",
        "geo_url": "geo:0,0?q=3772+Portland+Road",
        "geo_json": json.dumps({"lat": None, "lon": None, "precision": "address_query"}, separators=(",", ":")),
    }

    _write_parquet(source_dir / "services.parquet", [service_row])
    _write_parquet(source_dir / "documents.portal.parquet", [service_row])
    _write_parquet(source_dir / "service_locations.parquet", [location_row])
    _write_manifest_files(source_dir, service_count=1, location_count=1)

    cache_path = source_dir / "cache.json"
    cached_query = AddressQuery(
        address=location_row["address"],
        street=location_row["street"],
        city=location_row["city"],
        state=location_row["state"],
        postal_code=location_row["postal_code"],
    )
    cache_path.write_text(
        json.dumps(
            {
                cached_query.key: {
                    "provider": "fake",
                    "status": "miss",
                    "lat": None,
                    "lon": None,
                    "precision": "miss",
                    "confidence": 0.0,
                    "display_name": "",
                    "queried_at": "2026-05-09T00:00:00+00:00",
                    "query": {
                        "address": cached_query.address,
                        "street": cached_query.street,
                        "city": cached_query.city,
                        "state": cached_query.state,
                        "postal_code": cached_query.postal_code,
                        "country_code": cached_query.country_code,
                    },
                }
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    geocoder = FakeGeocoder()
    result = enrich_service_addresses(
        source_dir=source_dir,
        cache_path=cache_path,
        geocoder=geocoder,
        retry_misses=True,
        max_queries=1,
    )

    assert result["fetched_queries"] == 1
    assert result["repaired_retry_queries"] == 1
    assert result["cache_hits_reused"] == 0
    assert result["service_geo_count"] == 1
    assert geocoder.calls == ["3772 Portland Road NE Salem OR 97301"]
