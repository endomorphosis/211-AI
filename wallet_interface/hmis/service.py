"""Service orchestration helpers for canonical HMIS adapter execution."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
from typing import Any, Mapping
from uuid import uuid4

from .adapters.base import HmisAdapter
from .consent import HmisConsentDecision, evaluate_hmis_consent
from .errors import HmisPolicyError
from .models import HmisActionType, HmisAdapterResult, HmisConsentRecord, HmisSyncEvent


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _payload_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(encoded).hexdigest()


def _action_supported(adapter: HmisAdapter, action_type: HmisActionType) -> bool:
    capabilities = adapter.capabilities()
    if action_type in {"lookup_client", "lookup_household", "list_program_links"}:
        return capabilities.supports_lookup
    if action_type in {"submit_referral"}:
        return capabilities.supports_referral_submit
    if action_type in {"submit_enrollment"}:
        return capabilities.supports_enrollment_submit
    if action_type in {"sync_referral_status", "resolve_reconciliation_item"}:
        return capabilities.supports_status_sync or capabilities.supports_reconciliation
    if action_type in {"create_referral_draft", "validate_referral_draft", "create_enrollment_draft"}:
        return capabilities.supports_manual_review_packets or capabilities.supports_referral_submit
    if action_type in {"link_external_record", "reject_match"}:
        return capabilities.supports_lookup
    return False


@dataclass(slots=True)
class HmisExecutionResult:
    adapter_result: HmisAdapterResult
    sync_event: HmisSyncEvent
    consent_decision: HmisConsentDecision | None = None


@dataclass(slots=True)
class HmisService:
    adapter: HmisAdapter

    def execute(
        self,
        *,
        action_type: HmisActionType,
        payload: Mapping[str, Any],
        actor_id: str,
        consent: HmisConsentRecord | None = None,
        required_scope: str | None = None,
        program_ref: str | None = None,
        context: Mapping[str, Any] | None = None,
    ) -> HmisExecutionResult:
        if not _action_supported(self.adapter, action_type):
            raise HmisPolicyError(f"adapter {self.adapter.name} does not support action {action_type}")

        consent_decision = None
        if consent and required_scope:
            consent_decision = evaluate_hmis_consent(
                consent,
                required_scope=required_scope,
                program_ref=program_ref,
            )

        adapter_result = self.adapter.execute(action_type=action_type, payload=payload, context=context)
        sync_event = HmisSyncEvent(
            event_id=str(uuid4()),
            action_type=action_type,
            actor_id=actor_id,
            local_ref=str(payload.get("local_ref") or payload.get("local_subject_ref") or "") or None,
            external_ref=adapter_result.external_refs.get("external_id") or adapter_result.external_refs.get("referral_id"),
            adapter_name=self.adapter.name,
            status=adapter_result.status,
            request_payload_hash=_payload_hash(payload),
            response_summary=adapter_result.summary,
            occurred_at=_utc_now(),
            metadata={"retryable": adapter_result.retryable, "warnings": list(adapter_result.warnings)},
        )
        return HmisExecutionResult(
            adapter_result=adapter_result,
            sync_event=sync_event,
            consent_decision=consent_decision,
        )