# Chainlink ZKML LLM Router Consensus Plan

Last updated: 2026-06-14

Executable backlog: `docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_TODO.md`

## Goal

Add a verifiable inference mode to `ipfs_accelerate_py.llm_router` so callers can
request model outputs only when enough independent operators agree on the same
answer, with an upgrade path to Chainlink Runtime Environment (CRE), ZKML, TEE
attestation, and onchain proof receipts.

The target feature is not a replacement for the existing one-shot router. It is
an opt-in consensus path for higher-risk calls:

- `llm_router.generate_text(...)`: current fast path.
- `llm_router.generate_text_consensus(...)`: new verified path that returns a
  selected answer plus a receipt.
- `llm_router.chat_completions_create_consensus(...)`: OpenAI-compatible
  wrapper once text consensus is stable.

The implementation should reuse the existing router stack. The current
`ipfs_accelerate_py/llm_router.py` module is a thin compatibility wrapper around
`ipfs_datasets_py.llm_router`, and the underlying router already has provider
selection, response tracing, and a `p2p_task_queue` provider backed by libp2p
task delegation. The consensus feature should compose these pieces rather than
forking routing, provider, or network logic.

## Current Chainlink Assumptions

These assumptions are based on the Chainlink documentation available on
2026-06-13:

- Use CRE as the primary Chainlink target, not Chainlink Functions. Chainlink
  Functions documentation says testnet sunset was June 2, 2026 and mainnet
  sunset is Sept. 1, 2026. See:
  `https://docs.chain.link/chainlink-functions`.
- CRE workflows run across Decentralized Oracle Networks (DONs). Capability
  calls are executed by independent nodes, validated, and aggregated through BFT
  consensus into a single verified output. See:
  `https://docs.chain.link/cre/concepts/consensus-computing`.
- CRE HTTP capabilities can make API calls from multiple independent nodes and
  return only after consensus. See:
  `https://docs.chain.link/cre/capabilities/http`.
- Chainlink's verifiable AI framing combines secure data sourcing, offchain
  computation, cryptographic verification through ZKML or TEEs, and onchain
  delivery of verified outputs/proofs. See:
  `https://chain.link/article/verifiable-ai-stack` and
  `https://chain.link/article/what-is-verifiable-ai`.

Practical constraint: full ZK proofs for large generative LLM execution are not
a near-term default path. The feature should support ZKML where the model and
inference circuit are bounded enough to prove, and otherwise combine
deterministic inference, independent operator consensus, signed receipts, TEE
attestation, and optional onchain proof anchoring.

## Product Contract

Callers should be able to require one of these policies per request:

- `receipt_only`: collect signed operator outputs and a deterministic consensus
  receipt, but do not require Chainlink or cryptographic proof.
- `libp2p_quorum`: fan out to local and remote libp2p operators and require an
  M-of-N quorum before returning.
- `chainlink_cre`: route the inference request through a deployed CRE workflow
  and require the CRE report/transaction metadata.
- `zkml_required`: require a valid proof for the model execution or fail closed.
- `tee_or_zkml`: accept either a ZKML proof or a TEE attestation matching the
  configured verifier policy.
- `hybrid`: require libp2p quorum locally and Chainlink CRE verification for
  production/high-impact calls.

Default behavior should remain unchanged. The new path must be explicit through
function calls or environment flags.

## Proposed Public API

```python
from ipfs_accelerate_py import llm_router

receipt = llm_router.generate_text_consensus(
    prompt="Return JSON with the service category for this request...",
    provider="hf_inference_api",
    model_name="Qwen/Qwen2.5-1.5B-Instruct",
    consensus={
        "mode": "libp2p_quorum",
        "min_operators": 3,
        "quorum": 2,
        "comparison": "canonical_json",
        "timeout_s": 90,
        "fail_closed": True,
    },
    proof_policy={
        "mode": "receipt_only",
    },
    response_format={"type": "json_object"},
)

text = receipt.text
assert receipt.consensus.accepted is True
```

The API should also support `return_receipt=False` for callers that want the old
string-return shape but still want consensus enforcement:

```python
text = llm_router.generate_text_consensus(
    prompt=prompt,
    consensus={"mode": "hybrid", "quorum": 3, "min_operators": 5},
    return_receipt=False,
)
```

## Core Data Model

Use dataclasses or Pydantic models with JSON serialization. Keep them small and
stable so receipts can be pinned to IPFS, logged, or submitted to contracts.

```python
ConsensusRequest:
  request_id: str
  prompt_hash: str
  prompt_cid: str | None
  prompt_redaction_policy: str
  model_name: str | None
  model_commitment: str | None
  tokenizer_commitment: str | None
  generation_params: dict
  comparison: "exact" | "canonical_json" | "normalized_text" | "semantic"
  quorum: int
  min_operators: int
  deadline_unix_ms: int

OperatorResponse:
  operator_id: str
  transport: "local" | "libp2p" | "chainlink_cre"
  peer_id: str | None
  provider: str
  model_name: str | None
  output_text: str
  output_hash: str
  normalized_output_hash: str
  latency_ms: int
  error: str | None
  signature: str | None
  attestation: dict | None

ConsensusResult:
  accepted: bool
  selected_output_hash: str
  selected_normalized_hash: str
  selected_operator_ids: list[str]
  rejected_operator_ids: list[str]
  quorum: int
  total_successful: int
  comparison: str
  reason: str

ProofReceipt:
  policy: str
  verifier: str | None
  proof_cid: str | None
  public_inputs_hash: str | None
  tee_attestation_hash: str | None
  cre_workflow_id: str | None
  cre_report_id: str | None
  chain_id: str | None
  tx_hash: str | None
  verified: bool

ConsensusReceipt:
  schema_version: "llm-router-consensus-receipt-v1"
  request: ConsensusRequest
  responses: list[OperatorResponse]
  consensus: ConsensusResult
  proof: ProofReceipt
  text: str
  created_at: str
```

## Architecture

### 1. Request canonicalization

Every consensus call must produce a deterministic request envelope before it is
sent anywhere:

- Canonical prompt bytes and SHA-256 hash.
- Optional prompt CID for IPFS-pinned or encrypted payloads.
- Provider, model, tokenizer, model artifact digest, and container/image digest
  when available.
- Decoding parameters: `temperature`, `top_p`, `seed`, `max_tokens`, stop
  sequences, JSON mode, system prompt, tool schema, and retrieval context CIDs.
- Proof policy and verifier references.
- PII and secret handling policy.

For exact consensus, require deterministic parameters by default:
`temperature=0`, fixed `seed` when supported, pinned model and tokenizer
commitments, and stable tool/response schemas.

### 2. Operator registry

Add a router-local operator registry that can resolve:

- `local` operator: current process calls the underlying router.
- `provider` operator: same process calls a named provider, useful for
  multi-provider consensus.
- `libp2p` operator: remote peer reachable through the existing task queue RPC.
- `chainlink_cre` operator: CRE workflow endpoint or callback bridge.

Initial config can be environment-driven:

```text
IPFS_ACCELERATE_PY_LLM_CONSENSUS_ENABLED=1
IPFS_ACCELERATE_PY_LLM_CONSENSUS_MODE=libp2p_quorum
IPFS_ACCELERATE_PY_LLM_CONSENSUS_QUORUM=2
IPFS_ACCELERATE_PY_LLM_CONSENSUS_MIN_OPERATORS=3
IPFS_ACCELERATE_PY_LLM_CONSENSUS_COMPARISON=canonical_json
IPFS_ACCELERATE_PY_LLM_CONSENSUS_PEERS=/ip4/.../p2p/peerA,/ip4/.../p2p/peerB
IPFS_ACCELERATE_PY_LLM_CONSENSUS_FAIL_CLOSED=1
IPFS_ACCELERATE_PY_CHAINLINK_CRE_WORKFLOW_ID=...
IPFS_ACCELERATE_PY_CHAINLINK_CRE_ENDPOINT=...
IPFS_ACCELERATE_PY_CHAINLINK_VERIFIER_CONTRACT=...
```

Use the existing `IPFS_DATASETS_PY_*` aliases where the underlying router
already supports them, but expose `IPFS_ACCELERATE_PY_*` names as the public
surface for this package.

### 3. libp2p fan-out

The local implementation should fan out a single canonical request to each
configured peer, wait for responses, normalize outputs, and compute quorum.

Implementation target:

- Reuse the existing task queue protocol where possible:
  `ipfs_datasets_py.ml.accelerate_integration.p2p_task_client.RemoteQueue`.
- Send a new task payload type, `llm-consensus-generate-v1`, containing the
  canonical request and proof policy.
- Remote workers must run inference locally through their own router, sign the
  output hash if an operator key is configured, and return the output plus
  attestation metadata.
- Do not rely on one remote peer environment variable for multi-peer fan-out.
  Add an explicit multi-peer client helper rather than mutating process
  environment during concurrent calls.

### 4. Consensus algorithms

Support multiple comparison modes, with clear safety labels:

- `exact`: byte-for-byte output equality after trimming. Use for deterministic
  prompts and strict JSON.
- `canonical_json`: parse JSON, sort keys, normalize numbers/strings, then hash.
  This should be the default for service classification, extraction, policy
  checks, and structured tool outputs.
- `normalized_text`: lowercase, whitespace-normalized text hash. Suitable for
  low-risk summarization only.
- `semantic`: embedding similarity and/or entailment-based clustering. Useful
  for exploratory generative tasks, but not acceptable for high-impact decisions
  unless paired with a structured checker.

High-impact workflows should use structured output and `canonical_json`.
Unstructured answers can still carry a receipt, but the receipt must label the
consensus method and risk profile.

### 5. Chainlink CRE bridge

Add a bridge object in `ipfs_accelerate_py` that can submit a canonical request
to a deployed CRE workflow and parse the verified result:

```python
class ChainlinkCREInferenceBridge:
    def submit(self, request: ConsensusRequest) -> ChainlinkJobRef: ...
    def wait(self, job_ref: ChainlinkJobRef, timeout_s: float) -> ConsensusReceipt: ...
    def verify_receipt(self, receipt: ConsensusReceipt) -> bool: ...
```

CRE workflow responsibilities:

- Receive the canonical request or a CID to encrypted request material.
- Each DON node performs the same HTTP or confidential HTTP call to an approved
  inference endpoint, or calls an operator-local inference service.
- The workflow validates deterministic response shape and hashes.
- The DON aggregates responses through BFT consensus.
- The workflow returns the aggregate output, per-node metadata that Chainlink
  exposes to the workflow, and optional EVM report/transaction metadata.

The local router should treat CRE output as another `ConsensusReceipt`, not as a
bare string. This keeps audit, wallet, and API layers uniform.

### 6. ZKML and TEE proof adapters

Implement proof verification as a pluggable adapter:

```python
class ProofVerifier:
    def verify(self, request: ConsensusRequest, response: OperatorResponse) -> ProofReceipt: ...
```

Adapters:

- `ReceiptOnlyVerifier`: checks hashes/signatures, no cryptographic model proof.
- `TEEVerifier`: validates enclave measurement, signer, nonce binding,
  request/output hash binding, and expiry.
- `ZKMLVerifier`: validates proof bytes or proof CID against public inputs:
  model commitment, input commitment, output commitment, circuit ID, circuit
  version, and verifier key hash.
- `ChainlinkCREVerifier`: validates CRE workflow/report metadata and optional
  onchain transaction or verifier-contract event.

For large LLMs, use ZKML first for bounded verifier submodels and structured
post-checkers:

- Classification heads.
- JSON schema validators.
- Safety/policy classifiers.
- Embedding similarity checks.
- Retrieval membership and source-citation checks.

Do not claim full cryptographic proof of large generative inference unless the
model, tokenizer, quantization, circuit, proving key, and verifier are pinned
and the proof actually binds the prompt and output.

## Security And Privacy Requirements

- Fail closed by default in consensus modes. If quorum or proof verification
  fails, raise `LLMConsensusError`.
- Never put raw prompts, PII, secrets, or model-private material onchain. Use
  hashes, encrypted CIDs, redacted prompts, or confidential compute paths.
- Include replay protection: request nonce, timestamp, deadline, and domain
  separator.
- Bind every proof or signature to the request hash and output hash.
- Require operator identities for production: libp2p peer ID alone is not
  enough for economic or institutional trust.
- Detect equivocation: if one operator returns different hashes for the same
  request ID, mark the operator as suspect.
- Keep non-consensus fallback disabled in verified modes. A direct router
  fallback must not silently replace a failed quorum.
- Log receipt metadata, not raw prompts, unless the caller explicitly opts into
  local audit logs.
- Treat semantic consensus as advisory unless the downstream workflow can prove
  or deterministically validate the structured claim being acted upon.

## Implementation Phases

### Phase 0: CRE and ZKML spike

Outputs:

- Document selected CRE access mode, workflow registry mode, billing/subscription
  requirements, supported chain, and verifier contract requirements.
- Simulate a minimal CRE workflow that calls a deterministic inference endpoint
  and returns a hash.
- Identify whether target model execution can be ZK-proven, TEE-attested, or
  only receipt-verified in the first release.

Acceptance:

- CRE simulation works locally.
- The production path does not depend on Chainlink Functions.
- A proof policy matrix exists for each target model family.

### Phase 1: Local consensus core

Files:

- `ipfs_accelerate_py/llm_consensus.py`
- `ipfs_accelerate_py/llm_router.py`
- `tests/test_llm_consensus.py`

Work:

- Add request/response/receipt models.
- Add output normalization and quorum selection.
- Add `generate_text_consensus`.
- Support local multi-provider consensus using existing router providers.
- Add deterministic mock operators for tests.

Acceptance:

- Exact and canonical JSON quorum tests pass.
- Quorum failure raises `LLMConsensusError`.
- Existing `generate_text` behavior remains unchanged.

### Phase 2: libp2p operator fan-out

Files:

- `ipfs_accelerate_py/llm_consensus.py`
- `ipfs_accelerate_py/p2p_tasks/client.py` if available in the target package
- `ipfs_datasets_py` compatibility wrappers as needed

Work:

- Add explicit multi-peer `RemoteQueue` fan-out.
- Add `llm-consensus-generate-v1` task payload.
- Add operator signing hooks.
- Add peer timeout, partial failure, and equivocation handling.

Acceptance:

- Three local test workers can return 2-of-3 consensus.
- One malicious or divergent worker is rejected.
- No global environment mutation is needed during fan-out.

### Phase 3: Chainlink CRE bridge

Files:

- `ipfs_accelerate_py/chainlink_cre.py`
- `chainlink/cre/llm_consensus_workflow.ts` or Go equivalent
- `docs/CHAINLINK_ZKML_LLM_ROUTER_RUNBOOK.md`

Work:

- Add CRE bridge client and receipt verifier.
- Build a CRE workflow that accepts request CIDs/hashes, calls deterministic
  inference endpoints through HTTP or confidential HTTP, and returns an
  aggregate response.
- Add verifier-contract/event support if the selected deployment uses onchain
  anchoring.

Acceptance:

- CRE simulation returns a consensus receipt.
- Deployed workflow returns a receipt with workflow/report metadata.
- The Python verifier rejects receipts for the wrong workflow, model, request
  hash, output hash, chain, or verifier contract.

### Phase 4: ZKML and TEE proof verification

Files:

- `ipfs_accelerate_py/proof_verifiers.py`
- model-specific proof adapter modules
- integration tests gated by proof backend env vars

Work:

- Add proof envelope schema.
- Verify ZKML proofs for bounded models/checkers.
- Verify TEE attestations where ZKML is not practical.
- Bind proof public inputs to request/output/model commitments.

Acceptance:

- Invalid proof bytes fail closed.
- Proof for request A cannot be replayed for request B.
- Receipts clearly state whether they prove full inference or a bounded checker.

### Phase 5: Router and application integration

Files:

- `wallet_interface/api.py`
- `wallet_interface/ui/src/services/walletApi.ts`
- `wallet_interface/ui/src/app/App.tsx`
- `wallet_interface/ui/tests/*`
- call sites that perform high-impact AI decisions
- docs and env examples

Work:

- Add wallet/API options for consensus policy.
- Require consensus for selected high-risk workflows: eligibility extraction,
  service routing, safety-critical advice, and automated claims.
- Expose receipt IDs/CIDs to audit views.
- Add TypeScript models for sanitized consensus metadata and fail-closed error
  states.
- Add UI status surfaces for recipient access, wallet/uploads, Proof Center,
  Security/audit, provider eligibility, and public proof dashboards.
- Add a UI/backend workflow matrix before expanding Playwright coverage.
- Keep low-risk chat on the existing fast path.

Acceptance:

- High-risk routes fail closed when consensus is unavailable.
- Audit records include receipt hashes and selected operator IDs.
- UI/API callers can inspect whether output was direct, libp2p consensus, CRE
  verified, ZKML verified, or TEE attested.
- Frontend tests prove users see verified/attested state, fail-closed fallback,
  and no raw prompt/proof/operator secret leakage.

## UI/UX Workflow Gap Review

The core router implementation is strong, but the existing plan needs an
explicit frontend contract so consensus does not remain hidden inside backend
metadata. The UI must make the trust state inspectable without overclaiming what
the receipt proves.

Required surfaces:

- Recipient access: redacted analysis, extraction, form analysis, vector
  profile, and GraphRAG actions show direct/consensus/verified state on derived
  artifacts.
- Wallet/uploads: document profiling and organizer metadata generation show
  whether consensus was required, satisfied, bypassed, or unavailable.
- Proof Center and QR proof review: public proof cards show sanitized consensus
  receipt metadata when a proof or derived artifact depends on consensus.
- Security/audit: fail-closed events, receipt hashes, and verifier labels are
  visible to wallet operators without exposing private prompts.
- Provider eligibility and case workflows: automated eligibility claims are
  blocked or marked manual-review when consensus policy is not satisfied.
- Public analytics/proof dashboards: release copy that depends on AI-derived
  claims shows proof/consensus freshness and blocks publication when policy
  fails.

Required UI states:

- consensus disabled or direct fast path
- consensus pending
- receipt-only success
- libp2p quorum success
- Chainlink CRE verified success
- ZKML checker verified success
- TEE attested success
- quorum failure
- proof or CRE verification failure
- fail-closed manual fallback
- redacted receipt unavailable

The UI language must distinguish "consensus receipt", "Chainlink CRE verified",
"ZKML checker verified", and "TEE attested". It must not call a receipt-only
or TEE-attested result a mathematical ZK proof.

Full-stack Playwright coverage should launch the Abby UI and live wallet API
with deterministic mock consensus responses. The browser should exercise real
transport calls for wallet AI router and redacted-analysis routes, then assert
status refresh, audit evidence, fail-closed behavior, and no visible leakage of
raw prompts, wallet plaintext, proof witnesses, operator secrets, or raw proof
payloads.

### Phase 6: Production hardening

Work:

- Operator allowlist, key rotation, and revocation.
- Rate limits, billing controls, request-size limits, and timeout budgets.
- Receipt persistence and IPFS pinning policy.
- Monitoring for quorum failures, operator drift, and CRE workflow failures.
- Incident runbook and recovery procedures.

Acceptance:

- Production readiness check validates required env vars and verifier config.
- Load tests cover slow, failing, divergent, and byzantine operators.
- No high-impact route can silently downgrade to non-consensus inference.

## Test Plan

Unit tests:

- Canonical request hash stability.
- JSON normalization equivalence.
- Exact mismatch rejection.
- M-of-N quorum success and failure.
- Tie handling.
- Timeout handling.
- Receipt serialization round trip.
- Proof policy fail-closed behavior.

Integration tests:

- Local router provider consensus with mock providers.
- libp2p fan-out to multiple local workers.
- CRE simulation, gated behind `IPFS_ACCELERATE_PY_RUN_CHAINLINK_CRE_TESTS=1`.
- ZKML/TEE verifier tests, gated by backend-specific env vars.
- Wallet/API consensus policy tests for request-field and environment-policy
  activation, typed errors, fail-closed behavior, and sanitized metadata.

Frontend and Playwright tests:

- TypeScript API client maps sanitized consensus metadata and fail-closed error
  states.
- Mocked UI tests cover every consensus state shown in the workflow matrix.
- Full-stack Playwright drives recipient access and wallet/uploads against a
  live wallet API with deterministic mock consensus.
- Proof Center, QR review, Security/audit, provider eligibility, and public
  analytics surfaces show sanitized receipt state without raw prompt/proof/PII
  leakage.
- Desktop Chrome, Mobile Chrome, and Mobile Safari layouts have no horizontal
  overflow, incoherent overlap, or hidden manual-review fallback.

Security tests:

- No raw prompt leaks in receipts when redaction is enabled.
- Replay attack rejected by nonce/request hash mismatch.
- Operator signature mismatch rejected.
- CRE receipt with wrong workflow ID rejected.
- Proof with wrong model commitment rejected.

## First Implementation Slice

Start with a local, testable Python slice before adding Chainlink dependencies:

1. Create `ipfs_accelerate_py/llm_consensus.py`.
2. Implement models, normalizers, quorum selection, and `LLMConsensusError`.
3. Update `ipfs_accelerate_py/llm_router.py` to expose
   `generate_text_consensus`.
4. Add tests using deterministic mock operators.
5. Add docs showing how this maps onto libp2p and CRE.

This gives the library a real consensus feature immediately while keeping CRE,
ZKML, and TEE work behind explicit adapters.

## Open Questions

- Which Chainlink CRE deployment path is available for this project: private
  registry, onchain registry, or early-access hosted deployment?
- Which model outputs are high impact enough to require fail-closed consensus?
- Which models can be constrained to deterministic JSON outputs?
- Are remote libp2p operators controlled by the project, independent partners,
  or open network participants?
- What operator identity root should be trusted: DID, wallet address, libp2p
  peer ID plus signed key, or Chainlink operator metadata?
- Which ZKML backend, if any, is viable for the first target model/checker?
- Should receipts be stored only locally, pinned to IPFS, anchored onchain, or
  all three depending on policy?

## Recommended Default Policy

For the first production release:

- Use direct `generate_text` for low-risk conversational generation.
- Use `generate_text_consensus` with `canonical_json`, 2-of-3 quorum, and
  `receipt_only` for structured non-critical automation.
- Use `generate_text_consensus` with `canonical_json`, 3-of-5 quorum,
  operator signatures, and no fallback for high-impact service routing.
- Use CRE verification for workflows that trigger onchain state, payments,
  public claims, or institutional audit obligations.
- Use ZKML only for bounded checkers until full model proving is available and
  benchmarked.
- Use TEE attestation for large-model confidentiality or tamper resistance when
  ZKML is not practical, but label it separately from mathematical ZK proof.
