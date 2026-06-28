# ProveKit ZKP Logic Implementation Plan

Date: 2026-06-14

## Objective

Integrate World Foundation ProveKit as a real zero-knowledge proving backend for
`ipfs_datasets_py.logic`, while preserving the existing deontic, TDFOL, CEC,
F-logic, bridge, cache, IPFS, and proof-attestation APIs.

The core design decision is to add ProveKit as another `logic.zkp` backend, not
to replace the theorem provers. The theorem provers continue to decide what is
derivable. ProveKit proves bounded, circuit-encoded statements about those
derivations without exposing private axioms, policy text, or knowledge-base
witnesses.

## Upstream ProveKit Facts To Build Around

Source: https://github.com/worldfnd/provekit, checked 2026-06-13.

- ProveKit compiles Noir programs to R1CS and generates/verifies WHIR proofs
  using a Spartan-based protocol.
- The stable integration target is the `v1` branch; upstream marks `main` as
  active development with possible breaking key/proof formats.
- The CLI path is `prepare`, `prove`, `verify`.
- `prepare` writes `.pkp` prover keys and `.pkv` verifier keys.
- `prove` reads a `.pkp` and a `Prover.toml` input file and writes `proof.np`.
- `verify` reads a `.pkv` and a proof file.
- `prepare --hash` supports `skyscraper`, `sha256`, `keccak`, `blake3`, and
  `poseidon2`; upstream defaults to `skyscraper`.
- ProveKit includes a C-compatible FFI with file and in-memory proving APIs, but
  the FFI documentation says calls are not guaranteed thread-safe.
- ProveKit has recursive-verifier/Gnark support for cases where an on-chain
  Groth16 wrapper is required.

## Existing Local Architecture

Relevant local files:

- `ipfs_datasets_py/ipfs_datasets_py/logic/zkp/backends/__init__.py`
  defines the `ZKBackend` protocol and lazy `get_backend()` registry.
- `logic/zkp/zkp_prover.py` and `logic/zkp/zkp_verifier.py` are the public
  backend-neutral entry points.
- `logic/zkp/__init__.py` intentionally keeps import-time behavior lightweight
  and labels the current simulated API as non-production.
- `logic/zkp/backends/simulated.py` emits `ZKPProof` objects with standardized
  public inputs and attestation views.
- `logic/zkp/backends/groth16.py` and `groth16_ffi.py` provide a fail-closed
  Rust-backed Groth16 backend.
- `logic/zkp/circuits.py`, `statement.py`, and `canonicalization.py` define
  the stable public-input schema, circuit refs, commitments, and attestation
  views.
- `logic/bridge/zkp_attestation.py` converts formula records into proof
  attestation LegalIR views and graph triples.
- `logic/TDFOL/zkp_integration.py`,
  `logic/CEC/native/cec_zkp_integration.py`, and
  `logic/flogic/flogic_zkp_integration.py` already support hybrid standard/ZKP
  proving through a backend name.
- `logic/deontic/converter.py`, `logic/deontic/ir.py`, and
  `logic/deontic/prover_syntax.py` produce structured LegalNormIR, formula
  records, proof readiness signals, and prover-target syntax diagnostics.
- `logic/common/proof_cache.py` and `logic/integration/caching/ipfs_proof_cache.py`
  provide CID/IPFS-compatible proof caching.

This means ProveKit can be integrated with limited public API churn by matching
the existing backend protocol and proof-envelope shape.

## Target Architecture

Add a ProveKit backend under the existing ZKP backend boundary:

- `logic/zkp/backends/provekit.py`
  Implements `ZKBackend`:
  - `backend_id = "provekit"`
  - `generate_proof(theorem, private_axioms, metadata) -> ZKPProof`
  - `verify_proof(proof) -> bool`
  - fails closed if the CLI/library, circuit artifacts, `.pkp`, or `.pkv` are
    missing or disabled.
- `logic/zkp/backends/provekit_cli.py`
  Subprocess wrapper around the ProveKit CLI:
  - discover binary from `IPFS_DATASETS_PROVEKIT_BINARY`, `PROVEKIT_BINARY`, or
    packaged build locations.
  - run `prepare`, `prove`, `verify`.
  - enforce timeouts, structured errors, temp-dir cleanup, and no witness logs.
- `logic/zkp/provekit/`
  Local ProveKit support package:
  - `artifacts.py`: key/proof artifact manifest, checksums, version metadata.
  - `public_inputs.py`: maps existing public-input schema to Noir inputs.
  - `witness.py`: builds private `Prover.toml` from canonical theorem, axioms,
    and optional derivation traces.
  - `circuits/`: Noir packages for supported circuit families.
- `processors/provekit_backend/`
  Build/install helper location, mirroring the existing Groth16 backend style:
  - `build.sh`
  - pinned ProveKit source/release metadata
  - generated artifacts only when intentionally built or packaged.

Register backend aliases in `get_backend()`:

- `provekit`
- `provekit-whir`
- optionally `whir`

Do not make ProveKit import or build during normal `logic.api` import.

## Proof Envelope Compatibility

The ProveKit backend should return the existing `ZKPProof` dataclass shape:

- `proof_data`: raw `.np` bytes, or a compact JSON envelope containing `.np`
  bytes plus artifact refs if we need multiple files.
- `public_inputs`:
  - `theorem`
  - `theorem_hash`
  - `axioms_commitment`
  - `circuit_ref`
  - `circuit_version`
  - `ruleset_id`
  - optional `compiler_guidance_ref`
  - optional `compiler_guidance_version`
  - derived `attestation_ref`
  - derived `attestation_view_version`
- `metadata`:
  - `backend = "provekit"`
  - `proof_system = "ProveKit-WHIR"`
  - `provekit_branch = "v1"`
  - `provekit_commit`
  - `provekit_cli_version` if exposed
  - `hash_backend`
  - `pkp_sha256`
  - `pkv_sha256`
  - `noir_package_hash`
  - `attestation_view`
- `timestamp`
- `size_bytes`

Private witness material must never be stored in `metadata`, `public_inputs`,
LegalIR views, IPFS proof cache payloads, or logs.

## Wallet API And UI Workflow Gap Review

The backend signoff proves that ProveKit can generate, verify, cache, and
attest supported ZKP envelopes. It does not by itself prove that user-facing
wallet workflows expose those proofs accurately. A separate wallet/UI addendum
is required before ProveKit-backed proofs are production-visible to clients,
providers, or public dashboards.

Required wallet surfaces:

- Proof Center proof creation, capability preview, and proof receipt cards.
- Wallet/uploads proof receipts, saved wallet proof bundles, and QR bundle
  review.
- Security, audit, and transparency-log views that explain proof status.
- Provider eligibility, case, and zero-knowledge certificate workflows.
- Public analytics and proof dashboards that summarize proof coverage.
- Export/import flows for proof bundles, attestations, and wallet files.

Required UI states:

- `simulated`, `groth16`, `provekit`, and future
  `provekit_recursive_groth16` proof systems must have distinct labels and
  claim language.
- Backend disabled, backend unavailable, artifact hash mismatch, stale
  verifier key, proof pending, verification success, verification failure,
  cache hit/miss, and on-chain unsupported/manual fallback states must be
  visible without leaking witness material.
- ProveKit WHIR proofs must not be labeled as Groth16, EVM-verifiable, or
  on-chain-ready unless the recursive wrapper path has independent evidence.
- Simulated proofs must remain visibly non-production and must not be counted as
  production ProveKit evidence.

Required contract and Playwright coverage:

- Wallet API proof receipts must preserve backend metadata, public inputs,
  verifier IDs, artifact refs, and verification status while redacting private
  axioms, witness labels that reveal private facts, and raw witness content.
- TypeScript mappers must round-trip ProveKit receipts from the API into the
  UI's internal proof receipt shape without replacing the proof system with
  generic `unknown` or `simulated` labels.
- Full-stack Playwright tests must launch the wallet API and Abby UI with a
  deterministic proof backend or mock ProveKit receipts, then verify proof
  creation/listing, QR review, export/import, audit refresh, provider/public
  surfaces, disabled/error states, and no witness leakage across desktop and
  mobile projects.

## Circuit Strategy

### Circuit Family 1: Knowledge Of Axioms

Circuit ref: `provekit_knowledge_of_axioms@v1`.

Purpose:

- prove knowledge of private axioms whose commitment matches public
  `axioms_commitment`.
- bind the proof to public `theorem_hash`, `ruleset_id`, and `circuit_ref`.

This is the ProveKit replacement for the current simulated proof-attestation
path. It does not claim full theorem derivation yet; it proves witness
possession and commitment binding.

### Circuit Family 2: TDFOL V1 Derivation Trace

Circuit ref: `provekit_tdfol_v1_trace@v1`.

Purpose:

- prove that a bounded TDFOL derivation trace derives the public theorem from
  committed private axioms.
- start with the local semantics already present in
  `logic/zkp/legal_theorem_semantics.py` and
  `logic/zkp/canonicalization.py`.
- support simple facts and implication/modus-ponens traces first.

Required guardrail:

- before proving, the Python side must derive or validate the trace with the
  existing TDFOL prover/semantic helper.
- ProveKit proves the bounded trace constraints; it should not be treated as an
  unbounded theorem prover.

### Circuit Family 3: LegalNormIR/Deontic Attestation

Circuit ref: `provekit_legal_norm_ir_attestation@v1`.

Purpose:

- bind a deontic `LegalNormIR` export to source-grounded parser slots,
  formula records, proof-ready diagnostics, and `compiler_guidance_ref`.
- hide sensitive source clauses or policy context when needed.

This preserves the existing deontic theorem-proving system: deontic parsing,
prover-syntax readiness, and CEC/TDFOL translation remain outside the circuit.
The circuit attests that the private IR/witness corresponds to the public
commitments and guidance refs.

### Circuit Family 4: Recursive/On-Chain Wrapper

Circuit ref: future `provekit_recursive_groth16_wrapper@v1`.

Purpose:

- use ProveKit's recursive verifier export when an EVM/Groth16 verification
  path is required.
- keep the existing Groth16/EVM pipeline as the default on-chain route until
  recursive ProveKit artifacts have their own verifier contract tests.

## Hash And Field Encoding Policy

Initial recommendation:

- use ProveKit `prepare --hash sha256` for compatibility with existing
  `theorem_hash` and `axioms_commitment` semantics where feasible.
- where Noir field constraints require field elements, encode SHA-256 digests
  as BN254 scalar field elements using the existing `Statement.to_field_elements`
  policy.
- do not silently switch existing public commitments to Poseidon/Skyscraper.

Future optimization:

- add Poseidon2/Skyscraper-native commitments as a new circuit version, not as
  a mutation of existing public-input semantics.

## Integration Flow

### Deontic Text To Private ProveKit Proof

1. `DeonticConverter.convert(text)` extracts `LegalNormIR`, formula records,
   proof readiness, parser capability records, and prover syntax coverage.
2. `FolTdfolBridgeAdapter` or `CecDcecBridgeAdapter` converts proof-ready
   records to TDFOL/CEC proof obligations.
3. The native/external theorem prover validates derivability and emits a
   bounded derivation trace or proof signal.
4. `ZkpAttestationBridgeAdapter(prover_kwargs={"backend": "provekit"})`
   builds public inputs and private witness.
5. `ZKPProver(backend="provekit")` calls the ProveKit backend.
6. The ProveKit backend writes `Prover.toml`, calls `prove`, reads `proof.np`,
   computes attestation metadata, and returns `ZKPProof`.
7. `ZKPVerifier(backend="provekit")` calls `verify` using the matching `.pkv`.
8. The bridge publishes only public attestation views and graph triples.

### TDFOL/CEC/F-logic Hybrid Provers

Existing constructors already pass backend names through:

- `ZKPTDFOLProver(..., zkp_backend="provekit")`
- `ZKPCECProver(..., zkp_backend="provekit")`
- `ZKPFLogicProver(..., zkp_backend="provekit")`

The implementation work is mostly backend availability, witness shaping, and
tests. Avoid changing these classes unless they currently call verifier methods
that do not exist on `ZKPVerifier`; fix those as compatibility defects while
keeping behavior backward compatible.

## Artifact Management

Create deterministic artifact manifests for every prepared circuit:

```json
{
  "schema": "provekit-artifact-manifest-v1",
  "circuit_ref": "provekit_tdfol_v1_trace@v1",
  "hash_backend": "sha256",
  "provekit_branch": "v1",
  "provekit_commit": "<commit>",
  "noir_package_hash": "<sha256>",
  "pkp_path": ".../prover.pkp",
  "pkp_sha256": "<sha256>",
  "pkv_path": ".../verifier.pkv",
  "pkv_sha256": "<sha256>",
  "created_at": "<iso8601>"
}
```

Use this manifest in cache keys and attestation metadata. If the `.pkv` digest
changes, cached proofs must miss.

## Configuration

Environment variables:

- `IPFS_DATASETS_ENABLE_PROVEKIT=1`: enable real ProveKit backend.
- `IPFS_DATASETS_PROVEKIT_BINARY=/path/to/provekit-cli`: explicit CLI path.
- `PROVEKIT_BINARY=/path/to/provekit-cli`: compatibility alias.
- `IPFS_DATASETS_PROVEKIT_ARTIFACT_DIR=/path`: prepared key/artifact root.
- `IPFS_DATASETS_PROVEKIT_TIMEOUT_SECONDS=60`: subprocess timeout.
- `IPFS_DATASETS_PROVEKIT_HASH=sha256`: default `prepare --hash`.

Default behavior:

- backend registration is visible, but proof generation fails closed if ProveKit
  is unavailable.
- no automatic network clone, Rust build, or circuit preparation at import time.

## Optional Dependency And Packaging Plan

Add a `provekit` optional extra in `ipfs_datasets_py/pyproject.toml` for Python
side dependencies only. Do not assume Rust build tools are always present.

Packaging options:

1. Development mode:
   - build ProveKit from a pinned `v1` checkout.
   - configure `IPFS_DATASETS_PROVEKIT_BINARY`.
2. Packaged binary mode:
   - package vetted `provekit-cli` binaries under
     `processors/provekit_backend/bin/<platform>/`.
   - include prepared circuit artifacts only when licensing, size, and security
     review allow it.
3. FFI mode:
   - package `provekit-ffi` as a native library.
   - add a ctypes wrapper only after CLI semantics are stable.

CLI mode is the first milestone. FFI mode is a performance and mobile
integration follow-up.

## FFI Follow-Up

After CLI-backed tests pass:

- add `logic/zkp/backends/provekit_ffi.py`.
- wrap:
  - `pk_init`
  - `pk_configure_memory`
  - `pk_load_prover`
  - `pk_load_verifier`
  - `pk_prove_inputs`
  - `pk_prove_toml`
  - `pk_verify`
  - `pk_free_buf`
  - `pk_get_last_error`
- protect calls with a process-local lock because upstream FFI is not
  guaranteed thread-safe.
- prefer in-memory inputs only after no-leak tests prove witnesses are not
  copied into logs, exceptions, or persisted temp files.

## Security Model

Security claims should be explicit:

- `simulated`: educational/demo only, never production.
- `groth16`: existing local Groth16 backend and EVM path.
- `provekit`: ProveKit WHIR proof of a supported Noir circuit.
- `provekit_recursive_groth16`: future recursive wrapper for on-chain Groth16.

Fail closed when:

- backend disabled.
- ProveKit binary/library unavailable.
- artifact manifest missing.
- `.pkp` or `.pkv` hash mismatch.
- public inputs do not match expected theorem/circuit/ruleset.
- verification command exits non-zero.
- proof attestation view does not match proof bytes and public inputs.

No-leak requirements:

- no private axioms in proof envelope.
- no private axioms in IPFS cache records.
- no private witness in exception messages.
- temporary `Prover.toml` files created under a private temp dir and deleted.
- debug logging redacts witness paths and contents.

## Implementation Phases

### Phase 0: Spike And Pin

Deliverables:

- build ProveKit `v1` locally.
- run upstream `noir-examples/basic` through `prepare`, `prove`, and `verify`.
- record exact commit, binary path, command syntax, proof/key sizes, and runtime.
- decide `sha256` vs `poseidon2` for the first local circuit.

Validation:

- manual command transcript archived under `artifacts/provekit-spike/`.

### Phase 1: Backend Skeleton

Deliverables:

- `logic/zkp/backends/provekit.py`
- `logic/zkp/backends/provekit_cli.py`
- backend metadata and aliases in `backends/__init__.py`
- fail-closed availability checks.

Validation:

- unit tests with fake CLI subprocess responses.
- unavailable backend raises `ZKPError`.
- `ZKPProver(backend="provekit")` and `ZKPVerifier(backend="provekit")`
  instantiate without import-time side effects.

### Phase 2: Knowledge-Of-Axioms Circuit

Deliverables:

- Noir package `provekit_knowledge_of_axioms`.
- artifact preparation helper.
- public-input and witness serializers.
- `proof_data` wrapping and attestation-view refresh.

Validation:

- gated integration test:
  - prepare circuit.
  - generate proof.
  - verify proof.
  - serialize/deserialize proof.
  - verify public attestation.
- no-leak test over proof dict, cache payload, logs, and errors.

### Phase 3: TDFOL Trace Circuit

Deliverables:

- bounded TDFOL derivation trace witness schema.
- Python trace validation before proving.
- Noir constraints for fact and implication/modus ponens trace steps.
- new circuit ref and artifact manifest.

Validation:

- valid trace proves and verifies.
- invalid theorem fails before proving or fails ProveKit verification.
- public inputs match existing canonicalization golden vectors.

### Phase 4: Bridge And Hybrid Prover Wiring

Deliverables:

- `ZkpAttestationBridgeAdapter` accepts `backend="provekit"` and reports
  `proof_system="ProveKit-WHIR"`.
- TDFOL/CEC/F-logic integration tests run with mocked ProveKit backend.
- deontic bridge tests confirm LegalNormIR/proof-ready metadata survives into
  `compiler_guidance_ref` and public attestation records.

Validation:

- bridge report has:
  - `status="ok"` when ProveKit verification succeeds.
  - `verified_by=("zkp:provekit",)` or equivalent.
  - graph triples include proof hash, theorem hash, axiom commitment, ruleset.

### Phase 5: Cache, IPFS, And Ops

Deliverables:

- cache key includes backend, circuit ref, hash backend, `.pkv` digest, ProveKit
  commit, and ruleset.
- optional IPFS artifact pinning for verifier keys and proof envelopes.
- install/build command documentation.
- ops checks for ProveKit availability and artifact integrity.

Validation:

- cache invalidates when `.pkv` changes.
- IPFS proof payload has no witness material.
- production readiness check fails if a production config requests simulated
  proofs.

### Phase 6: FFI Optimization

Deliverables:

- ctypes wrapper for `provekit-ffi`.
- locked FFI execution.
- memory/error handling tests.
- benchmark CLI vs FFI.

Validation:

- FFI and CLI produce verifier-accepted proofs for the same circuit and inputs.
- no leaked buffers; `pk_free_buf` always called.

### Phase 7: Recursive/On-Chain Evaluation

Deliverables:

- evaluate ProveKit `generate-gnark-inputs`.
- decide whether to add an EVM/Groth16 recursive wrapper.
- keep existing Groth16 verifier contracts as the production on-chain route
  until this is independently validated.

Validation:

- local recursive verifier smoke.
- contract ABI and public input tests if EVM support is adopted.

## Test Plan

Unit tests:

- backend registry lists `provekit` metadata.
- ProveKit backend unavailable path fails closed.
- CLI wrapper builds correct commands without leaking witness content.
- temp witness files are deleted.
- public inputs satisfy `ZKPVerifier._validate_public_inputs`.
- attestation view matches proof bytes.
- cache keys include ProveKit artifact hashes.
- bridge records expose only public fields.

Integration tests, gated by `IPFS_DATASETS_RUN_PROVEKIT_TESTS=1`:

- prepare/prove/verify `provekit_knowledge_of_axioms@v1`.
- prepare/prove/verify `provekit_tdfol_v1_trace@v1`.
- TDFOL hybrid proof with `zkp_backend="provekit"`.
- CEC bridge proof with mocked or real ProveKit, depending on runtime.
- deontic text to ZKP attestation bridge.

Wallet API contract tests:

- proof receipt shapes preserve `proof_system`, verifier, public inputs,
  artifact refs, and verification status for simulated, Groth16, ProveKit WHIR,
  and future recursive wrappers.
- backend disabled, unavailable binary, stale/mismatched artifact, verification
  failure, and cache hit/miss responses are deterministic and fail closed.
- QR/export/import payloads contain only public proof metadata and sanitized
  public inputs.
- audit events include proof system and verifier metadata without private
  witness data.

Frontend and Playwright tests:

- Proof Center, Wallet/uploads, QR review, Security/audit,
  provider-certificate, public-dashboard, and export/import workflows display
  distinct proof-system labels and failure states.
- full-stack Playwright runs against a live wallet API with deterministic proof
  fixtures for simulated, Groth16, ProveKit WHIR, recursive, disabled, and
  artifact-mismatch cases.
- desktop and mobile projects verify keyboard focus, no overflow or overlap,
  no legal/cryptographic overclaim, and no witness/private-axiom leakage in
  rendered text, downloads, QR bundles, traces, or screenshots.

Golden vectors:

- theorem canonicalization.
- axiom commitment.
- Prover.toml rendering.
- public inputs.
- proof attestation ref.
- verifier-key digest.

Security tests:

- invalid public theorem rejected.
- mismatched `.pkv` rejected.
- stale attestation ref rejected.
- malformed proof bytes rejected.
- production config rejects simulated backend.
- no private axiom strings in serialized proof/cache/log artifacts.

Performance tests:

- CLI cold prepare time.
- CLI prove time.
- verify time.
- proof size.
- FFI improvement after Phase 6.

## Files Expected To Change

Core:

- `ipfs_datasets_py/ipfs_datasets_py/logic/zkp/backends/__init__.py`
- `ipfs_datasets_py/ipfs_datasets_py/logic/zkp/backends/provekit.py`
- `ipfs_datasets_py/ipfs_datasets_py/logic/zkp/backends/provekit_cli.py`
- `ipfs_datasets_py/ipfs_datasets_py/logic/zkp/provekit/*`
- `ipfs_datasets_py/ipfs_datasets_py/logic/zkp/circuits.py`
- `ipfs_datasets_py/ipfs_datasets_py/logic/zkp/statement.py`
- `ipfs_datasets_py/ipfs_datasets_py/logic/bridge/zkp_attestation.py`
- `ipfs_datasets_py/ipfs_datasets_py/logic/submodule_registry.py`
- `ipfs_datasets_py/ipfs_datasets_py/logic/bridge/registry.py`
- `ipfs_datasets_py/pyproject.toml`

Tests:

- `ipfs_datasets_py/tests/unit_tests/logic/zkp/test_backend_selection.py`
- `ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_backend.py`
- `ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_public_inputs.py`
- `ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_no_leak.py`
- `ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_golden_vectors.py`
- `ipfs_datasets_py/tests/integration/test_provekit_zkp.py`
- bridge and deontic/TDFOL/CEC tests as needed.
- `tests/test_wallet_interface_api.py`
- `tests/test_wallet_interface_proof_backends.py`
- `wallet_interface/ui/tests/provekit-proof-fullstack.spec.ts`
- `wallet_interface/ui/tests/provekit-proof-ux.spec.ts`
- `wallet_interface/ui/tests/smoke.spec.ts`

Wallet/UI:

- `wallet_interface/proof_backends.py`
- `wallet_interface/ui/src/services/walletApi.ts`
- `wallet_interface/ui/src/app/App.tsx`
- `wallet_interface/ui/src/styles/global.css`
- `wallet_interface/ui/tests/fixtures/provekit-proof-fixtures.ts`

Docs/ops:

- `docs/PROVEKIT_ZKP_LOGIC_IMPLEMENTATION_PLAN.md`
- `docs/PROVEKIT_ZKP_WALLET_UI_WORKFLOW_MATRIX.md`
- optional `docs/PROVEKIT_ZKP_SECURITY_NOTES.md`
- optional `scripts/build_provekit_backend.sh`
- optional release/readiness checks.

## Compatibility Requirements

- Existing imports from `ipfs_datasets_py.logic.api` remain quiet and
  deterministic.
- Existing simulated tests continue to pass.
- Existing Groth16/EVM tests continue to pass.
- Existing `ZKPProof.to_dict()` consumers continue to work.
- Existing `ZkpAttestationBridgeAdapter` output shape remains compatible.
- Existing deontic, TDFOL, CEC, and F-logic theorem-proving features remain the
  semantic authority.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| ProveKit `main` changes formats | Pin `v1` branch or exact commit; store commit in artifact manifest. |
| Circuit semantics overclaim theorem proving | Keep Python theorem prover/trace validation as prerequisite; circuit proves bounded trace only. |
| Public-input hash mismatch | Use existing canonicalization helpers and golden vectors. |
| FFI thread-safety issues | Start with CLI; add process-local FFI lock later. |
| Witness leakage through temp files/logs | Private temp dirs, cleanup, redaction tests, no witness in exceptions. |
| Cache reuses proof across key changes | Include `.pkv` digest and circuit manifest hash in cache key. |
| On-chain verification confusion | Keep ProveKit WHIR separate from existing Groth16/EVM until recursive wrapper is validated. |
| Rust build friction | Support explicit binary path and optional packaged binaries; never build at import time. |

## Acceptance Criteria

The integration is complete when:

- `ZKPProver(backend="provekit")` can produce a real ProveKit proof for a
  supported circuit.
- `ZKPVerifier(backend="provekit")` verifies the proof through ProveKit.
- `ZkpAttestationBridgeAdapter(prover_kwargs={"backend": "provekit"})` emits a
  verified LegalIR proof attestation without witness leakage.
- TDFOL/CEC/F-logic hybrid provers can select `zkp_backend="provekit"`.
- Deontic parser/prover-readiness metadata is preserved into public
  commitments and compiler guidance refs.
- Proof cache/IPFS payloads contain only public proof envelopes and artifact
  references.
- Production readiness checks distinguish `simulated`, `groth16`, and
  `provekit` proof systems.
- CI has unit coverage for unavailable/fail-closed behavior and gated
  integration coverage for real ProveKit runs.
- Wallet API and UI surfaces distinguish simulated, Groth16, ProveKit WHIR, and
  future recursive-wrapper proofs without overclaiming on-chain readiness.
- Full-stack Playwright coverage validates proof creation/listing, QR review,
  export/import, audit, provider, public-dashboard, disabled/error, and no-leak
  user workflows before production-visible ProveKit rollout.
