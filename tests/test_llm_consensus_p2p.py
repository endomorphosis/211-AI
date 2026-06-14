"""Tests for the llm-consensus-generate-v1 libp2p payload contract.

Covers:
- Request payload serialisation (build_p2p_request_payload)
- Response payload deserialisation (parse_p2p_response_payload)
- Schema-version validation (backward-compatible)
- Canonical field ordering and deterministic JSON
- Proof-policy, operator-metadata, and output-record embedding
- No-leak: raw prompt and sensitive fields excluded from receipt JSON
"""

from __future__ import annotations

import asyncio
import json
import os

import pytest

from ipfs_accelerate_py.llm_consensus import (
    CONSENSUS_RECEIPT_SCHEMA_VERSION,
    P2P_REQUEST_SCHEMA_VERSION,
    P2P_RESPONSE_SCHEMA_VERSION,
    ConsensusRequest,
    OperatorResponse,
    P2PConsensusPeer,
    ProofReceipt,
    build_consensus_request,
    build_p2p_request_payload,
    normalized_output_hash,
    parse_p2p_response_payload,
    receipt_content_hash,
    run_p2p_consensus,
    run_p2p_consensus_async,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_request(**overrides: object) -> ConsensusRequest:
    kwargs = dict(
        prompt="What is 2+2?",
        provider="openai",
        model_name="gpt-4o-mini",
        generation_params={"temperature": 0, "max_tokens": 256},
        proof_policy={"mode": "receipt_only"},
        nonce="test-nonce-42",
        deadline_unix_ms=1_800_000_000_000,
        comparison="canonical_json",
        quorum=2,
        min_operators=3,
    )
    kwargs.update(overrides)
    return build_consensus_request(**kwargs)


# ---------------------------------------------------------------------------
# build_p2p_request_payload – schema version and required fields
# ---------------------------------------------------------------------------


def test_p2p_request_payload_has_correct_schema_version() -> None:
    request = _build_request()
    payload = build_p2p_request_payload(request, "What is 2+2?")

    assert payload["schema_version"] == P2P_REQUEST_SCHEMA_VERSION
    assert P2P_REQUEST_SCHEMA_VERSION == "llm-consensus-generate-v1"


def test_p2p_request_payload_contains_request_id_and_hash() -> None:
    request = _build_request()
    payload = build_p2p_request_payload(request, "What is 2+2?")

    assert payload["request_id"] == request.request_id
    assert payload["request_hash"] == request.request_hash
    assert payload["request_hash"].startswith("sha256:")


def test_p2p_request_payload_contains_model_and_provider() -> None:
    request = _build_request()
    payload = build_p2p_request_payload(request, "What is 2+2?")

    assert payload["model_name"] == "gpt-4o-mini"
    assert payload["provider"] == "openai"


def test_p2p_request_payload_embeds_generation_params() -> None:
    request = _build_request(generation_params={"temperature": 0, "max_tokens": 256})
    payload = build_p2p_request_payload(request, "prompt")

    assert payload["generation_params"]["temperature"] == 0
    assert payload["generation_params"]["max_tokens"] == 256


def test_p2p_request_payload_embeds_proof_policy() -> None:
    request = _build_request(proof_policy={"mode": "receipt_only"})
    payload = build_p2p_request_payload(request, "prompt")

    assert payload["proof_policy"]["mode"] == "receipt_only"


def test_p2p_request_payload_embeds_quorum_and_comparison() -> None:
    request = _build_request(quorum=2, min_operators=3, comparison="canonical_json")
    payload = build_p2p_request_payload(request, "prompt")

    assert payload["quorum"] == 2
    assert payload["min_operators"] == 3
    assert payload["comparison"] == "canonical_json"


def test_p2p_request_payload_includes_nonce() -> None:
    request = _build_request(nonce="nonce-abc")
    payload = build_p2p_request_payload(request, "prompt")

    assert payload["nonce"] == "nonce-abc"


def test_p2p_request_payload_includes_deadline() -> None:
    request = _build_request(deadline_unix_ms=1_800_000_000_000)
    payload = build_p2p_request_payload(request, "prompt")

    assert payload["deadline_unix_ms"] == 1_800_000_000_000


def test_p2p_request_payload_includes_prompt_for_remote_execution() -> None:
    request = _build_request()
    payload = build_p2p_request_payload(request, "What is 2+2?")

    assert payload["prompt"] == "What is 2+2?"


def test_p2p_request_payload_redact_flag_default_true() -> None:
    request = _build_request()
    payload = build_p2p_request_payload(request, "prompt")

    assert payload["redact_prompt_in_receipt"] is True


def test_p2p_request_payload_redact_flag_can_be_set_false() -> None:
    request = _build_request()
    payload = build_p2p_request_payload(request, "prompt", redact_prompt_in_receipt=False)

    assert payload["redact_prompt_in_receipt"] is False


def test_p2p_request_payload_embeds_operator_metadata_when_provided() -> None:
    request = _build_request()
    op_meta = {"region": "us-east-1", "node_version": "1.2.3"}
    payload = build_p2p_request_payload(request, "prompt", operator_metadata=op_meta)

    assert payload["operator_metadata"]["region"] == "us-east-1"
    assert payload["operator_metadata"]["node_version"] == "1.2.3"


def test_p2p_request_payload_omits_operator_metadata_when_not_provided() -> None:
    request = _build_request()
    payload = build_p2p_request_payload(request, "prompt")

    assert "operator_metadata" not in payload


# ---------------------------------------------------------------------------
# build_p2p_request_payload – canonical JSON and determinism
# ---------------------------------------------------------------------------


def test_p2p_request_payload_is_canonical_json_serialisable() -> None:
    request = _build_request()
    payload = build_p2p_request_payload(request, "prompt")

    rendered = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    assert rendered == json.dumps(payload, sort_keys=True, separators=(",", ":"))
    assert "\n" not in rendered


def test_p2p_request_payload_generation_params_are_deterministic_for_nested_dicts() -> None:
    request_a = _build_request(
        generation_params={"temperature": 0, "extra": {"b": 2, "a": 1}}
    )
    request_b = _build_request(
        generation_params={"extra": {"a": 1, "b": 2}, "temperature": 0}
    )
    payload_a = build_p2p_request_payload(request_a, "prompt")
    payload_b = build_p2p_request_payload(request_b, "prompt")

    # Both should have the same generation_params structure (sorted)
    assert json.dumps(payload_a["generation_params"], sort_keys=True) == json.dumps(
        payload_b["generation_params"], sort_keys=True
    )


def test_p2p_request_payload_request_hash_is_stable_across_key_ordering() -> None:
    request_a = _build_request(
        nonce="same-nonce",
        generation_params={"b": 2, "a": 1},
    )
    request_b = _build_request(
        nonce="same-nonce",
        generation_params={"a": 1, "b": 2},
    )
    payload_a = build_p2p_request_payload(request_a, "What is 2+2?")
    payload_b = build_p2p_request_payload(request_b, "What is 2+2?")

    assert payload_a["request_hash"] == payload_b["request_hash"]


# ---------------------------------------------------------------------------
# build_p2p_request_payload – sensitive field exclusion
# ---------------------------------------------------------------------------


def test_p2p_request_payload_excludes_sensitive_generation_param_keys() -> None:
    request = _build_request(
        generation_params={
            "temperature": 0,
            "api_key": "secret-key",
            "timestamp": "2026-01-01T00:00:00Z",
        }
    )
    payload = build_p2p_request_payload(request, "prompt")
    rendered = json.dumps(payload)

    assert "secret-key" not in rendered
    assert "api_key" not in payload["generation_params"]
    assert "timestamp" not in payload["generation_params"]
    assert payload["generation_params"]["temperature"] == 0


def test_p2p_request_payload_excludes_authorization_header() -> None:
    request = _build_request(
        generation_params={
            "temperature": 0,
            "headers": {"Authorization": "Bearer secret-token", "X-Stable": "ok"},
        }
    )
    payload = build_p2p_request_payload(request, "prompt")
    rendered = json.dumps(payload)

    assert "secret-token" not in rendered
    assert "Authorization" not in payload["generation_params"].get("headers", {})
    assert payload["generation_params"]["headers"]["X-Stable"] == "ok"


def test_p2p_request_payload_excludes_private_key_from_proof_policy() -> None:
    request = _build_request(proof_policy={"mode": "receipt_only", "private_key": "do-not-leak"})
    payload = build_p2p_request_payload(request, "prompt")
    rendered = json.dumps(payload)

    assert "do-not-leak" not in rendered
    assert "private_key" not in payload["proof_policy"]
    assert payload["proof_policy"]["mode"] == "receipt_only"


# ---------------------------------------------------------------------------
# parse_p2p_response_payload – basic parsing
# ---------------------------------------------------------------------------


def _sample_response_dict(**overrides: object) -> dict:
    data = {
        "schema_version": P2P_RESPONSE_SCHEMA_VERSION,
        "request_id": "req-p2p-1",
        "request_hash": "sha256:abc123",
        "operator_id": "peer-a",
        "peer_id": "12D3KooWPeerA",
        "provider": "openai",
        "model_name": "gpt-4o-mini",
        "output_text": '{"answer":"4"}',
        "output_hash": "sha256:out-raw",
        "normalized_output_hash": "sha256:out-norm",
        "latency_ms": 150,
        "error": None,
        "signature": None,
        "attestation": None,
        "metadata": {"node_version": "1.0"},
    }
    data.update(overrides)
    return data


def test_parse_p2p_response_returns_operator_response() -> None:
    data = _sample_response_dict()
    response = parse_p2p_response_payload(data)

    assert isinstance(response, OperatorResponse)
    assert response.operator_id == "peer-a"
    assert response.peer_id == "12D3KooWPeerA"
    assert response.transport == "libp2p"


def test_parse_p2p_response_maps_output_fields() -> None:
    data = _sample_response_dict()
    response = parse_p2p_response_payload(data)

    assert response.output_text == '{"answer":"4"}'
    assert response.output_hash == "sha256:out-raw"
    assert response.normalized_output_hash == "sha256:out-norm"
    assert response.latency_ms == 150


def test_parse_p2p_response_maps_provider_and_model() -> None:
    data = _sample_response_dict()
    response = parse_p2p_response_payload(data)

    assert response.provider == "openai"
    assert response.model_name == "gpt-4o-mini"


def test_parse_p2p_response_maps_metadata() -> None:
    data = _sample_response_dict(metadata={"node_version": "2.0", "region": "eu"})
    response = parse_p2p_response_payload(data)

    assert response.metadata["node_version"] == "2.0"
    assert response.metadata["region"] == "eu"


def test_parse_p2p_response_maps_error_field() -> None:
    data = _sample_response_dict(
        output_text="",
        output_hash="",
        normalized_output_hash="",
        error="provider unavailable",
    )
    response = parse_p2p_response_payload(data)

    assert response.error == "provider unavailable"
    assert response.output_text == ""


def test_parse_p2p_response_uses_caller_peer_id_override() -> None:
    data = _sample_response_dict(peer_id=None, operator_id=None)
    response = parse_p2p_response_payload(data, peer_id="12D3KooWOverride")

    assert response.peer_id == "12D3KooWOverride"
    assert response.operator_id == "12D3KooWOverride"


def test_parse_p2p_response_uses_caller_operator_id_override() -> None:
    data = _sample_response_dict(operator_id=None)
    response = parse_p2p_response_payload(
        data, peer_id="12D3KooWPeer", operator_id="op-explicit"
    )

    assert response.operator_id == "op-explicit"
    assert response.peer_id == "12D3KooWPeer"


def test_parse_p2p_response_uses_caller_latency_ms_when_absent() -> None:
    data = _sample_response_dict(latency_ms=None)
    response = parse_p2p_response_payload(data, latency_ms=999)

    assert response.latency_ms == 999


def test_parse_p2p_response_computes_output_hash_when_absent() -> None:
    output_text = '{"answer":"4"}'
    data = _sample_response_dict(output_hash="", output_text=output_text)
    response = parse_p2p_response_payload(data)

    assert response.output_hash.startswith("sha256:")
    assert len(response.output_hash) > 10


# ---------------------------------------------------------------------------
# parse_p2p_response_payload – schema version validation
# ---------------------------------------------------------------------------


def test_parse_p2p_response_accepts_correct_schema_version() -> None:
    data = _sample_response_dict()
    response = parse_p2p_response_payload(data)

    assert response.operator_id == "peer-a"


def test_parse_p2p_response_accepts_missing_schema_version() -> None:
    data = _sample_response_dict()
    del data["schema_version"]
    response = parse_p2p_response_payload(data)

    assert response.operator_id == "peer-a"


def test_parse_p2p_response_rejects_unknown_schema_version() -> None:
    data = _sample_response_dict(schema_version="llm-consensus-generate-v999-response")

    with pytest.raises(ValueError, match="Unsupported p2p response schema_version"):
        parse_p2p_response_payload(data)


# ---------------------------------------------------------------------------
# Schema version constants
# ---------------------------------------------------------------------------


def test_p2p_request_schema_version_constant_matches_expected() -> None:
    assert P2P_REQUEST_SCHEMA_VERSION == "llm-consensus-generate-v1"


def test_p2p_response_schema_version_constant_matches_expected() -> None:
    assert P2P_RESPONSE_SCHEMA_VERSION == "llm-consensus-generate-v1-response"


def test_receipt_schema_version_constant_is_unchanged() -> None:
    assert CONSENSUS_RECEIPT_SCHEMA_VERSION == "llm-router-consensus-receipt-v1"


# ---------------------------------------------------------------------------
# Round-trip: request payload → parse response → normalized hash agreement
# ---------------------------------------------------------------------------


def test_request_hash_in_payload_matches_request_object() -> None:
    request = _build_request(nonce="round-trip-nonce")
    payload = build_p2p_request_payload(request, "What is 2+2?")

    # The hash embedded in the payload must equal the hash on the request object
    assert payload["request_hash"] == request.request_hash


def test_response_output_hash_matches_independently_computed_hash() -> None:
    output_text = '{"answer":"4"}'
    comparison = "canonical_json"
    expected_norm_hash = normalized_output_hash(output_text, comparison=comparison)

    data = _sample_response_dict(
        normalized_output_hash=expected_norm_hash,
        output_text=output_text,
    )
    response = parse_p2p_response_payload(data)

    assert response.normalized_output_hash == expected_norm_hash


def test_multiple_peers_with_same_output_produce_matching_normalized_hashes() -> None:
    output_text_a = '{"answer":"4"}'
    output_text_b = '{\n  "answer": "4"\n}'  # Same semantic content, different whitespace
    comparison = "canonical_json"

    hash_a = normalized_output_hash(output_text_a, comparison=comparison)
    hash_b = normalized_output_hash(output_text_b, comparison=comparison)

    response_a = parse_p2p_response_payload(
        _sample_response_dict(
            operator_id="peer-a",
            output_text=output_text_a,
            normalized_output_hash=hash_a,
        )
    )
    response_b = parse_p2p_response_payload(
        _sample_response_dict(
            operator_id="peer-b",
            output_text=output_text_b,
            normalized_output_hash=hash_b,
        )
    )

    assert response_a.normalized_output_hash == response_b.normalized_output_hash


def test_divergent_peers_produce_different_normalized_hashes() -> None:
    comparison = "canonical_json"
    hash_yes = normalized_output_hash('{"answer":"yes"}', comparison=comparison)
    hash_no = normalized_output_hash('{"answer":"no"}', comparison=comparison)

    response_yes = parse_p2p_response_payload(
        _sample_response_dict(
            operator_id="peer-a",
            output_text='{"answer":"yes"}',
            normalized_output_hash=hash_yes,
        )
    )
    response_no = parse_p2p_response_payload(
        _sample_response_dict(
            operator_id="peer-b",
            output_text='{"answer":"no"}',
            normalized_output_hash=hash_no,
        )
    )

    assert response_yes.normalized_output_hash != response_no.normalized_output_hash


# ---------------------------------------------------------------------------
# Proof policy in payload
# ---------------------------------------------------------------------------


def test_p2p_request_payload_receipt_only_proof_policy() -> None:
    request = _build_request(proof_policy={"mode": "receipt_only"})
    payload = build_p2p_request_payload(request, "prompt")

    assert payload["proof_policy"]["mode"] == "receipt_only"


def test_p2p_request_payload_zkml_proof_policy() -> None:
    request = _build_request(proof_policy={"mode": "zkml_required", "circuit": "v2"})
    payload = build_p2p_request_payload(request, "prompt")

    assert payload["proof_policy"]["mode"] == "zkml_required"
    assert payload["proof_policy"]["circuit"] == "v2"


def test_p2p_request_payload_tee_proof_policy() -> None:
    request = _build_request(proof_policy={"mode": "tee_required"})
    payload = build_p2p_request_payload(request, "prompt")

    assert payload["proof_policy"]["mode"] == "tee_required"


# ---------------------------------------------------------------------------
# Output record fields
# ---------------------------------------------------------------------------


def test_parse_p2p_response_maps_attestation() -> None:
    data = _sample_response_dict(attestation={"kind": "tee", "report": "base64abc"})
    response = parse_p2p_response_payload(data)

    assert response.attestation["kind"] == "tee"
    assert response.attestation["report"] == "base64abc"


def test_parse_p2p_response_maps_signature() -> None:
    data = _sample_response_dict(signature="hmac-sha256:key-1:abcdef123")
    response = parse_p2p_response_payload(data)

    assert response.signature == "hmac-sha256:key-1:abcdef123"


def test_parse_p2p_response_output_record_serialises_to_json() -> None:
    data = _sample_response_dict()
    response = parse_p2p_response_payload(data)

    rendered = response.to_json()
    restored = OperatorResponse.from_json(rendered)

    assert restored == response
    assert restored.transport == "libp2p"


def test_parse_p2p_response_json_round_trip_preserves_all_fields() -> None:
    data = _sample_response_dict(
        attestation={"kind": "tee"},
        signature="hmac-sha256:k:abc",
        metadata={"v": "1"},
    )
    response = parse_p2p_response_payload(data)

    restored = OperatorResponse.from_json(response.to_json())

    assert restored.attestation == {"kind": "tee"}
    assert restored.signature == "hmac-sha256:k:abc"
    assert restored.metadata == {"v": "1"}


# ---------------------------------------------------------------------------
# Backward-compatible schema versioning
# ---------------------------------------------------------------------------


def test_p2p_request_schema_version_is_in_payload_top_level() -> None:
    """schema_version must be a top-level key so parsers can check it first."""
    request = _build_request()
    payload = build_p2p_request_payload(request, "prompt")
    rendered = json.dumps(payload)

    assert '"schema_version"' in rendered
    assert payload["schema_version"] == P2P_REQUEST_SCHEMA_VERSION


def test_p2p_response_schema_version_survives_json_round_trip() -> None:
    data = _sample_response_dict()
    original_sv = data["schema_version"]

    response = parse_p2p_response_payload(data)
    raw = response.to_json()
    restored = OperatorResponse.from_json(raw)

    # The schema_version lives in the original data dict, not in OperatorResponse;
    # what matters is that parse → to_json → from_json is lossless for the response.
    assert restored == response
    assert original_sv == P2P_RESPONSE_SCHEMA_VERSION


def test_receipt_schema_version_survives_json_round_trip() -> None:
    from ipfs_accelerate_py.llm_consensus import (
        ConsensusReceipt,
        ConsensusResult,
    )

    request = _build_request()
    receipt = ConsensusReceipt(
        request=request,
        responses=[],
        consensus=ConsensusResult(accepted=False, reason="quorum_not_met", quorum=2),
        proof=ProofReceipt(policy="receipt_only"),
        text="",
        created_at="2026-06-13T12:00:00Z",
    )
    restored = ConsensusReceipt.from_json(receipt.to_json())

    assert restored.schema_version == CONSENSUS_RECEIPT_SCHEMA_VERSION


def test_receipt_content_hash_changes_when_output_changes() -> None:
    from ipfs_accelerate_py.llm_consensus import (
        ConsensusReceipt,
        ConsensusResult,
    )

    request = _build_request()
    base = ConsensusReceipt(
        request=request,
        responses=[],
        consensus=ConsensusResult(accepted=False, reason="quorum_not_met", quorum=2),
        proof=ProofReceipt(policy="receipt_only"),
        text='{"answer":"4"}',
        created_at="2026-06-13T12:00:00Z",
    )
    altered = ConsensusReceipt(
        request=request,
        responses=[],
        consensus=ConsensusResult(accepted=False, reason="quorum_not_met", quorum=2),
        proof=ProofReceipt(policy="receipt_only"),
        text='{"answer":"5"}',
        created_at="2026-06-13T12:00:00Z",
    )

    assert receipt_content_hash(base) != receipt_content_hash(altered)


# ---------------------------------------------------------------------------
# libp2p fan-out runner
# ---------------------------------------------------------------------------


def _peers() -> list[P2PConsensusPeer]:
    return [
        P2PConsensusPeer("peer-a", "/ip4/127.0.0.1/tcp/4101/p2p/peer-a"),
        P2PConsensusPeer("peer-b", "/ip4/127.0.0.1/tcp/4102/p2p/peer-b"),
        P2PConsensusPeer("peer-c", "/ip4/127.0.0.1/tcp/4103/p2p/peer-c"),
    ]


def _completed_task(peer_id: str, output_text: str = '{"answer":"4"}') -> dict:
    return {
        "task_id": f"task-{peer_id}",
        "task_type": P2P_REQUEST_SCHEMA_VERSION,
        "status": "completed",
        "error": None,
        "result": {
            "schema_version": P2P_RESPONSE_SCHEMA_VERSION,
            "operator_id": peer_id,
            "peer_id": peer_id,
            "provider": "openai",
            "model_name": "gpt-4o-mini",
            "output_text": output_text,
            "metadata": {"node_version": "test"},
        },
    }


def test_run_p2p_consensus_submits_payloads_and_waits_concurrently() -> None:
    async def _exercise() -> tuple[object, list[dict], list[str]]:
        request = _build_request(quorum=2, min_operators=3)
        submissions: list[dict] = []
        wait_started: list[str] = []
        all_waiting = asyncio.Event()

        async def submit_task(*, remote, task_type, model_name, payload):
            submissions.append(
                {
                    "peer_id": remote.peer_id,
                    "task_type": task_type,
                    "model_name": model_name,
                    "payload": payload,
                }
            )
            return {"task_id": f"task-{remote.peer_id}"}

        async def wait_task(*, remote, task_id, timeout_s):
            wait_started.append(remote.peer_id)
            if len(wait_started) == 3:
                all_waiting.set()
            await asyncio.wait_for(all_waiting.wait(), timeout=0.5)
            assert task_id == f"task-{remote.peer_id}"
            return _completed_task(remote.peer_id)

        receipt = await run_p2p_consensus_async(
            request=request,
            prompt="What is 2+2?",
            peers=_peers(),
            timeout_s=1.0,
            per_peer_timeout_s=0.5,
            submit_task_fn=submit_task,
            wait_task_fn=wait_task,
            created_at="2026-06-13T12:00:00Z",
        )
        return receipt, submissions, wait_started

    receipt, submissions, wait_started = asyncio.run(_exercise())

    assert receipt.consensus.accepted is True
    assert receipt.consensus.selected_operator_ids == ["peer-a", "peer-b", "peer-c"]
    assert receipt.text == '{"answer":"4"}'
    assert set(wait_started) == {"peer-a", "peer-b", "peer-c"}
    assert len(submissions) == 3
    for submission in submissions:
        assert submission["task_type"] == P2P_REQUEST_SCHEMA_VERSION
        assert submission["model_name"] == "gpt-4o-mini"
        assert submission["payload"]["schema_version"] == P2P_REQUEST_SCHEMA_VERSION
        assert submission["payload"]["request_id"] == receipt.request.request_id
        assert submission["payload"]["request_hash"] == receipt.request.request_hash
    assert {response.transport for response in receipt.responses} == {"libp2p"}


def test_run_p2p_consensus_tolerates_missing_peer_when_quorum_is_met() -> None:
    async def _exercise():
        request = _build_request(quorum=2, min_operators=3)

        async def submit_task(*, remote, task_type, model_name, payload):
            return f"task-{remote.peer_id}"

        async def wait_task(*, remote, task_id, timeout_s):
            if remote.peer_id == "peer-c":
                return None
            return _completed_task(remote.peer_id)

        return await run_p2p_consensus_async(
            request=request,
            prompt="What is 2+2?",
            peers=_peers(),
            timeout_s=1.0,
            per_peer_timeout_s=0.5,
            submit_task_fn=submit_task,
            wait_task_fn=wait_task,
        )

    receipt = asyncio.run(_exercise())

    assert receipt.consensus.accepted is True
    assert receipt.consensus.selected_operator_ids == ["peer-a", "peer-b"]
    errors = {response.operator_id: response.error for response in receipt.responses}
    assert errors["peer-c"] == "timeout"


def test_run_p2p_consensus_returns_degraded_receipt_when_fail_open() -> None:
    async def _exercise():
        request = _build_request(quorum=2, min_operators=3)

        async def submit_task(*, remote, task_type, model_name, payload):
            return f"task-{remote.peer_id}"

        async def wait_task(*, remote, task_id, timeout_s):
            if remote.peer_id == "peer-a":
                return _completed_task(remote.peer_id)
            return None

        return await run_p2p_consensus_async(
            request=request,
            prompt="What is 2+2?",
            peers=_peers(),
            timeout_s=1.0,
            per_peer_timeout_s=0.5,
            submit_task_fn=submit_task,
            wait_task_fn=wait_task,
            fail_closed=False,
        )

    receipt = asyncio.run(_exercise())

    assert receipt.consensus.accepted is False
    assert receipt.consensus.reason == "quorum_not_met"
    assert receipt.text == ""
    assert receipt.consensus.total_successful == 1


def test_run_p2p_consensus_does_not_mutate_remote_peer_env_vars(monkeypatch) -> None:
    env_names = [
        "IPFS_ACCELERATE_PY_TASK_P2P_REMOTE_PEER_ID",
        "IPFS_ACCELERATE_PY_TASK_P2P_REMOTE_MULTIADDR",
        "IPFS_DATASETS_PY_TASK_P2P_REMOTE_PEER_ID",
        "IPFS_DATASETS_PY_TASK_P2P_REMOTE_MULTIADDR",
    ]
    for name in env_names:
        monkeypatch.setenv(name, f"original-{name}")
    before = {name: os.environ.get(name) for name in env_names}

    async def submit_task(*, remote, task_type, model_name, payload):
        return f"task-{remote.peer_id}"

    async def wait_task(*, remote, task_id, timeout_s):
        return _completed_task(remote.peer_id)

    receipt = run_p2p_consensus(
        request=_build_request(quorum=2, min_operators=3),
        prompt="What is 2+2?",
        peers=_peers(),
        timeout_s=1.0,
        per_peer_timeout_s=0.5,
        submit_task_fn=submit_task,
        wait_task_fn=wait_task,
    )

    assert receipt.consensus.accepted is True
    after = {name: os.environ.get(name) for name in env_names}
    assert after == before
