# ProveKit ZKP Target Signoff — PROVEKIT-220 + PROVEKIT-280

> **Task:** PROVEKIT-220 End-To-End ProveKit ZKP Signoff
> **Addendum:** PROVEKIT-280 Wallet UI Signoff Addendum
> **Priority:** P0 · Track: ops
> **Date:** 2026-06-14
> **Status:** ✅ BACKEND SIGNED OFF · ⚠️ PRODUCTION UI ATTACH GATED

---

## Summary

This document records the end-to-end readiness evidence for the ProveKit ZKP
integration in `ipfs_datasets_py` and the wallet UI/API addendum required
before ProveKit-backed proof identity can be attached to client wallet files.
All validation commands listed in PROVEKIT-220 and the PROVEKIT-280 artifact
existence checks pass. The evidence covers real ProveKit proof generation and
verification for supported circuits, bridge integration, hybrid prover
selection, deontic guidance commitments, wallet API receipt contracts,
full-stack Playwright coverage, UX/accessibility review, cache/IPFS public
payload safety, QR/export no-leak checks, and documented rollback/readiness.

## Scope Note

The original PROVEKIT-220 signoff is a backend and logic-layer signoff. This
PROVEKIT-280 addendum certifies the wallet API/UI evidence collected through
PROVEKIT-230 through PROVEKIT-270, then records the release decision for
production-visible client wallet attachment.

Decision: ProveKit-backed proof identity is approved for integrated
non-production wallet workflows and internal release-candidate validation. It
must not be enabled as a default production-visible client attachment path
until the remaining production cutover requirements in this document are
closed by the release owner.

---

## Validation Results

| Command | Result | Details |
|---------|--------|---------|
| `pytest ipfs_datasets_py/tests/unit_tests/logic/zkp -q` | ✅ PASS | 700 passed, 29 skipped, 0 failed |
| `pytest ipfs_datasets_py/tests/unit_tests/logic/deontic/test_deontic_provekit_bridge.py -q` | ✅ PASS | 33 passed, 1 skipped, 0 failed |
| `pytest tests/test_wallet_interface_api.py tests/test_wallet_interface_proof_backends.py tests/test_world_id_wallet_api.py -q` | ✅ PASS | 56 passed, 2 warnings, 0 failed |
| `npm --prefix wallet_interface/ui run build` | ✅ PASS | TypeScript/Vite build passed |
| `npm --prefix wallet_interface/ui test -- tests/provekit-proof-fullstack.spec.ts` | ✅ PASS | 2 passed across configured desktop/mobile projects |
| `npm --prefix wallet_interface/ui test -- tests/provekit-proof-ux.spec.ts` | ✅ PASS | 5 passed, 1 expected Mobile Safari skip |
| `npm --prefix wallet_interface/ui test -- tests/wallet-ux-review.spec.ts` | ✅ PASS | 4 passed |
| `test -f docs/PROVEKIT_ZKP_TARGET_SIGNOFF.md` | ✅ PASS | This file exists |
| `test -d artifacts/provekit-ui-signoff` | ✅ PASS | PROVEKIT-280 signoff artifacts exist |

Full machine-readable results: `artifacts/provekit-release-checks/results.json`
Wallet UI signoff addendum: `artifacts/provekit-ui-signoff/signoff-matrix.json`

---

## Coverage Evidence

### 1. Proof Generation and Verification

**ProveKit WHIR backend** (`backends/provekit.py`): tested via
`test_provekit_backend.py`, `test_provekit_artifacts.py`,
`test_provekit_attestation_envelope.py`, `test_provekit_cli_wrapper.py`.

**Simulated backend**: always available as a safe fallback; deterministic
SHA-256 digests verified in golden-vector tests.

**Groth16 backend**: fail-closed by default (`IPFS_DATASETS_ENABLE_GROTH16=0`);
explicit opt-in required; binary-missing path raises `ZKPError` with
installer instructions.

### 2. Bridge Integration

`test_provekit_zkp_attestation_bridge.py` and
`test_deontic_provekit_bridge.py` verify the deontic→ZKP bridge end-to-end:
deontic formulas are converted to public inputs, committed, and signed in
attestation envelopes.

### 3. Hybrid Prover Selection

`test_provekit_hybrid_provers.py` verifies that the backend registry
correctly resolves `provekit`, `pk`, `provekit-whir`, `whir`, and `PROVEKIT`
aliases to the same `ProveKitBackend` instance and that availability checks
are gated on binary presence, not just backend registration.

### 4. Deontic Guidance Commitments

`test_deontic_provekit_bridge.py` (33 passed) verifies that:
- Deontic obligations, permissions, and prohibitions generate stable axiom
  commitments
- Prover.toml public inputs include the deontic context hash
- Re-running the same formula produces the same commitment (determinism)

### 5. Cache and IPFS Public Payload Safety

`test_provekit_cache_ipfs_payloads.py` verifies that:
- Only public inputs (`theorem_hash_hex`, `axioms_commitment_hex`,
  `circuit_ref`) appear in cached payloads
- Private axioms and witness fields are never present in cache entries or
  IPFS-published content
- Proof objects carry no raw witness material outside the `proof_data` blob

### 6. No-Leak Witness Boundaries

`test_provekit_witness_no_leak.py` verifies that private axioms do not
appear in logs, cache entries, public inputs, or attestation envelopes.

### 7. Deterministic Public Inputs

`test_provekit_golden_vectors.py` and `test_provekit_properties.py` verify
that canonicalization, axiom commitment hashing, theorem hashing, and
Prover.toml rendering are fully deterministic across calls and environments.

### 8. Wallet API Contract Results

`tests/test_wallet_interface_api.py` and
`tests/test_wallet_interface_proof_backends.py` verify that wallet proof
routes preserve ProveKit backend metadata, verifier IDs, public-input hashes,
artifact references, verification state, and fail-closed error status while
excluding private axioms, witness text, local artifact paths, and raw proof
payloads from response surfaces consumed by the UI.

### 9. Full-Stack Playwright Results

`wallet_interface/ui/tests/provekit-proof-fullstack.spec.ts` launches the
wallet UI/API workflow with deterministic ProveKit proof fixtures and verifies
proof creation/listing, QR review, export/import, audit refresh,
provider/public surfaces, disabled/unavailable/artifact-mismatch/error states,
and no witness/private-axiom leakage across the configured Playwright projects.

### 10. UX, Accessibility, And Mobile Review

`wallet_interface/ui/tests/provekit-proof-ux.spec.ts` and
`wallet_interface/ui/tests/wallet-ux-review.spec.ts` verify proof-system label
clarity, keyboard focus visibility, touch target sizing, no horizontal
overflow, desktop/mobile layout coverage, and review artifacts archived under
`artifacts/provekit-ui-review`.

### 11. QR/Export No-Leak Evidence

The full-stack and UX review checks confirm that QR review, encrypted export,
saved wallet files, public dashboards, provider surfaces, and downloadable link
metadata do not expose private witness material, private axioms, raw proof
payloads, local artifact paths, operator secrets, or non-public prover inputs.

### 12. Proof-System Label Review

The UI review distinguishes simulated proofs, Groth16 proofs, ProveKit WHIR
proofs, and recursive-wrapper evidence. ProveKit WHIR is not labeled as
Groth16, EVM-verifiable, or on-chain-ready unless an independently reviewed
recursive-wrapper path supplies that evidence.

---

## Fixes Applied in This Signoff Cycle

| File | Change |
|------|--------|
| `logic/zkp/backends/groth16.py` | Changed `_enabled()` default to `"0"` (fail-closed); updated error messages to `"disabled by default"` matching test regex `r"Groth16 backend is (not implemented\|disabled by default)"` |
| `caching/cache.py` | Wrapped `libp2p` import in `warnings.catch_warnings(DeprecationWarning)` and broadened `except` to `Exception` to handle protobuf `VersionError` gracefully |
| `logic/common/proof_cache.py` | Made IPFS backend imports fully lazy (`_probe_ipfs_backend()`) to prevent `ipfs_kit_py`/`lotus_kit` from loading at module import time |
| `logic/api.py` | Made `mcp_server.ucan_delegation` and `CEC.nl` imports fully lazy (probe functions + `__getattr__`) to eliminate segfault under `warnings.simplefilter("error")` and 10 s startup delay |

---

## Rollback and Readiness

### Fail-Closed Guarantees

- **Groth16**: disabled by default; `ZKPError("Groth16 backend is disabled by default")` raised on any attempt without `IPFS_DATASETS_ENABLE_GROTH16=1`
- **ProveKit**: `ZKPError` raised when binary is absent; no silent fallback to simulated proofs
- **Simulated**: proof objects carry `backend_id="simulated"` and are structurally distinguishable from cryptographic proofs; must not be presented as real proofs to external verifiers

### Rollback Procedure

1. Set `IPFS_DATASETS_ENABLE_GROTH16=0` (already the default) to disable Groth16
2. Remove or rename the `provekit` binary to disable ProveKit proving
3. The simulated backend remains available for test environments only
4. Run `pytest ipfs_datasets_py/tests/unit_tests/logic/zkp -q` to confirm fail-closed behavior

### Production Cutover Requirements

Per `PROVEKIT_ZKP_SECURITY_NOTES.md` §7:

- [ ] ProveKit binary pinned to a tagged release and SHA-256 verified
- [ ] Verifier key rotated and distributed out-of-band
- [ ] `IPFS_DATASETS_ENABLE_GROTH16=0` in production until Rust binary passes security review
- [ ] All 700 ZKP unit tests passing in CI on the target deployment branch
- [ ] Attestation envelope format signed by a key held in HSM
- [ ] Cache IPFS payload audit confirms no witness leakage in stored CIDs
- [x] Wallet API contract evidence recorded for ProveKit proof receipts
- [x] Full-stack Playwright evidence recorded for ProveKit wallet workflows
- [x] UX/accessibility and mobile review evidence recorded
- [x] QR/export no-leak and proof-system label review recorded
- [ ] Release owner explicitly enables production-visible client wallet attach
      after the unresolved production controls above are complete

---

## Dependency Signoffs

| Task | Status | Output |
|------|--------|--------|
| PROVEKIT-130 (ProveKit CLI Wrapper) | ✅ completed | `backends/provekit.py`, `provekit/cli.py` |
| PROVEKIT-140 (Public Inputs Schema) | ✅ completed | `zkp/public_inputs.py`, `Prover.toml` schemas |
| PROVEKIT-150 (Attestation Envelope) | ✅ completed | `zkp/attestation.py` |
| PROVEKIT-170 (Cache/IPFS Payload Safety) | ✅ completed | `test_provekit_cache_ipfs_payloads.py` |
| PROVEKIT-180 (Golden Vector & Property Tests) | ✅ completed | `provekit_golden_vectors.json`, property test suite |
| PROVEKIT-210 (Security Review & Threat Model) | ✅ completed | `docs/PROVEKIT_ZKP_SECURITY_NOTES.md` |
| PROVEKIT-260 (Full-Stack Playwright Harness) | ✅ completed | `wallet_interface/ui/tests/provekit-proof-fullstack.spec.ts` |
| PROVEKIT-270 (UX/Accessibility Review) | ✅ completed | `artifacts/provekit-ui-review` |
| PROVEKIT-280 (Wallet UI Signoff Addendum) | ✅ completed | `artifacts/provekit-ui-signoff` |

---

*Generated by the PROVEKIT-220 and PROVEKIT-280 signoff tasks. See `artifacts/provekit-release-checks/results.json` and `artifacts/provekit-ui-signoff/signoff-matrix.json` for machine-readable evidence.*
