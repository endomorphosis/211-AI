"""Unit tests for ipfs_accelerate_py.proof_verifiers.

Covers all four verifier classes with scenarios for:
- valid proof metadata (happy path)
- missing required fields
- mismatched binding fields (request hash, output hash, model commitment)
- replayed proof metadata (nonce / CRE round replay)
"""

from __future__ import annotations

import hashlib

import pytest

from ipfs_accelerate_py.proof_verifiers import (
    ChainlinkCREVerifier,
    ProofContext,
    ReceiptOnlyVerifier,
    TEEVerifier,
    VerificationResult,
    ZKMLVerifier,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ctx(
    request_hash: str = "sha256:req-abc",
    output_hash: str = "sha256:out-xyz",
    model_commitment: str = "sha256:model-v1",
    nonce: str = "nonce-unique-1",
    tokenizer_commitment: str = "sha256:tokenizer-v1",
    circuit_commitment: str = "sha256:circuit-v1",
    input_commitment: str = "sha256:input-abc",
    output_commitment: str = "sha256:output-xyz",
    public_inputs_hash: str = "sha256:pub-inputs",
    verifier_key_hash: str = "vk:sha256:pinned-key",
    circuit_version: str = "1.0.0",
    proof_cid: str = "",
    proof_bytes_hash: str = "",
) -> ProofContext:
    return ProofContext(
        request_hash=request_hash,
        output_hash=output_hash,
        model_commitment=model_commitment,
        nonce=nonce,
        tokenizer_commitment=tokenizer_commitment,
        circuit_commitment=circuit_commitment,
        input_commitment=input_commitment,
        output_commitment=output_commitment,
        public_inputs_hash=public_inputs_hash,
        verifier_key_hash=verifier_key_hash,
        circuit_version=circuit_version,
        proof_cid=proof_cid,
        proof_bytes_hash=proof_bytes_hash,
    )


def _receipt_meta(
    request_hash: str = "sha256:req-abc",
    output_hash: str = "sha256:out-xyz",
    nonce: str = "nonce-unique-1",
) -> dict:
    return {
        "request_hash": request_hash,
        "output_hash": output_hash,
        "nonce": nonce,
    }


def _tee_meta(
    request_hash: str = "sha256:req-abc",
    output_hash: str = "sha256:out-xyz",
    model_commitment: str = "sha256:model-v1",
    tee_measurement: str = "pcr0:aabbcc",
    tee_signer: str = "cert:tee-signer-pub",
    tee_nonce: str = "nonce-unique-1",
    tee_expiry_unix_ms: int = 9_999_999_999_000,
    tee_policy_mode: str = "tee_or_zkml",
    nonce: str | None = None,
) -> dict:
    meta = {
        "request_hash": request_hash,
        "output_hash": output_hash,
        "model_commitment": model_commitment,
        "tee_measurement": tee_measurement,
        "tee_signer": tee_signer,
        "tee_nonce": tee_nonce,
        "tee_expiry_unix_ms": tee_expiry_unix_ms,
    }
    if tee_policy_mode:
        meta["tee_policy_mode"] = tee_policy_mode
    if nonce is not None:
        meta["nonce"] = nonce
    return meta


def _tee_verifier(
    *,
    now_unix_ms: int = 1_000_000,
    tee_measurement_allowlist: tuple[str, ...] = ("pcr0:aabbcc",),
    tee_signer_allowlist: tuple[str, ...] = ("cert:tee-signer-pub",),
    expected_policy_mode: str | None = "tee_or_zkml",
) -> TEEVerifier:
    return TEEVerifier(
        now_unix_ms=now_unix_ms,
        tee_measurement_allowlist=tee_measurement_allowlist,
        tee_signer_allowlist=tee_signer_allowlist,
        expected_policy_mode=expected_policy_mode,
    )


def _zkml_verifier() -> ZKMLVerifier:
    return ZKMLVerifier(
        expected_verifier_key_hash="vk:sha256:pinned-key",
        expected_circuit_id="circuit-llm-checker-v1",
        expected_circuit_version="1.0.0",
    )


def _proof_bytes_hash(proof_bytes: str = "0xdeadbeef") -> str:
    return "sha256:" + hashlib.sha256(proof_bytes.encode("utf-8")).hexdigest()


def _zkml_meta(
    request_hash: str = "sha256:req-abc",
    output_hash: str = "sha256:out-xyz",
    model_commitment: str = "sha256:model-v1",
    tokenizer_commitment: str = "sha256:tokenizer-v1",
    circuit_commitment: str = "sha256:circuit-v1",
    input_commitment: str = "sha256:input-abc",
    output_commitment: str = "sha256:output-xyz",
    verifier_key_hash: str = "vk:sha256:pinned-key",
    circuit_id: str = "circuit-llm-checker-v1",
    circuit_version: str = "1.0.0",
    public_inputs_hash: str = "sha256:pub-inputs",
    proof_bytes: str = "0xdeadbeef",
    nonce: str = "nonce-unique-1",
) -> dict:
    return {
        "request_hash": request_hash,
        "output_hash": output_hash,
        "model_commitment": model_commitment,
        "tokenizer_commitment": tokenizer_commitment,
        "circuit_commitment": circuit_commitment,
        "input_commitment": input_commitment,
        "output_commitment": output_commitment,
        "verifier_key_hash": verifier_key_hash,
        "circuit_id": circuit_id,
        "circuit_version": circuit_version,
        "public_inputs_hash": public_inputs_hash,
        "proof_bytes": proof_bytes,
        "nonce": nonce,
    }


def _cre_verifier() -> ChainlinkCREVerifier:
    return ChainlinkCREVerifier(
        expected_workflow_id="wf-llm-router-v1",
        expected_don_id="don-42",
    )


def _cre_meta(
    request_hash: str = "sha256:req-abc",
    output_hash: str = "sha256:out-xyz",
    cre_workflow_id: str = "wf-llm-router-v1",
    cre_don_id: str = "don-42",
    cre_round: int = 1,
    cre_report_hash: str = "sha256:cre-report",
    nonce: str = "nonce-unique-1",
) -> dict:
    return {
        "request_hash": request_hash,
        "output_hash": output_hash,
        "cre_workflow_id": cre_workflow_id,
        "cre_don_id": cre_don_id,
        "cre_round": cre_round,
        "cre_report_hash": cre_report_hash,
        "nonce": nonce,
    }


# ===========================================================================
# ReceiptOnlyVerifier
# ===========================================================================

class TestReceiptOnlyVerifier:
    def test_valid_metadata_returns_verified(self) -> None:
        verifier = ReceiptOnlyVerifier()
        result = verifier.verify(_receipt_meta(), _ctx())
        assert result.verified is True
        assert result.verifier == "receipt-only-v1"
        assert result.reason == "receipt_binding_verified"

    def test_missing_proof_request_hash_fails(self) -> None:
        verifier = ReceiptOnlyVerifier()
        meta = _receipt_meta()
        del meta["request_hash"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "request_hash" in result.reason

    def test_missing_proof_output_hash_fails(self) -> None:
        verifier = ReceiptOnlyVerifier()
        meta = _receipt_meta()
        del meta["output_hash"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "output_hash" in result.reason

    def test_mismatched_request_hash_fails(self) -> None:
        verifier = ReceiptOnlyVerifier()
        meta = _receipt_meta(request_hash="sha256:wrong-req")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "request_hash_mismatch"

    def test_mismatched_output_hash_fails(self) -> None:
        verifier = ReceiptOnlyVerifier()
        meta = _receipt_meta(output_hash="sha256:wrong-out")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "output_hash_mismatch"

    def test_replayed_nonce_fails(self) -> None:
        verifier = ReceiptOnlyVerifier()
        meta = _receipt_meta(nonce="reused-nonce")
        ctx = _ctx(nonce="reused-nonce")
        first = verifier.verify(meta, ctx)
        assert first.verified is True
        # Second attempt with same nonce must fail
        second = verifier.verify(_receipt_meta(nonce="reused-nonce"), _ctx(nonce="reused-nonce"))
        assert second.verified is False
        assert second.reason == "replayed_nonce"

    def test_different_nonces_each_accepted(self) -> None:
        verifier = ReceiptOnlyVerifier()
        for i in range(3):
            nonce = f"unique-nonce-{i}"
            result = verifier.verify(_receipt_meta(nonce=nonce), _ctx(nonce=nonce))
            assert result.verified is True, f"Expected verified for nonce {nonce}"

    def test_empty_proof_meta_fails(self) -> None:
        verifier = ReceiptOnlyVerifier()
        result = verifier.verify({}, _ctx())
        assert result.verified is False

    def test_result_is_verification_result_instance(self) -> None:
        verifier = ReceiptOnlyVerifier()
        result = verifier.verify(_receipt_meta(), _ctx())
        assert isinstance(result, VerificationResult)


# ===========================================================================
# TEEVerifier
# ===========================================================================

class TestTEEVerifier:
    def test_valid_metadata_returns_verified(self) -> None:
        verifier = _tee_verifier()
        result = verifier.verify(_tee_meta(), _ctx())
        assert result.verified is True
        assert result.verifier == "tee-verifier-v1"
        assert result.reason == "tee_attestation_verified"

    def test_missing_proof_request_hash_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta()
        del meta["request_hash"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "request_hash" in result.reason

    def test_missing_proof_output_hash_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta()
        del meta["output_hash"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "output_hash" in result.reason

    def test_missing_model_commitment_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta()
        del meta["model_commitment"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "model_commitment" in result.reason

    def test_mismatched_request_hash_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta(request_hash="sha256:wrong")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "request_hash_mismatch"

    def test_mismatched_output_hash_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta(output_hash="sha256:wrong")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "output_hash_mismatch"

    def test_mismatched_model_commitment_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta(model_commitment="sha256:wrong-model")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "model_commitment_mismatch"

    def test_missing_tee_measurement_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta()
        meta["tee_measurement"] = ""
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "tee_measurement" in result.reason

    def test_missing_tee_signer_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta()
        del meta["tee_signer"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "tee_signer" in result.reason

    def test_missing_tee_nonce_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta()
        del meta["tee_nonce"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "tee_nonce" in result.reason

    def test_tee_nonce_must_match_context_nonce(self) -> None:
        verifier = _tee_verifier()
        result = verifier.verify(
            _tee_meta(tee_nonce="tee-nonce-1"),
            _ctx(nonce="ctx-nonce-1"),
        )
        assert result.verified is False
        assert result.reason == "tee_nonce_mismatch"

    def test_optional_top_level_nonce_must_match_tee_nonce(self) -> None:
        verifier = _tee_verifier()
        result = verifier.verify(
            _tee_meta(tee_nonce="tee-nonce-1", nonce="different-nonce"),
            _ctx(nonce="tee-nonce-1"),
        )
        assert result.verified is False
        assert result.reason == "nonce_mismatch"

    def test_expired_attestation_fails(self) -> None:
        verifier = _tee_verifier(now_unix_ms=10_000_000_000_000)
        meta = _tee_meta(tee_expiry_unix_ms=1_000)
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "tee_attestation_expired"

    def test_missing_measurement_allowlist_fails_closed(self) -> None:
        verifier = TEEVerifier(
            now_unix_ms=1_000_000,
            tee_signer_allowlist=("cert:tee-signer-pub",),
        )
        result = verifier.verify(_tee_meta(), _ctx())
        assert result.verified is False
        assert result.reason == "tee_measurement_allowlist_missing"

    def test_measurement_outside_allowlist_fails(self) -> None:
        verifier = _tee_verifier()
        result = verifier.verify(_tee_meta(tee_measurement="pcr0:unknown"), _ctx())
        assert result.verified is False
        assert result.reason == "tee_measurement_not_allowed"

    def test_missing_signer_allowlist_fails_closed(self) -> None:
        verifier = TEEVerifier(
            now_unix_ms=1_000_000,
            tee_measurement_allowlist=("pcr0:aabbcc",),
        )
        result = verifier.verify(_tee_meta(), _ctx())
        assert result.verified is False
        assert result.reason == "tee_signer_allowlist_missing"

    def test_signer_outside_allowlist_fails(self) -> None:
        verifier = _tee_verifier()
        result = verifier.verify(_tee_meta(tee_signer="cert:unknown-signer"), _ctx())
        assert result.verified is False
        assert result.reason == "tee_signer_not_allowed"

    def test_metadata_allowlists_can_supply_policy(self) -> None:
        verifier = TEEVerifier(now_unix_ms=1_000_000)
        meta = _tee_meta()
        meta["proof_policy"] = {
            "mode": "tee_or_zkml",
            "tee_measurement_allowlist": ["pcr0:aabbcc"],
            "tee_signer_allowlist": ["cert:tee-signer-pub"],
        }
        result = verifier.verify(meta, _ctx())
        assert result.verified is True

    def test_missing_policy_mode_fails(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta()
        del meta["tee_policy_mode"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "tee_policy_mode_missing"

    def test_disallowed_policy_mode_fails(self) -> None:
        verifier = _tee_verifier()
        result = verifier.verify(_tee_meta(tee_policy_mode="receipt_only"), _ctx())
        assert result.verified is False
        assert result.reason == "tee_policy_mode_not_allowed"

    def test_policy_mode_can_come_from_nested_proof_policy(self) -> None:
        verifier = _tee_verifier()
        meta = _tee_meta()
        del meta["tee_policy_mode"]
        meta["proof_policy"] = {"mode": "tee_or_zkml"}
        result = verifier.verify(meta, _ctx())
        assert result.verified is True

    def test_replayed_tee_nonce_fails(self) -> None:
        verifier = _tee_verifier()
        meta1 = _tee_meta(tee_nonce="tee-nonce-1")
        meta2 = _tee_meta(tee_nonce="tee-nonce-1")
        ctx1 = _ctx(nonce="tee-nonce-1")
        ctx2 = _ctx(nonce="tee-nonce-1")
        first = verifier.verify(meta1, ctx1)
        assert first.verified is True
        second = verifier.verify(meta2, ctx2)
        assert second.verified is False
        assert second.reason == "replayed_nonce"

    def test_empty_proof_meta_fails(self) -> None:
        verifier = _tee_verifier()
        result = verifier.verify({}, _ctx())
        assert result.verified is False

    def test_result_metadata_includes_measurement_and_signer(self) -> None:
        verifier = _tee_verifier()
        result = verifier.verify(_tee_meta(), _ctx())
        assert result.metadata["tee_measurement"] == "pcr0:aabbcc"
        assert result.metadata["tee_signer"] == "cert:tee-signer-pub"
        assert result.metadata["evidence_type"] == "tee_attestation"
        assert result.metadata["proof_type"] == "tee_attestation"
        assert result.metadata["zkml_proof"] is False
        assert result.metadata["tee_policy_mode"] == "tee_or_zkml"


# ===========================================================================
# ZKMLVerifier
# ===========================================================================

class TestZKMLVerifier:
    def test_valid_metadata_returns_verified(self) -> None:
        verifier = _zkml_verifier()
        result = verifier.verify(_zkml_meta(), _ctx())
        assert result.verified is True
        assert result.verifier == "zkml-verifier-v1"
        assert result.reason == "zkml_proof_verified"

    def test_missing_proof_request_hash_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["request_hash"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "request_hash" in result.reason

    def test_missing_proof_output_hash_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["output_hash"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "output_hash" in result.reason

    def test_missing_model_commitment_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["model_commitment"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "model_commitment" in result.reason

    def test_mismatched_request_hash_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(request_hash="sha256:wrong")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "request_hash_mismatch"

    def test_mismatched_output_hash_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(output_hash="sha256:wrong")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "output_hash_mismatch"

    def test_mismatched_model_commitment_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(model_commitment="sha256:wrong-model")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "model_commitment_mismatch"

    def test_missing_tokenizer_commitment_fails_when_context_requires_it(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["tokenizer_commitment"]
        result = verifier.verify(meta, _ctx(circuit_commitment=""))
        assert result.verified is False
        assert result.reason == "tokenizer_commitment_missing"

    def test_circuit_commitment_can_bind_without_tokenizer_commitment(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(tokenizer_commitment="")
        del meta["tokenizer_commitment"]
        result = verifier.verify(meta, _ctx(tokenizer_commitment=""))
        assert result.verified is True

    def test_missing_tokenizer_or_circuit_context_fails_closed(self) -> None:
        verifier = _zkml_verifier()
        result = verifier.verify(
            _zkml_meta(),
            _ctx(tokenizer_commitment="", circuit_commitment=""),
        )
        assert result.verified is False
        assert result.reason == "context_tokenizer_or_circuit_commitment_missing"

    def test_mismatched_circuit_commitment_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(circuit_commitment="sha256:wrong-circuit")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "circuit_commitment_mismatch"

    def test_missing_input_commitment_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["input_commitment"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "input_commitment_missing"

    def test_mismatched_input_commitment_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(input_commitment="sha256:wrong-input")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "input_commitment_mismatch"

    def test_missing_output_commitment_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["output_commitment"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "output_commitment_missing"

    def test_mismatched_output_commitment_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(output_commitment="sha256:wrong-output")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "output_commitment_mismatch"

    def test_missing_verifier_key_hash_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["verifier_key_hash"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "verifier_key_hash_missing"

    def test_mismatched_verifier_key_hash_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(verifier_key_hash="vk:sha256:unknown-key")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "verifier_key_hash_mismatch"

    def test_missing_circuit_id_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["circuit_id"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "circuit_id_missing"

    def test_mismatched_circuit_id_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(circuit_id="circuit-unknown")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "circuit_id_mismatch"

    def test_missing_circuit_version_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["circuit_version"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "circuit_version_missing"

    def test_mismatched_circuit_version_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(circuit_version="9.9.9")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "circuit_version_mismatch"

    def test_context_circuit_version_mismatch_fails(self) -> None:
        verifier = _zkml_verifier()
        result = verifier.verify(_zkml_meta(), _ctx(circuit_version="1.0.1"))
        assert result.verified is False
        assert result.reason == "circuit_version_mismatch"

    def test_missing_public_inputs_hash_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        meta["public_inputs_hash"] = ""
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "public_inputs_hash_missing"

    def test_context_public_inputs_hash_missing_fails(self) -> None:
        verifier = _zkml_verifier()
        result = verifier.verify(_zkml_meta(), _ctx(public_inputs_hash=""))
        assert result.verified is False
        assert result.reason == "context_public_inputs_hash_missing"

    def test_mismatched_public_inputs_hash_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(public_inputs_hash="sha256:wrong-public-inputs")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "public_inputs_hash_mismatch"

    def test_missing_proof_data_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        meta.pop("proof_bytes", None)
        meta.pop("proof_cid", None)
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "proof_data_missing"

    def test_proof_cid_accepted_instead_of_proof_bytes(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["proof_bytes"]
        meta["proof_cid"] = "bafy-proof-cid"
        result = verifier.verify(meta, _ctx(proof_cid="bafy-proof-cid"))
        assert result.verified is True

    def test_bound_proof_bytes_hash_mismatch_fails(self) -> None:
        verifier = _zkml_verifier()
        result = verifier.verify(
            _zkml_meta(proof_bytes="0xdeadbeef"),
            _ctx(proof_bytes_hash=_proof_bytes_hash("0xother-proof")),
        )
        assert result.verified is False
        assert result.reason == "proof_bytes_hash_mismatch"

    def test_bound_proof_bytes_hash_is_accepted(self) -> None:
        verifier = _zkml_verifier()
        result = verifier.verify(
            _zkml_meta(proof_bytes="0xdeadbeef"),
            _ctx(proof_bytes_hash=_proof_bytes_hash("0xdeadbeef")),
        )
        assert result.verified is True

    def test_bound_proof_bytes_hash_accepts_metadata_that_also_has_cid(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta(proof_bytes="0xdeadbeef")
        meta["proof_cid"] = "bafy-proof-cid"
        result = verifier.verify(
            meta,
            _ctx(proof_bytes_hash=_proof_bytes_hash("0xdeadbeef")),
        )
        assert result.verified is True

    def test_bound_proof_cid_mismatch_fails(self) -> None:
        verifier = _zkml_verifier()
        meta = _zkml_meta()
        del meta["proof_bytes"]
        meta["proof_cid"] = "bafy-proof-cid"
        result = verifier.verify(meta, _ctx(proof_cid="bafy-other-proof"))
        assert result.verified is False
        assert result.reason == "proof_cid_mismatch"

    def test_replayed_nonce_fails(self) -> None:
        verifier = _zkml_verifier()
        meta1 = _zkml_meta(nonce="nonce-zkml-1")
        meta2 = _zkml_meta(nonce="nonce-zkml-1")
        ctx1 = _ctx(nonce="nonce-zkml-1")
        ctx2 = _ctx(nonce="nonce-zkml-1")
        first = verifier.verify(meta1, ctx1)
        assert first.verified is True
        second = verifier.verify(meta2, ctx2)
        assert second.verified is False
        assert second.reason == "replayed_nonce"

    def test_same_proof_replayed_across_requests_fails(self) -> None:
        verifier = _zkml_verifier()
        first = verifier.verify(
            _zkml_meta(request_hash="sha256:req-a", nonce="nonce-zkml-a"),
            _ctx(request_hash="sha256:req-a", nonce="nonce-zkml-a"),
        )
        assert first.verified is True

        replay = verifier.verify(
            _zkml_meta(request_hash="sha256:req-b", nonce="nonce-zkml-b"),
            _ctx(request_hash="sha256:req-b", nonce="nonce-zkml-b"),
        )
        assert replay.verified is False
        assert replay.reason == "proof_replayed_for_different_request"

    def test_empty_proof_meta_fails(self) -> None:
        verifier = _zkml_verifier()
        result = verifier.verify({}, _ctx())
        assert result.verified is False

    def test_result_metadata_includes_circuit_and_inputs(self) -> None:
        verifier = _zkml_verifier()
        result = verifier.verify(_zkml_meta(), _ctx())
        assert result.metadata["circuit_id"] == "circuit-llm-checker-v1"
        assert result.metadata["circuit_version"] == "1.0.0"
        assert result.metadata["public_inputs_hash"] == "sha256:pub-inputs"
        assert result.metadata["proof_reference_type"] == "proof_bytes_hash"
        assert result.metadata["proof_reference"] == _proof_bytes_hash()
        assert result.metadata["proof_envelope_hash"].startswith("sha256:")


# ===========================================================================
# ChainlinkCREVerifier
# ===========================================================================

class TestChainlinkCREVerifier:
    def test_valid_metadata_returns_verified(self) -> None:
        verifier = _cre_verifier()
        result = verifier.verify(_cre_meta(), _ctx())
        assert result.verified is True
        assert result.verifier == "chainlink-cre-verifier-v1"
        assert result.reason == "chainlink_cre_report_verified"

    def test_missing_proof_request_hash_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta()
        del meta["request_hash"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "request_hash" in result.reason

    def test_missing_proof_output_hash_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta()
        del meta["output_hash"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert "output_hash" in result.reason

    def test_mismatched_request_hash_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta(request_hash="sha256:wrong")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "request_hash_mismatch"

    def test_mismatched_output_hash_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta(output_hash="sha256:wrong")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "output_hash_mismatch"

    def test_missing_workflow_id_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta()
        del meta["cre_workflow_id"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "cre_workflow_id_missing"

    def test_mismatched_workflow_id_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta(cre_workflow_id="wf-unknown")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "cre_workflow_id_mismatch"

    def test_missing_don_id_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta()
        del meta["cre_don_id"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "cre_don_id_missing"

    def test_mismatched_don_id_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta(cre_don_id="don-99")
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "cre_don_id_mismatch"

    def test_missing_cre_round_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta()
        del meta["cre_round"]
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "cre_round_missing"

    def test_replayed_cre_round_fails(self) -> None:
        verifier = _cre_verifier()
        meta1 = _cre_meta(cre_round=5, nonce="n-1")
        meta2 = _cre_meta(cre_round=5, nonce="n-2")
        ctx1 = _ctx(nonce="n-1")
        ctx2 = _ctx(nonce="n-2")
        first = verifier.verify(meta1, ctx1)
        assert first.verified is True
        second = verifier.verify(meta2, ctx2)
        assert second.verified is False
        assert second.reason == "replayed_cre_round"

    def test_monotonically_increasing_rounds_accepted(self) -> None:
        verifier = _cre_verifier()
        for i, (r, n) in enumerate([(1, "n-a"), (2, "n-b"), (3, "n-c")]):
            result = verifier.verify(
                _cre_meta(cre_round=r, nonce=n),
                _ctx(nonce=n),
            )
            assert result.verified is True, f"Expected verified for round {r}"
            assert result.metadata["cre_round"] == r

    def test_missing_report_hash_fails(self) -> None:
        verifier = _cre_verifier()
        meta = _cre_meta()
        meta["cre_report_hash"] = ""
        result = verifier.verify(meta, _ctx())
        assert result.verified is False
        assert result.reason == "cre_report_hash_missing"

    def test_replayed_nonce_fails(self) -> None:
        verifier = _cre_verifier()
        meta1 = _cre_meta(cre_round=1, nonce="shared-nonce")
        meta2 = _cre_meta(cre_round=2, nonce="shared-nonce")
        ctx1 = _ctx(nonce="shared-nonce")
        ctx2 = _ctx(nonce="shared-nonce")
        first = verifier.verify(meta1, ctx1)
        assert first.verified is True
        second = verifier.verify(meta2, ctx2)
        assert second.verified is False
        assert second.reason == "replayed_nonce"

    def test_empty_proof_meta_fails(self) -> None:
        verifier = _cre_verifier()
        result = verifier.verify({}, _ctx())
        assert result.verified is False

    def test_result_metadata_includes_workflow_don_round(self) -> None:
        verifier = _cre_verifier()
        result = verifier.verify(_cre_meta(cre_round=7, nonce="n-7"), _ctx(nonce="n-7"))
        assert result.metadata["cre_workflow_id"] == "wf-llm-router-v1"
        assert result.metadata["cre_don_id"] == "don-42"
        assert result.metadata["cre_round"] == 7
