"""Base HMIS adapter protocol."""

from __future__ import annotations

from typing import Any, Mapping, Protocol, runtime_checkable

from ..models import HmisActionType, HmisAdapterCapabilities, HmisAdapterResult


@runtime_checkable
class HmisAdapter(Protocol):
    """Transport adapter contract for canonical HMIS actions."""

    name: str

    def capabilities(self) -> HmisAdapterCapabilities:
        """Return the supported HMIS operations for this adapter."""

    def execute(
        self,
        *,
        action_type: HmisActionType,
        payload: Mapping[str, Any],
        context: Mapping[str, Any] | None = None,
    ) -> HmisAdapterResult:
        """Execute one canonical HMIS action and return a normalized result."""