from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Mapping, Sequence

from fastapi.testclient import TestClient

from ipfs_datasets_py.wallet import DeterministicLocationRegionProofBackend
from wallet_interface import ServiceRecord, WalletInterfaceService, create_app
import wallet_interface.api as wallet_api_module
from ipfs_datasets_py.wallet.crypto import random_key
from ipfs_datasets_py.wallet.ucan import resource_for_export, resource_for_record, resource_for_wallet


def _client() -> TestClient:
    service = WalletInterfaceService(
        services=[
            ServiceRecord(
                id="housing-1",
                name="Portland Housing Help",
                description="Rent assistance and emergency shelter navigation.",
                categories="housing shelter rent",
                city="Portland",
                state="OR",
            )
        ]
    )
    return TestClient(create_app(service=service))


def _client_with_service(service: WalletInterfaceService) -> TestClient:
    return TestClient(create_app(service=service))


def test_wallet_api_cors_allows_configured_browser_origin(monkeypatch) -> None:
    origin = "http://127.0.0.1:5185"
    monkeypatch.setenv("WALLET_API_CORS_ORIGINS", origin)
    client = _client()

    response = client.options(
        "/wallets",
        headers={
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Method": "POST",
            "Origin": origin,
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_health_warns_when_publicus_indextts_has_no_hf_token(monkeypatch) -> None:
    monkeypatch.setenv("WALLET_INDEXTTS_SPACE_URL", "https://publicus-indextts-2-demo.hf.space")
    monkeypatch.setenv("WALLET_INDEXTTS_MODEL_NAME", "Publicus/IndexTTS-2-Demo")
    for key in (
        "WALLET_INDEXTTS_HF_TOKEN",
        "HF_TOKEN",
        "HUGGINGFACEHUB_API_TOKEN",
        "IPFS_DATASETS_PY_HF_API_TOKEN",
        "HUGGINGFACE_API_TOKEN",
        "HUGGINGFACE_HUB_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(wallet_api_module, "resolve_secret", lambda *args: "")
    client = _client()

    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["warnings"][0]["code"] == "publicus_indextts_missing_hf_token"


def test_ops_health_includes_publicus_indextts_credential_warning(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("WALLET_INDEXTTS_SPACE_URL", "https://publicus-indextts-2-demo.hf.space")
    monkeypatch.setenv("WALLET_INDEXTTS_MODEL_NAME", "Publicus/IndexTTS-2-Demo")
    for key in (
        "WALLET_INDEXTTS_HF_TOKEN",
        "HF_TOKEN",
        "HUGGINGFACEHUB_API_TOKEN",
        "IPFS_DATASETS_PY_HF_API_TOKEN",
        "HUGGINGFACE_API_TOKEN",
        "HUGGINGFACE_HUB_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(wallet_api_module, "resolve_secret", lambda *args: "")
    service = WalletInterfaceService(repository_root=tmp_path / "wallet-repository")
    client = _client_with_service(service)

    response = client.get("/ops/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "warning"
    checks = {check["name"]: check for check in body["checks"]}
    assert checks["voice_proxy_credentials"]["status"] == "warning"
    assert checks["voice_proxy_credentials"]["details"]["code"] == "publicus_indextts_missing_hf_token"


def test_ops_voice_proxy_status_reports_publicus_warning(monkeypatch) -> None:
    monkeypatch.setenv("WALLET_INDEXTTS_SPACE_URL", "https://publicus-indextts-2-demo.hf.space")
    monkeypatch.setenv("WALLET_INDEXTTS_MODEL_NAME", "Publicus/IndexTTS-2-Demo")
    monkeypatch.setattr(wallet_api_module, "resolve_secret", lambda *args: "")
    client = _client()

    response = client.get("/ops/voice-proxy/status")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "warning"
    assert body["spaceUrl"] == "https://publicus-indextts-2-demo.hf.space"
    assert body["tokenConfigured"] is False
    assert body["warnings"][0]["code"] == "publicus_indextts_missing_hf_token"


def test_ops_voice_proxy_status_requires_shared_secret_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("WALLET_OPS_HEALTH_SHARED_SECRET", "top-secret")
    client = _client()

    unauthorized = client.get("/ops/voice-proxy/status")
    assert unauthorized.status_code == 401
    assert "authorization required" in unauthorized.json()["detail"]

    authorized = client.get(
        "/ops/voice-proxy/status",
        headers={"authorization": "Bearer top-secret"},
    )
    assert authorized.status_code == 200


def test_magic_login_request_sends_signed_sms_and_verify_connects_wallet(monkeypatch) -> None:
    monkeypatch.setenv("WALLET_MAGIC_LOGIN_SECRET", "test-magic-login-secret")
    deliveries: list[dict[str, object]] = []

    def fake_sms_delivery(**kwargs):
        deliveries.append(kwargs)
        return {"provider": "mock", "provider_status": "queued", "provider_message_id": "SM-login"}

    monkeypatch.setattr(wallet_api_module, "_send_sms_notification", fake_sms_delivery)
    client = _client()
    wallet_ids = []
    for owner in ["did:key:owner1", "did:key:owner2"]:
        response = client.post("/wallets", json={"owner_did": owner})
        assert response.status_code == 200
        wallet_ids.append(response.json()["wallet_id"])

    response = client.post(
        "/analytics/templates",
        json={
            "template_id": "api_housing_gap_v1",
            "title": "Housing service gaps",
            "purpose": "County-level planning",
            "allowed_record_types": ["location", "need"],
            "allowed_derived_fields": ["county", "need_category"],
            "min_cohort_size": 2,
            "epsilon_budget": 0.5,
            "created_by": "did:key:analyst",
        },
    )
    assert response.status_code == 200

    consent_ids = []
    for wallet_id, owner in zip(wallet_ids, ["did:key:owner1", "did:key:owner2"]):
        response = client.post(
            f"/wallets/{wallet_id}/analytics/consents/from-template",
            json={"actor_did": owner, "template_id": "api_housing_gap_v1"},
        )
        assert response.status_code == 200
        consent_ids.append(response.json()["consent_id"])

    for wallet_id, owner, consent_id in zip(wallet_ids, ["did:key:owner1", "did:key:owner2"], consent_ids):
        response = client.post(
            f"/wallets/{wallet_id}/analytics/contributions",
            json={
                "actor_did": owner,
                "consent_id": consent_id,
                "template_id": "api_housing_gap_v1",
                "fields": {"county": "Multnomah", "need_category": "housing"},
            },
        )
        assert response.status_code == 200

    response = client.post("/analytics/api_housing_gap_v1/count", json={"epsilon": 0.25})
    assert response.status_code == 200
    result = response.json()
    assert result["released"] is True
    assert result["count"] is None
    assert result["noisy_count"] is not None
    assert result["privacy_budget_spent"] == 0.25


def test_wallet_api_multi_dimensional_analytics_suppresses_sparse_cells() -> None:
    client = _client()
    response = client.post(
        "/analytics/templates",
        json={
            "template_id": "api_multi_sparse_v1",
            "title": "Sparse service gaps",
            "purpose": "County and need planning",
            "allowed_record_types": ["location", "need"],
            "allowed_derived_fields": ["county", "need_category"],
            "min_cohort_size": 2,
            "epsilon_budget": 0.5,
            "created_by": "did:key:analyst",
        },
    )
    assert response.status_code == 200
    rows = [
        ("did:key:api-cohort-owner1", {"county": "Multnomah", "need_category": "housing"}),
        ("did:key:api-cohort-owner2", {"county": "Multnomah", "need_category": "housing"}),
        ("did:key:api-cohort-owner3", {"county": "Lane", "need_category": "food"}),
        ("did:key:api-cohort-owner4", {"county": "Lane", "need_category": "food"}),
        ("did:key:api-cohort-owner5", {"county": "Clackamas", "need_category": "rare-need"}),
    ]

    for owner, fields in rows:
        wallet = client.post("/wallets", json={"owner_did": owner}).json()
        response = client.post(
            f"/wallets/{wallet['wallet_id']}/analytics/consents/from-template",
            json={"actor_did": owner, "template_id": "api_multi_sparse_v1"},
        )
        assert response.status_code == 200
        consent = response.json()
        response = client.post(
            f"/wallets/{wallet['wallet_id']}/analytics/contributions",
            json={
                "actor_did": owner,
                "consent_id": consent["consent_id"],
                "template_id": "api_multi_sparse_v1",
                "fields": fields,
            },
        )
        assert response.status_code == 200

    response = client.post(
        "/analytics/api_multi_sparse_v1/count-by-fields",
        json={"group_by": ["county", "need_category"], "min_cohort_size": 2},
    )
    assert response.status_code == 200
    result = response.json()
    serialized = json.dumps(result)

    assert result["metric"] == "count_by_fields"
    assert result["released"] is True
    assert result["suppressed"] is True
    assert result["count"] == 4
    assert result["group_by"] == ["county", "need_category"]
    assert result["suppressed_cohort_count"] == 1
    assert len(result["cohorts"]) == 2
    assert "rare-need" not in serialized
    assert "Clackamas" not in serialized


def test_wallet_api_draft_analytics_template_is_not_consentable() -> None:
    client = _client()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()

    response = client.post(
        "/analytics/templates",
        json={
            "template_id": "draft_housing_gap_v1",
            "title": "Draft housing service gaps",
            "purpose": "Template review",
            "allowed_record_types": ["location"],
            "allowed_derived_fields": ["county"],
            "min_cohort_size": 2,
            "epsilon_budget": 0.5,
            "created_by": "did:key:analyst",
            "status": "draft",
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "draft"

    response = client.get("/analytics/templates")
    assert response.status_code == 200
    assert response.json()["templates"] == []

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/analytics/consents/from-template",
        json={"actor_did": "did:key:owner", "template_id": "draft_housing_gap_v1"},
    )
    assert response.status_code == 400
    assert "not active" in response.json()["detail"]


def test_wallet_api_lists_and_revokes_analytics_consent() -> None:
    client = _client()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    response = client.post(
        "/analytics/templates",
        json={
            "template_id": "consent_controls_v1",
            "title": "Consent controls",
            "purpose": "UI consent controls",
            "allowed_record_types": ["location", "need"],
            "allowed_derived_fields": ["county", "need_category"],
            "min_cohort_size": 2,
            "epsilon_budget": 0.5,
            "created_by": "did:key:analyst",
        },
    )
    assert response.status_code == 200

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/analytics/consents/from-template",
        json={
            "actor_did": "did:key:owner",
            "template_id": "consent_controls_v1",
            "expires_at": "2026-06-30T00:00:00+00:00",
        },
    )
    assert response.status_code == 200
    consent = response.json()

    response = client.get(f"/wallets/{wallet['wallet_id']}/analytics/consents")
    assert response.status_code == 200
    listed = response.json()["consents"]
    assert listed[0]["consent_id"] == consent["consent_id"]
    assert listed[0]["expires_at"] == "2026-06-30T00:00:00+00:00"
    assert listed[0]["allowed_derived_fields"] == ["county", "need_category"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/analytics/consents/{consent['consent_id']}/revoke",
        json={"actor_did": "did:key:owner"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "revoked"

    response = client.get(f"/wallets/{wallet['wallet_id']}/analytics/consents?status=active")
    assert response.status_code == 200
    assert response.json()["consents"] == []


def test_wallet_api_matches_services_from_wallet_location_and_audit() -> None:
    client = _client()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations",
        json={"actor_did": "did:key:owner", "lat": 45.515232, "lon": -122.678385},
    )
    assert response.status_code == 200
    location = response.json()
    assert location["data_type"] == "location"

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/services/match",
        json={
            "location_record_id": location["record_id"],
            "actor_did": "did:key:owner",
            "need_terms": ["housing"],
        },
    )
    assert response.status_code == 200
    matches = response.json()["matches"]
    assert matches[0]["service"]["id"] == "housing-1"
    assert "matches need:housing" in matches[0]["reasons"]

    response = client.get(f"/wallets/{wallet['wallet_id']}/audit")
    assert response.status_code == 200
    actions = [event["action"] for event in response.json()["events"]]
    assert "location/read_coarse" in actions


def test_wallet_api_delegate_matches_services_with_coarse_location_invocation() -> None:
    client = _client()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    location = client.post(
        f"/wallets/{wallet['wallet_id']}/locations",
        json={"actor_did": "did:key:owner", "lat": 45.515232, "lon": -122.678385},
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/coarse-grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "audience_key_hex": delegate_key,
        },
    )
    assert response.status_code == 200
    grant = response.json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/coarse-invocations",
        json={
            "grant_id": grant["grant_id"],
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
        },
    )
    assert response.status_code == 200
    token = response.json()["token"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/services/match",
        json={
            "location_record_id": location["record_id"],
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": token,
            "need_terms": ["housing"],
        },
    )
    assert response.status_code == 200
    assert response.json()["matches"][0]["service"]["id"] == "housing-1"

    actions = [event["action"] for event in client.get(f"/wallets/{wallet['wallet_id']}/audit").json()["events"]]
    assert "invocation/issue" in actions
    assert "invocation/verify" in actions
    assert "location/read_coarse" in actions


def test_wallet_api_delegate_creates_location_region_proof() -> None:
    client = _client()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    location = client.post(
        f"/wallets/{wallet['wallet_id']}/locations",
        json={"actor_did": "did:key:owner", "lat": 45.515232, "lon": -122.678385},
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/region-proof-grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
        },
    )
    assert response.status_code == 200
    grant = response.json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/region-proofs",
        json={
            "actor_did": "did:key:delegate",
            "grant_id": grant["grant_id"],
            "region_id": "multnomah_county",
        },
    )
    assert response.status_code == 200
    proof = response.json()
    assert proof["proof_type"] == "location_region"
    assert proof["is_simulated"] is True
    assert proof["proof_system"] == "simulated"
    assert proof["verification_status"] == "verified"
    assert proof["public_inputs"]["region_id"] == "multnomah_county"
    assert proof["public_inputs"]["claim"] == "location_in_region"
    assert proof["public_inputs"]["region_policy_hash"]
    assert "lat" not in str(proof["public_inputs"]).lower()
    assert "lon" not in str(proof["public_inputs"]).lower()
    assert "witness" not in str(proof["public_inputs"]).lower()

    actions = [event["action"] for event in client.get(f"/wallets/{wallet['wallet_id']}/audit").json()["events"]]
    assert "proof/create" in actions

    response = client.get(f"/wallets/{wallet['wallet_id']}/proofs")
    assert response.status_code == 200
    proofs = response.json()["proofs"]
    assert [item["proof_id"] for item in proofs] == [proof["proof_id"]]
    assert proofs[0]["public_inputs"] == proof["public_inputs"]
    assert proofs[0]["witness_record_ids"] == [location["record_id"]]


def test_wallet_api_delegate_creates_location_distance_proof() -> None:
    client = _client()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    location = client.post(
        f"/wallets/{wallet['wallet_id']}/locations",
        json={"actor_did": "did:key:owner", "lat": 45.515232, "lon": -122.678385},
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/distance-proof-grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "target_id": "shelter-west",
            "max_distance_km": 1.0,
        },
    )
    assert response.status_code == 200
    grant = response.json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/distance-proofs",
        json={
            "actor_did": "did:key:delegate",
            "grant_id": grant["grant_id"],
            "target_id": "shelter-west",
            "target_lat": 45.516,
            "target_lon": -122.679,
            "max_distance_km": 1.0,
        },
    )
    assert response.status_code == 200
    proof = response.json()
    assert proof["proof_type"] == "location_distance"
    assert proof["is_simulated"] is True
    assert proof["proof_system"] == "simulated"
    assert proof["verification_status"] == "verified"
    assert proof["public_inputs"]["claim"] == "location_within_distance"
    assert proof["public_inputs"]["target_id"] == "shelter-west"
    assert proof["public_inputs"]["max_distance_km"] == 1.0
    assert proof["public_inputs"]["target_policy_hash"]
    serialized = str(proof)
    for secret in ("45.515232", "-122.678385", "45.516", "-122.679"):
        assert secret not in serialized


def test_wallet_api_location_distance_grant_enforces_target_and_threshold_caveats() -> None:
    client = _client()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    location = client.post(
        f"/wallets/{wallet['wallet_id']}/locations",
        json={"actor_did": "did:key:owner", "lat": 45.515232, "lon": -122.678385},
    ).json()
    grant = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/distance-proof-grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "target_id": "shelter-west",
            "max_distance_km": 1.0,
        },
    ).json()

    wrong_target = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/distance-proofs",
        json={
            "actor_did": "did:key:delegate",
            "grant_id": grant["grant_id"],
            "target_id": "shelter-east",
            "target_lat": 45.516,
            "target_lon": -122.679,
            "max_distance_km": 1.0,
        },
    )
    assert wrong_target.status_code == 400
    assert "target_id" in wrong_target.json()["detail"]

    wider_threshold = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/distance-proofs",
        json={
            "actor_did": "did:key:delegate",
            "grant_id": grant["grant_id"],
            "target_id": "shelter-west",
            "target_lat": 45.516,
            "target_lon": -122.679,
            "max_distance_km": 2.0,
        },
    )
    assert wider_threshold.status_code == 400
    assert "max_distance_km" in wider_threshold.json()["detail"]


def test_wallet_api_production_proof_mode_rejects_simulated_receipts() -> None:
    client = _client_with_service(WalletInterfaceService(allow_simulated_proofs=False))
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    location = client.post(
        f"/wallets/{wallet['wallet_id']}/locations",
        json={"actor_did": "did:key:owner", "lat": 45.515232, "lon": -122.678385},
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/region-proofs",
        json={"actor_did": "did:key:owner", "region_id": "multnomah_county"},
    )

    assert response.status_code == 400
    assert "Simulated proofs are disabled" in response.json()["detail"]
    response = client.get(f"/wallets/{wallet['wallet_id']}/proofs")
    assert response.status_code == 200
    assert response.json()["proofs"] == []


def test_wallet_api_production_proof_mode_accepts_configured_backend() -> None:
    client = _client_with_service(
        WalletInterfaceService(
            proof_backend=DeterministicLocationRegionProofBackend(),
            allow_simulated_proofs=False,
        )
    )
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    location = client.post(
        f"/wallets/{wallet['wallet_id']}/locations",
        json={"actor_did": "did:key:owner", "lat": 45.515232, "lon": -122.678385},
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/region-proofs",
        json={"actor_did": "did:key:owner", "region_id": "multnomah_county"},
    )

    assert response.status_code == 200
    proof = response.json()
    assert proof["is_simulated"] is False
    assert proof["proof_system"] == "deterministic-test-proof"
    assert proof["verification_status"] == "verified"
    assert proof["proof_artifact_ref"].startswith("deterministic-proof://")
    assert "lat" not in str(proof["public_inputs"]).lower()
    assert "lon" not in str(proof["public_inputs"]).lower()
    assert "witness" not in str(proof["public_inputs"]).lower()
    serialized = json.dumps(proof)
    assert "45.515232" not in serialized
    assert "-122.678385" not in serialized


def test_wallet_api_env_selects_deterministic_proof_backend(monkeypatch) -> None:
    monkeypatch.setenv("WALLET_PROOF_MODE", "production")
    monkeypatch.setenv("WALLET_PROOF_BACKEND", "deterministic-location-region")
    client = _client_with_service(WalletInterfaceService())
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    location = client.post(
        f"/wallets/{wallet['wallet_id']}/locations",
        json={"actor_did": "did:key:owner", "lat": 45.515232, "lon": -122.678385},
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/locations/{location['record_id']}/region-proofs",
        json={"actor_did": "did:key:owner", "region_id": "multnomah_county"},
    )

    assert response.status_code == 200
    proof = response.json()
    assert proof["is_simulated"] is False
    assert proof["proof_system"] == "deterministic-test-proof"
    assert proof["circuit_id"] == "deterministic-location-region-v0.1"


def test_wallet_api_document_analysis_invocation_flow() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "benefits.txt",
            "title": "Benefits letter",
            "text": "SNAP approval letter and utility shutoff risk.",
        },
    )
    assert response.status_code == 200
    record = response.json()

    response = client.get(f"/wallets/{wallet['wallet_id']}/records", params={"data_type": "document"})
    assert response.status_code == 200
    records = response.json()["records"]
    assert [item["record_id"] for item in records] == [record["record_id"]]
    assert records[0]["data_type"] == "document"

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analysis-grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
        },
    )
    assert response.status_code == 200
    grant = response.json()

    response = client.get(
        f"/wallets/{wallet['wallet_id']}/grant-receipts",
        params={"audience_did": "did:key:delegate"},
    )
    assert response.status_code == 200
    receipt = response.json()["receipts"][0]
    assert receipt["grant_id"] == grant["grant_id"]
    assert receipt["status"] == "active"
    assert receipt["receipt_hash"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analysis-invocations",
        json={
            "grant_id": grant["grant_id"],
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
        },
    )
    assert response.status_code == 200
    token = response.json()["token"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analyze",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": token,
        },
    )
    assert response.status_code == 200
    artifact = response.json()
    assert artifact["artifact_type"] == "summary"
    assert artifact["output_policy"] == "derived_only"

    response = client.get(f"/wallets/{wallet['wallet_id']}/audit")
    actions = [event["action"] for event in response.json()["events"]]
    assert "invocation/issue" in actions
    assert "invocation/verify" in actions
    assert "record/analyze" in actions


def test_wallet_api_redacted_and_vector_document_analysis_outputs_are_safe() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "intake.txt",
            "text": (
                "Jane Example can be reached at jane@example.org or 503-555-1212. "
                "SSN 123-45-6789. Needs rent, SNAP, and clinic help."
            ),
        },
    ).json()
    grant = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
            "abilities": ["record/analyze"],
            "output_types": ["redacted_derived_only", "vector_profile", "redacted_graphrag"],
        },
    ).json()

    redacted_invocation = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analysis-invocations",
        json={
            "grant_id": grant["grant_id"],
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "output_types": ["redacted_derived_only"],
        },
    ).json()
    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analyze/redacted",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": redacted_invocation["token"],
        },
    )
    assert response.status_code == 200
    redacted = response.json()
    redacted_output = json.dumps(redacted["output"])
    assert redacted["artifact"]["artifact_type"] == "redacted_document_analysis"
    assert redacted["output"]["output_policy"] == "redacted_derived_only"
    assert "jane@example.org" not in redacted_output
    assert "503-555-1212" not in redacted_output
    assert "123-45-6789" not in redacted_output
    assert "Jane Example" not in redacted_output
    assert set(redacted["output"]["derived_facts"]["need_categories"]) >= {"housing", "food", "health"}

    vector_invocation = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analysis-invocations",
        json={
            "grant_id": grant["grant_id"],
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "output_types": ["vector_profile"],
        },
    ).json()
    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/vector-profile",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": vector_invocation["token"],
            "chunk_size_words": 8,
        },
    )
    assert response.status_code == 200
    vector = response.json()
    vector_output = json.dumps(vector["output"])
    assert vector["artifact"]["artifact_type"] == "redacted_document_vector_profile"
    assert vector["output"]["output_policy"] == "encrypted_vector_profile"
    assert "jane@example.org" not in vector_output
    assert "503-555-1212" not in vector_output
    assert vector["output"]["profile"]["profile_type"] == "redacted_lexical_hash_vector"

    graphrag_invocation = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analysis-invocations",
        json={
            "grant_id": grant["grant_id"],
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "output_types": ["redacted_graphrag"],
        },
    ).json()
    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/graphrag/redacted",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": graphrag_invocation["token"],
            "record_ids": [record["record_id"]],
        },
    )
    assert response.status_code == 200
    graph = response.json()
    graph_output = json.dumps(graph["output"])
    assert graph["artifact"]["artifact_type"] == "redacted_document_graphrag"
    assert graph["output"]["output_policy"] == "redacted_graphrag"
    assert graph["output"]["graph"]["graph_type"] == "redacted_category_entity_graph"
    assert set(graph["output"]["graph"]["category_record_counts"]) >= {"housing", "food", "health"}
    assert "jane@example.org" not in graph_output
    assert "503-555-1212" not in graph_output
    assert "123-45-6789" not in graph_output

    actions = [event["action"] for event in client.get(f"/wallets/{wallet['wallet_id']}/audit").json()["events"]]
    assert "record/analyze_redacted" in actions
    assert "record/vector_profile" in actions
    assert "record/graphrag_redacted" in actions


def test_wallet_api_owner_can_create_cross_record_redacted_analysis() -> None:
    client = _client()
    owner_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    first = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "first.txt",
            "text": "Email jane@example.org about rent assistance.",
        },
    ).json()
    second = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "second.txt",
            "text": "Call 503-555-1212 about SNAP and clinic referrals.",
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/analyze/redacted",
        json={
            "actor_did": "did:key:owner",
            "actor_key_hex": owner_key,
            "record_ids": [first["record_id"], second["record_id"]],
        },
    )

    assert response.status_code == 200
    analysis = response.json()
    serialized = json.dumps(analysis["output"])
    assert analysis["artifact"]["artifact_type"] == "redacted_cross_document_analysis"
    assert analysis["output"]["source_record_count"] == 2
    assert "jane@example.org" not in serialized
    assert "503-555-1212" not in serialized


def test_wallet_api_owner_can_create_redacted_graphrag() -> None:
    client = _client()
    owner_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    first = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "first.txt",
            "text": "Jane Example emailed jane@example.org about rent and utility assistance.",
        },
    ).json()
    second = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "second.txt",
            "text": "Call 503-555-1212 about SNAP and medical clinic referrals.",
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/graphrag/redacted",
        json={
            "actor_did": "did:key:owner",
            "actor_key_hex": owner_key,
            "record_ids": [first["record_id"], second["record_id"]],
        },
    )

    assert response.status_code == 200
    graph = response.json()
    serialized = json.dumps(graph["output"])
    assert graph["artifact"]["artifact_type"] == "redacted_document_graphrag"
    assert graph["output"]["output_policy"] == "redacted_graphrag"
    assert graph["output"]["graph"]["graph_type"] == "redacted_category_entity_graph"
    assert graph["output"]["graph"]["category_record_counts"]["housing"] == 1
    assert graph["output"]["graph"]["category_record_counts"]["food"] == 1
    assert graph["output"]["graph"]["category_record_counts"]["health"] == 1
    assert "Jane Example" not in serialized
    assert "jane@example.org" not in serialized
    assert "503-555-1212" not in serialized
    actions = [event["action"] for event in client.get(f"/wallets/{wallet['wallet_id']}/audit").json()["events"]]
    assert "record/graphrag_redacted" in actions


def test_wallet_api_redacted_text_extraction_and_form_analysis_outputs_are_safe() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "intake-form.txt",
            "text": (
                "Full name: Jane Example\n"
                "Email: jane@example.org\n"
                "Phone: 503-555-1212\n"
                "Rent assistance required: yes\n"
                "SNAP enrollment: yes\n"
            ),
        },
    ).json()
    grant = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
            "abilities": ["record/analyze"],
            "output_types": ["redacted_extracted_text", "redacted_form_analysis"],
        },
    ).json()

    extraction_invocation = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analysis-invocations",
        json={
            "grant_id": grant["grant_id"],
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "output_types": ["redacted_extracted_text"],
        },
    ).json()
    extraction_response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/extract-text/redacted",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": extraction_invocation["token"],
        },
    )
    assert extraction_response.status_code == 200
    extraction = extraction_response.json()
    extraction_output = json.dumps(extraction["output"])
    assert extraction["artifact"]["artifact_type"] == "redacted_document_text_extraction"
    assert extraction["output"]["output_policy"] == "redacted_extracted_text"
    assert "jane@example.org" not in extraction_output
    assert "503-555-1212" not in extraction_output
    assert "[REDACTED_EMAIL]" in extraction["output"]["text"]

    form_invocation = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analysis-invocations",
        json={
            "grant_id": grant["grant_id"],
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "output_types": ["redacted_form_analysis"],
        },
    ).json()
    form_response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/forms/analyze/redacted",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": form_invocation["token"],
        },
    )
    assert form_response.status_code == 200
    form = form_response.json()
    form_output = json.dumps(form["output"])
    assert form["artifact"]["artifact_type"] == "redacted_document_form_analysis"
    assert form["output"]["output_policy"] == "redacted_form_analysis"
    assert form["output"]["form"]["field_count"] >= 5
    assert form["output"]["form"]["data_type_counts"]["email"] == 1
    assert form["output"]["form"]["data_type_counts"]["phone"] == 1
    assert "Jane Example" not in form_output
    assert "jane@example.org" not in form_output
    assert "503-555-1212" not in form_output

    actions = [event["action"] for event in client.get(f"/wallets/{wallet['wallet_id']}/audit").json()["events"]]
    assert "record/extract_text_redacted" in actions
    assert "record/analyze_form_redacted" in actions


def test_wallet_api_binary_document_upload_lists_record_and_storage() -> None:
    client = _client()
    owner_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/documents",
        data={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "title": "Binary identity scan",
        },
        files={"file": ("identity.bin", b"\x00\x01private document bytes", "application/octet-stream")},
    )
    assert response.status_code == 200
    record = response.json()
    assert record["data_type"] == "document"

    response = client.get(f"/wallets/{wallet['wallet_id']}/records", params={"data_type": "document"})
    assert response.status_code == 200
    assert [item["record_id"] for item in response.json()["records"]] == [record["record_id"]]

    response = client.get(f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/storage")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_wallet_api_owner_can_decrypt_document_without_grant() -> None:
    client = _client()
    owner_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "owner-preview.txt",
            "text": "Owner can preview this stored document.",
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt",
        json={"actor_did": "did:key:owner", "actor_key_hex": owner_key},
    )

    assert response.status_code == 200
    decrypted = response.json()
    assert decrypted["text"] == "Owner can preview this stored document."
    assert decrypted["size_bytes"] == len("Owner can preview this stored document.")


def test_wallet_api_owner_creates_record_view_grant() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "share.txt",
            "text": "Owner shared this document directly.",
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
            "abilities": ["record/analyze", "record/decrypt"],
            "purpose": "benefits_application",
        },
    )
    assert response.status_code == 200
    grant = response.json()
    assert grant["abilities"] == ["record/analyze", "record/decrypt"]
    assert grant["caveats"]["purpose"] == "benefits_application"
    assert set(grant["caveats"]["output_types"]) == {"summary", "plaintext"}

    response = client.get(
        f"/wallets/{wallet['wallet_id']}/grant-receipts",
        params={"audience_did": "did:key:delegate"},
    )
    assert response.status_code == 200
    receipt = response.json()["receipts"][0]
    assert receipt["grant_id"] == grant["grant_id"]
    assert receipt["status"] == "active"

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "grant_id": grant["grant_id"],
        },
    )
    assert response.status_code == 200
    assert response.json()["text"] == "Owner shared this document directly."


def test_wallet_api_rotates_document_key() -> None:
    service = WalletInterfaceService(services=[])
    client = _client_with_service(service)
    owner_key = random_key()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key.hex(),
            "filename": "rotation.txt",
            "text": "api rotation plaintext",
        },
    ).json()
    old_version_id = service.wallet_service.records[record["record_id"]].current_version_id

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/rotate-key",
        json={"actor_did": "did:key:owner", "actor_key_hex": owner_key.hex()},
    )

    assert response.status_code == 200
    rotated = response.json()
    assert rotated["version_id"] != old_version_id
    assert rotated["record_id"] == record["record_id"]
    plaintext = service.wallet_service.decrypt_record(
        wallet["wallet_id"],
        record["record_id"],
        actor_did="did:key:owner",
        actor_secret=owner_key,
    )
    assert plaintext == b"api rotation plaintext"


def test_wallet_api_delegates_grant_with_attenuation() -> None:
    service = WalletInterfaceService(services=[])
    client = _client_with_service(service)
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "filename": "delegation.txt",
            "text": "api delegated analysis content",
        },
    ).json()
    resource = resource_for_record(wallet["wallet_id"], record["record_id"])
    parent = service.wallet_service.create_grant(
        wallet_id=wallet["wallet_id"],
        issuer_did="did:key:owner",
        audience_did="did:key:advocate",
        resources=[resource],
        abilities=["record/analyze", "record/share"],
        caveats={"purpose": "case_review", "max_delegation_depth": 1},
    )

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/grants/{parent.grant_id}/delegate",
        json={
            "issuer_did": "did:key:advocate",
            "audience_did": "did:key:case-manager",
            "resources": [resource],
            "abilities": ["record/analyze"],
            "caveats": {"purpose": "case_review"},
        },
    )

    assert response.status_code == 200
    child = response.json()
    assert child["proof_chain"] == [parent.grant_id]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analyze",
        json={
            "actor_did": "did:key:case-manager",
            "grant_id": child["grant_id"],
            "max_chars": 30,
        },
    )
    assert response.status_code == 200
    assert response.json()["artifact_type"] == "summary"

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/grants/{parent.grant_id}/delegate",
        json={
            "issuer_did": "did:key:advocate",
            "audience_did": "did:key:case-manager",
            "resources": [resource],
            "abilities": ["record/decrypt"],
            "caveats": {"purpose": "case_review"},
        },
    )
    assert response.status_code == 400
    assert "exceeds parent" in response.json()["detail"]


def test_wallet_api_emergency_revoke_revokes_grants_and_rotates_records() -> None:
    service = WalletInterfaceService(services=[])
    client = _client_with_service(service)
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "filename": "emergency.txt",
            "text": "api emergency revoke content",
        },
    ).json()
    old_version_id = service.wallet_service.records[record["record_id"]].current_version_id
    grant = service.wallet_service.create_grant(
        wallet_id=wallet["wallet_id"],
        issuer_did="did:key:owner",
        audience_did="did:key:advocate",
        resources=[resource_for_record(wallet["wallet_id"], record["record_id"])],
        abilities=["record/analyze"],
        caveats={"purpose": "case_review"},
    )

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/emergency-revoke",
        json={"actor_did": "did:key:owner", "reason": "lost_device"},
    )

    assert response.status_code == 200
    report = response.json()
    assert report["revoked_grant_ids"] == [grant.grant_id]
    assert report["rotated_record_ids"] == [record["record_id"]]
    assert report["rotation_errors"] == {}
    assert service.wallet_service.grants[grant.grant_id].status == "revoked"
    assert service.wallet_service.records[record["record_id"]].current_version_id != old_version_id


def test_wallet_api_access_request_review_flow() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "case-note.txt",
            "text": "Housing instability and SNAP recertification.",
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests",
        json={
            "record_id": record["record_id"],
            "requester_did": "did:key:delegate",
            "purpose": "benefits_screening",
        },
    )
    assert response.status_code == 200
    access_request = response.json()
    assert access_request["status"] == "pending"

    response = client.get(f"/wallets/{wallet['wallet_id']}/access-requests")
    assert response.status_code == 200
    assert [item["request_id"] for item in response.json()["requests"]] == [access_request["request_id"]]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests/{access_request['request_id']}/approve",
        json={
            "actor_did": "did:key:owner",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
            "issue_invocation": True,
        },
    )
    assert response.status_code == 200
    approved = response.json()
    assert approved["status"] == "approved"
    assert approved["grant_id"].startswith("grant-")
    assert approved["invocation_token"].startswith("wallet-ucan-v1.")

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/analyze",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": approved["invocation_token"],
        },
    )
    assert response.status_code == 200
    assert response.json()["artifact_type"] == "summary"


def test_wallet_api_access_request_can_delegate_document_view() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "identity.txt",
            "text": "Delegate may view this identity document.",
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests",
        json={
            "record_id": record["record_id"],
            "requester_did": "did:key:delegate",
            "ability": "record/decrypt",
            "purpose": "identity_verification",
        },
    )
    assert response.status_code == 200
    access_request = response.json()
    assert access_request["abilities"] == ["record/decrypt"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests/{access_request['request_id']}/approve",
        json={
            "actor_did": "did:key:owner",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
            "issue_invocation": True,
        },
    )
    assert response.status_code == 200
    approved = response.json()
    assert approved["invocation_token"].startswith("wallet-ucan-v1.")

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "grant_id": approved["grant_id"],
        },
    )
    assert response.status_code == 200
    decrypted = response.json()
    assert decrypted["text"] == "Delegate may view this identity document."
    assert decrypted["size_bytes"] == len("Delegate may view this identity document.")

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt-invocations",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "grant_id": approved["grant_id"],
        },
    )
    assert response.status_code == 200
    decrypt_invocation_token = response.json()["token"]
    assert decrypt_invocation_token.startswith("wallet-ucan-v1.")

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": decrypt_invocation_token,
        },
    )
    assert response.status_code == 200
    decrypted = response.json()
    assert decrypted["text"] == "Delegate may view this identity document."
    assert decrypted["size_bytes"] == len("Delegate may view this identity document.")


def test_wallet_api_decrypt_invocation_satisfies_user_presence_caveat() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "presence.txt",
            "text": "User presence protected document.",
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
            "abilities": ["record/decrypt"],
            "purpose": "identity_verification",
            "user_presence_required": True,
        },
    )
    assert response.status_code == 200
    grant = response.json()
    assert grant["caveats"]["user_presence_required"] is True

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "grant_id": grant["grant_id"],
        },
    )
    assert response.status_code == 400
    assert "user presence" in response.json()["detail"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt-invocations",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "grant_id": grant["grant_id"],
        },
    )
    assert response.status_code == 400
    assert "user presence" in response.json()["detail"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt-invocations",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "grant_id": grant["grant_id"],
            "purpose": "identity_verification",
            "user_present": True,
        },
    )
    assert response.status_code == 200
    invocation = response.json()["invocation"]
    invocation_token = response.json()["token"]
    assert invocation["caveats"]["purpose"] == "identity_verification"
    assert invocation["caveats"]["user_present"] is True

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": invocation_token,
        },
    )
    assert response.status_code == 200
    assert response.json()["text"] == "User presence protected document."


def test_wallet_api_revoked_access_blocks_invocation() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "revoked.txt",
            "text": "Delegate access should be revoked.",
        },
    ).json()
    access_request = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests",
        json={
            "record_id": record["record_id"],
            "requester_did": "did:key:delegate",
            "ability": "record/decrypt",
            "purpose": "identity_verification",
        },
    ).json()
    approved = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests/{access_request['request_id']}/approve",
        json={
            "actor_did": "did:key:owner",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
            "issue_invocation": True,
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests/{access_request['request_id']}/revoke",
        json={"actor_did": "did:key:owner", "reason": "user withdrew consent"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "revoked"

    response = client.get(f"/wallets/{wallet['wallet_id']}/access-requests?status=revoked")
    assert response.status_code == 200
    assert response.json()["requests"][0]["request_id"] == access_request["request_id"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/decrypt",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": approved["invocation_token"],
        },
    )
    assert response.status_code == 400
    assert "not active" in response.json()["detail"]


def test_wallet_api_grant_revoke_updates_access_request_status() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "grant-revoke.txt",
            "text": "Grant revoke should update access request.",
        },
    ).json()
    access_request = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests",
        json={
            "record_id": record["record_id"],
            "requester_did": "did:key:delegate",
            "ability": "record/analyze",
            "purpose": "benefits_screening",
        },
    ).json()
    approved = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests/{access_request['request_id']}/approve",
        json={
            "actor_did": "did:key:owner",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/grants/{approved['grant_id']}/revoke",
        json={"actor_did": "did:key:owner"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "revoked"

    response = client.get(f"/wallets/{wallet['wallet_id']}/access-requests?status=revoked")
    assert response.status_code == 200
    assert response.json()["requests"][0]["request_id"] == access_request["request_id"]


def test_wallet_api_decrypt_access_request_respects_threshold_approval() -> None:
    client = _client()
    owner_key = random_key().hex()
    delegate_key = random_key().hex()
    wallet = client.post(
        "/wallets",
        json={
            "owner_did": "did:key:owner",
            "controller_dids": ["did:key:owner", "did:key:second-controller"],
            "approval_threshold": 2,
        },
    ).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "key_hex": owner_key,
            "filename": "threshold-identity.txt",
            "text": "Threshold protected identity document.",
        },
    ).json()

    access_request = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests",
        json={
            "record_id": record["record_id"],
            "requester_did": "did:key:delegate",
            "ability": "record/decrypt",
            "purpose": "identity_verification",
        },
    ).json()
    response = client.get(f"/wallets/{wallet['wallet_id']}/access-requests")
    assert response.status_code == 200
    review_item = response.json()["requests"][0]
    assert review_item["approval_required"] is True
    assert review_item["approval_id"] is None
    assert review_item["approval_count"] == 0
    assert review_item["grant_status"] is None

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests/{access_request['request_id']}/approve",
        json={
            "actor_did": "did:key:owner",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
        },
    )
    assert response.status_code == 400
    assert "approval_id is required" in response.json()["detail"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/approvals",
        json={
            "requested_by": "did:key:owner",
            "operation": "grant/create",
            "resources": [resource_for_record(wallet["wallet_id"], record["record_id"])],
            "abilities": ["record/decrypt"],
        },
    )
    assert response.status_code == 200
    approval = response.json()
    assert approval["threshold"] == 2

    response = client.get(f"/wallets/{wallet['wallet_id']}/access-requests")
    assert response.status_code == 200
    review_item = response.json()["requests"][0]
    assert review_item["approval_id"] == approval["approval_id"]
    assert review_item["approval_status"] == "pending"
    assert review_item["approval_threshold"] == 2
    assert review_item["approval_count"] == 0

    for approver in ["did:key:owner", "did:key:second-controller"]:
        response = client.post(
            f"/wallets/{wallet['wallet_id']}/approvals/{approval['approval_id']}/approve",
            json={"approver_did": approver},
        )
        assert response.status_code == 200
        approval_status = response.json()["status"]
    assert approval_status == "approved"

    response = client.get(f"/wallets/{wallet['wallet_id']}/access-requests")
    assert response.status_code == 200
    review_item = response.json()["requests"][0]
    assert review_item["approval_status"] == "approved"
    assert review_item["approval_count"] == 2

    response = client.get(f"/wallets/{wallet['wallet_id']}/approvals?status=approved")
    assert response.status_code == 200
    assert response.json()["approvals"][0]["approval_id"] == approval["approval_id"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/access-requests/{access_request['request_id']}/approve",
        json={
            "actor_did": "did:key:owner",
            "issuer_key_hex": owner_key,
            "audience_key_hex": delegate_key,
            "approval_id": approval["approval_id"],
            "issue_invocation": True,
        },
    )
    assert response.status_code == 200
    approved_access = response.json()
    assert approved_access["status"] == "approved"
    assert approved_access["invocation_token"].startswith("wallet-ucan-v1.")


def test_wallet_api_wallet_admin_controller_and_device_routes() -> None:
    client = _client()
    wallet = client.post(
        "/wallets",
        json={
            "owner_did": "did:key:owner",
            "controller_dids": ["did:key:owner", "did:key:second-controller"],
            "approval_threshold": 2,
        },
    ).json()
    response = client.get(f"/wallets/{wallet['wallet_id']}")
    assert response.status_code == 200
    assert response.json()["governance_policy"]["threshold"] == 2

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/controllers",
        json={"actor_did": "did:key:owner", "controller_did": "did:key:new-controller"},
    )
    assert response.status_code == 400
    assert "approval_id is required" in response.json()["detail"]

    approval = client.post(
        f"/wallets/{wallet['wallet_id']}/approvals",
        json={
            "requested_by": "did:key:owner",
            "operation": "wallet/controller_add",
            "resources": [resource_for_wallet(wallet["wallet_id"])],
            "abilities": ["wallet/admin"],
        },
    ).json()
    for approver in ["did:key:owner", "did:key:second-controller"]:
        response = client.post(
            f"/wallets/{wallet['wallet_id']}/approvals/{approval['approval_id']}/approve",
            json={"approver_did": approver},
        )
        assert response.status_code == 200

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/controllers",
        json={
            "actor_did": "did:key:owner",
            "controller_did": "did:key:new-controller",
            "approval_id": approval["approval_id"],
        },
    )
    assert response.status_code == 200
    updated = response.json()
    assert "did:key:new-controller" in updated["controller_dids"]
    assert "did:key:new-controller" in updated["governance_policy"]["approver_dids"]

    device_wallet = client.post("/wallets", json={"owner_did": "did:key:device-owner"}).json()
    response = client.post(
        f"/wallets/{device_wallet['wallet_id']}/devices",
        json={"actor_did": "did:key:device-owner", "device_did": "did:key:phone"},
    )
    assert response.status_code == 200
    assert "did:key:phone" in response.json()["device_dids"]
    response = client.post(
        f"/wallets/{device_wallet['wallet_id']}/devices/revoke",
        json={"actor_did": "did:key:device-owner", "device_did": "did:key:phone"},
    )
    assert response.status_code == 200
    assert "did:key:phone" not in response.json()["device_dids"]


def test_wallet_api_recovery_policy_and_controller_recovery() -> None:
    client = _client()
    wallet = client.post(
        "/wallets",
        json={
            "owner_did": "did:key:owner",
            "controller_dids": ["did:key:owner", "did:key:second-controller"],
            "approval_threshold": 2,
        },
    ).json()
    wallet_resource = resource_for_wallet(wallet["wallet_id"])
    recovery_contacts = ["did:key:recovery-a", "did:key:recovery-b"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/recovery-policy",
        json={
            "actor_did": "did:key:owner",
            "contact_dids": recovery_contacts,
            "threshold": 2,
        },
    )
    assert response.status_code == 400
    assert "approval_id is required" in response.json()["detail"]

    approval = client.post(
        f"/wallets/{wallet['wallet_id']}/approvals",
        json={
            "requested_by": "did:key:owner",
            "operation": "wallet/recovery_policy_set",
            "resources": [wallet_resource],
            "abilities": ["wallet/admin"],
        },
    ).json()
    for approver in ["did:key:owner", "did:key:second-controller"]:
        response = client.post(
            f"/wallets/{wallet['wallet_id']}/approvals/{approval['approval_id']}/approve",
            json={"approver_did": approver},
        )
        assert response.status_code == 200

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/recovery-policy",
        json={
            "actor_did": "did:key:owner",
            "contact_dids": recovery_contacts,
            "threshold": 2,
            "approval_id": approval["approval_id"],
        },
    )
    assert response.status_code == 200
    assert response.json()["governance_policy"]["recovery_policy"]["contact_dids"] == recovery_contacts

    recovery_approval = client.post(
        f"/wallets/{wallet['wallet_id']}/approvals",
        json={
            "requested_by": recovery_contacts[0],
            "operation": "wallet/controller_recover",
            "resources": [wallet_resource],
            "abilities": ["wallet/admin"],
        },
    ).json()
    assert recovery_approval["threshold"] == 2
    assert recovery_approval["approver_dids"] == recovery_contacts

    for approver in recovery_contacts:
        response = client.post(
            f"/wallets/{wallet['wallet_id']}/approvals/{recovery_approval['approval_id']}/approve",
            json={"approver_did": approver},
        )
        assert response.status_code == 200

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/controllers/recover",
        json={
            "actor_did": recovery_contacts[0],
            "controller_did": "did:key:recovered-controller",
            "approval_id": recovery_approval["approval_id"],
        },
    )
    assert response.status_code == 200
    assert "did:key:recovered-controller" in response.json()["controller_dids"]


def test_wallet_api_storage_health_and_repair() -> None:
    client = _client()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    response = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "filename": "storage.txt",
            "text": "storage health document",
        },
    )
    assert response.status_code == 200
    record = response.json()

    response = client.get(f"/wallets/{wallet['wallet_id']}/storage")
    assert response.status_code == 200
    wallet_report = response.json()
    assert wallet_report["ok"] is True
    assert wallet_report["record_count"] == 1
    assert wallet_report["replica_count"] == 2
    assert wallet_report["storage_types"] == {"memory": 2}
    assert wallet_report["reports"][0]["record_id"] == record["record_id"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/storage/repair",
        json={"actor_did": "did:key:owner"},
    )
    assert response.status_code == 200
    wallet_repair = response.json()
    assert wallet_repair["ok"] is True
    assert wallet_repair["repaired_replica_count"] == 0

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/records/{record['record_id']}/storage/repair",
        json={"actor_did": "did:key:owner"},
    )
    assert response.status_code == 200
    repair = response.json()
    assert repair["ok"] is True


def test_indextts_proxy_caches_config_fn_index_and_default_reference(monkeypatch) -> None:
    wallet_api_module._INDEXTTS_CONFIG_CACHE.clear()
    wallet_api_module._INDEXTTS_FN_INDEX_CACHE.clear()
    wallet_api_module._INDEXTTS_REFERENCE_CACHE.clear()

    calls = {"config": 0, "join": 0, "upload": 0, "wait": 0, "fetch": 0}

    class FakeClient:
        def get_config(self) -> dict[str, object]:
            calls["config"] += 1
            return {"dependencies": [{"id": 17, "api_name": "/gen_single"}]}

        def resolve_fn_index(self, api_name: str, config: Mapping[str, object], *, fallback_markers=()):
            return 17

        def upload_file(self, file_name: str, data: bytes, mime_type: str) -> dict[str, object]:
            calls["upload"] += 1
            return {"path": "/tmp/abby-reference.wav", "meta": {"_type": "gradio.FileData"}, "orig_name": file_name}

        def queue_join(self, fn_index: int, data: Sequence[object], *, session_hash: str | None = None) -> str:
            calls["join"] += 1
            assert fn_index == 17
            return session_hash or "session-123"

        def wait_for_queue_result(self, session_hash: str, *, timeout_seconds: float | None = None, poll_interval_seconds: float = 0.5) -> dict[str, object]:
            calls["wait"] += 1
            return {"path": "/tmp/out.wav"}

        def fetch_file(self, reference: object, *, accept: str = "audio/*, application/octet-stream") -> tuple[bytes, str]:
            calls["fetch"] += 1
            return b"RIFFstubWAVE", "audio/wav"

    monkeypatch.setenv("WALLET_INDEXTTS_SPACE_URL", "https://example.test")
    monkeypatch.setenv("WALLET_INDEXTTS_API_NAME", "gen_single")
    monkeypatch.setattr(wallet_api_module, "_indextts_space_client", lambda: FakeClient())

    first = wallet_api_module._run_indextts_gradio_tts(text="hello")
    second = wallet_api_module._run_indextts_gradio_tts(text="again")

    assert first["latency"]["total_ms"] >= 0
    assert second["latency"]["config_ms"] == 0
    assert calls == {"config": 1, "join": 2, "upload": 1, "wait": 2, "fetch": 2}


def test_indextts_spoken_text_normalizes_numbers_and_address_abbreviations() -> None:
    assert wallet_api_module._normalize_indextts_spoken_text("Call 911, then ask 211-ai.") == (
        "Call nine one one, then ask two one one AI."
    )
    assert wallet_api_module._normalize_indextts_spoken_text("Meet at SE 32nd ave, apt #4.") == (
        "Meet at South East thirty second Avenue, Apartment 4."
    )
    assert wallet_api_module._normalize_indextts_spoken_text("Shelter: S.E. 82nd Ave Ste 10") == (
        "Shelter: South East eighty second Avenue Suite 10"
    )
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Write this down: 8800 Southeast 8 0th Avenue, Portland."
    ) == "Write this down: 8800 Southeast eightieth Avenue, Portland."
    assert wallet_api_module._normalize_indextts_spoken_text("Food help near N.W. 23rd Pl and SW 4th St.") == (
        "Food help near North West twenty third Place and South West fourth Street."
    )
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Source: https://www.211info.org/agency/1439/14182/. Confirm details before traveling."
    ) == "Confirm details before traveling."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Visit https://gethelp.211info.org/get-help/food/ or call 211."
    ) == "Visit the two one one info website or call two one one."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Phone: phone not listed in this record. Eligibility: eligibility not listed in this record. Visit website."
    ) == ""
    assert wallet_api_module._normalize_indextts_spoken_text(
        "A grounded 211 match is FOOD PANTRY. Source: https://www.211info.org/agency/1439/14182/. Confirm details before traveling."
    ) == "I found Food Pantry. Confirm details before traveling."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "A grounded 211 match is EYE CLINIC. The record lists 120 minutes. 222 SE 8th Avenue Suite 110 Hillsboro, OR 97123. Phone: (503) 352-7300."
    ) == "I found Eye Clinic. The address is 222 South East eighth Avenue Suite 110, Hillsboro, Oregon. ZIP code nine seven one two three. You can call five zero three, three five two, seven three zero zero."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Mail goes to Portland, OR 97206-1234 or use 97204."
    ) == "Mail goes to Portland, Oregon. ZIP code nine seven two zero six dash one two three four or use nine seven two zero four."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Try 450 Highway 99 N Eugene, OR 97402, 1400 Queen Avenue SE Suite 201 Albany, OR 97322, or 15325 NW Central Drive Suite J-8 Portland, OR 97229."
    ) == (
        "Try 450 Highway ninety nine North Eugene, Oregon. ZIP code nine seven four zero two, "
        "1400 Queen Avenue South East Suite 201, Albany, Oregon. ZIP code nine seven three two two, "
        "or 15325 North West Central Drive Suite J-8, Portland, Oregon. ZIP code nine seven two two nine."
    )
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Ages 18-24 who are fleeing domestic violence."
    ) == "Ages eighteen to twenty four who are fleeing domestic violence."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "The office is at 101 E Broadway Suite 200 Eugene, OR 97401."
    ) == "The office is at 101 East Broadway Suite 200, Eugene, Oregon. ZIP code nine seven four zero one."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Monday/Wednesday 8:30am - 4:30pm, call (503) 771-7914, income 80-100% AMI, up to $500."
    ) == (
        "Monday, Wednesday 8:30 AM to 4:30 PM, call five zero three, seven seven one, seven nine one four, "
        "income eighty to one hundred percent AMI, up to five hundred dollars."
    )
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Monday/Wednesday/Thursday 1:15pm-3:45pm"
    ) == "Monday, Wednesday, Thursday 1:15 PM to 3:45 PM"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "-Drop-in Center: 7 days per week 8:30am-5pm"
    ) == "Drop-in Center: 7 days per week 8:30 AM to 5 PM"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Must have served post 9/11 and be eligible."
    ) == "Must have served post September eleventh and be eligible."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "223 SE M Street Grants Pass, OR 97526"
    ) == "223 South East M Street, Grants Pass, Oregon. ZIP code nine seven five two six"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "6329 NE Martin Luther King Jr Boulevard Portland, OR 97211"
    ) == "6329 North East Martin Luther King Jr Boulevard, Portland, Oregon. ZIP code nine seven two one one"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "51 W Washington Burns, OR 97720"
    ) == "51 West Washington Burns, Oregon. ZIP code nine seven seven two zero"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Laundry Facilities * Homeless Youth - 211info"
    ) == "Laundry Facilities for Homeless Youth"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "24 hours per day / 7 days a week"
    ) == "24 hours per day, 7 days a week"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "29796 SW Town Center Loop E Wilsonville, OR 97070"
    ) == "29796 South West Town Center Loop East, Wilsonville, Oregon. ZIP code nine seven zero seven zero"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "ST VINCENT DE PAUL Email (541) 536-1956 Get Directions Visit Website More Details Print & Share X Print & Share Print PDF"
    ) == "Saint VINCENT DE PAUL"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "ST VINCENT DE PAUL OF LANE COUNTY"
    ) == "Saint VINCENT DE PAUL OF LANE COUNTY"
    assert wallet_api_module._normalize_indextts_spoken_text(
        "The record lists latitude: 45.5152 longitude: -122.6784. Source: https://example.org/a."
    ) == ""
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Phone: (541) 485-1017, (541) 485-1017 ext 100."
    ) == "You can call five four one, four eight five, one zero one seven, extension one zero zero."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Eligibility: Unrestricted. Varies by program."
    ) == "Eligibility varies by program."
    assert wallet_api_module._normalize_indextts_spoken_text(
        "Eligibility: Low income individuals age 18 and older. Unrestricted."
    ) == "Eligibility: Low income individuals age eighteen and older."


def test_indextts_proxy_sends_normalized_speech_text(monkeypatch) -> None:
    wallet_api_module._INDEXTTS_CONFIG_CACHE.clear()
    wallet_api_module._INDEXTTS_FN_INDEX_CACHE.clear()
    wallet_api_module._INDEXTTS_REFERENCE_CACHE.clear()

    queued_payloads: list[tuple[int, list[object]]] = []

    class FakeClient:
        def get_config(self) -> dict[str, object]:
            return {"dependencies": [{"id": 17, "api_name": "/gen_single"}]}

        def resolve_fn_index(self, api_name: str, config: Mapping[str, object], *, fallback_markers=()):
            return 17

        def upload_file(self, file_name: str, data: bytes, mime_type: str) -> dict[str, object]:
            return {"path": "/tmp/abby-reference.wav", "meta": {"_type": "gradio.FileData"}, "orig_name": file_name}

        def queue_join(self, fn_index: int, data: Sequence[object], *, session_hash: str | None = None) -> str:
            queued_payloads.append((fn_index, list(data)))
            return session_hash or "session-123"

        def wait_for_queue_result(self, session_hash: str, *, timeout_seconds: float | None = None, poll_interval_seconds: float = 0.5) -> dict[str, object]:
            return {"path": "/tmp/out.wav"}

        def fetch_file(self, reference: object, *, accept: str = "audio/*, application/octet-stream") -> tuple[bytes, str]:
            return b"RIFFstubWAVE", "audio/wav"

    monkeypatch.setenv("WALLET_INDEXTTS_SPACE_URL", "https://example.test")
    monkeypatch.setenv("WALLET_INDEXTTS_API_NAME", "gen_single")
    monkeypatch.setattr(wallet_api_module, "_indextts_space_client", lambda: FakeClient())

    result = wallet_api_module._run_indextts_gradio_tts(text="Visit SE 32nd ave or call 211.")

    assert result["text"] == "Visit South East thirty second Avenue or call two one one."
    assert result["originalText"] == "Visit SE 32nd ave or call 211."
    assert queued_payloads
    assert queued_payloads[0][0] == 17
    assert queued_payloads[0][1][2] == "Visit South East thirty second Avenue or call two one one."


def test_indextts_batch_proxy_uses_batch_endpoint(monkeypatch) -> None:
    wallet_api_module._INDEXTTS_CONFIG_CACHE.clear()
    wallet_api_module._INDEXTTS_FN_INDEX_CACHE.clear()
    wallet_api_module._INDEXTTS_REFERENCE_CACHE.clear()

    queued_payloads: list[tuple[int, list[object]]] = []

    class FakeClient:
        def get_config(self) -> dict[str, object]:
            return {"dependencies": [{"id": 17, "api_name": "/gen_single"}, {"id": 23, "api_name": "/gen_batch"}]}

        def resolve_fn_index(self, api_name: str, config: Mapping[str, object], *, fallback_markers=()):
            return 23 if "batch" in api_name else 17

        def upload_file(self, file_name: str, data: bytes, mime_type: str) -> dict[str, object]:
            return {"path": "/tmp/abby-reference.wav", "meta": {"_type": "gradio.FileData"}, "orig_name": file_name}

        def queue_join(self, fn_index: int, data: Sequence[object], *, session_hash: str | None = None) -> str:
            queued_payloads.append((fn_index, list(data)))
            return session_hash or "session-123"

        def wait_for_queue_result(self, session_hash: str, *, timeout_seconds: float | None = None, poll_interval_seconds: float = 0.5) -> dict[str, object]:
            return {
                "data": [
                    {"__type__": "update", "value": {"path": "/tmp/preview.wav"}},
                    {"__type__": "update", "value": [{"path": "/tmp/one.wav"}, {"path": "/tmp/two.wav"}]},
                    {"__type__": "update", "value": None},
                ]
            }

        def fetch_file(self, reference: object, *, accept: str = "audio/*, application/octet-stream") -> tuple[bytes, str]:
            return b"RIFFstubWAVE", "audio/wav"

    monkeypatch.setenv("WALLET_INDEXTTS_SPACE_URL", "https://example.test")
    monkeypatch.setenv("WALLET_INDEXTTS_BATCH_API_NAME", "gen_batch")
    monkeypatch.setattr(wallet_api_module, "_indextts_space_client", lambda: FakeClient())

    result = wallet_api_module._run_indextts_gradio_batch_tts(texts=["Call 211.", "Meet at SE 32nd ave."])

    assert result["mode"] == "batch"
    assert result["batchSize"] == 2
    assert queued_payloads[0][0] == 23
    assert queued_payloads[0][1][2] == '["Call two one one.", "Meet at South East thirty second Avenue."]'
    assert queued_payloads[0][1][16] == 2
    assert [item["text"] for item in result["items"]] == ["Call two one one.", "Meet at South East thirty second Avenue."]


def test_indextts_batch_prefers_generated_file_list_over_preview(monkeypatch) -> None:
    result = {
        "data": [
            {"__type__": "update", "value": {"path": "/tmp/preview.wav"}},
            {
                "__type__": "update",
                "value": [
                    {"path": "/tmp/item-1.wav"},
                    {"path": "/tmp/item-2.wav"},
                ],
            },
            {"__type__": "update", "value": None},
        ]
    }

    assert wallet_api_module._indextts_batch_audio_references(result) == [
        {"path": "/tmp/item-1.wav"},
        {"path": "/tmp/item-2.wav"},
    ]


def test_indextts_batch_extracts_audio_from_zip_output(monkeypatch) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("spk-item-1.wav", b"RIFFoneWAVE")
        archive.writestr("spk-item-2.wav", b"RIFFtwoWAVE")
    monkeypatch.setattr(wallet_api_module, "_fetch_gradio_file", lambda ref: (buffer.getvalue(), "application/zip"))
    result = {
        "data": [
            {"__type__": "update", "value": {"path": "/tmp/preview.wav"}},
            {"__type__": "update", "value": []},
            {"__type__": "update", "value": {"path": "/tmp/batch.zip"}},
        ]
    }

    refs = wallet_api_module._indextts_batch_audio_references(result)

    assert [ref["name"] for ref in refs] == ["spk-item-1.wav", "spk-item-2.wav"]
    assert refs[0]["_inline_bytes"] == b"RIFFoneWAVE"


def test_indextts_single_tts_accepts_batch_shaped_result(monkeypatch) -> None:
    wallet_api_module._INDEXTTS_CONFIG_CACHE.clear()
    wallet_api_module._INDEXTTS_FN_INDEX_CACHE.clear()
    wallet_api_module._INDEXTTS_REFERENCE_CACHE.clear()

    class FakeClient:
        def get_config(self) -> dict[str, object]:
            return {"dependencies": [{"id": 17, "api_name": "/gen_single"}]}

        def resolve_fn_index(self, api_name: str, config: Mapping[str, object], *, fallback_markers=()):
            return 17

        def upload_file(self, file_name: str, data: bytes, mime_type: str) -> dict[str, object]:
            return {"path": "/tmp/abby-reference.wav", "meta": {"_type": "gradio.FileData"}, "orig_name": file_name}

        def queue_join(self, fn_index: int, data: Sequence[object], *, session_hash: str | None = None) -> str:
            return session_hash or "session-123"

        def wait_for_queue_result(self, session_hash: str, *, timeout_seconds: float | None = None, poll_interval_seconds: float = 0.5) -> dict[str, object]:
            return {
                "data": [
                    {"__type__": "update", "value": {"path": "/tmp/preview.wav"}},
                    {"__type__": "update", "value": [{"path": "/tmp/item-1.wav"}]},
                    {"__type__": "update", "value": None},
                ]
            }

        def fetch_file(self, reference: object, *, accept: str = "audio/*, application/octet-stream") -> tuple[bytes, str]:
            return b"RIFFstubWAVE", "audio/wav"

    monkeypatch.setenv("WALLET_INDEXTTS_SPACE_URL", "https://example.test")
    monkeypatch.setenv("WALLET_INDEXTTS_API_NAME", "gen_single")
    monkeypatch.setattr(wallet_api_module, "_indextts_space_client", lambda: FakeClient())

    result = wallet_api_module._run_indextts_gradio_tts(text="Call 211.")

    assert result["audioBase64"]
    assert result["mimeType"] == "audio/wav"
    assert result["text"] == "Call two one one."


def test_indextts_wait_for_result_expands_empty_space_queue_error(monkeypatch) -> None:
    class FakeClient:
        def wait_for_queue_result(self, session_hash: str, *, timeout_seconds: float | None = None, poll_interval_seconds: float = 0.5):
            raise RuntimeError("Space queue failed: {'error': None}")

    monkeypatch.setattr(wallet_api_module, "_indextts_space_client", lambda: FakeClient())

    try:
        wallet_api_module._indextts_wait_for_result("session-opaque-error")
        raise AssertionError("Expected _indextts_wait_for_result to raise ValueError")
    except ValueError as exc:
        assert "Space queue failed without diagnostic details" in str(exc)


def test_indextts_tts_falls_back_to_api_name_call_after_opaque_queue_failures(monkeypatch) -> None:
    wallet_api_module._INDEXTTS_CONFIG_CACHE.clear()
    wallet_api_module._INDEXTTS_FN_INDEX_CACHE.clear()
    wallet_api_module._INDEXTTS_REFERENCE_CACHE.clear()

    calls = {"wait": 0, "api_call": 0, "predict": 0}

    class FakeClient:
        def get_config(self) -> dict[str, object]:
            return {"dependencies": [{"id": 17, "api_name": "/gen_single"}]}

        def resolve_fn_index(self, api_name: str, config: Mapping[str, object], *, fallback_markers=()):
            return 17

        def upload_file(self, file_name: str, data: bytes, mime_type: str) -> dict[str, object]:
            return {"path": "/tmp/abby-reference.wav", "meta": {"_type": "gradio.FileData"}, "orig_name": file_name}

        def queue_join(self, fn_index: int, data: Sequence[object], *, session_hash: str | None = None) -> str:
            return session_hash or "session-opaque"

        def wait_for_queue_result(self, session_hash: str, *, timeout_seconds: float | None = None, poll_interval_seconds: float = 0.5):
            calls["wait"] += 1
            raise RuntimeError("Space queue failed: {'error': None}")

        def call_api_name(
            self,
            api_name: str,
            data: Sequence[object],
            *,
            timeout_seconds: float | None = None,
            poll_interval_seconds: float = 0.5,
        ) -> Mapping[str, object]:
            calls["api_call"] += 1
            return {"data": [{"path": "/tmp/api-name-fallback.wav"}]}

        def call_endpoint(self, fn_index: int, data: Sequence[object]) -> list[object]:
            calls["predict"] += 1
            return [{"path": "/tmp/direct-predict.wav"}]

        def fetch_file(self, reference: object, *, accept: str = "audio/*, application/octet-stream") -> tuple[bytes, str]:
            return b"RIFFstubWAVE", "audio/wav"

    monkeypatch.setenv("WALLET_INDEXTTS_SPACE_URL", "https://example.test")
    monkeypatch.setenv("WALLET_INDEXTTS_API_NAME", "gen_single")
    monkeypatch.setenv("WALLET_INDEXTTS_ALLOW_DIRECT_PREDICT_FALLBACK", "true")
    monkeypatch.setattr(wallet_api_module, "_indextts_space_client", lambda: FakeClient())

    result = wallet_api_module._run_indextts_gradio_tts(text="Call 211.")

    assert result["audioBase64"]
    assert result["mimeType"] == "audio/wav"
    assert result["latency"].get("result_path") == "api-name-fallback"
    assert calls == {"wait": 2, "api_call": 1, "predict": 0}


def test_indextts_voice_reply_generates_llm_text_before_tts(monkeypatch) -> None:
    from ipfs_datasets_py import llm_router

    prompts: list[dict[str, object]] = []
    expected_text = "Food pantries near Portland may be open today. What ZIP code should I search around?"

    def fake_generate_text(prompt: str, *, model_name: str, provider: str, **kwargs: object) -> str:
        prompts.append({"prompt": prompt, "model_name": model_name, "provider": provider, "kwargs": kwargs})
        return expected_text

    def fake_tts(**kwargs: object) -> dict[str, object]:
        assert kwargs["text"] == expected_text
        return {"audioBase64": "UklGRnN0dWJXQVZF", "mimeType": "audio/wav", "latency": {"tts_request_ms": 1}}

    monkeypatch.setattr(llm_router, "generate_text", fake_generate_text)
    monkeypatch.setattr(wallet_api_module, "_run_indextts_tts_with_batch_fallback", fake_tts)
    monkeypatch.setenv("WALLET_VOICE_LLM_MODEL", "Qwen/Qwen3.5-2B")

    client = _client()
    response = client.post(
        "/voice/indextts/infer",
        data={
            "mode": "voice-reply",
            "userPrompt": "I need food help",
            "fallbackText": "I can help search for food resources.",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["audioBase64"] == "UklGRnN0dWJXQVZF"
    assert body["mimeType"] == "audio/wav"
    assert body["text"] == expected_text
    assert body["latency"]["llm_request_ms"] >= 0
    assert body["latency"]["llm_model"] == "Qwen/Qwen3.5-2B"
    assert prompts and "I need food help" in str(prompts[0]["prompt"])


def test_hf_whisper_stt_extracts_text_from_nested_payload(monkeypatch) -> None:
    class FakeResponse:
        headers = {"content-type": "application/json"}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps({"items": [{"text": "hello from nested whisper"}]}).encode("utf-8")

    def fake_urlopen(request, timeout: float):
        return FakeResponse()

    monkeypatch.setenv("HF_TOKEN", "test-token")
    monkeypatch.setenv("WALLET_HF_WHISPER_MODEL_NAME", "openai/whisper-large-v3-turbo")
    monkeypatch.setattr(wallet_api_module.urllib_request, "urlopen", fake_urlopen)

    result = wallet_api_module._run_hf_whisper_stt(b"RIFFstubWAVE", audio_name="speech.wav", audio_type="audio/wav")

    assert result["text"] == "hello from nested whisper"
    assert result["provider"] == "huggingface-whisper"


def test_wallet_api_phone_call_notification_queue_and_manual_dispatch_uses_http_webhook(monkeypatch) -> None:
    captured_requests = []

    class FakeResponse:
        def __init__(self, payload: dict[str, object]) -> None:
            self.payload = payload
            self.headers = {"content-type": "application/json"}
            self.status = 202

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(self.payload).encode("utf-8")


def test_wallet_api_ops_health_reports_repository_storage_and_audits(tmp_path) -> None:
    service = WalletInterfaceService(repository_root=tmp_path / "wallet-repository")
    client = _client_with_service(service)
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    response = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "filename": "ops-health.txt",
            "text": "ops health document",
        },
    )
    assert response.status_code == 200

    response = client.get("/ops/health", params={"verify_storage": "true"})
    assert response.status_code == 200
    report = response.json()
    checks = {check["name"]: check for check in report["checks"]}

    assert report["status"] in {"ok", "warning"}
    assert checks["repository"]["status"] == "ok"
    assert checks["storage_availability"]["status"] == "ok"
    assert checks["storage_availability"]["details"]["verified"] is True
    assert checks["revocation_propagation"]["status"] == "ok"
    assert checks["privacy_budget"]["status"] == "ok"

    response = client.get(f"/wallets/{wallet['wallet_id']}/audit")
    actions = [event["action"] for event in response.json()["events"]]
    assert "ops/health" in actions

    restored = WalletInterfaceService(
        repository_root=tmp_path / "wallet-repository",
        auto_load_repository=True,
    )
    restored_actions = [
        event.action for event in restored.wallet_service.get_audit_log(wallet["wallet_id"])
    ]
    assert "ops/health" in restored_actions


def test_wallet_api_ops_health_requires_shared_secret_when_configured(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("WALLET_OPS_HEALTH_SHARED_SECRET", "top-secret")
    service = WalletInterfaceService(repository_root=tmp_path / "wallet-repository")
    client = _client_with_service(service)

    unauthorized = client.get("/ops/health")
    assert unauthorized.status_code == 401
    assert "authorization required" in unauthorized.json()["detail"]

    wrong_secret = client.get(
        "/ops/health",
        headers={"authorization": "Bearer wrong-secret"},
    )
    assert wrong_secret.status_code == 401

    authorized = client.get(
        "/ops/health",
        headers={"authorization": "Bearer top-secret"},
    )
    assert authorized.status_code == 200
    assert authorized.json()["status"] in {"ok", "warning"}


def test_wallet_api_ops_health_accepts_shared_secret_header(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("WALLET_OPS_HEALTH_SHARED_SECRET", "edge-secret")
    service = WalletInterfaceService(repository_root=tmp_path / "wallet-repository")
    client = _client_with_service(service)

    response = client.get(
        "/ops/health",
        headers={"x-wallet-ops-shared-secret": "edge-secret"},
    )
    assert response.status_code == 200
    assert response.json()["check_count"] >= 1


def test_wallet_api_snapshot_save_list_and_load(tmp_path) -> None:
    storage_config = {"type": "local", "root": tmp_path / "wallet-blobs"}
    repository_root = tmp_path / "wallet-repository"
    service = WalletInterfaceService(
        services=[],
        storage_config=storage_config,
        repository_root=repository_root,
    )
    client = _client_with_service(service)
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    record = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "filename": "snapshot.txt",
            "text": "snapshot round trip document",
        },
    ).json()

    response = client.post(f"/wallets/{wallet['wallet_id']}/snapshot")

    assert response.status_code == 200
    assert Path(response.json()["path"]).exists()
    response = client.get(f"/wallets/{wallet['wallet_id']}/snapshot")
    assert response.status_code == 200
    assert response.json()["valid"] is True
    assert response.json()["snapshot_hash"] == response.json()["computed_hash"]
    response = client.get("/wallets/snapshots")
    assert response.status_code == 200
    assert response.json()["wallet_ids"] == [wallet["wallet_id"]]
    response = client.post("/wallets/snapshots/save-all")
    assert response.status_code == 200
    assert response.json()["count"] == 1

    restored_service = WalletInterfaceService(
        services=[],
        storage_config=storage_config,
        repository_root=repository_root,
        auto_load_repository=False,
    )
    restored_client = _client_with_service(restored_service)
    response = restored_client.post("/wallets/snapshots/load-all")

    assert response.status_code == 200
    assert response.json()["wallet_ids"] == [wallet["wallet_id"]]
    response = restored_client.get(f"/wallets/{wallet['wallet_id']}/records", params={"data_type": "document"})
    assert response.status_code == 200
    assert [item["record_id"] for item in response.json()["records"]] == [record["record_id"]]


def test_wallet_api_portal_saved_services_plans_and_interactions_round_trip() -> None:
    client = _client()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/portal/saved-services",
        json={
            "actor_did": "did:key:owner",
            "service_doc_id": "service:abc123",
            "source_content_cid": "bafk-service",
            "source_page_cid": "bafk-page",
            "title": "Energy Assistance",
            "provider_name": "Community Action",
            "program_name": "Energy Assistance",
            "source_url": "https://example.test/services/energy",
            "label": "Call this week",
            "reason": "Utility shutoff risk",
            "priority": "high",
            "status": "saved",
        },
    )
    assert response.status_code == 200
    saved = response.json()
    assert saved["saved_service_id"].startswith("saved-service-")
    assert saved["service_doc_id"] == "service:abc123"

    response = client.patch(
        f"/wallets/{wallet['wallet_id']}/portal/saved-services/{saved['saved_service_id']}",
        json={
            "actor_did": "did:key:owner",
            "status": "contacted",
            "private_notes_record_id": "record-private-notes-1",
        },
    )
    assert response.status_code == 200
    saved = response.json()
    assert saved["status"] == "contacted"
    assert saved["private_notes_record_id"] == "record-private-notes-1"

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/portal/plans",
        json={
            "actor_did": "did:key:owner",
            "service_doc_id": "service:abc123",
            "source_content_cid": "bafk-service",
            "source_page_cid": "bafk-page",
            "service_title": "Energy Assistance",
            "provider_name": "Community Action",
            "goal": "Avoid utility disconnection",
            "steps": ["Call provider", "Gather bill", "Complete intake"],
            "documents_needed": ["Photo ID", "Utility bill"],
            "questions_to_ask": ["Do they cover reconnect fees?"],
            "reminder_at": "2026-05-06T09:00:00+00:00",
            "travel_target": "Phone call",
            "status": "active",
        },
    )
    assert response.status_code == 200
    plan = response.json()
    assert plan["plan_id"].startswith("service-plan-")
    assert plan["steps"] == ["Call provider", "Gather bill", "Complete intake"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/portal/interactions",
        json={
            "actor_did": "did:key:owner",
            "service_doc_id": "service:abc123",
            "source_content_cid": "bafk-service",
            "source_page_cid": "bafk-page",
            "provider_name": "Community Action",
            "program_name": "Energy Assistance",
            "interaction_type": "called_provider",
            "channel": "phone",
            "counterparty_name": "Front Desk",
            "counterparty_contact": "(503) 555-0100",
            "status": "completed",
            "outcome": "Left voicemail",
            "next_action": "Try again tomorrow",
            "next_follow_up_at": "2026-05-06T16:00:00+00:00",
            "related_record_ids": [saved["private_notes_record_id"]],
            "privacy_level": "restricted",
        },
    )
    assert response.status_code == 200
    interaction = response.json()
    assert interaction["interaction_id"].startswith("interaction-")
    assert interaction["privacy_level"] == "restricted"

    response = client.patch(
        f"/wallets/{wallet['wallet_id']}/portal/plans/{plan['plan_id']}",
        json={
            "actor_did": "did:key:owner",
            "status": "in_progress",
            "related_interaction_ids": [interaction["interaction_id"]],
        },
    )
    assert response.status_code == 200
    updated_plan = response.json()
    assert updated_plan["related_interaction_ids"] == [interaction["interaction_id"]]

    response = client.patch(
        f"/wallets/{wallet['wallet_id']}/portal/interactions/{interaction['interaction_id']}",
        json={
            "actor_did": "did:key:owner",
            "outcome": "Appointment scheduled",
            "status": "scheduled",
        },
    )
    assert response.status_code == 200
    interaction = response.json()
    assert interaction["status"] == "scheduled"
    assert interaction["outcome"] == "Appointment scheduled"

    response = client.get(f"/wallets/{wallet['wallet_id']}/portal/saved-services")
    assert response.status_code == 200
    assert [item["saved_service_id"] for item in response.json()["saved_services"]] == [saved["saved_service_id"]]

    response = client.get(
        f"/wallets/{wallet['wallet_id']}/portal/plans",
        params={"service_doc_id": "service:abc123"},
    )
    assert response.status_code == 200
    assert [item["plan_id"] for item in response.json()["plans"]] == [plan["plan_id"]]

    response = client.get(
        f"/wallets/{wallet['wallet_id']}/portal/interactions",
        params={"interaction_type": "called_provider"},
    )
    assert response.status_code == 200
    assert [item["interaction_id"] for item in response.json()["interactions"]] == [interaction["interaction_id"]]

    response = client.get(f"/wallets/{wallet['wallet_id']}/audit")
    actions = [event["action"] for event in response.json()["events"]]
    assert "service/save" in actions
    assert "service/update" in actions
    assert "service_plan/create" in actions
    assert "service_plan/update" in actions
    assert "interaction/create" in actions
    assert "interaction/update" in actions


def test_wallet_api_portal_state_persists_through_snapshot_load(tmp_path) -> None:
    repository_root = tmp_path / "wallet-repository"
    service = WalletInterfaceService(repository_root=repository_root, services=[])
    client = _client_with_service(service)
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()

    saved = client.post(
        f"/wallets/{wallet['wallet_id']}/portal/saved-services",
        json={
            "actor_did": "did:key:owner",
            "service_doc_id": "service:persist-1",
            "source_content_cid": "bafk-persist",
            "title": "Shelter Intake",
            "provider_name": "Shelter Network",
            "status": "saved",
        },
    ).json()
    plan = client.post(
        f"/wallets/{wallet['wallet_id']}/portal/plans",
        json={
            "actor_did": "did:key:owner",
            "service_doc_id": "service:persist-1",
            "service_title": "Shelter Intake",
            "goal": "Complete shelter intake",
            "steps": ["Call first", "Bring ID"],
        },
    ).json()
    interaction = client.post(
        f"/wallets/{wallet['wallet_id']}/portal/interactions",
        json={
            "actor_did": "did:key:owner",
            "service_doc_id": "service:persist-1",
            "interaction_type": "saved_service",
            "status": "recorded",
        },
    ).json()

    response = client.post(f"/wallets/{wallet['wallet_id']}/snapshot")
    assert response.status_code == 200

    restored_service = WalletInterfaceService(
        repository_root=repository_root,
        services=[],
        auto_load_repository=False,
    )
    restored_client = _client_with_service(restored_service)
    response = restored_client.post("/wallets/snapshots/load-all")
    assert response.status_code == 200

    response = restored_client.get(f"/wallets/{wallet['wallet_id']}/portal/saved-services")
    assert response.status_code == 200
    assert [item["saved_service_id"] for item in response.json()["saved_services"]] == [saved["saved_service_id"]]

    response = restored_client.get(f"/wallets/{wallet['wallet_id']}/portal/plans")
    assert response.status_code == 200
    assert [item["plan_id"] for item in response.json()["plans"]] == [plan["plan_id"]]

    response = restored_client.get(f"/wallets/{wallet['wallet_id']}/portal/interactions")
    assert response.status_code == 200
    assert [item["interaction_id"] for item in response.json()["interactions"]] == [interaction["interaction_id"]]

    response = restored_client.get(f"/wallets/{wallet['wallet_id']}/audit")
    assert response.status_code == 200
    actions = [event["action"] for event in response.json()["events"]]
    assert "service/save" in actions
    assert "service_plan/create" in actions
    assert "interaction/create" in actions


def test_wallet_api_rejects_precise_analytics_fields() -> None:
    client = _client()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    client.post(
        "/analytics/templates",
        json={
            "template_id": "api_unsafe_location_v1",
            "title": "Unsafe location",
            "purpose": "Should reject precise fields",
            "allowed_record_types": ["location"],
            "allowed_derived_fields": ["lat"],
            "min_cohort_size": 2,
            "epsilon_budget": 0.5,
            "created_by": "did:key:analyst",
        },
    )
    consent = client.post(
        f"/wallets/{wallet['wallet_id']}/analytics/consents/from-template",
        json={"actor_did": "did:key:owner", "template_id": "api_unsafe_location_v1"},
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/analytics/contributions",
        json={
            "actor_did": "did:key:owner",
            "consent_id": consent["consent_id"],
            "template_id": "api_unsafe_location_v1",
            "fields": {"lat": 45.515232},
        },
    )
    assert response.status_code == 422


def test_wallet_api_service_matching_rejects_precise_location() -> None:
    client = _client()
    response = client.post(
        "/services/match-derived",
        json={
            "need_terms": ["housing"],
            "location_claim": {"public_value": {"lat": 45.515232, "lon": -122.678385}, "precision": "precise"},
        },
    )
    assert response.status_code == 422


def test_wallet_api_export_bundle_uses_export_grant_without_plaintext() -> None:
    client = _client()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    document = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "filename": "notice.txt",
            "text": "Confidential export document",
        },
    ).json()
    location = client.post(
        f"/wallets/{wallet['wallet_id']}/locations",
        json={"actor_did": "did:key:owner", "lat": 45.515232, "lon": -122.678385},
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/exports",
        json={
            "actor_did": "did:key:delegate",
            "record_ids": [document["record_id"], location["record_id"]],
        },
    )
    assert response.status_code == 400
    assert "requires" in response.json()["detail"]

    grant = client.post(
        f"/wallets/{wallet['wallet_id']}/exports/grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "audience_key_hex": delegate_key,
            "record_ids": [document["record_id"], location["record_id"]],
        },
    ).json()
    assert grant["caveats"]["output_types"] == ["encrypted_export_bundle"]
    invocation = client.post(
        f"/wallets/{wallet['wallet_id']}/exports/invocations",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "grant_id": grant["grant_id"],
            "record_ids": [document["record_id"]],
        },
    ).json()
    response = client.post(
        f"/wallets/{wallet['wallet_id']}/exports",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": invocation["invocation_token"],
            "record_ids": [document["record_id"]],
        },
    )
    assert response.status_code == 200
    bundle = response.json()
    assert bundle["bundle_type"] == "wallet_export_v1"
    assert bundle["bundle_id"] == f"export-{bundle['bundle_hash'][:24]}"
    assert "controller_dids" not in bundle["wallet"]
    assert "device_dids" not in bundle["wallet"]
    assert [record["data_type"] for record in bundle["records"]] == ["document"]
    public_bundle = json.dumps(bundle)
    assert "Confidential export document" not in public_bundle
    assert "45.515232" not in public_bundle
    assert "-122.678385" not in public_bundle
    response = client.post("/exports/verify", json={"bundle": bundle})
    assert response.status_code == 200
    verified = response.json()
    assert verified["valid"] is True
    assert verified["hash_valid"] is True
    assert verified["schema_valid"] is True
    assert verified["computed_hash"] == bundle["bundle_hash"]
    response = client.post("/exports/import", json={"bundle": bundle})
    assert response.status_code == 200
    imported = response.json()
    assert imported["record_count"] == 1
    assert imported["bundle_hash"] == bundle["bundle_hash"]
    response = client.post("/exports/storage", json={"bundle": bundle})
    assert response.status_code == 200
    storage = response.json()
    assert storage["record_count"] == 1
    assert "ok" in storage
    tampered = {**bundle, "records": []}
    response = client.post("/exports/verify", json={"bundle": tampered})
    assert response.status_code == 200
    assert response.json()["valid"] is False
    response = client.post("/exports/import", json={"bundle": tampered})
    assert response.status_code == 400
    assert "verification failed" in response.json()["detail"]
    malformed = {**bundle, "bundle_type": "not_wallet_export"}
    verify = client.post("/exports/verify", json={"bundle": malformed}).json()
    malformed["bundle_hash"] = verify["computed_hash"]
    malformed["bundle_id"] = f"export-{malformed['bundle_hash'][:24]}"
    response = client.post("/exports/verify", json={"bundle": malformed})
    assert response.status_code == 200
    malformed_verification = response.json()
    assert malformed_verification["valid"] is False
    assert malformed_verification["hash_valid"] is True
    assert malformed_verification["schema_valid"] is False
    assert "Unsupported" in malformed_verification["schema_error"]
    response = client.post("/exports/import", json={"bundle": malformed})
    assert response.status_code == 400
    assert "Unsupported" in response.json()["detail"]

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/exports",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": invocation["invocation_token"],
            "record_ids": [location["record_id"]],
        },
    )
    assert response.status_code == 400
    assert "invocation" in response.json()["detail"]


def test_wallet_api_revoked_export_grant_blocks_invocation() -> None:
    client = _client()
    delegate_key = random_key().hex()
    wallet = client.post("/wallets", json={"owner_did": "did:key:owner"}).json()
    document = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "filename": "revoked-export.txt",
            "text": "Export must stop after revocation.",
        },
    ).json()
    grant = client.post(
        f"/wallets/{wallet['wallet_id']}/exports/grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "audience_key_hex": delegate_key,
            "record_ids": [document["record_id"]],
        },
    ).json()
    invocation = client.post(
        f"/wallets/{wallet['wallet_id']}/exports/invocations",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "grant_id": grant["grant_id"],
            "record_ids": [document["record_id"]],
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/grants/{grant['grant_id']}/revoke",
        json={"actor_did": "did:key:owner"},
    )
    assert response.status_code == 200
    response = client.post(
        f"/wallets/{wallet['wallet_id']}/exports",
        json={
            "actor_did": "did:key:delegate",
            "actor_key_hex": delegate_key,
            "invocation_token": invocation["invocation_token"],
            "record_ids": [document["record_id"]],
        },
    )

    assert response.status_code == 400
    assert "not active" in response.json()["detail"]


def test_wallet_api_export_grant_respects_threshold_approval() -> None:
    client = _client()
    wallet = client.post(
        "/wallets",
        json={
            "owner_did": "did:key:owner",
            "controller_dids": ["did:key:owner", "did:key:second-controller"],
            "approval_threshold": 2,
        },
    ).json()
    document = client.post(
        f"/wallets/{wallet['wallet_id']}/documents/text",
        json={
            "actor_did": "did:key:owner",
            "filename": "export-approval.txt",
            "text": "API export approval document",
        },
    ).json()

    response = client.post(
        f"/wallets/{wallet['wallet_id']}/exports/grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "record_ids": [document["record_id"]],
        },
    )
    assert response.status_code == 400
    assert "approval_id is required" in response.json()["detail"]

    approval = client.post(
        f"/wallets/{wallet['wallet_id']}/approvals",
        json={
            "requested_by": "did:key:owner",
            "operation": "grant/create",
            "resources": [resource_for_export(wallet["wallet_id"])],
            "abilities": ["export/create"],
        },
    ).json()
    for approver in ["did:key:owner", "did:key:second-controller"]:
        response = client.post(
            f"/wallets/{wallet['wallet_id']}/approvals/{approval['approval_id']}/approve",
            json={"approver_did": approver},
        )
        assert response.status_code == 200
    response = client.post(
        f"/wallets/{wallet['wallet_id']}/exports/grants",
        json={
            "issuer_did": "did:key:owner",
            "audience_did": "did:key:delegate",
            "record_ids": [document["record_id"]],
            "approval_id": approval["approval_id"],
        },
    )

    assert response.status_code == 200
    assert response.json()["abilities"] == ["export/create"]
