"""Tests for LLM consensus receipt models."""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass

import pytest

from ipfs_accelerate_py.llm_consensus import (
    CONSENSUS_RECEIPT_SCHEMA_VERSION,
    ConsensusReceipt,
    ConsensusRequest,
    ConsensusResult,
    LocalConsensusOperator,
    OperatorResponse,
    ProofReceipt,
    build_consensus_request,
    canonical_request_hash,
    canonical_request_payload,
    consensus_health_summary,
    consensus_receipt_counts,
    is_advisory_comparison,
    normalize_output_text,
    normalized_output_hash,
    operator_signature_payload,
    persist_consensus_receipt,
    receipt_content_hash,
    receipt_persistence_record,
    run_local_consensus,
    select_consensus_result,
    sign_operator_response,
    utc_now_iso,
    verify_operator_response_signature,
)


@dataclass
class _MockConsensusOperator:
    operator_id: str
    output_text: str = "{\"answer\":\"yes\"}"
    output_hash: str = "sha256:raw"
    normalized_output_hash: str = "sha256:normalized"
    provider: str = "mock"
    transport: str = "local"
    error: str | None = None
    latency_ms: int = 0
    equivocate_after: int | None = None

    def __post_init__(self) -> None:
        self.calls = 0

    def respond(self, request: ConsensusRequest) -> OperatorResponse:
        self.calls += 1
        if self.error:
            return OperatorResponse(
                operator_id=self.operator_id,
                transport=self.transport,
                provider=self.provider,
                model_name=request.model_name,
                output_text="",
                output_hash="",
                normalized_output_hash="",
                latency_ms=self.latency_ms,
                error=self.error,
            )

        output_text = self.output_text
        output_hash = self.output_hash
        normalized_output_hash = self.normalized_output_hash
        if self.equivocate_after is not None and self.calls > self.equivocate_after:
            output_text = "{\"answer\":\"changed\"}"
            output_hash = "sha256:changed-raw"
            normalized_output_hash = "sha256:changed-normalized"

        return OperatorResponse(
            operator_id=self.operator_id,
            transport=self.transport,
            provider=self.provider,
            model_name=request.model_name,
            output_text=output_text,
            output_hash=output_hash,
            normalized_output_hash=normalized_output_hash,
            latency_ms=self.latency_ms,
            metadata={"request_id": request.request_id, "call": self.calls},
        )


def _sample_request(**overrides: object) -> ConsensusRequest:
    values = {
        "request_id": "req-1",
        "prompt_hash": "sha256:prompt",
        "prompt_cid": "bafy-prompt",
        "prompt_redaction_policy": "hash_only",
        "provider": "mock",
        "model_name": "mock-model",
        "model_commitment": "sha256:model",
        "tokenizer_commitment": "sha256:tokenizer",
        "generation_params": {"temperature": 0, "nested": {"b": 2, "a": 1}},
        "comparison": "canonical_json",
        "quorum": 2,
        "min_operators": 3,
        "deadline_unix_ms": 1780000000000,
        "proof_policy": {"mode": "receipt_only"},
        "metadata": {"purpose": "unit-test"},
    }
    values.update(overrides)
    return ConsensusRequest(**values)


def _sample_response(operator_id: str = "op-a", **overrides: object) -> OperatorResponse:
    values = {
        "operator_id": operator_id,
        "transport": "local",
        "peer_id": None,
        "provider": "mock",
        "model_name": "mock-model",
        "output_text": "{\"answer\":\"yes\"}",
        "output_hash": "sha256:raw",
        "normalized_output_hash": "sha256:normalized",
        "latency_ms": 12,
        "error": None,
        "signature": "sig-a",
        "attestation": {"kind": "dev"},
        "metadata": {"trace_provider": "mock"},
    }
    values.update(overrides)
    return OperatorResponse(**values)


def _sample_receipt() -> ConsensusReceipt:
    return ConsensusReceipt(
        request=_sample_request(),
        responses=[
            _sample_response("op-a"),
            _sample_response("op-b", signature="sig-b"),
        ],
        consensus=ConsensusResult(
            accepted=True,
            selected_output_hash="sha256:raw",
            selected_normalized_hash="sha256:normalized",
            selected_operator_ids=["op-a", "op-b"],
            rejected_operator_ids=["op-c"],
            quorum=2,
            total_successful=2,
            comparison="canonical_json",
            reason="quorum_met",
        ),
        proof=ProofReceipt(
            policy="receipt_only",
            verified=True,
            verifier="receipt-only-v1",
            public_inputs_hash="sha256:public-inputs",
            metadata={"mode": "test"},
        ),
        text="{\"answer\":\"yes\"}",
        created_at="2026-06-13T12:00:00Z",
    )


def test_utc_now_iso_uses_z_suffix() -> None:
    timestamp = utc_now_iso()
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", timestamp)


def test_request_json_is_deterministic_for_nested_data() -> None:
    left = _sample_request(generation_params={"nested": {"b": 2, "a": 1}, "temperature": 0})
    right = _sample_request(generation_params={"temperature": 0, "nested": {"a": 1, "b": 2}})

    assert left.to_json() == right.to_json()
    assert left.to_json() == left.to_json()
    assert json.loads(left.to_json())["generation_params"]["nested"] == {"a": 1, "b": 2}


def test_receipt_round_trip_preserves_nested_models() -> None:
    receipt = _sample_receipt()

    restored = ConsensusReceipt.from_json(receipt.to_json())

    assert restored == receipt
    assert restored.schema_version == CONSENSUS_RECEIPT_SCHEMA_VERSION
    assert restored.request.request_id == "req-1"
    assert restored.responses[0].operator_id == "op-a"
    assert restored.consensus.accepted is True
    assert restored.proof.verified is True


def test_receipt_json_is_stable_and_compact() -> None:
    receipt = _sample_receipt()

    rendered = receipt.to_json()

    assert rendered == receipt.to_json()
    assert "\n" not in rendered
    assert rendered.startswith("{\"consensus\":")
    assert "\"schema_version\":\"llm-router-consensus-receipt-v1\"" in rendered


def test_receipt_from_dict_rejects_schema_mismatch() -> None:
    payload = _sample_receipt().to_dict()
    payload["schema_version"] = "llm-router-consensus-receipt-v999"

    with pytest.raises(ValueError, match="Unsupported consensus receipt schema_version"):
        ConsensusReceipt.from_dict(payload)


def test_individual_model_json_round_trips() -> None:
    request = _sample_request()
    response = _sample_response()
    result = ConsensusResult(
        accepted=False,
        selected_output_hash="",
        selected_normalized_hash="",
        quorum=2,
        total_successful=1,
        reason="quorum_not_met",
    )
    proof = ProofReceipt(policy="receipt_only")

    assert ConsensusRequest.from_json(request.to_json()) == request
    assert OperatorResponse.from_json(response.to_json()) == response
    assert ConsensusResult.from_json(result.to_json()) == result
    assert ProofReceipt.from_json(proof.to_json()) == proof


def test_receipt_requires_object_sections() -> None:
    payload = _sample_receipt().to_dict()
    payload["request"] = None

    with pytest.raises(ValueError, match="request must be an object"):
        ConsensusReceipt.from_dict(payload)


def test_build_consensus_request_hash_is_stable_across_dict_ordering() -> None:
    left = build_consensus_request(
        prompt="private prompt",
        provider="mock",
        model_name="mock-model",
        generation_params={"temperature": 0, "nested": {"b": 2, "a": 1}},
        response_schema={"required": ["answer"], "properties": {"answer": {"type": "string"}}},
        proof_policy={"mode": "receipt_only"},
        nonce="nonce-1",
        deadline_unix_ms=1780000000000,
        prompt_cid="bafy-prompt",
        context_cids=["bafy-context"],
        comparison="canonical_json",
        quorum=2,
        min_operators=3,
    )
    right = build_consensus_request(
        prompt="private prompt",
        provider="mock",
        model_name="mock-model",
        generation_params={"nested": {"a": 1, "b": 2}, "temperature": 0},
        response_schema={"properties": {"answer": {"type": "string"}}, "required": ["answer"]},
        proof_policy={"mode": "receipt_only"},
        nonce="nonce-1",
        deadline_unix_ms=1780000000000,
        prompt_cid="bafy-prompt",
        context_cids=["bafy-context"],
        comparison="canonical_json",
        quorum=2,
        min_operators=3,
    )

    assert left.request_hash == right.request_hash
    assert left.prompt_hash == right.prompt_hash
    assert left.request_hash == canonical_request_hash(
        prompt="private prompt",
        provider="mock",
        model_name="mock-model",
        generation_params={"temperature": 0, "nested": {"b": 2, "a": 1}},
        response_schema={"required": ["answer"], "properties": {"answer": {"type": "string"}}},
        proof_policy={"mode": "receipt_only"},
        nonce="nonce-1",
        deadline_unix_ms=1780000000000,
        prompt_cid="bafy-prompt",
        context_cids=["bafy-context"],
        comparison="canonical_json",
        quorum=2,
        min_operators=3,
    )


def test_build_consensus_request_hash_changes_for_nonce_deadline_and_schema() -> None:
    base = build_consensus_request(
        prompt="prompt",
        nonce="nonce-1",
        deadline_unix_ms=1780000000000,
        response_schema={"type": "object", "required": ["answer"]},
    )
    changed_nonce = build_consensus_request(
        prompt="prompt",
        nonce="nonce-2",
        deadline_unix_ms=1780000000000,
        response_schema={"type": "object", "required": ["answer"]},
    )
    changed_deadline = build_consensus_request(
        prompt="prompt",
        nonce="nonce-1",
        deadline_unix_ms=1780000000001,
        response_schema={"type": "object", "required": ["answer"]},
    )
    changed_schema = build_consensus_request(
        prompt="prompt",
        nonce="nonce-1",
        deadline_unix_ms=1780000000000,
        response_schema={"type": "object", "required": ["answer", "confidence"]},
    )

    assert base.request_hash != changed_nonce.request_hash
    assert base.request_hash != changed_deadline.request_hash
    assert base.request_hash != changed_schema.request_hash


def test_build_consensus_request_excludes_raw_prompt_and_sensitive_fields() -> None:
    request = build_consensus_request(
        prompt="raw sensitive prompt",
        generation_params={
            "temperature": 0,
            "api_key": "secret-api-key",
            "timestamp": "2026-06-13T12:00:00Z",
            "headers": {"Authorization": "Bearer secret-token", "X-Stable": "ok"},
        },
        response_schema={"type": "object", "secret_note": "do-not-store"},
        proof_policy={"mode": "receipt_only", "private_key": "do-not-store"},
        metadata={"trace_id": "trace-123", "purpose": "test", "token": "do-not-store"},
        nonce="nonce-1",
    )

    rendered = request.to_json()

    assert "raw sensitive prompt" not in rendered
    assert "secret-api-key" not in rendered
    assert "secret-token" not in rendered
    assert "do-not-store" not in rendered
    assert "trace-123" not in rendered
    assert request.generation_params == {
        "headers": {"X-Stable": "ok"},
        "temperature": 0,
    }
    assert request.proof_policy == {"mode": "receipt_only"}
    assert request.metadata["request_hash_payload"]["metadata"] == {"purpose": "test"}


def test_canonical_request_payload_keeps_optional_cids_and_redaction_policy() -> None:
    payload = canonical_request_payload(
        prompt="prompt",
        prompt_cid="bafy-prompt",
        context_cids=("bafy-a", "bafy-b"),
        prompt_redaction_policy="hash_only",
        nonce="nonce-1",
    )

    assert payload["prompt_hash"].startswith("sha256:")
    assert payload["prompt_cid"] == "bafy-prompt"
    assert payload["context_cids"] == ["bafy-a", "bafy-b"]
    assert payload["prompt_redaction_policy"] == "hash_only"
    assert payload["nonce"] == "nonce-1"


def test_exact_output_normalization_trims_edges_only() -> None:
    assert normalize_output_text("  Hello   world  ", comparison="exact") == "Hello   world"
    assert normalized_output_hash("x", comparison="exact") == normalized_output_hash(" x ", comparison="exact")


def test_canonical_json_output_normalization_sorts_keys() -> None:
    left = "{\n  \"b\": 2, \"a\": 1\n}"
    right = "{\"a\":1,\"b\":2}"

    assert normalize_output_text(left, comparison="canonical_json") == "{\"a\":1,\"b\":2}"
    assert normalized_output_hash(left, comparison="canonical_json") == normalized_output_hash(
        right,
        comparison="canonical_json",
    )


def test_canonical_json_output_normalization_rejects_invalid_json() -> None:
    with pytest.raises(Exception, match="canonical_json comparison requires valid JSON output"):
        normalize_output_text("not-json", comparison="canonical_json")


def test_normalized_text_output_normalization_collapses_whitespace_and_case() -> None:
    assert normalize_output_text("Hello\n  WORLD", comparison="normalized_text") == "hello world"
    assert normalized_output_hash("Hello WORLD", comparison="normalized_text") == normalized_output_hash(
        " hello   world ",
        comparison="normalized_text",
    )


def test_semantic_output_normalization_is_deterministic_and_advisory() -> None:
    normalized = normalize_output_text("Hello\nWORLD", comparison="semantic")

    assert normalized == "semantic-advisory:hello world"
    assert is_advisory_comparison("semantic") is True
    assert is_advisory_comparison("canonical_json") is False
    assert normalized_output_hash("Hello WORLD", comparison="semantic") == normalized_output_hash(
        " hello   world ",
        comparison="semantic",
    )


def test_output_normalization_rejects_unknown_comparison_mode() -> None:
    with pytest.raises(Exception, match="Unsupported consensus comparison mode"):
        normalize_output_text("hello", comparison="unknown-mode")


def test_select_consensus_result_accepts_quorum_and_rejects_outliers() -> None:
    responses = [
        _sample_response("op-b"),
        _sample_response("op-a"),
        _sample_response(
            "op-c",
            output_text="{\"answer\":\"no\"}",
            output_hash="sha256:no-raw",
            normalized_output_hash="sha256:no-normalized",
        ),
    ]

    result = select_consensus_result(responses, quorum=2, comparison="canonical_json")

    assert result.accepted is True
    assert result.selected_operator_ids == ["op-a", "op-b"]
    assert result.rejected_operator_ids == ["op-c"]
    assert result.total_successful == 3
    assert result.reason == "quorum_met"


def test_select_consensus_result_rejects_failed_and_timeout_responses() -> None:
    responses = [
        _sample_response("op-a"),
        _sample_response("op-b", error="timeout", output_hash="", normalized_output_hash="", output_text=""),
        _sample_response("op-c", error="provider failed", output_hash="", normalized_output_hash="", output_text=""),
    ]

    result = select_consensus_result(
        responses,
        quorum=2,
        comparison="canonical_json",
        fail_closed=False,
    )

    assert result.accepted is False
    assert result.selected_operator_ids == []
    assert result.rejected_operator_ids == ["op-a", "op-b", "op-c"]
    assert result.total_successful == 1
    assert result.reason == "quorum_not_met"


def test_select_consensus_result_fails_closed_on_missing_quorum() -> None:
    responses = [_sample_response("op-a")]

    with pytest.raises(Exception, match="Consensus quorum not met: 1 of 2"):
        select_consensus_result(responses, quorum=2, comparison="canonical_json")


def test_select_consensus_result_fails_closed_on_tie() -> None:
    responses = [
        _sample_response("op-a", normalized_output_hash="sha256:a", output_hash="sha256:a-raw"),
        _sample_response("op-b", normalized_output_hash="sha256:b", output_hash="sha256:b-raw"),
    ]

    with pytest.raises(Exception, match="tied normalized outputs"):
        select_consensus_result(responses, quorum=1, comparison="canonical_json")


def test_select_consensus_result_can_return_tie_without_raising() -> None:
    responses = [
        _sample_response("op-a", normalized_output_hash="sha256:a", output_hash="sha256:a-raw"),
        _sample_response("op-b", normalized_output_hash="sha256:b", output_hash="sha256:b-raw"),
    ]

    result = select_consensus_result(
        responses,
        quorum=1,
        comparison="canonical_json",
        fail_closed=False,
    )

    assert result.accepted is False
    assert result.reason == "tie"
    assert result.rejected_operator_ids == ["op-a", "op-b"]


def test_select_consensus_result_rejects_invalid_quorum() -> None:
    with pytest.raises(Exception, match="quorum must be at least 1"):
        select_consensus_result([], quorum=0, comparison="canonical_json")


def test_select_consensus_result_can_return_invalid_quorum_without_raising() -> None:
    result = select_consensus_result(
        [],
        quorum=0,
        comparison="canonical_json",
        fail_closed=False,
    )

    assert result.accepted is False
    assert result.reason == "invalid_quorum"


def test_run_local_consensus_accepts_callable_operators() -> None:
    request = build_consensus_request(
        prompt="return json",
        comparison="canonical_json",
        quorum=2,
        min_operators=2,
        nonce="nonce-1",
    )
    operators = [
        LocalConsensusOperator("op-b", lambda _: "{\"answer\":\"yes\"}", provider="mock"),
        LocalConsensusOperator("op-a", lambda _: "{\n  \"answer\": \"yes\"\n}", provider="mock"),
    ]

    receipt = run_local_consensus(
        request=request,
        operators=operators,
        created_at="2026-06-13T12:00:00Z",
    )

    assert receipt.consensus.accepted is True
    assert receipt.consensus.selected_operator_ids == ["op-a", "op-b"]
    assert receipt.consensus.reason == "quorum_met"
    assert json.loads(receipt.text) == {"answer": "yes"}
    assert receipt.proof.policy == "receipt_only"
    assert receipt.created_at == "2026-06-13T12:00:00Z"


def test_run_local_consensus_records_errors_and_returns_failure_when_not_fail_closed() -> None:
    request = build_consensus_request(
        prompt="return json",
        comparison="canonical_json",
        quorum=2,
        min_operators=2,
        nonce="nonce-1",
    )

    def _raise(_: ConsensusRequest) -> str:
        raise RuntimeError("provider unavailable")

    receipt = run_local_consensus(
        request=request,
        operators=[
            LocalConsensusOperator("op-a", lambda _: "{\"answer\":\"yes\"}", provider="mock"),
            LocalConsensusOperator("op-b", _raise, provider="mock"),
        ],
        fail_closed=False,
    )

    assert receipt.consensus.accepted is False
    assert receipt.consensus.reason == "quorum_not_met"
    assert receipt.text == ""
    errors = {response.operator_id: response.error for response in receipt.responses}
    assert errors["op-b"].startswith("RuntimeError: provider unavailable")


def test_run_local_consensus_fails_closed_on_missing_quorum() -> None:
    request = build_consensus_request(
        prompt="return json",
        comparison="canonical_json",
        quorum=2,
        min_operators=2,
        nonce="nonce-1",
    )

    with pytest.raises(Exception, match="Consensus quorum not met"):
        run_local_consensus(
            request=request,
            operators=[
                LocalConsensusOperator("op-a", lambda _: "{\"answer\":\"yes\"}", provider="mock"),
                LocalConsensusOperator("op-b", lambda _: "not-json", provider="mock"),
            ],
        )


def test_run_local_consensus_applies_operator_timeout_from_latency() -> None:
    request = _sample_request(quorum=2, comparison="canonical_json")
    receipt = run_local_consensus(
        request=request,
        operators=[
            _MockConsensusOperator("op-a"),
            _MockConsensusOperator("op-slow", latency_ms=1500),
        ],
        operator_timeout_s=1.0,
        fail_closed=False,
    )

    assert receipt.consensus.accepted is False
    assert receipt.consensus.reason == "quorum_not_met"
    errors = {response.operator_id: response.error for response in receipt.responses}
    assert errors["op-slow"] == "timeout"


def test_run_local_consensus_applies_overall_timeout() -> None:
    request = _sample_request(quorum=2, comparison="canonical_json")

    def _sleep(_: ConsensusRequest) -> str:
        time.sleep(0.2)
        return "{\"answer\":\"late\"}"

    receipt = run_local_consensus(
        request=request,
        operators=[
            _MockConsensusOperator("op-a"),
            LocalConsensusOperator("op-slow", _sleep, provider="mock"),
        ],
        timeout_s=0.01,
        fail_closed=False,
    )

    assert receipt.consensus.accepted is False
    assert receipt.consensus.reason == "quorum_not_met"
    errors = {response.operator_id: response.error for response in receipt.responses}
    assert errors["op-slow"] == "timeout"


def test_run_local_consensus_requires_operators() -> None:
    with pytest.raises(Exception, match="At least one consensus operator is required"):
        run_local_consensus(request=_sample_request(), operators=[])


def test_receipt_persistence_record_includes_content_hash() -> None:
    receipt = _sample_receipt()

    record = receipt_persistence_record(receipt)

    assert record["schema_version"] == "llm-router-consensus-persistence-record-v1"
    assert record["receipt_hash"] == receipt_content_hash(receipt)
    assert record["receipt"]["schema_version"] == CONSENSUS_RECEIPT_SCHEMA_VERSION
    assert record["persisted_at"].endswith("Z")


def test_persist_consensus_receipt_writes_json(tmp_path) -> None:
    receipt = _sample_receipt()
    path = tmp_path / "receipt.json"

    record = persist_consensus_receipt(receipt, path=path)
    persisted = json.loads(path.read_text(encoding="utf-8"))

    assert persisted["receipt_hash"] == record["receipt_hash"]
    assert persisted["receipt"]["request"]["request_id"] == "req-1"
    assert persisted["receipt"]["text"] == "{\"answer\":\"yes\"}"


def test_persist_consensus_receipt_appends_jsonl(tmp_path) -> None:
    path = tmp_path / "receipts.jsonl"

    first = _sample_receipt()
    second = ConsensusReceipt.from_dict({**_sample_receipt().to_dict(), "created_at": "2026-06-13T12:00:01Z"})
    persist_consensus_receipt(first, path=path)
    persist_consensus_receipt(second, path=path)

    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 2
    assert rows[0]["receipt_hash"] == receipt_content_hash(first)
    assert rows[1]["receipt_hash"] == receipt_content_hash(second)


def test_run_local_consensus_can_persist_json_and_jsonl(tmp_path) -> None:
    request = build_consensus_request(
        prompt="private prompt",
        comparison="canonical_json",
        quorum=1,
        min_operators=1,
        nonce="nonce-1",
    )
    json_path = tmp_path / "receipt.json"
    jsonl_path = tmp_path / "receipts.jsonl"

    receipt = run_local_consensus(
        request=request,
        operators=[LocalConsensusOperator("op-a", lambda _: "{\"answer\":\"yes\"}")],
        receipt_path=json_path,
        receipt_jsonl_path=jsonl_path,
    )

    assert json.loads(json_path.read_text(encoding="utf-8"))["receipt_hash"] == receipt_content_hash(receipt)
    rows = jsonl_path.read_text(encoding="utf-8").splitlines()
    assert len(rows) == 1
    assert json.loads(rows[0])["receipt_hash"] == receipt_content_hash(receipt)


def test_persisted_receipt_does_not_contain_raw_prompt_or_secret_fields(tmp_path) -> None:
    request = build_consensus_request(
        prompt="raw prompt should not persist",
        generation_params={"api_key": "secret-api-key", "temperature": 0},
        proof_policy={"mode": "receipt_only", "private_key": "secret-key"},
        metadata={"token": "secret-token", "purpose": "test"},
        comparison="canonical_json",
        quorum=1,
        min_operators=1,
        nonce="nonce-1",
    )
    path = tmp_path / "receipt.json"

    run_local_consensus(
        request=request,
        operators=[LocalConsensusOperator("op-a", lambda _: "{\"answer\":\"yes\"}")],
        receipt_path=path,
    )
    rendered = path.read_text(encoding="utf-8")

    assert "raw prompt should not persist" not in rendered
    assert "secret-api-key" not in rendered
    assert "secret-key" not in rendered
    assert "secret-token" not in rendered


def test_consensus_health_summary_reports_readiness_fields_without_prompt_or_output_content() -> None:
    raw_prompt = "caller says private housing eligibility details"
    output_text = "{\"answer\":\"sensitive route recommendation\"}"
    workflow_id = "wf-sensitive-eligibility-v1"
    request = build_consensus_request(
        prompt=raw_prompt,
        comparison="canonical_json",
        quorum=2,
        min_operators=2,
        proof_policy={"mode": "chainlink_cre", "cre_workflow_id": workflow_id},
        metadata={"cre_workflow_id": workflow_id, "purpose": "readiness-test"},
        nonce="nonce-1",
    )
    receipt = ConsensusReceipt(
        request=request,
        responses=[
            _sample_response("op-a", output_text=output_text),
            _sample_response("op-b", output_text=output_text, signature="sig-b"),
        ],
        consensus=ConsensusResult(
            accepted=True,
            selected_output_hash="sha256:raw",
            selected_normalized_hash="sha256:normalized",
            selected_operator_ids=["op-a", "op-b"],
            quorum=2,
            total_successful=2,
            comparison="canonical_json",
            reason="quorum_met",
        ),
        proof=ProofReceipt(
            policy="chainlink_cre",
            verified=True,
            verifier="chainlink-cre-bridge-v1",
            cre_workflow_id=workflow_id,
        ),
        text=output_text,
        created_at="2026-06-13T12:00:00Z",
    )

    summary = consensus_health_summary(
        {
            "mode": "chainlink_cre",
            "comparison": "canonical_json",
            "quorum": 2,
            "min_operators": 2,
            "cre_workflow_id": workflow_id,
            "verifier_contract": "0xVerifier",
        },
        receipts=[receipt],
        proof_policy={"mode": "chainlink_cre", "verifier": "chainlink-cre-bridge-v1", "cre_verified": True},
    )

    assert summary["schema_version"] == "llm-consensus-health-summary-v1"
    assert summary["status"] == "ready"
    assert summary["configured_mode"] == "chainlink_cre"
    assert summary["quorum"] == 2
    assert summary["operator_count"] == 2
    assert summary["cre_workflow_id_present"] is True
    assert summary["proof_verifier_policy"] == {
        "mode": "chainlink_cre",
        "requires_verifier": False,
        "verifier_present": True,
        "verifier_contract_present": True,
        "cre_workflow_required": True,
        "require_signatures": False,
    }
    assert summary["last_failure_reason"] is None
    assert summary["redacted_receipt_counts"]["receipt_count"] == 1
    assert summary["redacted_receipt_counts"]["accepted_receipt_count"] == 1
    assert summary["redacted_receipt_counts"]["operator_response_count"] == 2
    assert summary["redacted_receipt_counts"]["cre_receipt_count"] == 1

    rendered = json.dumps(summary, sort_keys=True)
    assert raw_prompt not in rendered
    assert output_text not in rendered
    assert workflow_id not in rendered
    assert "request_hash" not in rendered
    assert "prompt_hash" not in rendered


def test_consensus_health_summary_reports_redacted_counts_and_failure_reason() -> None:
    raw_prompt = "private prompt must not appear in health"
    failed_receipt = ConsensusReceipt(
        request=_sample_request(quorum=2, min_operators=2),
        responses=[
            _sample_response("op-a"),
            _sample_response(
                "op-b",
                output_text="",
                output_hash="",
                normalized_output_hash="",
                error=f"provider failed for {raw_prompt}",
            ),
        ],
        consensus=ConsensusResult(
            accepted=False,
            selected_output_hash="",
            selected_normalized_hash="",
            selected_operator_ids=[],
            rejected_operator_ids=["op-a", "op-b"],
            quorum=2,
            total_successful=1,
            comparison="canonical_json",
            reason="quorum_not_met",
        ),
        proof=ProofReceipt(policy="receipt_only", verified=False),
        text="",
        created_at="2026-06-13T12:00:00Z",
    )

    counts = consensus_receipt_counts([failed_receipt])
    assert counts["receipt_count"] == 1
    assert counts["failed_receipt_count"] == 1
    assert counts["quorum_not_met_receipt_count"] == 1
    assert counts["successful_operator_response_count"] == 1
    assert counts["failed_operator_response_count"] == 1

    summary = consensus_health_summary(
        {"mode": "local_quorum", "quorum": 2, "min_operators": 2},
        receipts=[failed_receipt],
    )

    assert summary["status"] == "ready"
    assert summary["last_failure_reason"] == "quorum_not_met"
    rendered = json.dumps(summary, sort_keys=True)
    assert raw_prompt not in rendered
    assert "provider failed" not in rendered

    explicit_summary = consensus_health_summary(
        {"mode": "local_quorum", "quorum": 1, "min_operators": 1},
        last_failure_reason=f"provider failed for prompt: {raw_prompt}",
    )

    assert explicit_summary["last_failure_reason"] == "redacted_failure"
    assert raw_prompt not in json.dumps(explicit_summary, sort_keys=True)


def test_consensus_health_summary_counts_configured_peers_and_verifier_env() -> None:
    summary = consensus_health_summary(
        env={
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_MODE": "libp2p_quorum",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_QUORUM": "2",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_MIN_OPERATORS": "3",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_PEERS": "peer-a,peer-b,peer-c",
            "IPFS_ACCELERATE_PY_CHAINLINK_CRE_WORKFLOW_ID": "wf-env-secret",
            "IPFS_ACCELERATE_PY_LLM_PROOF_VERIFIER": "zkml-verifier-v1",
        },
        proof_policy={"mode": "zkml_required"},
    )

    assert summary["configured_mode"] == "libp2p_quorum"
    assert summary["operator_count"] == 3
    assert summary["cre_workflow_id_present"] is True
    assert summary["proof_verifier_policy"]["mode"] == "zkml_required"
    assert summary["proof_verifier_policy"]["requires_verifier"] is True
    assert summary["proof_verifier_policy"]["verifier_present"] is True
    assert summary["status"] == "ready"
    assert "wf-env-secret" not in json.dumps(summary, sort_keys=True)


def test_operator_signature_payload_binds_request_and_output() -> None:
    request = build_consensus_request(
        prompt="prompt",
        comparison="canonical_json",
        quorum=1,
        min_operators=1,
        nonce="nonce-1",
    )
    response = _sample_response("op-a")

    payload = operator_signature_payload(request, response)

    assert payload["domain_separator"] == "ipfs-accelerate-llm-consensus-v1"
    assert payload["nonce"] == "nonce-1"
    assert payload["request_hash"] == request.request_hash
    assert payload["operator_id"] == "op-a"
    assert payload["output_hash"] == response.output_hash
    assert payload["normalized_output_hash"] == response.normalized_output_hash


def test_sign_and_verify_operator_response_signature() -> None:
    request = build_consensus_request(prompt="prompt", nonce="nonce-1")
    response = _sample_response("op-a", signature=None)

    signed = sign_operator_response(request, response, signing_key="secret", key_id="key-a")

    assert signed.signature.startswith("hmac-sha256:key-a:")
    assert signed.metadata["signature_key_id"] == "key-a"
    assert verify_operator_response_signature(request, signed, key_lookup={"key-a": "secret"}) is True


def test_operator_signature_rejects_tampered_output_or_request() -> None:
    request = build_consensus_request(prompt="prompt", nonce="nonce-1")
    other_request = build_consensus_request(prompt="prompt", nonce="nonce-2")
    response = _sample_response("op-a", signature=None)
    signed = sign_operator_response(request, response, signing_key="secret", key_id="key-a")
    tampered = OperatorResponse.from_dict({**signed.to_dict(), "output_hash": "sha256:tampered"})

    assert verify_operator_response_signature(other_request, signed, key_lookup={"key-a": "secret"}) is False
    assert verify_operator_response_signature(request, tampered, key_lookup={"key-a": "secret"}) is False


def test_operator_signature_rejects_unknown_key() -> None:
    request = build_consensus_request(prompt="prompt", nonce="nonce-1")
    response = sign_operator_response(request, _sample_response("op-a", signature=None), signing_key="secret", key_id="key-a")

    assert verify_operator_response_signature(request, response, key_lookup={"key-b": "secret"}) is False


def test_unsigned_operator_allowed_only_for_receipt_only_development_policy() -> None:
    receipt_only_request = build_consensus_request(prompt="prompt", proof_policy={"mode": "receipt_only"})
    zk_request = build_consensus_request(prompt="prompt", proof_policy={"mode": "zkml_required"})
    response = _sample_response("op-a", signature=None)

    assert verify_operator_response_signature(receipt_only_request, response, key_lookup={}) is True
    assert verify_operator_response_signature(zk_request, response, key_lookup={}) is False
    assert (
        verify_operator_response_signature(
            receipt_only_request,
            response,
            key_lookup={},
            allow_unsigned_receipt_only=False,
        )
        is False
    )


def test_mock_operators_can_construct_agreeing_responses() -> None:
    request = _sample_request()
    operators = [_MockConsensusOperator("op-a"), _MockConsensusOperator("op-b")]

    responses = [operator.respond(request) for operator in operators]

    assert [response.error for response in responses] == [None, None]
    assert {response.normalized_output_hash for response in responses} == {"sha256:normalized"}
    assert responses[0].metadata["request_id"] == "req-1"


def test_mock_operators_can_construct_disagreeing_responses() -> None:
    request = _sample_request()
    operators = [
        _MockConsensusOperator("op-a"),
        _MockConsensusOperator(
            "op-b",
            output_text="{\"answer\":\"no\"}",
            output_hash="sha256:no-raw",
            normalized_output_hash="sha256:no-normalized",
        ),
    ]

    responses = [operator.respond(request) for operator in operators]

    assert {response.normalized_output_hash for response in responses} == {
        "sha256:normalized",
        "sha256:no-normalized",
    }


def test_mock_operators_can_construct_failing_and_slow_responses() -> None:
    request = _sample_request()
    failing = _MockConsensusOperator("op-fail", error="provider unavailable")
    slow = _MockConsensusOperator("op-slow", latency_ms=1500)

    failed = failing.respond(request)
    delayed = slow.respond(request)

    assert failed.error == "provider unavailable"
    assert failed.output_text == ""
    assert delayed.error is None
    assert delayed.latency_ms == 1500


def test_mock_operator_can_construct_equivocal_responses() -> None:
    request = _sample_request()
    operator = _MockConsensusOperator("op-a", equivocate_after=1)

    first = operator.respond(request)
    second = operator.respond(request)

    assert first.operator_id == second.operator_id
    assert first.normalized_output_hash == "sha256:normalized"
    assert second.normalized_output_hash == "sha256:changed-normalized"
    assert second.metadata["call"] == 2
