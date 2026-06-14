from __future__ import annotations

import json

import pytest

from wallet_interface.world_id import (
    DEFAULT_WORLD_ID_ACTION,
    DEFAULT_WORLD_ID_VERIFY_BASE_URL,
    WorldIdSignatureError,
    WorldIdConfigError,
    WorldIdPayloadError,
    WorldIdVerificationError,
    compute_rp_signature_message,
    hash_to_field,
    hash_to_field_hex,
    load_world_id_config,
    normalize_idkit_response,
    normalize_world_id_idkit_response,
    normalize_world_id_verification_response,
    redact_world_id_payload,
    sign_world_id_request,
    sign_world_id_request_from_config,
    verify_world_id_proof,
    verify_world_id_proof_from_config,
)


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


def test_world_id_config_defaults_to_disabled_without_secret_requirements() -> None:
    config = load_world_id_config(env={})

    assert config.enabled is False
    assert config.environment == "staging"
    assert config.default_action == DEFAULT_WORLD_ID_ACTION
    assert config.allowed_actions == (DEFAULT_WORLD_ID_ACTION,)
    assert config.verify_base_url == DEFAULT_WORLD_ID_VERIFY_BASE_URL
    assert config.rp_signature_ttl_seconds == 300
    assert config.http_timeout_seconds == 15.0
    assert config.rp_signing_key.configured is False
    assert config.nullifier_hmac_key.configured is False


def test_world_id_config_loads_enabled_backend_settings() -> None:
    config = load_world_id_config(
        env=enabled_env(
            WORLD_ID_ENVIRONMENT="production",
            WORLD_ID_ALLOWED_ACTIONS="wallet-attach-world-id-v1, provider-staff-world-id-v1",
            WORLD_ID_DEFAULT_ACTION="provider-staff-world-id-v1",
            WORLD_ID_CREDENTIAL_POLICY="proof_of_human",
            WORLD_ID_ALLOW_LEGACY_PROOFS="false",
            WORLD_ID_REQUIRE_USER_PRESENCE="true",
            WORLD_ID_RP_SIGNATURE_TTL_SECONDS="120",
            WORLD_ID_VERIFY_BASE_URL="https://developer.world.org/",
            WORLD_ID_HTTP_TIMEOUT_SECONDS="9.5",
        )
    )

    assert config.enabled is True
    assert config.environment == "production"
    assert config.app_id == "app_test_123"
    assert config.rp_id == "rp_test_123"
    assert config.allowed_actions == ("wallet-attach-world-id-v1", "provider-staff-world-id-v1")
    assert config.default_action == "provider-staff-world-id-v1"
    assert config.allow_legacy_proofs is False
    assert config.require_user_presence is True
    assert config.rp_signature_ttl_seconds == 120
    assert config.verify_base_url == "https://developer.world.org"
    assert config.http_timeout_seconds == 9.5
    assert config.rp_signing_key.configured is True
    assert config.nullifier_hmac_key.configured is True


def test_world_id_config_accepts_secret_manager_references_without_secret_values() -> None:
    config = load_world_id_config(
        env=enabled_env(
            WORLD_ID_RP_SIGNING_KEY="",
            WORLD_ID_NULLIFIER_HMAC_KEY="",
            WORLD_ID_RP_SIGNING_KEY_SECRET_REF="secret://wallet/world-id/rp-signing-key",
            WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF="secret://wallet/world-id/nullifier-hmac-key",
        )
    )

    assert config.rp_signing_key.value == ""
    assert config.rp_signing_key.secret_ref == "secret://wallet/world-id/rp-signing-key"
    assert config.nullifier_hmac_key.value == ""
    assert config.nullifier_hmac_key.secret_ref == "secret://wallet/world-id/nullifier-hmac-key"
    assert config.rp_signing_key.public_dict() == {"configured": True, "source": "secret_ref"}


def test_world_id_public_config_does_not_expose_secret_values_or_refs() -> None:
    config = load_world_id_config(
        env=enabled_env(
            WORLD_ID_RP_SIGNING_KEY="super-secret-signing-key",
            WORLD_ID_NULLIFIER_HMAC_KEY="super-secret-nullifier-key",
            WORLD_ID_RP_SIGNING_KEY_SECRET_REF="secret://wallet/world-id/rp-signing-key",
            WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF="secret://wallet/world-id/nullifier-hmac-key",
        )
    )

    public_payload = json.dumps(config.public_dict(), sort_keys=True)

    assert "super-secret" not in public_payload
    assert "secret://wallet" not in public_payload
    assert "signing_key" not in public_payload.lower()
    assert "nullifier_hmac_key" not in public_payload.lower()
    assert "secret" not in repr(config)


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"WORLD_ID_APP_ID": ""}, "WORLD_ID_APP_ID"),
        ({"WORLD_ID_RP_ID": ""}, "WORLD_ID_RP_ID"),
        ({"WORLD_ID_RP_SIGNING_KEY": "", "WORLD_ID_RP_SIGNING_KEY_SECRET_REF": ""}, "WORLD_ID_RP_SIGNING_KEY"),
        (
            {"WORLD_ID_NULLIFIER_HMAC_KEY": "", "WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF": ""},
            "WORLD_ID_NULLIFIER_HMAC_KEY",
        ),
    ],
)
def test_world_id_enabled_config_requires_backend_fields(override: dict[str, str], message: str) -> None:
    with pytest.raises(WorldIdConfigError, match=message):
        load_world_id_config(env=enabled_env(**override))


def test_world_id_config_rejects_browser_exposed_secret_env_vars() -> None:
    with pytest.raises(WorldIdConfigError, match="browser-exposed"):
        load_world_id_config(env={**enabled_env(), "VITE_WORLD_ID_RP_SIGNING_KEY": "leaked"})

    with pytest.raises(WorldIdConfigError, match="browser-exposed"):
        load_world_id_config(env={**enabled_env(), "ABBY_RUNTIME_WORLD_ID_NULLIFIER_HMAC_KEY": "leaked"})


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"WORLD_ID_ENVIRONMENT": "dev"}, "WORLD_ID_ENVIRONMENT"),
        ({"WORLD_ID_ENABLED": "sometimes"}, "WORLD_ID_ENABLED"),
        ({"WORLD_ID_RP_SIGNATURE_TTL_SECONDS": "0"}, "WORLD_ID_RP_SIGNATURE_TTL_SECONDS"),
        ({"WORLD_ID_HTTP_TIMEOUT_SECONDS": "-1"}, "WORLD_ID_HTTP_TIMEOUT_SECONDS"),
        ({"WORLD_ID_VERIFY_BASE_URL": "developer.world.org"}, "WORLD_ID_VERIFY_BASE_URL"),
        ({"WORLD_ID_ALLOWED_ACTIONS": "bad action"}, "actions"),
        (
            {"WORLD_ID_ALLOWED_ACTIONS": DEFAULT_WORLD_ID_ACTION, "WORLD_ID_DEFAULT_ACTION": "other-action"},
            "WORLD_ID_DEFAULT_ACTION",
        ),
        ({"WORLD_ID_APP_ID": "not-app"}, "WORLD_ID_APP_ID"),
        ({"WORLD_ID_RP_ID": "not-rp"}, "WORLD_ID_RP_ID"),
    ],
)
def test_world_id_config_rejects_invalid_values(override: dict[str, str], message: str) -> None:
    with pytest.raises(WorldIdConfigError, match=message):
        load_world_id_config(env=enabled_env(**override))


def test_world_id_hash_to_field_matches_official_empty_string_vector() -> None:
    assert (
        hash_to_field_hex(b"")
        == "0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4"
    )
    assert hash_to_field(b"")[0] == 0


def test_world_id_compute_rp_signature_message_matches_official_vector() -> None:
    message = compute_rp_signature_message(
        "0x008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd",
        1_700_000_000,
        1_700_000_300,
    )

    assert len(message) == 49
    assert (
        message.hex()
        == "01008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd"
        "000000006553f100000000006553f22c"
    )


def test_world_id_compute_rp_signature_message_with_action_is_81_bytes() -> None:
    nonce = bytes.fromhex("008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd")

    message = compute_rp_signature_message(nonce, 1_700_000_000, 1_700_000_300, "test-action")

    assert len(message) == 81
    assert message[:49] == compute_rp_signature_message(nonce, 1_700_000_000, 1_700_000_300)
    assert message[49:] == hash_to_field("test-action")


def test_world_id_sign_request_matches_official_without_action_vector() -> None:
    signature = sign_world_id_request(
        "0x" + "ab" * 32,
        ttl_seconds=300,
        random_bytes=bytes(range(32)),
        created_at=1_700_000_000,
    )

    assert signature.nonce == "0x008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd"
    assert signature.created_at == 1_700_000_000
    assert signature.expires_at == 1_700_000_300
    assert (
        signature.signature
        == "0x14f693175773aed912852a601e9c0fd30f2afe2738d31388316232ce6f64ae9e"
        "4edbfb19d81c4229ba9c9fca78ede4b28956b7ba4415f08d957cbc1b3bdaa4021b"
    )
    assert signature.to_protocol_dict()["sig"] == signature.signature


def test_world_id_sign_request_from_config_uses_allowed_action_and_rp_context() -> None:
    config = load_world_id_config(env=enabled_env(WORLD_ID_RP_SIGNATURE_TTL_SECONDS="300"))

    signature = sign_world_id_request_from_config(
        config,
        action=DEFAULT_WORLD_ID_ACTION,
        random_bytes=bytes(range(32)),
        created_at=1_700_000_000,
    )

    context = signature.to_rp_context(config.rp_id)
    assert context["rp_id"] == "rp_test_123"
    assert context["nonce"] == signature.nonce
    assert context["sig"] == signature.signature
    assert signature.action == DEFAULT_WORLD_ID_ACTION


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"signing_key_hex": "0x1234"}, "signing key"),
        ({"random_bytes": b"short"}, "random_bytes"),
        ({"ttl_seconds": 0}, "ttl_seconds"),
        ({"created_at": -1}, "created_at"),
    ],
)
def test_world_id_sign_request_rejects_invalid_inputs(kwargs: dict[str, object], message: str) -> None:
    params = {
        "signing_key_hex": "0x" + "ab" * 32,
        "random_bytes": bytes(range(32)),
        "created_at": 1_700_000_000,
        "ttl_seconds": 300,
    }
    params.update(kwargs)
    signing_key = str(params.pop("signing_key_hex"))

    with pytest.raises(WorldIdSignatureError, match=message):
        sign_world_id_request(signing_key, **params)  # type: ignore[arg-type]


def test_world_id_sign_from_config_rejects_disabled_unallowed_and_secret_ref_only() -> None:
    disabled = load_world_id_config(env={})
    with pytest.raises(WorldIdSignatureError, match="disabled"):
        sign_world_id_request_from_config(disabled)

    config = load_world_id_config(env=enabled_env())
    with pytest.raises(WorldIdSignatureError, match="not allowed"):
        sign_world_id_request_from_config(config, action="other-action")

    secret_ref_only = load_world_id_config(
        env=enabled_env(
            WORLD_ID_RP_SIGNING_KEY="",
            WORLD_ID_RP_SIGNING_KEY_SECRET_REF="secret://wallet/world-id/rp-signing-key",
            WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF="secret://wallet/world-id/nullifier-hmac-key",
        )
    )
    with pytest.raises(WorldIdSignatureError, match="WORLD_ID_RP_SIGNING_KEY"):
        sign_world_id_request_from_config(secret_ref_only)


def sample_idkit_payload() -> dict[str, object]:
    return {
        "protocol_version": "3.0",
        "nonce": "0xabc123",
        "action": DEFAULT_WORLD_ID_ACTION,
        "environment": "staging",
        "responses": [
            {
                "identifier": "orb",
                "merkle_root": "0xroot",
                "nullifier": "0xnullifier",
                "proof": "0xproof",
                "signal_hash": "0xsignal",
            }
        ],
    }


def sample_idkit_v4_uniqueness_payload() -> dict[str, object]:
    return {
        "protocol_version": "4.0",
        "nonce": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "action": DEFAULT_WORLD_ID_ACTION,
        "action_description": "Attach wallet",
        "environment": "production",
        "user_presence_completed": True,
        "identity_attested": False,
        "integrity_bundle": {
            "version": 1,
            "signature_format": "apple_app_attest",
            "signature": "0xsignature",
            "jwt": "private.jwt.value",
        },
        "responses": [
            {
                "identifier": "proof_of_human",
                "signal_hash": "0x0",
                "proof": ["0x1a", "0x2b", "0x3c", "0x4d", "0x5e"],
                "nullifier": "0xrp-scoped-nullifier",
                "issuer_schema_id": 1,
                "expires_at_min": 1_756_166_400,
            }
        ],
    }


def sample_idkit_v4_session_payload() -> dict[str, object]:
    return {
        "protocol_version": "4.0",
        "nonce": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "session_id": "ses_abc123",
        "environment": "production",
        "user_presence_completed": True,
        "responses": [
            {
                "identifier": "proof_of_human",
                "signal_hash": "0x0",
                "proof": ["0x1a", "0x2b", "0x3c", "0x4d", "0x5e"],
                "session_nullifier": ["0xsession-nullifier", "0xgenerated-action"],
                "issuer_schema_id": 1,
                "expires_at_min": 1_756_166_400,
            }
        ],
    }


def test_world_id_normalizes_v3_legacy_idkit_response() -> None:
    normalized = normalize_idkit_response(sample_idkit_payload())

    assert normalized.protocol_version == "3.0"
    assert normalized.proof_type == "legacy"
    assert normalized.action == DEFAULT_WORLD_ID_ACTION
    assert normalized.environment == "staging"
    assert normalized.credential_identifiers == ("orb",)
    assert normalized.signal_hashes == ("0xsignal",)
    assert normalized.nullifiers == ("0xnullifier",)
    assert normalized.verification_timestamps == ()
    assert normalized.responses[0].credential_identifier == "orb"
    assert normalized.responses[0].issuer_schema_id is None
    assert "0xnullifier" not in repr(normalized)


def test_world_id_normalizes_v4_uniqueness_idkit_response() -> None:
    normalized = normalize_world_id_idkit_response(sample_idkit_v4_uniqueness_payload())

    assert normalized.protocol_version == "4.0"
    assert normalized.proof_type == "uniqueness"
    assert normalized.action == DEFAULT_WORLD_ID_ACTION
    assert normalized.action_description == "Attach wallet"
    assert normalized.user_presence_completed is True
    assert normalized.identity_attested is False
    assert normalized.integrity_bundle_present is True
    assert normalized.credential_identifiers == ("proof_of_human",)
    assert normalized.nullifiers == ("0xrp-scoped-nullifier",)
    assert normalized.signal_hashes == ("0x0",)
    assert normalized.verification_timestamps == (1_756_166_400,)
    assert normalized.responses[0].issuer_schema_id == 1


def test_world_id_normalizes_v4_session_idkit_response() -> None:
    normalized = normalize_idkit_response(sample_idkit_v4_session_payload())

    assert normalized.protocol_version == "4.0"
    assert normalized.proof_type == "session"
    assert normalized.action == ""
    assert normalized.session_id == "ses_abc123"
    assert normalized.credential_identifiers == ("proof_of_human",)
    assert normalized.nullifiers == ("0xsession-nullifier",)
    assert normalized.session_actions == ("0xgenerated-action",)
    assert normalized.verification_timestamps == (1_756_166_400,)


def test_world_id_normalized_public_dict_omits_sensitive_payload_material() -> None:
    normalized = normalize_idkit_response(sample_idkit_v4_uniqueness_payload())

    rendered = json.dumps(normalized.public_dict(), sort_keys=True)

    assert "0xrp-scoped-nullifier" not in rendered
    assert "0x0" not in rendered
    assert "0xsignature" not in rendered
    assert "private.jwt.value" not in rendered
    assert '"nullifier_count": 1' in rendered
    assert '"signal_hash_count": 1' in rendered


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ([], "JSON object"),
        ({"protocol_version": "2.0", "nonce": "n", "environment": "staging", "responses": [{}]}, "protocol_version"),
        ({"protocol_version": "4.0", "nonce": "n", "environment": "dev", "responses": [{}]}, "environment"),
        ({"protocol_version": "4.0", "nonce": "n", "environment": "staging", "responses": []}, "responses"),
        (
            {
                "protocol_version": "4.0",
                "nonce": "n",
                "environment": "staging",
                "responses": [{"session_nullifier": ["0xsession", "0xaction"]}],
            },
            "session_id",
        ),
        (
            {
                "protocol_version": "4.0",
                "nonce": "n",
                "action": DEFAULT_WORLD_ID_ACTION,
                "environment": "staging",
                "responses": [
                    {
                        "identifier": "proof_of_human",
                        "proof": "0xproof",
                        "nullifier": "0xnullifier",
                        "issuer_schema_id": 1,
                        "expires_at_min": 1_756_166_400,
                    }
                ],
            },
            "proof",
        ),
        (
            {
                "protocol_version": "4.0",
                "nonce": "n",
                "action": DEFAULT_WORLD_ID_ACTION,
                "environment": "staging",
                "responses": [
                    {
                        "identifier": "proof_of_human",
                        "proof": ["0x1", "0x2", "0x3", "0x4", "0x5"],
                        "nullifier": "0xnullifier",
                        "issuer_schema_id": True,
                        "expires_at_min": 1_756_166_400,
                    }
                ],
            },
            "issuer_schema_id",
        ),
        (
            {
                "protocol_version": "3.0",
                "nonce": "n",
                "action": DEFAULT_WORLD_ID_ACTION,
                "environment": "staging",
                "responses": [
                    {"identifier": "orb", "signal_hash": "0xsignal", "proof": "0xproof", "merkle_root": "0xroot"}
                ],
            },
            "nullifier",
        ),
    ],
)
def test_world_id_normalizer_rejects_malformed_or_unsupported_responses(
    payload: object,
    message: str,
) -> None:
    with pytest.raises(WorldIdPayloadError, match=message):
        normalize_idkit_response(payload)  # type: ignore[arg-type]


def test_world_id_verify_client_posts_payload_as_is_and_normalizes_response() -> None:
    payload = sample_idkit_payload()
    calls: list[tuple[str, str, object, dict[str, str], float]] = []

    def fake_request_json(method, url, request_payload, headers, timeout_seconds):
        calls.append((method, url, request_payload, dict(headers), timeout_seconds))
        assert request_payload is payload
        return {
            "success": True,
            "results": [
                {
                    "identifier": "orb",
                    "success": True,
                    "nullifier": "0xverified-nullifier",
                    "code": "ok",
                    "detail": "verified",
                }
            ],
            "action": DEFAULT_WORLD_ID_ACTION,
            "created_at": "2026-06-13T00:00:00Z",
            "environment": "staging",
            "session_id": "session-123",
            "message": "verified",
        }

    result = verify_world_id_proof(
        "rp_test_123",
        payload,
        verify_base_url="https://developer.world.org/",
        timeout_seconds=9.5,
        request_json=fake_request_json,
    )

    assert calls == [
        (
            "POST",
            "https://developer.world.org/api/v4/verify/rp_test_123",
            payload,
            {"content-type": "application/json"},
            9.5,
        )
    ]
    assert result.success is True
    assert result.action == DEFAULT_WORLD_ID_ACTION
    assert result.nullifier == "0xverified-nullifier"
    assert result.created_at == "2026-06-13T00:00:00Z"
    assert result.environment == "staging"
    assert result.session_id == "session-123"
    assert len(result.successful_results) == 1


def test_world_id_verify_from_config_uses_rp_and_timeout() -> None:
    config = load_world_id_config(env=enabled_env(WORLD_ID_HTTP_TIMEOUT_SECONDS="4.25"))
    seen: dict[str, object] = {}

    def fake_request_json(method, url, request_payload, headers, timeout_seconds):
        seen.update(url=url, timeout=timeout_seconds)
        return {"success": True, "results": [], "action": DEFAULT_WORLD_ID_ACTION, "nullifier": "0xabc"}

    result = verify_world_id_proof_from_config(config, sample_idkit_payload(), request_json=fake_request_json)

    assert result.success is True
    assert seen == {"url": "https://developer.world.org/api/v4/verify/rp_test_123", "timeout": 4.25}


def test_world_id_verify_rejects_disabled_config_and_bad_inputs() -> None:
    with pytest.raises(WorldIdVerificationError, match="disabled"):
        verify_world_id_proof_from_config(load_world_id_config(env={}), sample_idkit_payload())

    with pytest.raises(WorldIdVerificationError, match="rp_id"):
        verify_world_id_proof("", sample_idkit_payload(), request_json=lambda *_: {})

    with pytest.raises(WorldIdVerificationError, match="base URL"):
        verify_world_id_proof("rp_test_123", sample_idkit_payload(), verify_base_url="developer.world.org")

    with pytest.raises(WorldIdVerificationError, match="timeout_seconds"):
        verify_world_id_proof("rp_test_123", sample_idkit_payload(), timeout_seconds=0)


def test_world_id_verify_rejects_malformed_response() -> None:
    with pytest.raises(WorldIdVerificationError, match="JSON object"):
        normalize_world_id_verification_response([])  # type: ignore[arg-type]

    with pytest.raises(WorldIdVerificationError, match="results"):
        normalize_world_id_verification_response({"success": True, "results": {"bad": "shape"}})


def test_world_id_verify_errors_redact_proof_payload_material() -> None:
    def fake_request_json(*_):
        raise RuntimeError("upstream failed proof=0xproof nullifier=0xnullifier")

    with pytest.raises(WorldIdVerificationError) as exc_info:
        verify_world_id_proof("rp_test_123", sample_idkit_payload(), request_json=fake_request_json)

    message = str(exc_info.value)
    assert "[redacted World ID verification error]" in message
    assert "0xproof" not in message
    assert "0xnullifier" not in message


def test_world_id_payload_redaction_removes_sensitive_proof_values() -> None:
    redacted = redact_world_id_payload(sample_idkit_payload())
    rendered = json.dumps(redacted, sort_keys=True)

    assert "0xproof" not in rendered
    assert "0xnullifier" not in rendered
    assert "0xroot" not in rendered
    assert "0xsignal" not in rendered
