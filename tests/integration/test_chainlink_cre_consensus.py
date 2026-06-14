"""Gated Chainlink CRE simulation integration tests for consensus receipts."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from typing import Any

import pytest

from ipfs_accelerate_py.chainlink_cre import (
    CREInferenceResult,
    ChainlinkCREBridgeClient,
    ChainlinkCREBridgeError,
)
from ipfs_accelerate_py.llm_consensus import (
    ConsensusReceipt,
    build_consensus_request,
    normalized_output_hash,
    receipt_content_hash,
    sha256_digest,
)


RUN_ENV = "IPFS_ACCELERATE_PY_RUN_CHAINLINK_CRE_TESTS"
WORKFLOW_ENV = "IPFS_ACCELERATE_PY_CHAINLINK_CRE_WORKFLOW_ID"
DON_ENV = "IPFS_ACCELERATE_PY_CHAINLINK_CRE_DON_ID"
REGISTRY_ENV = "IPFS_ACCELERATE_PY_CHAINLINK_CRE_REGISTRY"
CHAIN_ID_ENV = "IPFS_ACCELERATE_PY_CHAINLINK_CRE_CHAIN_ID"
ENDPOINT_ENV = "IPFS_ACCELERATE_PY_CHAINLINK_CRE_ENDPOINT"

_REQUIRED_CONFIG_ENVS = (WORKFLOW_ENV, DON_ENV)
_SIMULATED_PROMPT = "Return JSON with answer=yes for the Chainlink CRE simulation."
_SIMULATED_OUTPUT = '{"answer":"yes","source":"chainlink_cre_simulation"}'


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


pytestmark = pytest.mark.skipif(
    not _truthy_env(RUN_ENV),
    reason=f"Set {RUN_ENV}=1 to run gated Chainlink CRE simulation tests",
)


@dataclass(frozen=True)
class _CRETestConfig:
    workflow_id: str
    don_id: str
    registry: str = "private"
    chain_id: str | None = None
    endpoint_url: str | None = None


def _env_text(name: str) -> str:
    return os.environ.get(name, "").strip()


def _require_chainlink_cre_config() -> _CRETestConfig:
    missing = [name for name in _REQUIRED_CONFIG_ENVS if not _env_text(name)]
    if missing:
        pytest.skip(
            "Chainlink CRE simulation config absent; set "
            + ", ".join(missing)
            + " to bind simulated receipts to a workflow and DON"
        )

    return _CRETestConfig(
        workflow_id=_env_text(WORKFLOW_ENV),
        don_id=_env_text(DON_ENV),
        registry=_env_text(REGISTRY_ENV) or "private",
        chain_id=_env_text(CHAIN_ID_ENV) or None,
        endpoint_url=_env_text(ENDPOINT_ENV) or None,
    )


def _stable_json(data: dict[str, Any]) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _request(config: _CRETestConfig, *, nonce: str = "nonce-clzkml-220"):
    return build_consensus_request(
        prompt=_SIMULATED_PROMPT,
        request_id=f"req-clzkml-220-{nonce}",
        provider="chainlink-cre-simulation",
        model_name="deterministic-json-fixture",
        model_commitment="chainlink-cre-sim:deterministic-json@clzkml-220",
        generation_params={
            "temperature": 0,
            "max_tokens": 64,
            "seed": 220,
            "response_format": {"type": "json_object"},
        },
        response_schema={
            "type": "object",
            "required": ["answer", "source"],
            "properties": {
                "answer": {"const": "yes"},
                "source": {"const": "chainlink_cre_simulation"},
            },
        },
        proof_policy={
            "mode": "chainlink_cre",
            "cre_workflow_id": config.workflow_id,
            "cre_don_id": config.don_id,
            "cre_registry": config.registry,
        },
        nonce=nonce,
        comparison="canonical_json",
        quorum=1,
        min_operators=1,
        metadata={
            "model_policy_id": "policy-cre-sim-json-v1",
            "endpoint_policy_id": "policy-cre-sim-http-v1",
        },
    )


def _simulated_workflow_result(*, output_text: str = _SIMULATED_OUTPUT, cre_round: int = 220):
    def _handler(submission, config):
        output_hash = sha256_digest(output_text)
        normalized_hash = normalized_output_hash(
            output_text,
            comparison=str(submission.metadata.get("comparison") or "canonical_json"),
        )
        aggregation = {
            "comparison": "canonical_json",
            "quorum": 3,
            "min_operators": 5,
            "successful_nodes": 5,
            "selected_count": 5,
            "selected_normalized_output_hash": normalized_hash,
        }
        report_body = {
            "workflow_id": submission.workflow_id,
            "don_id": submission.don_id,
            "request_hash": submission.request_hash,
            "output_hash": output_hash,
            "normalized_output_hash": normalized_hash,
            "cre_round": cre_round,
            "aggregation": aggregation,
        }
        report_hash = sha256_digest(_stable_json(report_body))
        return {
            "submission_id": submission.submission_id,
            "workflow_id": submission.workflow_id,
            "don_id": submission.don_id,
            "request_hash": submission.request_hash,
            "output_hash": output_hash,
            "normalized_output_hash": normalized_hash,
            "output_text": output_text,
            "status": "completed",
            "cre_round": cre_round,
            "cre_report_hash": report_hash,
            "cre_report_id": f"cre-report-clzkml-220-{cre_round}",
            "chain_id": config.chain_id,
            "tx_hash": "0x" + "220".zfill(64),
            "latency_ms": 1288,
            "nonce": str(submission.metadata.get("nonce") or ""),
            "metadata": {
                "model_policy_id": "policy-cre-sim-json-v1",
                "endpoint_policy_id": "policy-cre-sim-http-v1",
                "operator_set_hash": sha256_digest("clzkml-220-cre-operator-set"),
                "aggregation": aggregation,
                "proof": {
                    "node_response_hashes": [
                        sha256_digest(f"node-{index}:{output_hash}") for index in range(1, 6)
                    ],
                    "verifier_event": (
                        "CREInferenceVerified(bytes32 requestHash, bytes32 outputHash)"
                    ),
                },
            },
        }

    return _handler


def _client(config: _CRETestConfig, *, cre_round: int = 220) -> ChainlinkCREBridgeClient:
    return ChainlinkCREBridgeClient(
        workflow_id=config.workflow_id,
        don_id=config.don_id,
        registry=config.registry,
        chain_id=config.chain_id,
        endpoint_url=config.endpoint_url,
        timeout_s=1.0,
        poll_interval_s=0.0,
        simulated_response=_simulated_workflow_result(cre_round=cre_round),
    )


def _run_simulation(config: _CRETestConfig, *, nonce: str = "nonce-clzkml-220"):
    request = _request(config, nonce=nonce)
    client = _client(config)
    submission = client.submit(
        request,
        prompt=_SIMULATED_PROMPT,
        metadata={"simulation_task": "CLZKML-220"},
    )
    result = client.wait(submission, timeout_s=1.0, poll_interval_s=0.0)
    return client, request, submission, result


def test_simulated_cre_workflow_builds_verified_consensus_receipt() -> None:
    config = _require_chainlink_cre_config()
    client, request, submission, result = _run_simulation(config)

    verification = client.verify(result, request)
    receipt = client.build_receipt(
        request,
        result,
        verification=verification,
        fail_closed=True,
        created_at="2026-06-13T12:00:00Z",
    )

    assert verification.verified is True
    assert verification.reason == "chainlink_cre_report_verified"
    assert isinstance(result, CREInferenceResult)
    assert isinstance(receipt, ConsensusReceipt)
    assert receipt.consensus.accepted is True
    assert receipt.consensus.reason == "chainlink_cre_verified"
    assert receipt.text == _SIMULATED_OUTPUT
    assert receipt.proof.policy == "chainlink_cre"
    assert receipt.proof.verified is True
    assert receipt.proof.verifier == "chainlink-cre-verifier-v1"
    assert receipt.proof.cre_workflow_id == config.workflow_id
    assert receipt.proof.cre_report_id == result.cre_report_id
    assert receipt.proof.chain_id == config.chain_id
    assert receipt.proof.tx_hash == result.tx_hash
    assert receipt.proof.metadata["cre_don_id"] == config.don_id
    assert receipt.proof.metadata["cre_round"] == 220
    assert receipt.proof.metadata["cre_report_hash"] == result.cre_report_hash

    response = receipt.responses[0]
    assert response.transport == "chainlink_cre"
    assert response.operator_id == "chainlink-cre"
    assert response.output_hash == sha256_digest(_SIMULATED_OUTPUT)
    assert response.normalized_output_hash == normalized_output_hash(
        _SIMULATED_OUTPUT,
        comparison="canonical_json",
    )
    assert response.attestation is not None
    assert response.attestation["request_hash"] == request.request_hash
    assert response.attestation["output_hash"] == result.output_hash
    assert response.attestation["cre_workflow_id"] == config.workflow_id
    assert response.attestation["cre_don_id"] == config.don_id
    assert response.attestation["cre_report_hash"] == result.cre_report_hash
    assert response.metadata["submission_id"] == submission.submission_id
    assert response.metadata["verification_reason"] == "chainlink_cre_report_verified"
    assert response.metadata["operator_set_hash"].startswith("sha256:")
    assert response.metadata["aggregation"]["selected_count"] == 5

    restored = ConsensusReceipt.from_json(receipt.to_json())
    assert restored.proof.cre_workflow_id == config.workflow_id
    assert restored.responses[0].metadata["aggregation"]["quorum"] == 3
    assert receipt_content_hash(restored).startswith("sha256:")


@pytest.mark.parametrize(
    ("bad_identifier", "expected_reason"),
    (
        ("workflow", "cre_workflow_id_mismatch"),
        ("request", "request_hash_mismatch"),
        ("output", "output_hash_mismatch"),
    ),
)
def test_simulated_cre_workflow_rejects_wrong_identifiers(
    bad_identifier: str,
    expected_reason: str,
) -> None:
    config = _require_chainlink_cre_config()
    client, request, _submission, result = _run_simulation(
        config,
        nonce=f"nonce-clzkml-220-{bad_identifier}",
    )

    if bad_identifier == "workflow":
        result = replace(result, workflow_id=f"{config.workflow_id}-wrong")
    elif bad_identifier == "request":
        result = replace(result, request_hash="sha256:" + "0" * 64)
    elif bad_identifier == "output":
        result = replace(result, output_hash=sha256_digest("wrong-output"))
    else:  # pragma: no cover - protects future parametrization edits.
        raise AssertionError(f"Unknown bad identifier: {bad_identifier}")

    verification = client.verify(result, request)

    assert verification.verified is False
    assert verification.reason == expected_reason
    with pytest.raises(
        ChainlinkCREBridgeError,
        match=f"cre_verification_failed:{expected_reason}",
    ):
        client.build_receipt(
            request,
            result,
            verification=verification,
            fail_closed=True,
        )


def test_missing_chainlink_cre_config_skips_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _REQUIRED_CONFIG_ENVS:
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(pytest.skip.Exception) as excinfo:
        _require_chainlink_cre_config()

    reason = str(excinfo.value)
    assert "Chainlink CRE simulation config absent" in reason
    assert WORKFLOW_ENV in reason
    assert DON_ENV in reason
