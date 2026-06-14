from __future__ import annotations

import pytest

from wallet_interface.hmis import HmisFieldMapping, HmisMappingError, HmisMappingRegistry


def test_hmis_mapping_registry_maps_required_and_default_values() -> None:
    registry = HmisMappingRegistry(version="2026.05")
    registry.register(
        "referral",
        [
            HmisFieldMapping("client_id", "ClientID", required=True),
            HmisFieldMapping("program_id", "ProjectID", required=True),
            HmisFieldMapping("source", "Source", default_value="abby"),
        ],
    )

    payload = registry.map_payload("referral", {"client_id": "c-1", "program_id": "p-1"})

    assert payload == {"ClientID": "c-1", "ProjectID": "p-1", "Source": "abby"}


def test_hmis_mapping_registry_rejects_missing_required_fields() -> None:
    registry = HmisMappingRegistry(version="2026.05")
    registry.register("lookup", [HmisFieldMapping("client_id", "ClientID", required=True)])

    with pytest.raises(HmisMappingError, match="missing required fields"):
        registry.map_payload("lookup", {})


def test_hmis_mapping_registry_rejects_unknown_mapping_name() -> None:
    registry = HmisMappingRegistry(version="2026.05")

    with pytest.raises(HmisMappingError, match="unknown HMIS mapping"):
        registry.map_payload("missing", {})