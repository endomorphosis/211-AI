from __future__ import annotations

from datetime import datetime, timezone

import pytest

from wallet_interface.hmis import HmisConsentError, HmisConsentRecord, evaluate_hmis_consent


def test_evaluate_hmis_consent_accepts_active_scoped_record() -> None:
    decision = evaluate_hmis_consent(
        HmisConsentRecord(
            consent_id="consent-1",
            subject_ref="wallet:user-1",
            status="active",
            basis="client_consent",
            purpose="Referral submission",
            authorized_scopes=("hmis_submit_referral",),
            authorized_program_refs=("program-1",),
            effective_at="2026-05-19T00:00:00+00:00",
            expires_at="2026-06-01T00:00:00+00:00",
            policy_version="v1",
            copy_version="copy-v1",
        ),
        required_scope="hmis_submit_referral",
        program_ref="program-1",
        now=datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc),
    )

    assert decision.allowed is True
    assert decision.consent_id == "consent-1"
    assert decision.basis == "client_consent"
    assert decision.metadata["policy_version"] == "v1"


def test_evaluate_hmis_consent_rejects_missing_program_scope() -> None:
    consent = HmisConsentRecord(
        consent_id="consent-2",
        subject_ref="wallet:user-1",
        status="active",
        basis="client_consent",
        purpose="Referral submission",
        authorized_scopes=("hmis_submit_referral",),
        authorized_program_refs=("program-1",),
    )

    with pytest.raises(HmisConsentError, match="does not authorize program"):
        evaluate_hmis_consent(
            consent,
            required_scope="hmis_submit_referral",
            program_ref="program-2",
            now=datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc),
        )


def test_evaluate_hmis_consent_rejects_expired_record() -> None:
    consent = HmisConsentRecord(
        consent_id="consent-3",
        subject_ref="wallet:user-1",
        status="active",
        basis="client_consent",
        purpose="Lookup",
        authorized_scopes=("hmis_lookup_client",),
        expires_at="2026-05-01T00:00:00+00:00",
    )

    with pytest.raises(HmisConsentError, match="has expired"):
        evaluate_hmis_consent(
            consent,
            required_scope="hmis_lookup_client",
            now=datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc),
        )