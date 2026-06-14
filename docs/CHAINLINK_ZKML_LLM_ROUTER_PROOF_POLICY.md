# Chainlink ZKML LLM Router Proof Policy

Last updated: 2026-06-13

Task: `CLZKML-030 Proof Policy Matrix`

## Purpose

This document defines the proof policy boundary for
`ipfs_accelerate_py.llm_router` consensus mode. It classifies model and checker
families by what the router may claim, what public inputs must be bound, and
when the feature must fail closed.

The central rule is simple: do not label an output as ZKML-verified unless a
valid proof actually binds the request, model commitment, public inputs, and
output. Multi-operator consensus, Chainlink CRE consensus, signatures, and TEE
attestations are valuable verification evidence, but they are not automatically
ZKML proofs of full model execution.

## Policy Modes

### `receipt_only`

Use when operators can sign or report outputs but no cryptographic model proof
is required.

Guarantee:

- The receipt binds request hash, output hash, operator metadata, comparison
  mode, quorum result, and optional Chainlink CRE metadata.

Does not guarantee:

- Mathematical proof that a specific model produced the output.
- Confidential execution.

Fail-closed behavior:

- Fail if quorum is not met.
- Fail if required signatures are missing under production policy.
- Fail if request/output hashes do not match receipt fields.

### `tee_or_zkml`

Use when large model execution cannot practically be ZK-proven in the first
release, but execution should be bound to either a TEE attestation or a ZKML
proof when available.

Guarantee:

- Either a valid TEE attestation or valid ZKML proof binds request and output.

Does not guarantee:

- If the accepted evidence is TEE-only, it is not a zero-knowledge proof.

Fail-closed behavior:

- Fail if neither evidence type is present.
- Fail if TEE measurement, signer, nonce, expiry, request hash, or output hash
  is invalid.
- Fail if a ZKML proof is present but verifier key, public inputs, request hash,
  output hash, or model commitment do not match.

### `zkml_required`

Use only for bounded models or checker circuits where a real verifier exists.

Guarantee:

- A proof verifies against a pinned verifier key and public inputs.

Does not guarantee:

- Anything outside the proven circuit. For example, a proven checker does not
  prove full LLM generation unless the circuit includes full generation.

Fail-closed behavior:

- Fail if proof bytes/CID are missing.
- Fail if verifier key hash, circuit ID, circuit version, public input hash,
  model commitment, request hash, or output commitment mismatch.
- Fail if proof verification cannot run.

### `unsupported`

Use when the target is too ambiguous, non-deterministic, sensitive, or
unbounded for the current consensus/proof system.

Guarantee:

- None. The router should reject the request under verified mode.

Fail-closed behavior:

- Raise `LLMConsensusError` before operator fan-out.

## Public Input Commitments

All proof and attestation policies should bind these fields where available:

- `domain_separator`: fixed string such as
  `ipfs-accelerate-llm-consensus-v1`.
- `request_id`: replay-safe unique ID.
- `request_hash`: canonical request hash.
- `prompt_hash`: hash of raw or redacted prompt according to policy.
- `context_cids`: ordered retrieval/source CIDs if RAG context is used.
- `model_commitment`: model ID plus revision, weights digest, container digest,
  or approved provider model version.
- `tokenizer_commitment`: tokenizer ID plus revision or digest where relevant.
- `generation_params_hash`: deterministic generation parameters.
- `comparison_mode`: exact, canonical JSON, normalized text, or semantic.
- `output_hash`: raw output hash.
- `normalized_output_hash`: normalized output hash used for quorum.
- `proof_policy`: receipt-only, tee-or-zkml, zkml-required, or unsupported.
- `deadline_unix_ms`: prevents stale proof reuse.
- `operator_id` or `operator_set_hash`: binds evidence to the operator set when
  relevant.
- `cre_workflow_id` and `cre_registry`: binds Chainlink evidence when relevant.

Private inputs must not be logged or placed onchain. Use hashes, encrypted CIDs,
or confidential execution paths for sensitive material.

## Matrix

| Target family | Default policy | Accepted evidence | Comparison mode | Public input focus | Notes |
| --- | --- | --- | --- | --- | --- |
| Local deterministic mock operators | `receipt_only` | Receipt hash and optional dev signatures | `exact` or `canonical_json` | Request hash, output hash, operator ID | Unit-test only. No security claim beyond deterministic test behavior. |
| General hosted LLM text generation | `receipt_only` | Operator receipt, provider trace, optional signatures | `normalized_text` for low risk, `canonical_json` for structured output | Request hash, model/provider ID, output hash | No full model proof. Use only for low-risk generation unless paired with quorum and structured validation. |
| Structured JSON extraction or classification through an LLM | `receipt_only` first, `tee_or_zkml` when checker evidence exists | Quorum receipt, signatures, optional checker proof | `canonical_json` | JSON schema hash, normalized output hash, field-level commitments | Recommended first high-impact path. Require deterministic decoding and fail closed on malformed JSON. |
| Service-routing category classifier | `zkml_required` when implemented as bounded classifier; otherwise `receipt_only` plus quorum | ZKML classifier proof or signed quorum receipt | `canonical_json` | Input embedding/text commitment, category vocabulary hash, classifier model commitment, output category hash | Good candidate for first bounded ZKML circuit or ONNX-style proof. |
| Safety/policy checker | `zkml_required` for bounded checker; `tee_or_zkml` for larger checker | ZKML proof or TEE attestation | `canonical_json` | Policy version hash, claim hash, verdict hash, threshold/hash commitments | A checker proof can validate a generated answer's policy verdict without proving the whole answer generation. |
| Retrieval membership and citation checker | `zkml_required` for bounded membership proof; otherwise `receipt_only` | Merkle/IPLD membership proof, ZK set-membership proof, or receipt | `canonical_json` | Query hash, retrieved CID set root, citation CID, selected span hash | Proves source inclusion, not answer correctness. |
| Embedding similarity checker | `zkml_required` only for bounded vector/circuit; otherwise `tee_or_zkml` | ZK vector similarity proof or TEE attestation | `canonical_json` | Embedding model commitment, vector commitments, threshold, result bit/hash | Useful for semantic consensus support, but semantic agreement remains advisory for high-impact decisions. |
| Full small ML model inference | `zkml_required` if circuit/verifier exists | ZKML proof | `exact` or `canonical_json` | Model weights commitment, input commitment, output commitment, verifier key hash | Acceptable only for pinned bounded models with measured proof cost. |
| Full large generative LLM inference | `tee_or_zkml` only if TEE attestation is configured; otherwise `receipt_only` | TEE attestation, future full ZKML proof, or quorum receipt | `canonical_json` for structured output | Model/container measurement, prompt hash, output hash, nonce, enclave measurement | Do not claim full ZKML unless generation is actually proven. |
| Chainlink CRE HTTP inference workflow | `receipt_only` plus CRE verification; `tee_or_zkml` if Confidential HTTP or proof evidence is configured | CRE workflow/report metadata, HTTP capability consensus, optional TEE/ZKML proof | `canonical_json` | CRE workflow ID, registry, request hash, output hash, model policy ID | CRE verifies capability execution across DON nodes. Python must still verify receipt binding. |
| Chainlink CRE Confidential HTTP inference workflow | `tee_or_zkml` | CRE metadata plus Confidential HTTP evidence/attestation; optional encrypted response metadata | `canonical_json` | Workflow ID, enclave/confidential capability evidence, secret template policy, request/output hashes | Confidential compute evidence is not identical to ZKML proof. Label it separately. |
| Unbounded free-form advice for high-impact decisions | `unsupported` | None | None | N/A | Require structured subclaims/checkers before enabling verified mode. |

## Recommended Defaults By Workflow Risk

Low-risk generation:

- Policy: `receipt_only`
- Quorum: optional
- Comparison: `normalized_text` or `exact`
- Fallback: allowed only if receipt records actual provider

Structured automation:

- Policy: `receipt_only`
- Quorum: 2-of-3 minimum
- Comparison: `canonical_json`
- Fallback: disabled after operator selection

High-impact service routing or eligibility extraction:

- Policy: `receipt_only` plus signatures for MVP, upgrade to `zkml_required`
  for bounded classifiers/checkers
- Quorum: 3-of-5 preferred
- Comparison: `canonical_json`
- Fallback: fail closed
- Audit: persist redacted receipt hash and receipt CID if configured

Onchain, public-claim, or institutional audit workflow:

- Policy: `tee_or_zkml` or `zkml_required`
- Chainlink: CRE verified receipt required
- Verifier contract: recommended
- Fallback: fail closed
- Audit: onchain proof/receipt hash plus local redacted receipt

## Implementation Requirements

`ReceiptOnlyVerifier`:

- Verify request hash and output hash binding.
- Verify quorum result and comparison mode.
- Verify operator signatures when production policy requires them.
- Reject stale deadlines and replayed request IDs when replay store is enabled.

`TEEVerifier`:

- Verify enclave measurement allowlist.
- Verify signer identity.
- Verify nonce and expiry.
- Verify request hash and output hash claims.
- Return `proof.verified=True` only for accepted TEE policy, not for ZKML.

`ZKMLVerifier`:

- Verify proof bytes or proof CID.
- Verify verifier key hash and circuit version.
- Verify public input hash.
- Verify model, tokenizer, input, and output commitments.
- Reject proof reuse across requests or model versions.

`ChainlinkCREVerifier`:

- Verify workflow ID and registry.
- Verify request hash, model policy ID, and output hash.
- Verify chain ID, transaction hash, and verifier contract event when supplied.
- Reject receipts produced by unexpected workflows or registries.

## Explicit Non-Claims

The router must not claim:

- That CRE consensus is a ZKML proof.
- That TEE attestation is a ZKML proof.
- That a policy checker proof proves full LLM generation.
- That semantic similarity is safe for high-impact output consensus by itself.
- That provider model names are model commitments unless backed by pinned
  revision/digest or approved provider version policy.

## First Release Recommendation

For the first executable release:

1. Implement `receipt_only` thoroughly.
2. Require `canonical_json` for high-impact structured outputs.
3. Add operator signatures before production libp2p use.
4. Add CRE receipt verification before any onchain/public-claim workflow.
5. Add ZKML first for bounded classifiers/checkers, not full large LLM
   generation.
6. Add TEE evidence only with clear labeling and strict measurement allowlists.

