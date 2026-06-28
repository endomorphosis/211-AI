"""Tests for the Chainlink CRE bridge client skeleton."""

from __future__ import annotations

import pytest

from ipfs_accelerate_py.chainlink_cre import (
    CREBridgeConfig,
    CREInferenceResult,
    CRESubmission,
    CREVerifierContractEvent,
    CRE_VERIFIER_EVENT_VERIFIER_ID,
    ChainlinkCREBridgeClient,
    ChainlinkCREBridgeError,
)
from ipfs_accelerate_py.llm_consensus import (
    ConsensusReceipt,
    build_consensus_request,
    normalized_output_hash,
    sha256_digest,
)


def _request():
    return build_consensus_request(
        prompt="Return JSON with answer=yes",
        provider="mock",
        model_name="mock-model",
        proof_policy={"mode": "chainlink_cre"},
        comparison="canonical_json",
        quorum=1,
        min_operators=1,
        nonce="nonce-cre-1",
    )


def _client(**kwargs):
    values = {"workflow_id": "wf-llm-router-v1", "don_id": "don-42"}
    values.update(kwargs)
    return ChainlinkCREBridgeClient(**values)


def test_simulated_submit_wait_verify_and_receipt() -> None:
    request = _request()
    output_text = "{\"answer\":\"yes\"}"
    client = _client(simulated_response={"output_text": output_text, "cre_round": 7})

    submission = client.submit(request, prompt="raw prompt stays outside receipt")
    result = client.wait(submission)
    verification = client.verify(result, request)
    receipt = client.build_receipt(
        request,
        result,
        verification=verification,
        fail_closed=True,
        created_at="2026-06-13T12:00:00Z",
    )

    assert isinstance(submission, CRESubmission)
    assert submission.workflow_id == "wf-llm-router-v1"
    assert result.request_hash == request.request_hash
    assert result.output_hash == sha256_digest(output_text)
    assert result.normalized_output_hash == normalized_output_hash(
        output_text,
        comparison="canonical_json",
    )
    assert verification.verified is True
    assert receipt.consensus.accepted is True
    assert receipt.responses[0].transport == "chainlink_cre"
    assert receipt.proof.verified is True
    assert receipt.proof.cre_workflow_id == "wf-llm-router-v1"
    assert receipt.text == output_text

    restored = ConsensusReceipt.from_json(receipt.to_json())
    assert restored.proof.metadata["cre_round"] == 7


def test_run_fails_closed_for_workflow_mismatch() -> None:
    request = _request()
    client = _client(
        simulated_response={
            "workflow_id": "wf-wrong",
            "output_text": "{\"answer\":\"yes\"}",
        }
    )

    with pytest.raises(ChainlinkCREBridgeError, match="cre_workflow_id_mismatch"):
        client.run(request)


def test_verify_fails_for_request_hash_mismatch() -> None:
    request = _request()
    client = _client()
    output_text = "{\"answer\":\"yes\"}"
    result = CREInferenceResult(
        submission_id="sub-1",
        workflow_id="wf-llm-router-v1",
        don_id="don-42",
        request_hash="sha256:wrong-request",
        output_hash=sha256_digest(output_text),
        output_text=output_text,
        cre_round=1,
        cre_report_hash="sha256:report",
        nonce="nonce-cre-1",
    )

    verification = client.verify(result, request)

    assert verification.verified is False
    assert verification.reason == "request_hash_mismatch"


def test_verify_fails_for_output_hash_mismatch() -> None:
    request = _request()
    client = _client()
    result = CREInferenceResult(
        submission_id="sub-1",
        workflow_id="wf-llm-router-v1",
        don_id="don-42",
        request_hash=request.request_hash or "",
        output_hash="sha256:wrong-output",
        output_text="{\"answer\":\"yes\"}",
        cre_round=1,
        cre_report_hash="sha256:report",
        nonce="nonce-cre-1",
    )

    verification = client.verify(result, request)

    assert verification.verified is False
    assert verification.reason == "output_hash_mismatch"


def test_verify_fails_closed_for_missing_cre_metadata() -> None:
    request = _request()
    client = _client()
    result = {
        "submission_id": "sub-1",
        "workflow_id": "wf-llm-router-v1",
        "don_id": "don-42",
        "request_hash": request.request_hash,
        "output_hash": sha256_digest("{\"answer\":\"yes\"}"),
        "output_text": "{\"answer\":\"yes\"}",
        "cre_round": 1,
    }

    verification = client.verify(result, request)

    assert verification.verified is False
    assert verification.reason == "cre_report_hash_missing"


def test_verify_fails_closed_when_output_hash_cannot_be_bound() -> None:
    request = _request()
    client = _client()
    result = {
        "submission_id": "sub-1",
        "workflow_id": "wf-llm-router-v1",
        "don_id": "don-42",
        "request_hash": request.request_hash,
        "output_hash": "sha256:result-only",
        "cre_round": 1,
        "cre_report_hash": "sha256:report",
    }

    verification = client.verify(result, request)

    assert verification.verified is False
    assert verification.reason == "expected_output_hash_missing"


def test_hash_only_result_can_be_verified_with_expected_output_hash() -> None:
    request = _request()
    client = _client()
    result = {
        "submission_id": "sub-1",
        "workflow_id": "wf-llm-router-v1",
        "don_id": "don-42",
        "request_hash": request.request_hash,
        "output_hash": "sha256:result-only",
        "cre_round": 1,
        "cre_report_hash": "sha256:report",
        "nonce": "nonce-cre-1",
    }

    verification = client.verify(
        result,
        request,
        expected_output_hash="sha256:result-only",
    )

    assert verification.verified is True


def test_wait_requires_handler_or_simulation() -> None:
    request = _request()
    client = _client()
    submission = client.submit(request)

    with pytest.raises(ChainlinkCREBridgeError, match="cre_wait_handler_required"):
        client.wait(submission)


def test_verifier_contract_event_parses_web3_shape_and_matches_expected_fields() -> None:
    request = _request()
    output_hash = sha256_digest("{\"answer\":\"yes\"}")
    proof_hash = sha256_digest("cre-report")
    raw_event = {
        "address": "0xABCDEF0000000000000000000000000000000000",
        "blockNumber": "12345",
        "transactionHash": "0xtransaction",
        "logIndex": 7,
        "event": "CREVerifierReceipt",
        "args": {
            "workflowId": "wf-llm-router-v1",
            "requestHash": request.request_hash,
            "outputHash": output_hash,
            "proofHash": proof_hash,
            "chainId": "11155111",
        },
    }

    event = CREVerifierContractEvent.from_dict(raw_event)
    verification = event.verify_expected(
        chain_id="11155111",
        contract_address="0xabcdef0000000000000000000000000000000000",
        workflow_id="wf-llm-router-v1",
        request_hash=request.request_hash,
        output_hash=output_hash,
        proof_hash=proof_hash,
        block_number=12345,
        tx_hash="0xtransaction",
    )
    restored = CREVerifierContractEvent.from_json(event.to_json())

    assert event.block_number == 12345
    assert event.log_index == 7
    assert verification.verified is True
    assert verification.verifier == CRE_VERIFIER_EVENT_VERIFIER_ID
    assert restored == event


def test_verifier_contract_event_fails_closed_on_binding_mismatch() -> None:
    event = CREVerifierContractEvent.from_dict(
        {
            "contract_address": "0xabc",
            "block_number": 10,
            "tx_hash": "0xtransaction",
            "workflow_id": "wf-llm-router-v1",
            "request_hash": "sha256:request",
            "output_hash": "sha256:output",
            "proof_hash": "sha256:proof",
            "chain_id": "11155111",
        }
    )

    verification = event.verify_expected(
        chain_id="11155111",
        contract_address="0xabc",
        workflow_id="wf-llm-router-v1",
        request_hash="sha256:request",
        output_hash="sha256:wrong-output",
        proof_hash="sha256:proof",
        block_number=10,
        tx_hash="0xtransaction",
    )

    assert verification.verified is False
    assert verification.verifier == CRE_VERIFIER_EVENT_VERIFIER_ID
    assert verification.reason == "verifier_contract_output_hash_mismatch"


def test_cre_bridge_verifies_optional_contract_event_without_live_rpc() -> None:
    request = _request()
    output_text = "{\"answer\":\"yes\"}"
    output_hash = sha256_digest(output_text)
    proof_hash = sha256_digest("cre-contract-proof")
    raw_event = {
        "address": "0xABCDEF0000000000000000000000000000000000",
        "blockNumber": 12345,
        "transactionHash": "0xtransaction",
        "args": {
            "workflowId": "wf-llm-router-v1",
            "requestHash": request.request_hash,
            "outputHash": output_hash,
            "proofHash": proof_hash,
            "chainId": "11155111",
        },
    }
    client = ChainlinkCREBridgeClient(
        config=CREBridgeConfig(
            workflow_id="wf-llm-router-v1",
            don_id="don-42",
            chain_id="11155111",
            metadata={"verifier_contract_address": "0xabcdef0000000000000000000000000000000000"},
        ),
        simulated_response={
            "output_text": output_text,
            "output_hash": output_hash,
            "cre_report_hash": proof_hash,
            "chain_id": "11155111",
            "tx_hash": "0xtransaction",
            "metadata": {"verifier_contract_event": raw_event},
        },
    )

    submission = client.submit(request)
    result = client.wait(submission)
    verification = client.verify(result, request)
    receipt = client.build_receipt(request, result, verification=verification)

    assert verification.verified is True
    assert verification.metadata["verifier_contract_event"]["proof_hash"] == proof_hash
    assert receipt.proof.metadata["verifier_contract_event"]["tx_hash"] == "0xtransaction"


def test_cre_bridge_fails_closed_for_mismatched_contract_event() -> None:
    request = _request()
    output_text = "{\"answer\":\"yes\"}"
    output_hash = sha256_digest(output_text)
    proof_hash = sha256_digest("cre-contract-proof")
    client = ChainlinkCREBridgeClient(
        config=CREBridgeConfig(
            workflow_id="wf-llm-router-v1",
            don_id="don-42",
            chain_id="11155111",
            metadata={"verifier_contract_address": "0xabcdef0000000000000000000000000000000000"},
        ),
        simulated_response={
            "output_text": output_text,
            "output_hash": output_hash,
            "cre_report_hash": proof_hash,
            "chain_id": "11155111",
            "tx_hash": "0xtransaction",
            "metadata": {
                "verifier_contract_event": {
                    "address": "0xABCDEF0000000000000000000000000000000000",
                    "blockNumber": 12345,
                    "transactionHash": "0xtransaction",
                    "args": {
                        "workflowId": "wf-llm-router-v1",
                        "requestHash": request.request_hash,
                        "outputHash": "sha256:wrong-output",
                        "proofHash": proof_hash,
                        "chainId": "11155111",
                    },
                }
            },
        },
    )

    verification = client.verify(client.wait(client.submit(request)), request)

    assert verification.verified is False
    assert verification.reason == "verifier_contract_output_hash_mismatch"
