"""Adversarial consensus tests for Chainlink ZKML LLM router receipts."""

from __future__ import annotations

import asyncio
import time
from dataclasses import replace
from typing import Any

import pytest

from ipfs_accelerate_py.chainlink_cre import ChainlinkCREBridgeClient, ChainlinkCREBridgeError
from ipfs_accelerate_py.llm_consensus import (
    LLMConsensusError,
    P2P_REQUEST_SCHEMA_VERSION,
    P2P_RESPONSE_SCHEMA_VERSION,
    LocalConsensusOperator,
    OperatorResponse,
    P2PConsensusPeer,
    build_consensus_request,
    normalized_output_hash,
    run_local_consensus,
    run_p2p_consensus_async,
    select_consensus_result,
    sha256_digest,
    sign_operator_response,
    verify_operator_response_signature,
)
from ipfs_accelerate_py.proof_verifiers import ProofContext, ZKMLVerifier


def _request(**overrides: Any):
    values = {
        "prompt": "Return JSON with answer=yes.",
        "provider": "mock",
        "model_name": "mock-model",
        "model_commitment": "sha256:model-v1",
        "tokenizer_commitment": "sha256:tokenizer-v1",
        "generation_params": {"temperature": 0, "seed": 310},
        "proof_policy": {"mode": "receipt_only"},
        "nonce": "nonce-clzkml-310",
        "deadline_unix_ms": 1_900_000_000_000,
        "comparison": "canonical_json",
        "quorum": 2,
        "min_operators": 3,
    }
    values.update(overrides)
    return build_consensus_request(**values)


def _response(operator_id: str, output_text: str = '{"answer":"yes"}') -> OperatorResponse:
    return OperatorResponse(
        operator_id=operator_id,
        transport="local",
        provider="mock",
        model_name="mock-model",
        output_text=output_text,
        output_hash=sha256_digest(output_text),
        normalized_output_hash=normalized_output_hash(output_text, comparison="canonical_json"),
        latency_ms=3,
    )


def _p2p_peers() -> list[P2PConsensusPeer]:
    return [
        P2PConsensusPeer("peer-a", "/ip4/127.0.0.1/tcp/4310/p2p/peer-a"),
        P2PConsensusPeer("peer-b", "/ip4/127.0.0.1/tcp/4311/p2p/peer-b"),
        P2PConsensusPeer("peer-c", "/ip4/127.0.0.1/tcp/4312/p2p/peer-c"),
    ]


def _completed_p2p_task(peer_id: str) -> dict[str, Any]:
    return {
        "task_id": f"task-{peer_id}",
        "task_type": P2P_REQUEST_SCHEMA_VERSION,
        "status": "completed",
        "result": {
            "schema_version": P2P_RESPONSE_SCHEMA_VERSION,
            "operator_id": peer_id,
            "peer_id": peer_id,
            "provider": "mock",
            "model_name": "mock-model",
            "output_text": '{"answer":"yes"}',
        },
    }


def _zkml_context(**overrides: Any) -> ProofContext:
    values = {
        "request_hash": "sha256:req-310",
        "output_hash": "sha256:out-310",
        "model_commitment": "sha256:model-v1",
        "nonce": "nonce-proof-310",
        "tokenizer_commitment": "sha256:tokenizer-v1",
        "input_commitment": "sha256:input-310",
        "output_commitment": "sha256:output-310",
        "public_inputs_hash": "sha256:public-inputs-310",
        "verifier_key_hash": "vk:sha256:pinned-key",
        "circuit_version": "1.0.0",
    }
    values.update(overrides)
    return ProofContext(**values)


def _zkml_meta(**overrides: Any) -> dict[str, Any]:
    values = {
        "request_hash": "sha256:req-310",
        "output_hash": "sha256:out-310",
        "model_commitment": "sha256:model-v1",
        "tokenizer_commitment": "sha256:tokenizer-v1",
        "input_commitment": "sha256:input-310",
        "output_commitment": "sha256:output-310",
        "verifier_key_hash": "vk:sha256:pinned-key",
        "circuit_id": "circuit-llm-checker-v1",
        "circuit_version": "1.0.0",
        "public_inputs_hash": "sha256:public-inputs-310",
        "proof_bytes": "0xdeadbeef",
        "nonce": "nonce-proof-310",
    }
    values.update(overrides)
    return values


def test_divergent_outputs_do_not_satisfy_unanimous_quorum() -> None:
    responses = [
        _response("op-a", '{"answer":"yes"}'),
        _response("op-b", '{"answer":"no"}'),
        _response("op-c", '{"answer":"no"}'),
    ]

    result = select_consensus_result(
        responses,
        quorum=3,
        comparison="canonical_json",
        fail_closed=False,
    )

    assert result.accepted is False
    assert result.reason == "quorum_not_met"
    assert result.total_successful == 3
    assert result.rejected_operator_ids == ["op-a", "op-b", "op-c"]


def test_equivocating_operator_is_rejected_before_quorum_selection() -> None:
    responses = [
        _response("op-a", '{"answer":"yes"}'),
        _response("op-a", '{"answer":"no"}'),
        _response("op-b", '{"answer":"yes"}'),
    ]

    with pytest.raises(LLMConsensusError, match="operator equivocation"):
        select_consensus_result(responses, quorum=2, comparison="canonical_json")

    result = select_consensus_result(
        responses,
        quorum=2,
        comparison="canonical_json",
        fail_closed=False,
    )
    assert result.accepted is False
    assert result.reason == "operator_equivocation"


def test_duplicate_operator_ids_cannot_be_counted_twice_for_quorum() -> None:
    responses = [
        _response("op-a", '{"answer":"yes"}'),
        _response("op-a", '{"answer":"yes"}'),
    ]

    with pytest.raises(LLMConsensusError, match="duplicate operator IDs"):
        select_consensus_result(responses, quorum=2, comparison="canonical_json")

    result = select_consensus_result(
        responses,
        quorum=2,
        comparison="canonical_json",
        fail_closed=False,
    )
    assert result.accepted is False
    assert result.reason == "duplicate_operator_id"


def test_replayed_signature_for_different_request_is_rejected() -> None:
    request_a = _request(nonce="nonce-a", request_id="req-a")
    request_b = _request(nonce="nonce-b", request_id="req-b")
    signed = sign_operator_response(
        request_a,
        _response("op-a", '{"answer":"yes"}'),
        signing_key="operator-a-secret",
        key_id="op-a-key",
    )

    assert verify_operator_response_signature(
        request_a,
        signed,
        key_lookup={"op-a-key": "operator-a-secret"},
    )
    assert not verify_operator_response_signature(
        request_b,
        signed,
        key_lookup={"op-a-key": "operator-a-secret"},
    )

    tampered = replace(
        signed,
        output_text='{"answer":"no"}',
        output_hash=sha256_digest('{"answer":"no"}'),
        normalized_output_hash=normalized_output_hash('{"answer":"no"}', comparison="canonical_json"),
    )
    assert not verify_operator_response_signature(
        request_a,
        tampered,
        key_lookup={"op-a-key": "operator-a-secret"},
    )


def test_stale_deadline_is_bound_to_request_hash_and_blocks_signature_replay() -> None:
    fresh_request = _request(
        nonce="nonce-deadline",
        request_id="req-deadline",
        deadline_unix_ms=1_900_000_000_000,
    )
    stale_request = _request(
        nonce="nonce-deadline",
        request_id="req-deadline",
        deadline_unix_ms=1,
    )
    signed = sign_operator_response(
        fresh_request,
        _response("op-a", '{"answer":"yes"}'),
        signing_key="operator-a-secret",
        key_id="op-a-key",
    )

    assert stale_request.deadline_unix_ms < int(time.time() * 1000)
    assert stale_request.request_hash != fresh_request.request_hash
    assert not verify_operator_response_signature(
        stale_request,
        signed,
        key_lookup={"op-a-key": "operator-a-secret"},
    )


def test_malformed_json_operator_response_cannot_satisfy_canonical_json_quorum() -> None:
    request = _request(nonce="nonce-malformed", quorum=2, min_operators=2)

    receipt = run_local_consensus(
        request=request,
        operators=[
            LocalConsensusOperator("op-a", lambda _: '{"answer":"yes"}', provider="mock"),
            LocalConsensusOperator("op-b", lambda _: '{"answer":', provider="mock"),
        ],
        fail_closed=False,
    )

    assert receipt.consensus.accepted is False
    assert receipt.consensus.reason == "quorum_not_met"
    errors = {response.operator_id: response.error for response in receipt.responses}
    assert "canonical_json comparison requires valid JSON output" in str(errors["op-b"])


def test_zkml_proof_mismatch_fails_closed() -> None:
    verifier = ZKMLVerifier(
        expected_verifier_key_hash="vk:sha256:pinned-key",
        expected_circuit_id="circuit-llm-checker-v1",
        expected_circuit_version="1.0.0",
    )
    result = verifier.verify(
        _zkml_meta(),
        _zkml_context(proof_bytes_hash="sha256:not-the-proof-bytes"),
    )

    assert result.verified is False
    assert result.reason == "proof_bytes_hash_mismatch"


def test_cre_workflow_mismatch_cannot_build_fail_closed_receipt() -> None:
    request = _request(
        proof_policy={"mode": "chainlink_cre"},
        nonce="nonce-cre-mismatch",
        quorum=1,
        min_operators=1,
    )
    client = ChainlinkCREBridgeClient(
        workflow_id="wf-expected",
        don_id="don-42",
        simulated_response={
            "workflow_id": "wf-attacker",
            "output_text": '{"answer":"yes"}',
            "cre_round": 310,
            "nonce": "nonce-cre-mismatch",
        },
    )

    submission = client.submit(request)
    result = client.wait(submission)
    verification = client.verify(result, request)

    assert verification.verified is False
    assert verification.reason == "cre_workflow_id_mismatch"
    with pytest.raises(ChainlinkCREBridgeError, match="cre_workflow_id_mismatch"):
        client.build_receipt(request, result, verification=verification, fail_closed=True)


def test_timeout_race_keeps_fast_quorum_and_marks_late_peer_timed_out() -> None:
    async def _exercise():
        request = _request(nonce="nonce-timeout-race", quorum=2, min_operators=3)

        async def submit_task(*, remote, task_type, model_name, payload):
            assert task_type == P2P_REQUEST_SCHEMA_VERSION
            assert payload["request_hash"] == request.request_hash
            return {"task_id": f"task-{remote.peer_id}"}

        async def wait_task(*, remote, task_id, timeout_s):
            if remote.peer_id == "peer-c":
                await asyncio.sleep(0.2)
            return _completed_p2p_task(remote.peer_id)

        return await run_p2p_consensus_async(
            request=request,
            prompt="Return JSON with answer=yes.",
            peers=_p2p_peers(),
            timeout_s=0.05,
            per_peer_timeout_s=0.5,
            fail_closed=True,
            submit_task_fn=submit_task,
            wait_task_fn=wait_task,
        )

    receipt = asyncio.run(_exercise())

    assert receipt.consensus.accepted is True
    assert receipt.consensus.selected_operator_ids == ["peer-a", "peer-b"]
    errors = {response.operator_id: response.error for response in receipt.responses}
    assert errors["peer-c"] == "timeout"


def test_quorum_ties_fail_closed_and_return_tie_reason_when_fail_open() -> None:
    responses = [
        _response("op-a", '{"answer":"yes"}'),
        _response("op-b", '{"answer":"yes"}'),
        _response("op-c", '{"answer":"no"}'),
        _response("op-d", '{"answer":"no"}'),
    ]

    with pytest.raises(LLMConsensusError, match="tied normalized outputs"):
        select_consensus_result(responses, quorum=2, comparison="canonical_json")

    result = select_consensus_result(
        responses,
        quorum=2,
        comparison="canonical_json",
        fail_closed=False,
    )
    assert result.accepted is False
    assert result.reason == "tie"
