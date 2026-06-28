"""Canonical HMIS integration models."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Literal, Mapping, Sequence

HmisActionType = Literal[
    "lookup_client",
    "lookup_household",
    "list_program_links",
    "create_referral_draft",
    "validate_referral_draft",
    "submit_referral",
    "sync_referral_status",
    "create_enrollment_draft",
    "submit_enrollment",
    "link_external_record",
    "reject_match",
    "resolve_reconciliation_item",
]

HmisLinkStatus = Literal["proposed", "verified", "rejected", "merged"]
HmisRecordStatus = Literal["draft", "pending", "active", "closed", "rejected", "error"]
HmisConsentStatus = Literal["draft", "active", "expired", "revoked", "superseded", "policy_blocked"]
HmisSyncStatus = Literal["pending", "success", "failed", "retryable", "reconciliation_required"]


@dataclass(slots=True)
class HmisClientLink:
    local_subject_ref: str
    external_client_id: str | None = None
    status: HmisLinkStatus = "proposed"
    match_confidence: float | None = None
    matched_fields: tuple[str, ...] = ()
    candidate_ids: tuple[str, ...] = ()
    reviewed_by_actor_id: str | None = None
    reviewed_at: str | None = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class HmisHouseholdLink:
    local_household_ref: str
    external_household_id: str | None = None
    status: HmisLinkStatus = "proposed"
    relationship_summary: str | None = None
    match_confidence: float | None = None
    reviewed_by_actor_id: str | None = None
    reviewed_at: str | None = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class HmisProgramLink:
    local_program_ref: str
    external_program_id: str | None = None
    external_project_id: str | None = None
    status: HmisLinkStatus = "proposed"
    match_confidence: float | None = None
    active_from: str | None = None
    active_until: str | None = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class HmisReferralRecord:
    local_referral_ref: str
    local_subject_ref: str
    destination_program_ref: str
    external_referral_id: str | None = None
    source_program_ref: str | None = None
    status: HmisRecordStatus = "draft"
    status_detail: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    consent_id: str | None = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class HmisEnrollmentRecord:
    local_enrollment_ref: str
    local_subject_ref: str
    destination_program_ref: str
    external_enrollment_id: str | None = None
    status: HmisRecordStatus = "draft"
    created_at: str | None = None
    updated_at: str | None = None
    consent_id: str | None = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class HmisConsentRecord:
    consent_id: str
    subject_ref: str
    status: HmisConsentStatus
    basis: str
    purpose: str
    authorized_scopes: tuple[str, ...] = ()
    authorized_program_refs: tuple[str, ...] = ()
    effective_at: str | None = None
    expires_at: str | None = None
    revoked_at: str | None = None
    evidence_ref: str | None = None
    copy_version: str | None = None
    policy_version: str | None = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class HmisSyncEvent:
    event_id: str
    action_type: HmisActionType
    actor_id: str
    local_ref: str | None = None
    external_ref: str | None = None
    adapter_name: str | None = None
    status: HmisSyncStatus = "pending"
    request_payload_hash: str | None = None
    response_summary: str | None = None
    occurred_at: str | None = None
    retry_count: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class HmisAdapterCapabilities:
    supports_lookup: bool = False
    supports_referral_submit: bool = False
    supports_enrollment_submit: bool = False
    supports_status_sync: bool = False
    supports_reconciliation: bool = False
    supports_manual_review_packets: bool = False


@dataclass(slots=True)
class HmisAdapterResult:
    ok: bool
    action_type: HmisActionType
    adapter_name: str
    status: HmisSyncStatus
    summary: str
    external_refs: Dict[str, str] = field(default_factory=dict)
    normalized_payload: Dict[str, Any] = field(default_factory=dict)
    errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    retryable: bool = False
    reconciliation_required: bool = False

    @classmethod
    def success(
        cls,
        *,
        action_type: HmisActionType,
        adapter_name: str,
        summary: str,
        external_refs: Mapping[str, str] | None = None,
        normalized_payload: Mapping[str, Any] | None = None,
        warnings: Sequence[str] = (),
    ) -> "HmisAdapterResult":
        return cls(
            ok=True,
            action_type=action_type,
            adapter_name=adapter_name,
            status="success",
            summary=summary,
            external_refs=dict(external_refs or {}),
            normalized_payload=dict(normalized_payload or {}),
            warnings=tuple(warnings),
        )

    @classmethod
    def failure(
        cls,
        *,
        action_type: HmisActionType,
        adapter_name: str,
        summary: str,
        errors: Sequence[str],
        retryable: bool = False,
        reconciliation_required: bool = False,
        normalized_payload: Mapping[str, Any] | None = None,
        warnings: Sequence[str] = (),
    ) -> "HmisAdapterResult":
        return cls(
            ok=False,
            action_type=action_type,
            adapter_name=adapter_name,
            status="reconciliation_required" if reconciliation_required else "retryable" if retryable else "failed",
            summary=summary,
            normalized_payload=dict(normalized_payload or {}),
            errors=tuple(errors),
            warnings=tuple(warnings),
            retryable=retryable,
            reconciliation_required=reconciliation_required,
        )