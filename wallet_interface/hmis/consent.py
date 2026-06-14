"""Consent evaluation helpers for HMIS workflows."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from .errors import HmisConsentError, HmisPolicyError
from .models import HmisConsentRecord


def _parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    return datetime.fromisoformat(normalized)


@dataclass(slots=True)
class HmisConsentDecision:
    allowed: bool
    basis: str
    scope: str
    program_ref: str | None = None
    consent_id: str | None = None
    warnings: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)


def evaluate_hmis_consent(
    consent: HmisConsentRecord,
    *,
    required_scope: str,
    program_ref: str | None = None,
    now: datetime | None = None,
    allowed_bases: Sequence[str] = ("client_consent", "program_operational_authority"),
    require_program_scope: bool = True,
) -> HmisConsentDecision:
    current_time = now or datetime.now(timezone.utc)

    if consent.status != "active":
        raise HmisConsentError(f"HMIS consent {consent.consent_id} is not active")
    if consent.basis not in allowed_bases:
        raise HmisPolicyError(f"HMIS basis {consent.basis} is not allowed for this action")
    if required_scope not in consent.authorized_scopes:
        raise HmisConsentError(f"HMIS consent {consent.consent_id} does not authorize {required_scope}")

    effective_at = _parse_utc(consent.effective_at)
    expires_at = _parse_utc(consent.expires_at)
    revoked_at = _parse_utc(consent.revoked_at)

    if effective_at and current_time < effective_at:
        raise HmisConsentError(f"HMIS consent {consent.consent_id} is not effective yet")
    if expires_at and current_time > expires_at:
        raise HmisConsentError(f"HMIS consent {consent.consent_id} has expired")
    if revoked_at and current_time >= revoked_at:
        raise HmisConsentError(f"HMIS consent {consent.consent_id} has been revoked")

    if require_program_scope and program_ref:
        if consent.authorized_program_refs and program_ref not in consent.authorized_program_refs:
            raise HmisConsentError(
                f"HMIS consent {consent.consent_id} does not authorize program {program_ref}"
            )

    warnings: list[str] = []
    if not consent.authorized_program_refs:
        warnings.append("consent has no explicit program scoping")

    return HmisConsentDecision(
        allowed=True,
        basis=consent.basis,
        scope=required_scope,
        program_ref=program_ref,
        consent_id=consent.consent_id,
        warnings=tuple(warnings),
        metadata={"policy_version": consent.policy_version, "copy_version": consent.copy_version},
    )