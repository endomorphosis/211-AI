from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from wallet_interface import WalletInterfaceService, create_app
from wallet_interface.world_id import DEFAULT_WORLD_ID_ACTION, WorldIdVerificationError, load_world_id_config


OWNER = "did:key:owner"
ADVOCATE = "did:key:advocate"
PROVIDER_STAFF_ACTION = "provider-staff-world-id-v1"


def enabled_env(**overrides: str) -> dict[str, str]:
    env = {
        "WORLD_ID_ENABLED": "1",
        "WORLD_ID_ENVIRONMENT": "staging",
        "WORLD_ID_APP_ID": "app_test_123",
        "WORLD_ID_RP_ID": "rp_test_123",
        "WORLD_ID_RP_SIGNING_KEY": "0x" + "11" * 32,
        "WORLD_ID_NULLIFIER_HMAC_KEY": "nullifier-hmac-secret",
    }
    env.update(overrides)
    return env


def sample_v4_idkit_payload(nullifier: str = "0xraw-world-id-nullifier") -> dict[str, object]:
    return {
        "protocol_version": "4.0",
        "nonce": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "action": DEFAULT_WORLD_ID_ACTION,
        "environment": "staging",
        "user_presence_completed": True,
        "responses": [
            {
                "identifier": "proof_of_human",
                "signal_hash": "0x0",
                "proof": ["0x1a", "0x2b", "0x3c", "0x4d", "0x5e"],
                "nullifier": nullifier,
                "issuer_schema_id": 1,
                "expires_at_min": 1_756_166_400,
            }
        ],
    }


def test_wallet_interface_world_id_config_status_and_rp_signature() -> None:
    config = load_world_id_config(env=enabled_env())
    app = WalletInterfaceService(world_id_config=config, services=[], auto_persist=False)
    wallet = app.create_wallet(OWNER)

    public_config = app.get_world_id_config()
    status = app.get_world_id_status(wallet.wallet_id)
    signature = app.create_world_id_rp_signature(
        wallet_id=wallet.wallet_id,
        actor_did=OWNER,
        action=DEFAULT_WORLD_ID_ACTION,
        random_bytes=bytes(range(32)),
        created_at=1_700_000_000,
    )

    assert public_config["enabled"] is True
    assert "signing" not in json.dumps(public_config).lower()
    assert status["wallet"]["binding_count"] == 0
    assert signature["rp_id"] == "rp_test_123"
    assert signature["sig"] == signature["signature"]
    assert signature["action"] == DEFAULT_WORLD_ID_ACTION
    with pytest.raises(ValueError, match="not authorized"):
        app.create_world_id_rp_signature(wallet_id=wallet.wallet_id, actor_did=ADVOCATE)


def test_wallet_interface_provider_staff_world_id_action_is_separate_and_policy_gated() -> None:
    config = load_world_id_config(
        env=enabled_env(WORLD_ID_ALLOWED_ACTIONS=f"{DEFAULT_WORLD_ID_ACTION},{PROVIDER_STAFF_ACTION}")
    )
    app = WalletInterfaceService(world_id_config=config, services=[], auto_persist=False)
    wallet = app.create_wallet(OWNER)

    client_signature = app.create_world_id_rp_signature(
        wallet_id=wallet.wallet_id,
        actor_did=OWNER,
        action=DEFAULT_WORLD_ID_ACTION,
        random_bytes=bytes(range(32)),
        created_at=1_700_000_000,
    )
    staff_signature = app.create_provider_staff_world_id_rp_signature(
        wallet_id=wallet.wallet_id,
        actor_did=OWNER,
        provider_id="Rose City Shelter",
        provider_staff_id="staff-demo-rose",
        random_bytes=bytes(range(32)),
        created_at=1_700_000_000,
    )

    assert client_signature["action"] == DEFAULT_WORLD_ID_ACTION
    assert staff_signature["action"] == PROVIDER_STAFF_ACTION
    assert staff_signature["signal_context"] == "provider_staff_verification"
    assert staff_signature["provider_id"] == "Rose City Shelter"
    assert staff_signature["provider_staff_id"] == "staff-demo-rose"
    assert client_signature["action"] != staff_signature["action"]
    with pytest.raises(ValueError, match="provider organization policy"):
        app.create_provider_staff_world_id_rp_signature(
            wallet_id=wallet.wallet_id,
            actor_did=OWNER,
            provider_id="",
            provider_staff_id="staff-demo-rose",
        )


def test_wallet_interface_verifies_registers_persists_and_revokes_world_id_binding(tmp_path) -> None:
    config = load_world_id_config(env=enabled_env())
    raw_nullifier = "0xraw-world-id-nullifier"
    calls: list[tuple[str, str, object, dict[str, str], float]] = []

    def fake_request_json(method, url, request_payload, headers, timeout_seconds):
        calls.append((method, url, request_payload, dict(headers), timeout_seconds))
        return {
            "success": True,
            "results": [
                {
                    "success": True,
                    "identifier": "proof_of_human",
                    "nullifier": raw_nullifier,
                }
            ],
            "action": DEFAULT_WORLD_ID_ACTION,
            "nullifier": raw_nullifier,
            "created_at": "2026-06-13T00:00:00Z",
            "environment": "staging",
            "message": "verified",
        }

    app = WalletInterfaceService(
        world_id_config=config,
        world_id_request_json=fake_request_json,
        repository_root=tmp_path / "repo",
        services=[],
    )
    wallet = app.create_wallet(OWNER)

    result = app.register_world_id_verification(
        wallet.wallet_id,
        actor_did=OWNER,
        idkit_payload=sample_v4_idkit_payload(raw_nullifier),
    )

    binding = result["binding"]
    proof = result["proof"]
    rendered_result = json.dumps(result, sort_keys=True)
    snapshot_path = app.repository.wallet_path(wallet.wallet_id)
    snapshot_payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    rendered_snapshot = json.dumps(snapshot_payload, sort_keys=True)

    assert calls[0][1] == "https://developer.world.org/api/v4/verify/rp_test_123"
    assert binding["nullifier_ref"].startswith("worldid-nullifier-ref:v1:")
    assert binding["nullifier_ref"] != raw_nullifier
    assert binding["proof_receipt_id"] == proof["proof_id"]
    assert proof["proof_type"] == "world_id_proof_of_human"
    assert proof["proof_system"] == "world_id_idkit_v4"
    assert result["verification"]["nullifier"] == "[redacted]"
    assert raw_nullifier not in rendered_result
    assert raw_nullifier not in rendered_snapshot
    assert snapshot_payload["snapshot"]["world_id_bindings"][0]["binding_id"] == binding["binding_id"]
    assert app.get_world_id_status(wallet.wallet_id)["wallet"]["active_binding_count"] == 1

    with pytest.raises(ValueError, match="not authorized"):
        app.revoke_world_id_binding(wallet.wallet_id, binding["binding_id"], actor_did=ADVOCATE)
    revoked = app.revoke_world_id_binding(
        wallet.wallet_id,
        binding["binding_id"],
        actor_did=OWNER,
        reason="user disconnected",
    )

    assert revoked.status == "revoked"
    assert app.get_world_id_status(wallet.wallet_id)["wallet"]["active_binding_count"] == 0
    assert "wallet/world_id_revoke" in [event.action for event in app.wallet_service.get_audit_log(wallet.wallet_id)]


def test_world_id_export_bundle_carries_only_sanitized_public_proof_metadata(tmp_path) -> None:
    config = load_world_id_config(env=enabled_env())
    raw_nullifier = "0xraw-world-id-nullifier"

    def fake_request_json(*_):
        return {
            "success": True,
            "results": [{"success": True, "identifier": "proof_of_human", "nullifier": raw_nullifier}],
            "action": DEFAULT_WORLD_ID_ACTION,
            "nullifier": raw_nullifier,
            "created_at": "2026-06-13T00:00:00Z",
            "environment": "staging",
            "message": "verified",
        }

    app = WalletInterfaceService(
        world_id_config=config,
        world_id_request_json=fake_request_json,
        repository_root=tmp_path / "repo",
        services=[],
    )
    wallet = app.create_wallet(OWNER)
    source = tmp_path / "benefits-note.txt"
    source.write_text(
        "Benefits note for Jane Example. Email jane@example.org, phone 503-555-1212, SSN 123-45-6789.",
        encoding="utf-8",
    )
    document = app.add_document(wallet.wallet_id, source, actor_did=OWNER)
    result = app.register_world_id_verification(
        wallet.wallet_id,
        actor_did=OWNER,
        idkit_payload=sample_v4_idkit_payload(raw_nullifier),
    )
    proof = app.wallet_service.proofs[result["proof"]["proof_id"]]
    proof.statement["idkit_payload"] = sample_v4_idkit_payload(raw_nullifier)
    proof.statement["developer_portal_response"] = {"nullifier": raw_nullifier}
    proof.public_inputs.update(
        {
            "raw_nullifier": raw_nullifier,
            "nullifier": raw_nullifier,
            "idkit_proof": ["0x1a", "0x2b"],
            "developer_portal_response": {"results": [{"nullifier": raw_nullifier}]},
            "rp_signature": "0xmocksig",
            "email": "jane@example.org",
            "phone": "503-555-1212",
            "ssn": "123-45-6789",
        }
    )
    proof.metadata["developer_portal_response"] = {"nullifier": raw_nullifier}
    proof.metadata["rp_signature"] = "0xmocksig"

    bundle = app.create_export_bundle(
        wallet.wallet_id,
        actor_did=OWNER,
        record_ids=[document.record_id],
        include_proofs=True,
    )
    rendered_bundle = json.dumps(bundle, sort_keys=True)
    world_id_proofs = [proof for proof in bundle["proofs"] if proof["proof_type"] == "world_id_proof_of_human"]

    assert len(world_id_proofs) == 1
    public_inputs = world_id_proofs[0]["public_inputs"]
    assert public_inputs["claim"] == "world_id_proof_of_human"
    assert public_inputs["credential_policy"] == "proof_of_human"
    assert public_inputs["nullifier_commitment"].startswith("hmac-sha256:")
    assert public_inputs["verification_result_hash"].startswith("sha256:")
    assert "nullifier_ref" not in public_inputs
    assert "nullifier_ref" not in world_id_proofs[0]["statement"]
    assert app.verify_export_bundle(bundle)["valid"] is True

    for forbidden in [
        raw_nullifier,
        "0x1a",
        "idkit_payload",
        "idkit_proof",
        "developer_portal_response",
        "rp_signature",
        "0xmocksig",
        "jane@example.org",
        "503-555-1212",
        "123-45-6789",
        "Jane Example",
    ]:
        assert forbidden not in rendered_bundle


def test_wallet_interface_world_id_registration_preserves_authorization_and_config_boundaries() -> None:
    config = load_world_id_config(env=enabled_env())
    app = WalletInterfaceService(world_id_config=config, services=[], auto_persist=False)
    wallet = app.create_wallet(OWNER)

    with pytest.raises(ValueError, match="not authorized"):
        app.register_world_id_verification(
            wallet.wallet_id,
            actor_did=ADVOCATE,
            idkit_payload=sample_v4_idkit_payload(),
            request_json=lambda *_: {"success": True},
        )

    bad_action = sample_v4_idkit_payload()
    bad_action["action"] = "other-action"
    with pytest.raises(ValueError, match="not allowed"):
        app.register_world_id_verification(
            wallet.wallet_id,
            actor_did=OWNER,
            idkit_payload=bad_action,
            request_json=lambda *_: {"success": True},
        )

    disabled = WalletInterfaceService(world_id_config=load_world_id_config(env={}), services=[], auto_persist=False)
    disabled_wallet = disabled.create_wallet(OWNER)
    with pytest.raises(WorldIdVerificationError, match="disabled"):
        disabled.register_world_id_verification(
            disabled_wallet.wallet_id,
            actor_did=OWNER,
            idkit_payload=sample_v4_idkit_payload(),
            request_json=lambda *_: {"success": True},
        )


def test_world_id_fastapi_routes_cover_config_signature_registration_replay_and_revoke(tmp_path) -> None:
    config = load_world_id_config(env=enabled_env())
    raw_nullifier = "0xraw-world-id-nullifier"

    def fake_request_json(*_):
        return {
            "success": True,
            "results": [{"success": True, "identifier": "proof_of_human", "nullifier": raw_nullifier}],
            "action": DEFAULT_WORLD_ID_ACTION,
            "nullifier": raw_nullifier,
            "created_at": "2026-06-13T00:00:00Z",
            "environment": "staging",
            "message": "verified",
        }

    service = WalletInterfaceService(
        world_id_config=config,
        world_id_request_json=fake_request_json,
        repository_root=tmp_path / "repo",
        services=[],
    )
    client = TestClient(create_app(service=service))
    wallet = client.post("/wallets", json={"owner_did": OWNER}).json()
    wallet_id = wallet["wallet_id"]

    config_response = client.get(f"/wallets/{wallet_id}/world-id/config")
    status_response = client.get(f"/wallets/{wallet_id}/world-id/status", params={"actor_did": OWNER})
    denied_status = client.get(f"/wallets/{wallet_id}/world-id/status", params={"actor_did": ADVOCATE})
    signature_response = client.post(
        f"/wallets/{wallet_id}/world-id/rp-signature",
        json={"actor_did": OWNER, "action": DEFAULT_WORLD_ID_ACTION},
    )
    denied_signature = client.post(
        f"/wallets/{wallet_id}/world-id/rp-signature",
        json={"actor_did": ADVOCATE, "action": DEFAULT_WORLD_ID_ACTION},
    )

    assert config_response.status_code == 200, config_response.text
    assert config_response.json()["enabled"] is True
    assert status_response.status_code == 200, status_response.text
    assert status_response.json()["wallet"]["binding_count"] == 0
    assert denied_status.status_code == 400
    assert signature_response.status_code == 200, signature_response.text
    assert signature_response.json()["rp_id"] == "rp_test_123"
    assert denied_signature.status_code == 400

    verify_response = client.post(
        f"/wallets/{wallet_id}/world-id/verifications",
        json={"actor_did": OWNER, "idkit_payload": sample_v4_idkit_payload(raw_nullifier)},
    )
    assert verify_response.status_code == 200, verify_response.text
    body = verify_response.json()
    rendered = json.dumps(body, sort_keys=True)
    binding_id = body["binding"]["binding_id"]

    assert body["binding"]["nullifier_ref"].startswith("worldid-nullifier-ref:v1:")
    assert body["proof"]["proof_type"] == "world_id_proof_of_human"
    assert body["verification"]["nullifier"] == "[redacted]"
    assert raw_nullifier not in rendered

    second_wallet = client.post("/wallets", json={"owner_did": "did:key:other-owner"}).json()
    replay_response = client.post(
        f"/wallets/{second_wallet['wallet_id']}/world-id/verifications",
        json={
            "actor_did": "did:key:other-owner",
            "idkit_payload": sample_v4_idkit_payload(raw_nullifier),
        },
    )
    assert replay_response.status_code == 409, replay_response.text

    denied_revoke = client.post(
        f"/wallets/{wallet_id}/world-id/bindings/{binding_id}/revoke",
        json={"actor_did": ADVOCATE, "reason": "not allowed"},
    )
    revoke_response = client.post(
        f"/wallets/{wallet_id}/world-id/bindings/{binding_id}/revoke",
        json={"actor_did": OWNER, "reason": "user disconnected"},
    )
    final_status = client.get(f"/wallets/{wallet_id}/world-id/status", params={"actor_did": OWNER})
    snapshot_text = service.repository.wallet_path(wallet_id).read_text(encoding="utf-8")

    assert denied_revoke.status_code == 400
    assert revoke_response.status_code == 200, revoke_response.text
    assert revoke_response.json()["status"] == "revoked"
    assert final_status.json()["wallet"]["active_binding_count"] == 0
    assert raw_nullifier not in snapshot_text


def test_world_id_fastapi_provider_staff_signature_is_policy_gated() -> None:
    config = load_world_id_config(
        env=enabled_env(WORLD_ID_ALLOWED_ACTIONS=f"{DEFAULT_WORLD_ID_ACTION},{PROVIDER_STAFF_ACTION}")
    )
    service = WalletInterfaceService(world_id_config=config, services=[], auto_persist=False)
    client = TestClient(create_app(service=service))
    wallet = client.post("/wallets", json={"owner_did": OWNER}).json()
    wallet_id = wallet["wallet_id"]

    missing_policy = client.post(
        f"/wallets/{wallet_id}/world-id/provider-staff/rp-signature",
        json={"actor_did": OWNER, "provider_id": "", "provider_staff_id": "staff-demo-rose"},
    )
    staff_signature = client.post(
        f"/wallets/{wallet_id}/world-id/provider-staff/rp-signature",
        json={
            "actor_did": OWNER,
            "provider_id": "Rose City Shelter",
            "provider_staff_id": "staff-demo-rose",
        },
    )
    client_signature = client.post(
        f"/wallets/{wallet_id}/world-id/rp-signature",
        json={"actor_did": OWNER, "action": DEFAULT_WORLD_ID_ACTION},
    )

    assert missing_policy.status_code == 400
    assert "provider organization policy" in missing_policy.text
    assert staff_signature.status_code == 200, staff_signature.text
    assert staff_signature.json()["action"] == PROVIDER_STAFF_ACTION
    assert staff_signature.json()["signal_context"] == "provider_staff_verification"
    assert client_signature.status_code == 200, client_signature.text
    assert client_signature.json()["action"] == DEFAULT_WORLD_ID_ACTION
