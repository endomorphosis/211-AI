"""Field mapping helpers for canonical HMIS payloads."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Sequence

from .errors import HmisMappingError


@dataclass(frozen=True, slots=True)
class HmisFieldMapping:
    source_field: str
    target_field: str
    required: bool = False
    default_value: Any = None


@dataclass(slots=True)
class HmisMappingRegistry:
    version: str
    mappings: Dict[str, tuple[HmisFieldMapping, ...]] = field(default_factory=dict)

    def register(self, mapping_name: str, fields: Sequence[HmisFieldMapping]) -> None:
        if not mapping_name.strip():
            raise HmisMappingError("mapping name must be non-empty")
        if not fields:
            raise HmisMappingError(f"mapping {mapping_name} must contain at least one field")
        self.mappings[mapping_name] = tuple(fields)

    def map_payload(self, mapping_name: str, source: Mapping[str, Any]) -> dict[str, Any]:
        if mapping_name not in self.mappings:
            raise HmisMappingError(f"unknown HMIS mapping: {mapping_name}")

        result: dict[str, Any] = {}
        missing_required: list[str] = []

        for field_map in self.mappings[mapping_name]:
            if field_map.source_field in source and source[field_map.source_field] is not None:
                result[field_map.target_field] = source[field_map.source_field]
                continue
            if field_map.default_value is not None:
                result[field_map.target_field] = field_map.default_value
                continue
            if field_map.required:
                missing_required.append(field_map.source_field)

        if missing_required:
            raise HmisMappingError(
                f"mapping {mapping_name} is missing required fields: {', '.join(sorted(missing_required))}"
            )

        return result