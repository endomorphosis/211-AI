from __future__ import annotations

import pytest

from wallet_interface.hmis import (
    HmisActionType,
    HmisAdapterCapabilities,
    HmisAdapterResult,
    HmisConsentRecord,
    HmisPolicyError,
    HmisService,
)


class FakeAdapter:
    name = "fake-hmis"

    def __init__(self, *, supports_lookup: bool = True, supports_referral_submit: bool = True) -> None:
        self._supports_lookup = supports_lookup
        self._supports_referral_submit = supports_referral_submit

    def capabilities(self) -> HmisAdapterCapabilities:
        return HmisAdapterCapabilities(
            supports_lookup=self._supports_lookup,
            supports_referral_submit=self._supports_referral_submit,
            supports_manual_review_packets=True,
        )

    def execute(self, *, action_type: HmisActionType, payload, context=None) -> HmisAdapterResult:
        return HmisAdapterResult.success(
            action_type=action_type,
            adapter_name=self.name,
            summary="adapter ok",
            external_refs={"referral_id": "ext-1"},
            normalized_payload={"echo": dict(payload)},
        )


def test_hmis_service_executes_supported_action_and_emits_sync_event() -> None:
    service = HmisService(adapter=FakeAdapter())

    result = service.execute(
        action_type="submit_referral",
        payload={"local_ref": "ref-1", "client_id": "c-1"},
        actor_id="did:key:case-manager",
        consent=HmisConsentRecord(
            consent_id="consent-1",
            subject_ref="wallet:user-1",
            status="active",
            basis="client_consent",
            purpose="Referral submit",
            authorized_scopes=("hmis_submit_referral",),
            authorized_program_refs=("program-1",),
        ),
        required_scope="hmis_submit_referral",
        program_ref="program-1",
    )

    assert result.adapter_result.ok is True
    assert result.sync_event.action_type == "submit_referral"
    assert result.sync_event.adapter_name == "fake-hmis"
    assert result.sync_event.external_ref == "ext-1"
    assert result.consent_decision is not None
    assert result.consent_decision.allowed is True


def test_hmis_service_rejects_unsupported_action() -> None:
    service = HmisService(adapter=FakeAdapter(supports_referral_submit=False))

    with pytest.raises(HmisPolicyError, match="does not support action submit_referral"):
        service.execute(
            action_type="submit_referral",
            payload={"local_ref": "ref-1"},
            actor_id="did:key:case-manager",
        )