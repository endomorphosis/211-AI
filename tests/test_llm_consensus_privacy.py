"""No-leak boundary tests for LLM consensus receipts and verifier errors."""

from __future__ import annotations

import json

import pytest

from ipfs_accelerate_py.llm_consensus import (
    LocalConsensusOperator,
    ProofReceipt,
    build_consensus_request,
    persist_consensus_receipt,
    run_local_consensus,
    sha256_digest,
)
from ipfs_accelerate_py.proof_verifiers import (
    ChainlinkCREVerifier,
    ProofContext,
    ReceiptOnlyVerifier,
    TEEVerifier,
    VerificationResult,
    ZKMLVerifier,
)


RAW_PROMPT = (
    "CLZKML-150 raw prompt marker: user secret is configured-sensitive-substring-150 "
    "and the emergency phrase is keep-this-prompt-private"
)
API_SECRET = "clzkml-150-api-secret"
BEARER_TOKEN = "Bearer clzkml-150-bearer-token"
PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----clzkml-150-private-key-----END PRIVATE KEY-----"
CONFIGURED_SENSITIVE_SUBSTRING = "configured-sensitive-substring-150"

SENSITIVE_SUBSTRINGS = (
    RAW_PROMPT,
    "keep-this-prompt-private",
    API_SECRET,
    BEARER_TOKEN,
    "clzkml-150-bearer-token",
    PRIVATE_KEY,
    "clzkml-150-private-key",
    CONFIGURED_SENSITIVE_SUBSTRING,
)


def _render(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)


def _assert_no_sensitive_substrings(value: object) -> None:
    rendered = value if isinstance(value, str) else _render(value)
    for sensitive in SENSITIVE_SUBSTRINGS:
        assert sensitive not in rendered


def _privacy_request(**overrides: object):
    values = {
        "prompt": RAW_PROMPT,
        "provider": "mock",
        "model_name": "privacy-model",
        "model_commitment": "sha256:model-privacy-v1",
        "generation_params": {
            "temperature": 0,
            "api_key": API_SECRET,
            "headers": {
                "Authorization": BEARER_TOKEN,
                "X-Stable": "ok",
            },
            "nested": {
                "password": CONFIGURED_SENSITIVE_SUBSTRING,
                "safe": "stable-value",
            },
        },
        "response_schema": {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "secret_note": CONFIGURED_SENSITIVE_SUBSTRING,
        },
        "proof_policy": {
            "mode": "receipt_only",
            "private_key": PRIVATE_KEY,
            "verifier_ref": "privacy-verifier-v1",
        },
        "metadata": {
            "purpose": "privacy-boundary-test",
            "token": CONFIGURED_SENSITIVE_SUBSTRING,
            "trace_id": "trace-should-drop",
        },
        "comparison": "canonical_json",
        "quorum": 1,
        "min_operators": 1,
        "nonce": "privacy-nonce-150",
        "prompt_redaction_policy": "hash_only",
    }
    values.update(overrides)
    return build_consensus_request(**values)


def _safe_operator() -> LocalConsensusOperator:
    return LocalConsensusOperator(
        "op-privacy-safe",
        lambda _: "{\"answer\":\"safe\"}",
        provider="mock",
    )


def test_redacted_receipt_json_excludes_prompt_credentials_and_configured_sensitive_values() -> None:
    request = _privacy_request()

    receipt = run_local_consensus(
        request=request,
        operators=[_safe_operator()],
        created_at="2026-06-13T12:00:00Z",
    )
    payload = json.loads(receipt.to_json())

    assert payload["request"]["prompt_hash"] == sha256_digest(RAW_PROMPT)
    assert payload["request"]["prompt_redaction_policy"] == "hash_only"
    assert payload["request"]["generation_params"] == {
        "headers": {"X-Stable": "ok"},
        "nested": {"safe": "stable-value"},
        "temperature": 0,
    }
    assert payload["request"]["proof_policy"] == {
        "mode": "receipt_only",
        "verifier_ref": "privacy-verifier-v1",
    }
    _assert_no_sensitive_substrings(payload)


def test_persisted_receipt_files_exclude_prompt_credentials_and_configured_sensitive_values(tmp_path) -> None:
    request = _privacy_request()
    json_path = tmp_path / "receipt.json"
    jsonl_path = tmp_path / "receipts.jsonl"

    receipt = run_local_consensus(
        request=request,
        operators=[_safe_operator()],
        created_at="2026-06-13T12:00:00Z",
    )
    persist_consensus_receipt(receipt, path=json_path, append_jsonl=False)
    persist_consensus_receipt(receipt, path=jsonl_path, append_jsonl=True)

    _assert_no_sensitive_substrings(json_path.read_text(encoding="utf-8"))
    _assert_no_sensitive_substrings(jsonl_path.read_text(encoding="utf-8"))


def test_failed_proof_receipt_from_verifier_error_does_not_leak_sensitive_inputs() -> None:
    request = _privacy_request(proof_policy={"mode": "zkml_required", "private_key": PRIVATE_KEY})
    context = ProofContext(
        request_hash=request.request_hash or "",
        output_hash=sha256_digest("{\"answer\":\"safe\"}"),
        model_commitment=request.model_commitment or "",
        nonce="proof-error-nonce-150",
    )
    result = ZKMLVerifier(
        expected_verifier_key_hash="vk:sha256:pinned-key",
        expected_circuit_id="circuit-llm-checker-v1",
        expected_circuit_version="1.0.0",
    ).verify(
        {
            "request_hash": context.request_hash,
            "output_hash": context.output_hash,
            "model_commitment": context.model_commitment,
            "verifier_key_hash": f"vk:{CONFIGURED_SENSITIVE_SUBSTRING}",
            "circuit_id": "circuit-llm-checker-v1",
            "circuit_version": "1.0.0",
            "public_inputs_hash": "sha256:public-inputs",
            "proof_bytes": PRIVATE_KEY,
            "nonce": context.nonce,
        },
        context,
    )
    proof = ProofReceipt(
        policy="zkml_required",
        verified=result.verified,
        verifier=result.verifier,
        public_inputs_hash="sha256:public-inputs",
        metadata={"reason": result.reason},
    )

    receipt = run_local_consensus(
        request=request,
        operators=[_safe_operator()],
        proof=proof,
        created_at="2026-06-13T12:00:00Z",
    )

    assert result.verified is False
    assert result.reason == "verifier_key_hash_mismatch"
    _assert_no_sensitive_substrings(result.__dict__)
    _assert_no_sensitive_substrings(receipt.to_json())


def _verification_result_payload(result: VerificationResult) -> dict[str, object]:
    return {
        "verified": result.verified,
        "verifier": result.verifier,
        "reason": result.reason,
        "metadata": result.metadata,
    }


@pytest.mark.parametrize(
    ("verifier", "proof_meta", "context", "expected_reason"),
    [
        (
            ReceiptOnlyVerifier(),
            {
                "request_hash": RAW_PROMPT,
                "output_hash": "sha256:out",
                "nonce": "receipt-error-nonce-150",
                "authorization": BEARER_TOKEN,
            },
            ProofContext(
                request_hash="sha256:req",
                output_hash="sha256:out",
                nonce="receipt-error-nonce-150",
            ),
            "request_hash_mismatch",
        ),
        (
            TEEVerifier(now_unix_ms=2_000_000),
            {
                "request_hash": "sha256:req",
                "output_hash": "sha256:out",
                "model_commitment": "sha256:model",
                "tee_measurement": "pcr0:ok",
                "tee_signer": PRIVATE_KEY,
                "tee_nonce": "tee-error-nonce-150",
                "tee_expiry_unix_ms": 1_000,
                "authorization": BEARER_TOKEN,
            },
            ProofContext(
                request_hash="sha256:req",
                output_hash="sha256:out",
                model_commitment="sha256:model",
                nonce="tee-error-nonce-150",
            ),
            "tee_attestation_expired",
        ),
        (
            ZKMLVerifier(
                expected_verifier_key_hash="vk:sha256:pinned-key",
                expected_circuit_id="circuit-llm-checker-v1",
                expected_circuit_version="1.0.0",
            ),
            {
                "request_hash": "sha256:req",
                "output_hash": "sha256:out",
                "model_commitment": "sha256:model",
                "verifier_key_hash": f"vk:{CONFIGURED_SENSITIVE_SUBSTRING}",
                "circuit_id": "circuit-llm-checker-v1",
                "circuit_version": "1.0.0",
                "public_inputs_hash": "sha256:public-inputs",
                "proof_bytes": PRIVATE_KEY,
                "nonce": "zkml-error-nonce-150",
            },
            ProofContext(
                request_hash="sha256:req",
                output_hash="sha256:out",
                model_commitment="sha256:model",
                nonce="zkml-error-nonce-150",
            ),
            "verifier_key_hash_mismatch",
        ),
        (
            ChainlinkCREVerifier(
                expected_workflow_id="wf-llm-router-v1",
                expected_don_id="don-42",
            ),
            {
                "request_hash": "sha256:req",
                "output_hash": "sha256:out",
                "cre_workflow_id": CONFIGURED_SENSITIVE_SUBSTRING,
                "cre_don_id": "don-42",
                "cre_round": 1,
                "cre_report_hash": PRIVATE_KEY,
                "nonce": "cre-error-nonce-150",
            },
            ProofContext(
                request_hash="sha256:req",
                output_hash="sha256:out",
                nonce="cre-error-nonce-150",
            ),
            "cre_workflow_id_mismatch",
        ),
    ],
)
def test_verifier_error_results_do_not_echo_sensitive_proof_metadata(
    verifier,
    proof_meta: dict[str, object],
    context: ProofContext,
    expected_reason: str,
) -> None:
    result = verifier.verify(proof_meta, context)

    assert result.verified is False
    assert result.reason == expected_reason
    _assert_no_sensitive_substrings(_verification_result_payload(result))
