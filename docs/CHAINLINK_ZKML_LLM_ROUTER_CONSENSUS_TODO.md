# Chainlink ZKML LLM Router Consensus Todo

This backlog is the executable implementation queue for
`docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_PLAN.md`.

The shared implementation daemon can consume this file with:

```bash
python scripts/portal_implementation_daemon.py --once --no-implement \
  --todo-path docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_TODO.md \
  --task-prefix '## CLZKML-' \
  --state-prefix clzkml \
  --state-dir data/chainlink_zkml_implementation/state
```

For supervised multi-agent execution, use:

```bash
python scripts/portal_implementation_supervisor.py --once --no-implement \
  --todo-path docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_TODO.md \
  --task-prefix '## CLZKML-' \
  --state-prefix clzkml \
  --state-dir data/chainlink_zkml_implementation/state
```

For autonomous implementation until the full `CLZKML-` backlog is complete, run
the supervised drain loop:

```bash
python scripts/portal_implementation_supervisor.py \
  --todo-path docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_TODO.md \
  --task-prefix '## CLZKML-' \
  --state-prefix clzkml \
  --state-dir data/chainlink_zkml_implementation/state \
  --implement \
  --until-complete \
  --daemon-interval 5 \
  --check-interval 5 \
  --max-restarts 0
```

For a single-process autonomous drain without supervisor restarts, use:

```bash
python scripts/portal_implementation_daemon.py \
  --todo-path docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_TODO.md \
  --task-prefix '## CLZKML-' \
  --state-prefix clzkml \
  --state-dir data/chainlink_zkml_implementation/state \
  --implement \
  --until-complete \
  --interval 5
```

Agent coordination notes:

- Claim one `CLZKML-` task at a time through the daemon state directory.
- Prefer lower numbered unblocked tasks first.
- Do not widen a task beyond its declared outputs without updating this file.
- If two tasks touch the same file, the lower numbered task owns the primary
  shape and later tasks should extend it.
- Keep Chainlink CRE, ZKML, TEE, and live libp2p integration tests gated behind
  explicit environment variables so offline CI remains deterministic.

Priority guide:

- `P0`: foundation, safety, or MVP blocker work
- `P1`: required libp2p, Chainlink, proof, or test integration
- `P2`: production hardening, observability, wallet/API integration
- `P3`: polish or optional refinement

Track guide:

- `ops`: control plane, docs, readiness, deployment, and runbooks
- `core`: request, response, receipt, normalization, and quorum logic
- `router`: `ipfs_accelerate_py.llm_router` public API and compatibility
- `p2p`: libp2p operator fan-out and remote task integration
- `chainlink`: CRE workflow bridge and verified report handling
- `proofs`: ZKML, TEE, signatures, public inputs, and proof envelopes
- `privacy`: prompt redaction, receipt boundaries, no-leak behavior
- `quality`: unit, integration, adversarial, and regression tests
- `ui`: Abby React app, TypeScript wallet API client, workflow states, and Playwright tests
- `wallet`: downstream `wallet_interface` and high-impact route integration

## CLZKML-000 Plan And Executable Backlog
- Status: completed
- Completion: artifact
- Priority: P0
- Track: ops
- Depends on: none
- Outputs: docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_PLAN.md, docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_TODO.md
- Validation: python scripts/portal_implementation_daemon.py --once --no-implement --todo-path docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_TODO.md --task-prefix '## CLZKML-' --state-prefix clzkml --state-dir data/chainlink_zkml_implementation/state
- Acceptance: The Chainlink ZKML LLM router consensus plan and daemon-consumable backlog exist, use stable `CLZKML-` task IDs, and can be parsed by the shared implementation daemon without source mutations.

## CLZKML-010 Router Surface Audit
- Status: completed
- Completion: artifact
- Priority: P0
- Track: ops
- Depends on: CLZKML-000
- Outputs: artifacts/chainlink-zkml-router-audit/README.md
- Validation: test -f artifacts/chainlink-zkml-router-audit/README.md
- Acceptance: The audit records the current `ipfs_accelerate_py.llm_router` wrapper, delegated `ipfs_datasets_py.llm_router` API, existing `p2p_task_queue` provider behavior, cache/trace hooks, and the exact extension points for consensus without changing runtime code.

## CLZKML-020 Chainlink CRE Access And Capability Spike
- Status: completed
- Completion: artifact
- Priority: P0
- Track: chainlink
- Depends on: CLZKML-000
- Outputs: artifacts/chainlink-cre-spike/README.md, artifacts/chainlink-cre-spike/cre-capability-matrix.json
- Validation: test -f artifacts/chainlink-cre-spike/README.md; test -f artifacts/chainlink-cre-spike/cre-capability-matrix.json
- Acceptance: CRE access mode, registry mode, supported chain/network, billing/subscription needs, HTTP or confidential HTTP capability availability, workflow deployment path, and verifier-contract requirements are documented with current Chainlink references.

## CLZKML-030 Proof Policy Matrix
- Status: completed
- Completion: artifact
- Priority: P0
- Track: proofs
- Depends on: CLZKML-000
- Outputs: docs/CHAINLINK_ZKML_LLM_ROUTER_PROOF_POLICY.md
- Validation: test -f docs/CHAINLINK_ZKML_LLM_ROUTER_PROOF_POLICY.md
- Acceptance: Each target model or checker family is classified as `receipt_only`, `tee_or_zkml`, `zkml_required`, or unsupported, with explicit public input commitments, verifier assumptions, fail-closed behavior, and labels that distinguish full inference proofs from bounded checker proofs.

## CLZKML-040 Consensus Data Models
- Status: completed
- Completion: evidence
- Priority: P0
- Track: core
- Depends on: CLZKML-010
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus.py
- Validation: pytest tests/test_llm_consensus.py -q
- Acceptance: `ConsensusRequest`, `OperatorResponse`, `ConsensusResult`, `ProofReceipt`, and `ConsensusReceipt` are implemented with deterministic JSON serialization, schema versioning, timestamp handling, and round-trip tests.

## CLZKML-050 Request Canonicalization And Hashing
- Status: completed
- Completion: evidence
- Priority: P0
- Track: core
- Depends on: CLZKML-040
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus.py
- Validation: pytest tests/test_llm_consensus.py -q
- Acceptance: Prompt, model, provider, generation parameters, response schema, proof policy, nonce, deadline, optional CIDs, and redaction policy are canonicalized into stable request hashes while excluding raw secrets and non-deterministic fields.

## CLZKML-060 Output Normalizers
- Status: completed
- Completion: evidence
- Priority: P0
- Track: core
- Depends on: CLZKML-040
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus.py
- Validation: pytest tests/test_llm_consensus.py -q
- Acceptance: `exact`, `canonical_json`, `normalized_text`, and explicitly unsafe/advisory `semantic` comparison modes produce deterministic normalized hashes, reject malformed JSON in JSON mode, and preserve raw output only inside operator response records.

## CLZKML-070 Quorum Selection Engine
- Status: completed
- Completion: evidence
- Priority: P0
- Track: core
- Depends on: CLZKML-050, CLZKML-060
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus.py
- Validation: pytest tests/test_llm_consensus.py -q
- Acceptance: M-of-N selection handles success, failure, ties, timeout records, rejected operators, quorum failure, and deterministic selected output choice, and raises `LLMConsensusError` when fail-closed policy requires it.

## CLZKML-080 Deterministic Mock Operators
- Status: completed
- Completion: evidence
- Priority: P0
- Track: quality
- Depends on: CLZKML-040
- Outputs: tests/test_llm_consensus.py
- Validation: pytest tests/test_llm_consensus.py -q
- Acceptance: Tests can construct deterministic agreeing, disagreeing, failing, slow, and equivocal mock operators without live network, Chainlink, ZKML, or provider credentials.

## CLZKML-090 Local Multi-Provider Consensus Runner
- Status: completed
- Completion: evidence
- Priority: P0
- Track: core
- Depends on: CLZKML-070, CLZKML-080
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus.py
- Validation: pytest tests/test_llm_consensus.py -q
- Acceptance: A local runner executes multiple configured operators, records latency/error metadata, enforces per-operator and overall timeouts, and returns a `ConsensusReceipt` without mutating global router environment.

## CLZKML-100 Public Router API Wrapper
- Status: completed
- Completion: evidence
- Priority: P0
- Track: router
- Depends on: CLZKML-090
- Outputs: ipfs_accelerate_py/llm_router.py, tests/test_llm_router_consensus.py
- Validation: pytest tests/test_llm_consensus.py tests/test_llm_router_consensus.py -q
- Acceptance: `ipfs_accelerate_py.llm_router.generate_text_consensus` is exposed, supports `return_receipt=True/False`, preserves existing `generate_text` behavior, normalizes provider aliases consistently, and returns deterministic receipts for mock consensus calls.

## CLZKML-110 Consensus Configuration Loader
- Status: completed
- Completion: evidence
- Priority: P0
- Track: router
- Depends on: CLZKML-100
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_router_consensus.py
- Validation: pytest tests/test_llm_router_consensus.py -q
- Acceptance: Consensus options load from explicit call dictionaries first and `IPFS_ACCELERATE_PY_LLM_CONSENSUS_*` environment variables second, with validated defaults, type coercion, alias handling, and clear errors for impossible quorum settings.

## CLZKML-120 Receipt Persistence Adapter
- Status: completed
- Completion: evidence
- Priority: P1
- Track: core
- Depends on: CLZKML-100
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus.py
- Validation: pytest tests/test_llm_consensus.py -q
- Acceptance: Receipts can be written to local JSON/JSONL paths when configured, include content hashes, avoid raw prompt persistence when redaction is enabled, and remain optional for callers that only need returned receipt objects.

## CLZKML-130 Operator Identity And Signing Skeleton
- Status: completed
- Completion: evidence
- Priority: P1
- Track: proofs
- Depends on: CLZKML-040
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus.py
- Validation: pytest tests/test_llm_consensus.py -q
- Acceptance: Operator IDs, signing key references, signature fields, and verification stubs bind signatures to request hash, output hash, nonce, and domain separator, with unsigned operators allowed only under `receipt_only` development policy.

## CLZKML-140 Proof Verifier Interface
- Status: completed
- Completion: evidence
- Priority: P1
- Track: proofs
- Depends on: CLZKML-030, CLZKML-040
- Outputs: ipfs_accelerate_py/proof_verifiers.py, tests/test_llm_consensus_proof_verifiers.py
- Validation: pytest tests/test_llm_consensus_proof_verifiers.py -q
- Acceptance: `ReceiptOnlyVerifier`, `TEEVerifier`, `ZKMLVerifier`, and `ChainlinkCREVerifier` interfaces exist with fail-closed defaults, request/output/model binding checks, and unit tests for valid, missing, mismatched, and replayed proof metadata.

## CLZKML-150 No-Leak Receipt Boundary Tests
- Status: completed
- Completion: evidence
- Priority: P1
- Track: privacy
- Depends on: CLZKML-120, CLZKML-140
- Outputs: tests/test_llm_consensus_privacy.py
- Validation: pytest tests/test_llm_consensus_privacy.py -q
- Acceptance: Redacted receipts, persisted receipt files, proof errors, and verifier errors do not contain raw prompts, secrets, bearer tokens, private keys, or configured sensitive substrings.

## CLZKML-160 libp2p Multi-Peer Client Design
- Status: completed
- Completion: artifact
- Priority: P1
- Track: p2p
- Depends on: CLZKML-010, CLZKML-090
- Outputs: artifacts/chainlink-zkml-p2p-design/README.md
- Validation: test -f artifacts/chainlink-zkml-p2p-design/README.md
- Acceptance: The design specifies how to fan out to multiple `RemoteQueue` peers using existing libp2p task client APIs, how task payloads are shaped, how timeouts and partial failures are represented, and why global environment mutation is avoided.

## CLZKML-170 libp2p Consensus Payload Contract
- Status: completed
- Completion: evidence
- Priority: P1
- Track: p2p
- Depends on: CLZKML-160
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus_p2p.py
- Validation: pytest tests/test_llm_consensus_p2p.py -q
- Acceptance: `llm-consensus-generate-v1` request and response payload helpers serialize canonical requests, proof policy, operator metadata, and output records in a backward-compatible JSON form with schema-version tests.

## CLZKML-180 libp2p Fan-Out Runner
- Status: completed
- Completion: evidence
- Priority: P1
- Track: p2p
- Depends on: CLZKML-170, CLZKML-090
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus_p2p.py
- Validation: pytest tests/test_llm_consensus_p2p.py -q
- Acceptance: A multi-peer runner submits consensus payloads to configured peers, waits concurrently, converts completed remote tasks into `OperatorResponse` records, tolerates missing peers according to quorum policy, and does not alter process-level remote peer env vars.

## CLZKML-190 libp2p Local Worker Integration Gate
- Status: completed
- Completion: evidence
- Priority: P1
- Track: p2p
- Depends on: CLZKML-180
- Outputs: tests/integration/test_llm_consensus_p2p.py, artifacts/chainlink-zkml-p2p-smoke/README.md
- Validation: IPFS_ACCELERATE_PY_RUN_LLM_CONSENSUS_P2P_TESTS=1 pytest tests/integration/test_llm_consensus_p2p.py -q
- Acceptance: When gated integration tests are enabled and libp2p dependencies are available, three local workers can produce 2-of-3 consensus, one divergent worker is rejected, and unavailable environments skip with a clear reason.

## CLZKML-200 Chainlink CRE Bridge Client Skeleton
- Status: completed
- Completion: evidence
- Priority: P1
- Track: chainlink
- Depends on: CLZKML-020, CLZKML-140
- Outputs: ipfs_accelerate_py/chainlink_cre.py, tests/test_chainlink_cre_bridge.py
- Validation: pytest tests/test_chainlink_cre_bridge.py -q
- Acceptance: A bridge client models submit, wait, and verify operations for CRE inference workflows, supports simulated responses, validates workflow ID/request hash/output hash bindings, and fails closed for missing or mismatched CRE metadata.

## CLZKML-210 Chainlink CRE Workflow Template
- Status: completed
- Completion: artifact
- Priority: P1
- Track: chainlink
- Depends on: CLZKML-020, CLZKML-200
- Outputs: chainlink/cre/llm_consensus_workflow.md, chainlink/cre/llm_consensus_workflow.example.json
- Validation: test -f chainlink/cre/llm_consensus_workflow.md; test -f chainlink/cre/llm_consensus_workflow.example.json
- Acceptance: A CRE workflow template or detailed pseudocode defines canonical request input, HTTP or confidential HTTP inference calls, DON consensus aggregation, error handling, proof metadata, and returned receipt fields without relying on Chainlink Functions.

## CLZKML-220 Chainlink CRE Simulation Integration
- Status: completed
- Completion: evidence
- Priority: P1
- Track: chainlink
- Depends on: CLZKML-200, CLZKML-210
- Outputs: tests/integration/test_chainlink_cre_consensus.py, artifacts/chainlink-cre-simulation/README.md
- Validation: IPFS_ACCELERATE_PY_RUN_CHAINLINK_CRE_TESTS=1 pytest tests/integration/test_chainlink_cre_consensus.py -q
- Acceptance: The gated integration test exercises a simulated CRE workflow result, verifies receipt metadata, rejects wrong workflow/request/output identifiers, and skips cleanly when Chainlink test configuration is absent.

## CLZKML-230 ZKML Proof Envelope Binding
- Status: completed
- Completion: evidence
- Priority: P1
- Track: proofs
- Depends on: CLZKML-030, CLZKML-140
- Outputs: ipfs_accelerate_py/proof_verifiers.py, tests/test_llm_consensus_proof_verifiers.py
- Validation: pytest tests/test_llm_consensus_proof_verifiers.py -q
- Acceptance: ZKML proof metadata binds model commitment, tokenizer or circuit commitment, input commitment, output commitment, public input hash, verifier key hash, circuit version, and proof CID or bytes, and rejects replay across requests.

## CLZKML-240 TEE Attestation Binding
- Status: completed
- Completion: evidence
- Priority: P1
- Track: proofs
- Depends on: CLZKML-140
- Outputs: ipfs_accelerate_py/proof_verifiers.py, tests/test_llm_consensus_proof_verifiers.py
- Validation: pytest tests/test_llm_consensus_proof_verifiers.py -q
- Acceptance: TEE attestation metadata validates enclave measurement allowlists, signer identity, nonce freshness, request hash, output hash, expiry, and policy mode while clearly labeling TEE evidence separately from ZKML proof.

## CLZKML-250 Chainlink Verifier Contract Event Parser
- Status: completed
- Completion: evidence
- Priority: P2
- Track: chainlink
- Depends on: CLZKML-200
- Outputs: ipfs_accelerate_py/chainlink_cre.py, tests/test_chainlink_cre_bridge.py
- Validation: pytest tests/test_chainlink_cre_bridge.py -q
- Acceptance: Optional verifier-contract event metadata can be parsed and matched to expected chain ID, contract address, workflow ID, request hash, output hash, proof hash, block number, and transaction hash without requiring a live RPC in unit tests.

## CLZKML-260 OpenAI-Compatible Chat Consensus Wrapper
- Status: completed
- Completion: evidence
- Priority: P2
- Track: router
- Depends on: CLZKML-100
- Outputs: ipfs_accelerate_py/llm_router.py, tests/test_llm_router_consensus.py
- Validation: pytest tests/test_llm_router_consensus.py -q
- Acceptance: `chat_completions_create_consensus` accepts OpenAI-style messages, delegates to text consensus through deterministic message canonicalization or native chat operators, and returns an object compatible with existing `choices[0].message.content` access.

## CLZKML-270 Downstream Wallet/API Consensus Policy
- Status: completed
- Completion: artifact
- Priority: P2
- Track: wallet
- Depends on: CLZKML-100, CLZKML-030
- Outputs: docs/CHAINLINK_ZKML_LLM_ROUTER_WALLET_POLICY.md
- Validation: test -f docs/CHAINLINK_ZKML_LLM_ROUTER_WALLET_POLICY.md
- Acceptance: High-impact wallet and API workflows are classified by required consensus mode, comparison mode, proof policy, fail-closed setting, audit receipt requirement, and allowed fallback behavior.

## CLZKML-280 Wallet/API Optional Integration
- Status: completed
- Completion: evidence
- Priority: P2
- Track: wallet
- Depends on: CLZKML-270, CLZKML-100
- Outputs: wallet_interface/api.py, tests/test_wallet_interface_api.py
- Validation: pytest tests/test_wallet_interface_api.py -q
- Acceptance: Selected wallet AI router endpoints can request consensus mode through validated request fields or environment policy, record receipt metadata in responses or audit fields, and preserve existing non-consensus behavior unless policy requires fail-closed consensus.

## CLZKML-281 UI/API Consensus Workflow Matrix And Fixtures
- Status: completed
- Completion: evidence
- Priority: P2
- Track: ui
- Depends on: CLZKML-270, CLZKML-280
- Outputs: docs/CHAINLINK_ZKML_LLM_ROUTER_UI_WORKFLOW_MATRIX.md, wallet_interface/ui/tests/fixtures/chainlink-consensus-fixtures.ts
- Validation: python scripts/portal_implementation_daemon.py --once --no-implement --todo-path docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_TODO.md --task-prefix '## CLZKML-' --state-prefix clzkml --state-dir data/chainlink_zkml_implementation/state; npm --prefix wallet_interface/ui run build
- Acceptance: A workflow matrix maps recipient access, wallet/uploads, Proof Center, QR proof review, Security/audit, provider eligibility, and public analytics/proof dashboards to backend routes, TypeScript calls, consensus modes, fail-closed errors, receipt metadata fields, no-leak assertions, and desktop/mobile Playwright coverage; shared fixtures provide deterministic direct, receipt-only, libp2p, CRE, ZKML, TEE, quorum-failure, proof-failure, and sanitizer sentinel payloads.

## CLZKML-282 TypeScript Consensus Client And UI Surfaces
- Status: completed
- Completion: evidence
- Priority: P2
- Track: ui
- Depends on: CLZKML-281
- Outputs: wallet_interface/ui/src/services/walletApi.ts, wallet_interface/ui/src/app/App.tsx, wallet_interface/ui/src/styles/global.css, wallet_interface/ui/tests/smoke.spec.ts
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
- Acceptance: The TypeScript wallet API client exposes sanitized consensus metadata and typed fail-closed errors, and the UI shows precise direct/consensus/CRE/ZKML/TEE/manual-review state on recipient access derived artifacts, wallet/uploads profiling, Proof Center proof cards, Security/audit events, provider eligibility claims, and public analytics/proof dashboards without labeling receipt-only or TEE evidence as mathematical ZK proof.

## CLZKML-283 Backend/UI Consensus Contract Regression Tests
- Status: completed
- Completion: evidence
- Priority: P2
- Track: quality
- Depends on: CLZKML-280, CLZKML-281
- Outputs: tests/test_wallet_interface_api.py, wallet_interface/ui/tests/agent-unit.spec.ts
- Validation: pytest tests/test_wallet_interface_api.py -q; npm --prefix wallet_interface/ui run build
- Acceptance: Backend and TypeScript contract tests cover request-field and environment-policy consensus activation, route response shapes consumed by the UI client, fail-closed error codes, no silent downgrade to direct LLM output, sanitized receipt hashes/CIDs, and no raw prompt, wallet plaintext, operator secret, proof witness, CRE private report, or raw proof payload leakage.

## CLZKML-284 Full-Stack Chainlink Consensus Playwright Harness
- Status: completed
- Completion: evidence
- Priority: P2
- Track: ui
- Depends on: CLZKML-282, CLZKML-283
- Outputs: wallet_interface/ui/tests/chainlink-consensus-fullstack.spec.ts, wallet_interface/ui/tests/fixtures/chainlink-consensus-fixtures.ts
- Validation: pytest tests/test_wallet_interface_api.py -q; npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/chainlink-consensus-fullstack.spec.ts
- Acceptance: Playwright launches the real Abby UI and live wallet API with deterministic mocked consensus responses, then verifies recipient access redacted analysis, wallet/uploads profiling, Proof Center/QR review, Security/audit, provider eligibility, and public analytics/proof dashboard behavior for success, fail-closed no-quorum, proof/CRE mismatch, manual fallback, audit refresh, and no visible or exported raw prompt/PII/proof/operator-secret leakage.

## CLZKML-285 Cross-Surface Consensus UX Accessibility And No-Leak Review
- Status: completed
- Completion: evidence
- Priority: P2
- Track: ui
- Depends on: CLZKML-284
- Outputs: wallet_interface/ui/tests/chainlink-consensus-ux.spec.ts, wallet_interface/ui/tests/wallet-ux-review.spec.ts, artifacts/chainlink-zkml-ui-review
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/chainlink-consensus-ux.spec.ts; npm --prefix wallet_interface/ui test -- tests/wallet-ux-review.spec.ts
- Acceptance: Desktop Chrome, Mobile Chrome, and Mobile Safari Playwright evidence proves consensus controls and receipt badges are keyboard reachable, have accurate accessible names, avoid horizontal overflow or incoherent overlap, preserve manual-review fallback paths, use precise non-overclaiming labels, and archive screenshots or traces for release signoff.

## CLZKML-290 Observability And Readiness Checks
- Status: completed
- Completion: evidence
- Priority: P2
- Track: ops
- Depends on: CLZKML-100, CLZKML-200
- Outputs: ipfs_accelerate_py/llm_consensus.py, tests/test_llm_consensus.py, docs/CHAINLINK_ZKML_LLM_ROUTER_RUNBOOK.md
- Validation: pytest tests/test_llm_consensus.py -q; test -f docs/CHAINLINK_ZKML_LLM_ROUTER_RUNBOOK.md
- Acceptance: Consensus health summaries expose configured mode, quorum, operator count, CRE workflow ID presence, proof verifier policy, last failure reason, and redacted receipt counts for readiness reporting without exposing prompt content.

## CLZKML-300 Production Env Examples
- Status: completed
- Completion: artifact
- Priority: P2
- Track: ops
- Depends on: CLZKML-110, CLZKML-200
- Outputs: wallet_interface/deploy/env.production.example, wallet_interface/deploy/env.local.mock.example, docs/CHAINLINK_ZKML_LLM_ROUTER_RUNBOOK.md
- Validation: test -f docs/CHAINLINK_ZKML_LLM_ROUTER_RUNBOOK.md
- Acceptance: Environment examples document consensus mode, peer list, operator identity, receipt path, fail-closed behavior, CRE workflow settings, verifier contract settings, and proof backend gates without adding secrets.

## CLZKML-310 Adversarial Consensus Tests
- Status: completed
- Completion: evidence
- Priority: P2
- Track: quality
- Depends on: CLZKML-130, CLZKML-180
- Outputs: tests/test_llm_consensus_adversarial.py
- Validation: pytest tests/test_llm_consensus_adversarial.py -q
- Acceptance: Tests cover divergent outputs, equivocation, duplicate operator IDs, replayed signatures, stale deadlines, malformed JSON, proof mismatch, CRE workflow mismatch, timeout races, and quorum ties.

## CLZKML-320 Backward Compatibility And Import Quietness
- Status: completed
- Completion: evidence
- Priority: P2
- Track: quality
- Depends on: CLZKML-100, CLZKML-140, CLZKML-200
- Outputs: tests/test_llm_router_consensus.py
- Validation: pytest tests/test_llm_router_consensus.py -q
- Acceptance: Importing `ipfs_accelerate_py` and `ipfs_accelerate_py.llm_router` has no network, Chainlink, libp2p, ZKML, TEE, provider, or filesystem side effects, and existing `generate_text` tests or smoke calls remain unchanged.

## CLZKML-330 Documentation Examples
- Status: completed
- Completion: artifact
- Priority: P3
- Track: ops
- Depends on: CLZKML-100
- Outputs: ipfs_accelerate_py/README.md, docs/CHAINLINK_ZKML_LLM_ROUTER_RUNBOOK.md
- Validation: test -f docs/CHAINLINK_ZKML_LLM_ROUTER_RUNBOOK.md
- Acceptance: README and runbook examples show receipt-only local consensus, libp2p quorum, CRE-verified consensus, and proof-policy configuration with warnings about deterministic parameters and high-impact fail-closed behavior.

## CLZKML-340 Release Signoff Checklist
- Status: completed
- Completion: artifact
- Priority: P3
- Track: ops
- Depends on: CLZKML-285, CLZKML-290, CLZKML-300, CLZKML-310, CLZKML-320, CLZKML-330
- Outputs: docs/CHAINLINK_ZKML_LLM_ROUTER_RELEASE_CHECKLIST.md
- Validation: test -f docs/CHAINLINK_ZKML_LLM_ROUTER_RELEASE_CHECKLIST.md
- Acceptance: The release checklist captures backend test commands, full-stack and UX Playwright evidence, required env vars, unsupported downgrade paths, operator identity assumptions, proof-policy limitations, Chainlink CRE deployment evidence, frontend no-leak evidence, and residual risks before enabling consensus for production high-impact routes.
