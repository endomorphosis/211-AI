# ProveKit ZKP Logic Todo

This backlog is the executable implementation queue for
`docs/PROVEKIT_ZKP_LOGIC_IMPLEMENTATION_PLAN.md`.

The ProveKit implementation daemon can consume this file with:

```bash
python scripts/provekit_implementation_daemon.py --once --no-implement
```

For a foreground autonomous run that invokes implementation agents and exits
when all parsed tasks are complete, use:

```bash
python scripts/provekit_implementation_supervisor.py --implement --until-complete
```

For a long-running background service managed by the shared implementation
service manager, use:

```bash
python scripts/manage_implementation_services.py start provekit --implement
```

In a shared dirty checkout where follow-up tasks must build on uncommitted
agent work, run the same persistent background loop in-place:

```bash
python scripts/manage_implementation_services.py start provekit --implement --no-ephemeral-worktree
```

Priority guide:

- `P0`: foundation, safety, or production blocker work
- `P1`: required integration, bridge, cache, or test coverage work
- `P2`: performance, FFI, recursive/on-chain, or hardening follow-up
- `P3`: polish or optional refinement

Track guide:

- `platform`: logic, circuits, bridge contracts, and theorem-prover integration
- `runtime`: backend execution, subprocess/FFI, proof envelopes, and APIs
- `privacy`: witness boundaries, no-leak tests, public-input discipline
- `quality`: unit, integration, golden-vector, and regression coverage
- `ops`: build, packaging, availability, readiness, and signoff
- `wallet`: downstream wallet/verifier interoperability
- `ui`: wallet_interface React surfaces, TypeScript proof receipt mapping, and Playwright workflows

## PROVEKIT-000 Control Plane And Backlog
- Status: completed
- Completion: artifact
- Priority: P0
- Track: ops
- Depends on: none
- Outputs: docs/PROVEKIT_ZKP_LOGIC_IMPLEMENTATION_PLAN.md, docs/PROVEKIT_ZKP_LOGIC_TODO.md
- Validation: test -f docs/PROVEKIT_ZKP_LOGIC_IMPLEMENTATION_PLAN.md; test -f docs/PROVEKIT_ZKP_LOGIC_TODO.md
- Acceptance: The ProveKit implementation plan and daemon-consumable backlog exist, use the `PROVEKIT-` task prefix, and can be parsed by the shared implementation daemon with a custom todo path and task prefix.

## PROVEKIT-010 Upstream ProveKit Spike And Pin
- Status: completed
- Completion: artifact
- Priority: P0
- Track: ops
- Depends on: PROVEKIT-000
- Outputs: artifacts/provekit-spike/README.md, artifacts/provekit-spike/provekit-v1-smoke.json
- Validation: test -f artifacts/provekit-spike/README.md; test -f artifacts/provekit-spike/provekit-v1-smoke.json
- Acceptance: A local ProveKit `v1` checkout or binary is identified, the upstream basic example has documented `prepare`, `prove`, and `verify` results, and the chosen ProveKit commit, binary path, proof size, key size, command syntax, and runtime measurements are recorded.

## PROVEKIT-020 Public Input And Canonicalization Contract Audit
- Status: completed
- Completion: artifact
- Priority: P0
- Track: quality
- Depends on: PROVEKIT-000
- Outputs: ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/public_inputs.py, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_public_inputs.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_public_inputs.py -q
- Acceptance: Existing theorem hash, axiom commitment, circuit ref, ruleset, compiler guidance, and attestation fields are mapped into ProveKit-compatible public input records without changing existing simulated or Groth16 public-input semantics.

## PROVEKIT-030 ProveKit CLI Wrapper Skeleton
- Status: completed
- Completion: artifact
- Priority: P0
- Track: runtime
- Depends on: PROVEKIT-010
- Outputs: ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/cli.py, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_cli_wrapper.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_cli_wrapper.py -q
- Acceptance: The CLI wrapper discovers ProveKit from explicit environment variables or package paths, builds `prepare`, `prove`, and `verify` subprocess commands, enforces timeouts, captures structured failures, and never logs witness content.

## PROVEKIT-040 Backend Registry And Fail-Closed Backend
- Status: completed
- Completion: artifact
- Priority: P0
- Track: runtime
- Depends on: PROVEKIT-030
- Outputs: ipfs_datasets_py/ipfs_datasets_py/logic/zkp/backends/provekit.py, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_backend.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_backend_selection.py ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_backend.py -q
- Acceptance: `get_backend("provekit")` and aliases instantiate a lazy fail-closed backend, unavailable binaries or missing artifacts raise `ZKPError`, and normal `ipfs_datasets_py.logic.api` imports remain quiet and deterministic.

## PROVEKIT-050 Artifact Manifest And Key Discovery
- Status: completed
- Completion: artifact
- Priority: P0
- Track: ops
- Depends on: PROVEKIT-030
- Outputs: ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/artifacts.py, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_artifacts.py, ipfs_datasets_py/ipfs_datasets_py/processors/provekit_backend/README.md
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_artifacts.py -q
- Acceptance: ProveKit `.pkp`, `.pkv`, Noir package, hash backend, branch, commit, and digest metadata are represented by a deterministic artifact manifest, and missing or mismatched key hashes fail closed.

## PROVEKIT-060 Knowledge-Of-Axioms Noir Circuit Package
- Status: completed
- Completion: artifact
- Priority: P0
- Track: platform
- Depends on: PROVEKIT-020, PROVEKIT-050
- Outputs: ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/circuits/knowledge_of_axioms/Nargo.toml, ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/circuits/knowledge_of_axioms/src/main.nr, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_knowledge_of_axioms_circuit.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_knowledge_of_axioms_circuit.py -q
- Acceptance: A first Noir circuit binds theorem hash, axiom commitment, circuit ref, circuit version, and ruleset ID for the knowledge-of-axioms proof family without asserting unbounded theorem derivability.

## PROVEKIT-070 Prover Witness Serializer And No-Leak Temp Handling
- Status: completed
- Completion: artifact
- Priority: P0
- Track: privacy
- Depends on: PROVEKIT-020, PROVEKIT-030, PROVEKIT-060
- Outputs: ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/witness.py, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_witness_no_leak.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_witness_no_leak.py -q
- Acceptance: Private axioms and derivation witnesses are rendered into ProveKit input files only inside private temporary directories, all temp files are cleaned up, and serialized proof, cache, logs, and exceptions contain no private axiom text.

## PROVEKIT-080 ProveKit Proof Envelope And Attestation Compatibility
- Status: completed
- Completion: artifact
- Priority: P0
- Track: runtime
- Depends on: PROVEKIT-040, PROVEKIT-070
- Outputs: ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_attestation_envelope.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_attestation_envelope.py -q
- Acceptance: The ProveKit backend returns existing `ZKPProof` envelopes with `.np` proof bytes, public inputs, ProveKit metadata, size, timestamp, and a fresh attestation view that passes the existing attestation consistency checks.

## PROVEKIT-090 Real CLI Prepare-Prove-Verify Integration Gate
- Status: completed
- Completion: artifact
- Priority: P0
- Track: quality
- Depends on: PROVEKIT-040, PROVEKIT-050, PROVEKIT-060, PROVEKIT-070, PROVEKIT-080
- Outputs: ipfs_datasets_py/tests/integration/test_provekit_zkp.py, artifacts/provekit-integration/README.md
- Validation: pytest ipfs_datasets_py/tests/integration/test_provekit_zkp.py -q
- Acceptance: When `IPFS_DATASETS_RUN_PROVEKIT_TESTS=1` and a ProveKit binary is configured, the integration test prepares keys, generates a real proof, verifies it through ProveKit, serializes it through `ZKPProof`, and verifies that disabled or unavailable environments skip or fail closed as intended.

## PROVEKIT-100 TDFOL Trace Schema And Python Prevalidation
- Status: completed
- Completion: artifact
- Priority: P1
- Track: platform
- Depends on: PROVEKIT-020, PROVEKIT-090
- Outputs: ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/trace.py, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_tdfol_trace_schema.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_tdfol_trace_schema.py -q
- Acceptance: A bounded TDFOL trace witness schema is defined, Python-side validation rejects non-derivable traces before proving, and the schema reuses existing canonicalization and `TDFOL_v1` semantics.

## PROVEKIT-110 TDFOL V1 Trace Noir Circuit
- Status: completed
- Completion: artifact
- Priority: P1
- Track: platform
- Depends on: PROVEKIT-100
- Outputs: ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/circuits/tdfol_v1_trace/Nargo.toml, ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/circuits/tdfol_v1_trace/src/main.nr, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_tdfol_trace_circuit.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_tdfol_trace_circuit.py -q
- Acceptance: The Noir trace circuit proves bounded fact and implication/modus-ponens derivation traces against public theorem and axiom commitments, and invalid traces fail before proof generation or fail verification.

## PROVEKIT-120 ZKP Attestation Bridge ProveKit Wiring
- Status: completed
- Completion: artifact
- Priority: P1
- Track: platform
- Depends on: PROVEKIT-080, PROVEKIT-110
- Outputs: ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_zkp_attestation_bridge.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_zkp_attestation_bridge.py -q
- Acceptance: `ZkpAttestationBridgeAdapter(prover_kwargs={"backend": "provekit"})` emits verified LegalIR ZKP attestation records, public inputs, proof-gate details, and graph triples while preserving the existing bridge output shape.

## PROVEKIT-130 Hybrid TDFOL CEC And F-Logic Compatibility
- Status: completed
- Completion: artifact
- Priority: P1
- Track: platform
- Depends on: PROVEKIT-120
- Outputs: ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_hybrid_provers.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_hybrid_provers.py -q
- Acceptance: `ZKPTDFOLProver`, `ZKPCECProver`, and `ZKPFLogicProver` can select `zkp_backend="provekit"` through their existing constructors, verify generated proof envelopes, and retain standard proving fallback behavior where allowed.

## PROVEKIT-140 Deontic LegalNormIR Guidance Commitments
- Status: completed
- Completion: artifact
- Priority: P1
- Track: privacy
- Depends on: PROVEKIT-120
- Outputs: ipfs_datasets_py/tests/unit_tests/logic/deontic/test_deontic_provekit_bridge.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/deontic/test_deontic_provekit_bridge.py -q
- Acceptance: Deontic `LegalNormIR`, parser capability records, prover syntax readiness, and repair/compiler guidance metadata flow into stable public commitments and `compiler_guidance_ref` fields without exposing private legal text or parser witness data.

## PROVEKIT-150 Proof Cache And IPFS Public Payload Hardening
- Status: completed
- Completion: artifact
- Priority: P1
- Track: privacy
- Depends on: PROVEKIT-080, PROVEKIT-120
- Outputs: ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_cache_ipfs_payloads.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_cache_ipfs_payloads.py -q
- Acceptance: Proof cache keys include ProveKit backend ID, circuit ref, hash backend, verifier-key digest, ProveKit commit, and ruleset; IPFS/cache payloads contain only public proof envelopes and artifact references.

## PROVEKIT-160 Optional Dependency Packaging And Build Script
- Status: todo
- Completion: artifact
- Priority: P1
- Track: ops
- Depends on: PROVEKIT-050, PROVEKIT-090
- Outputs: ipfs_datasets_py/ipfs_datasets_py/processors/provekit_backend/build.sh, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_optional_dependencies.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_optional_dependencies.py -q
- Acceptance: A `provekit` optional dependency/build path is documented and test-covered, package data rules cover approved backend assets, and no Rust build, network clone, or artifact preparation runs at import time.

## PROVEKIT-170 Ops Readiness And Backend Health Checks
- Status: completed
- Completion: artifact
- Priority: P1
- Track: ops
- Depends on: PROVEKIT-150, PROVEKIT-160
- Outputs: docs/PROVEKIT_ZKP_OPERATIONS.md, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_backend_health.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_backend_health.py -q; test -f docs/PROVEKIT_ZKP_OPERATIONS.md
- Acceptance: Operators can check ProveKit binary availability, artifact integrity, circuit manifests, backend enablement, and fail-closed readiness from documented commands without exposing witness material.

## PROVEKIT-180 Golden Vector And Property Test Suite
- Status: todo
- Completion: artifact
- Priority: P1
- Track: quality
- Depends on: PROVEKIT-060, PROVEKIT-110, PROVEKIT-140
- Outputs: ipfs_datasets_py/tests/unit_tests/logic/zkp/provekit_golden_vectors.json, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_golden_vectors.py, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_properties.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_golden_vectors.py ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_properties.py -q
- Acceptance: Golden vectors cover theorem canonicalization, axiom commitments, Prover.toml rendering, public inputs, attestation refs, and verifier-key digests; property tests cover determinism and failure cases.

## PROVEKIT-190 ProveKit FFI Feasibility And Wrapper Prototype
- Status: completed
- Completion: artifact
- Priority: P2
- Track: runtime
- Depends on: PROVEKIT-090, PROVEKIT-160
- Outputs: ipfs_datasets_py/ipfs_datasets_py/logic/zkp/backends/provekit_ffi.py, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_ffi_wrapper.py
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_ffi_wrapper.py -q
- Acceptance: A ctypes wrapper prototypes `pk_init`, memory configuration, prover/verifier loading, proving, verification, error retrieval, and buffer cleanup behind a process-local lock, while CLI remains the default production path.

## PROVEKIT-200 Recursive Gnark And On-Chain Evaluation
- Status: completed
- Completion: artifact
- Priority: P2
- Track: wallet
- Depends on: PROVEKIT-090
- Outputs: docs/PROVEKIT_RECURSIVE_ONCHAIN_EVALUATION.md, ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_recursive_export_contract.py
- Validation: test -f docs/PROVEKIT_RECURSIVE_ONCHAIN_EVALUATION.md; pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_recursive_export_contract.py -q
- Acceptance: The team has a documented decision on ProveKit recursive verifier/Gnark export, whether it should integrate with the existing Groth16/EVM verifier path, and which tests are required before any on-chain ProveKit route is production-exposed.

## PROVEKIT-210 Security Review And Threat Model
- Status: completed
- Completion: artifact
- Priority: P1
- Track: privacy
- Depends on: PROVEKIT-150, PROVEKIT-170
- Outputs: docs/PROVEKIT_ZKP_SECURITY_NOTES.md
- Validation: test -f docs/PROVEKIT_ZKP_SECURITY_NOTES.md
- Acceptance: The security notes distinguish simulated, Groth16, ProveKit WHIR, and future recursive wrapper claims; document no-leak boundaries, artifact trust, cache/IPFS risks, verifier-key rotation, failure modes, and production cutover requirements.

## PROVEKIT-220 End-To-End ProveKit ZKP Signoff
- Status: completed
- Completion: evidence
- Priority: P0
- Track: ops
- Depends on: PROVEKIT-130, PROVEKIT-140, PROVEKIT-150, PROVEKIT-170, PROVEKIT-180, PROVEKIT-210
- Outputs: docs/PROVEKIT_ZKP_TARGET_SIGNOFF.md, artifacts/provekit-release-checks/results.json
- Validation: pytest ipfs_datasets_py/tests/unit_tests/logic/zkp -q; pytest ipfs_datasets_py/tests/unit_tests/logic/deontic/test_deontic_provekit_bridge.py -q; test -f docs/PROVEKIT_ZKP_TARGET_SIGNOFF.md
- Acceptance: A target environment demonstrates real ProveKit proof generation and verification for supported circuits, bridge integration, hybrid prover selection, deontic guidance commitments, cache/IPFS public payload safety, and documented rollback/readiness evidence.

## PROVEKIT-230 Wallet UI Proof Workflow Matrix And Fixtures
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: PROVEKIT-220
- Outputs: docs/PROVEKIT_ZKP_WALLET_UI_WORKFLOW_MATRIX.md, wallet_interface/ui/tests/fixtures/provekit-proof-fixtures.ts
- Validation: python scripts/provekit_implementation_daemon.py --once --no-implement --todo-path docs/PROVEKIT_ZKP_LOGIC_TODO.md --task-prefix "## PROVEKIT-" --state-dir data/provekit_implementation/state --state-prefix provekit; npm --prefix wallet_interface/ui run build
- Acceptance: The matrix maps Proof Center, Wallet/uploads, QR review, Security/audit, provider eligibility/case proofs, public analytics/proof dashboards, and export/import to backend routes, proof systems, error states, labels, privacy assertions, and desktop/mobile Playwright coverage; fixtures include simulated, Groth16, ProveKit WHIR, recursive, disabled, artifact-hash-mismatch, stale-verifier-key, verification-failure, and witness-sentinel cases.

## PROVEKIT-240 Wallet API ProveKit Proof Contract Regression
- Status: completed
- Completion: evidence
- Priority: P1
- Track: wallet
- Depends on: PROVEKIT-220, PROVEKIT-230
- Outputs: tests/test_wallet_interface_api.py, tests/test_wallet_interface_proof_backends.py
- Validation: pytest tests/test_wallet_interface_api.py tests/test_wallet_interface_proof_backends.py -q
- Acceptance: Wallet API regression tests cover ProveKit proof receipt mapping, disabled/unavailable backend responses, artifact hash mismatch, stale verifier key, verification failure, cache hit/miss metadata, simulated-proof overclaim prevention, QR/export proof metadata sanitization, audit event proof-system metadata, and no witness/private-axiom leakage.

## PROVEKIT-250 Frontend ProveKit Proof UI Surfaces
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: PROVEKIT-230, PROVEKIT-240
- Outputs: wallet_interface/ui/src/services/walletApi.ts, wallet_interface/ui/src/app/App.tsx, wallet_interface/ui/src/styles/global.css, wallet_interface/ui/tests/smoke.spec.ts
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
- Acceptance: TypeScript proof mappers and UI surfaces preserve exact proof-system labels and states; proof cards, QR review, Security/audit, provider, public-dashboard, and export/import views distinguish simulated, Groth16, ProveKit WHIR, and recursive-wrapper proofs, fail closed on disabled/error states, avoid on-chain overclaiming, and never render witness/private-axiom content.

## PROVEKIT-260 Full-Stack ProveKit Playwright Harness
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: PROVEKIT-250
- Outputs: wallet_interface/ui/tests/provekit-proof-fullstack.spec.ts, wallet_interface/ui/tests/fixtures/provekit-proof-fixtures.ts
- Validation: pytest tests/test_wallet_interface_api.py tests/test_wallet_interface_proof_backends.py -q; npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/provekit-proof-fullstack.spec.ts
- Acceptance: Playwright launches the live Abby UI and wallet API with deterministic proof backend or mock ProveKit receipts, then verifies proof creation/listing, QR review, export/import, audit refresh, provider/public surfaces, disabled/unavailable/artifact-mismatch/error states, and no witness/private-axiom leakage.

## PROVEKIT-270 Cross-Surface ProveKit UX Accessibility And No-Leak Review
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: PROVEKIT-260
- Outputs: wallet_interface/ui/tests/provekit-proof-ux.spec.ts, wallet_interface/ui/tests/wallet-ux-review.spec.ts, artifacts/provekit-ui-review
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/provekit-proof-ux.spec.ts; npm --prefix wallet_interface/ui test -- tests/wallet-ux-review.spec.ts
- Acceptance: Desktop Chrome, Mobile Chrome, and Mobile Safari coverage verifies proof label clarity, keyboard focus, touch ergonomics, no overflow or overlap, no legal/cryptographic overclaim, no witness/private-axiom leakage in screenshots/traces/downloads, and archived review artifacts under `artifacts/provekit-ui-review`.

## PROVEKIT-280 Wallet UI Signoff Addendum
- Status: completed
- Completion: evidence
- Priority: P0
- Track: ops
- Depends on: PROVEKIT-220, PROVEKIT-270
- Outputs: docs/PROVEKIT_ZKP_TARGET_SIGNOFF.md, artifacts/provekit-ui-signoff
- Validation: test -f docs/PROVEKIT_ZKP_TARGET_SIGNOFF.md; test -d artifacts/provekit-ui-signoff
- Acceptance: The ProveKit signoff includes the original backend evidence plus wallet API contract results, full-stack Playwright results, UX/accessibility review evidence, QR/export no-leak evidence, proof-system label review, and an explicit production-visible rollout decision before clients can attach ProveKit-backed proof identity to wallet files.
