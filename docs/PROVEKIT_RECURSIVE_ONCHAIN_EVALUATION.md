# PROVEKIT-200: Recursive Gnark and On-Chain Evaluation

**Date:** 2026-06-13
**Status:** Decision recorded
**Track:** wallet
**Depends on:** PROVEKIT-090

---

## Summary

This document records the team decision on whether and how to integrate
ProveKit's recursive verifier / Gnark export capability with the existing
Groth16/EVM verifier path, and which tests must pass before any on-chain
ProveKit route may be production-exposed.

---

## Background

ProveKit generates WHIR proofs over Noir circuits. The upstream repository
(`worldfnd/provekit`, `v1` branch) includes a recursive-verifier export
feature that wraps a WHIR proof inside a Groth16 circuit, producing a
Groth16 proof that can be verified by standard EVM `verifyProof` contracts
(BN254 pairing check).

The existing local on-chain stack uses:

- `logic/zkp/backends/groth16.py` — Groth16 backend (BN254, Rust FFI).
- `logic/zkp/evm_harness.py` — local EVM sandbox (py-evm) for precheck.
- `logic/zkp/onchain_pipeline.py` — dependency-light orchestration: prove →
  RPC precheck → submit transaction → wait for confirmation.
- `logic/zkp/eth_vk_registry_payloads.py` — VK hash registry payloads.
- Solidity verifier ABI tested in `test_groth_verifier_abi.py`.

ProveKit adds a second potential on-chain route:

```
Noir circuit
  → ProveKit prove (WHIR proof)
  → ProveKit recursive export (Gnark/Groth16 wrapper)
  → Groth16 proof + verifier key
  → Existing Solidity Groth16Verifier.verifyProof()
```

---

## Decision

### 1. The existing Groth16/EVM path remains the default production on-chain route.

**Rationale:**

- The Groth16 backend has its own proven security model (trusted setup,
  BN254 pairing, audited Solidity verifier).
- The ProveKit recursive export is experimental upstream; ProveKit marks `main`
  as active development.  Recursive/Gnark export stability is not guaranteed on
  the pinned `v1` branch.
- No recursive verifier key artifact, Gnark export binary, or recursive circuit
  test vectors exist in this repository yet.
- Migrating on-chain verification is a production-critical, irreversible
  contract deployment decision.

### 2. ProveKit recursive/Gnark integration is deferred pending gate criteria.

Integration is **blocked** until all of the following are satisfied:

| # | Gate criterion |
|---|----------------|
| G1 | ProveKit upstream confirms stable Gnark/Groth16 export on the pinned `v1` branch and documents the export CLI flags, output layout, and verifier key format. |
| G2 | A recursive verifier key (`.pkv-recursive`) is prepared, its SHA-256 digest is recorded in a signed artifact manifest, and the manifest is stored in `artifacts/provekit-recursive/`. |
| G3 | A dedicated Noir circuit `provekit_recursive_groth16_wrapper@v1` is authored in `logic/zkp/provekit/circuits/recursive_groth16_wrapper/`, covers the existing public-input schema (theorem hash, axiom commitment, circuit ref, ruleset ID), and its Nargo.toml is checked in. |
| G4 | A new Solidity verifier contract is deployed to a test network with the recursive verifier key embedded; its ABI is validated in a new contract artifact test. |
| G5 | All tests in `test_provekit_recursive_export_contract.py` pass without skips. |
| G6 | `PROVEKIT-180` golden vectors include at least one recursive export test vector. |
| G7 | The security notes in `PROVEKIT_ZKP_SECURITY_NOTES.md` are updated to distinguish simulated, Groth16, ProveKit-WHIR, and recursive-wrapped ProveKit proof claims and their on-chain verification scope. |

### 3. Circuit ref naming convention is reserved.

The following circuit ref is reserved for the future recursive path and must
not be used in production proofs until G1–G7 are satisfied:

```
provekit_recursive_groth16_wrapper@v1
```

The backend ID `provekit_recursive_groth16` is registered in the backend
registry as a **known-but-unavailable** alias that raises `ZKPError` with a
clear explanation.

### 4. Hash backend compatibility constraint.

If and when the recursive export path is implemented:

- use `prepare --hash sha256` to preserve compatibility with existing
  `theorem_hash` and `axioms_commitment` public-input semantics.
- do not silently change public commitments to Poseidon2 or Skyscraper;
  any new hash backend must be a new circuit version.
- the Groth16 verifier contract's `verifyProof` call must receive the same
  BN254 field-element encoding as the existing pipeline
  (`Statement.to_field_elements`).

### 5. No witness material in on-chain calldata.

Whether via the existing Groth16 path or a future recursive ProveKit path,
private axiom text, derivation witnesses, and policy content must never appear
in proof bytes, calldata, events, or public inputs submitted on-chain.

---

## Required Tests Before Production Exposure

The following tests must exist, be non-skipped, and pass in CI before any
on-chain ProveKit route is production-exposed:

| Test file | Purpose |
|-----------|---------|
| `test_provekit_recursive_export_contract.py` | Contract interface shape, reserved circuit-ref guard, fail-closed behavior for missing artifacts, public-input schema compatibility, and stub round-trip for the recursive path (currently gated by `IPFS_DATASETS_RUN_PROVEKIT_RECURSIVE_TESTS=1`). |
| `test_groth_verifier_abi.py` | Existing Solidity verifier ABI unchanged by adding a recursive alias. |
| `test_onchain_pipeline.py` | Existing on-chain orchestration unchanged. |
| `test_provekit_golden_vectors.py` | Golden vectors include recursive circuit ref once artifacts exist. |
| `test_provekit_backend_health.py` | Health check reports the recursive alias as unavailable until G1–G7 are satisfied. |

---

## Rollback / Cutover Notes

- The existing Groth16/EVM pipeline must remain operational and independently
  deployable regardless of ProveKit recursive integration status.
- If the recursive path is ever activated in production, a separate contract
  address must be used for the recursive verifier to allow independent rollback.
- Verifier key rotation for the recursive path requires the same offline process
  as the existing Groth16 VK registry documented in `WALLET_PROOF_VERIFIER_CONTRACT.md`.

---

## Open Questions (to be resolved before G1)

1. Does the `v1` ProveKit CLI expose `export-recursive` or a similar command?
   Which flags control the Gnark proving key and verifier key output?
2. What is the expected proof size difference between a WHIR proof and a
   Gnark-wrapped Groth16 proof for our circuit sizes?
3. Does the Gnark export require a separate trusted setup, or does it reuse the
   ProveKit WHIR setup parameters?
4. What on-chain gas cost delta should the team accept compared to the existing
   Groth16 verifier call?

---

## References

- [`docs/PROVEKIT_ZKP_LOGIC_IMPLEMENTATION_PLAN.md`](PROVEKIT_ZKP_LOGIC_IMPLEMENTATION_PLAN.md) — Circuit Family 4: Recursive/On-Chain Wrapper
- [`docs/PROVEKIT_ZKP_SECURITY_NOTES.md`](PROVEKIT_ZKP_SECURITY_NOTES.md)
- [`docs/WALLET_PROOF_VERIFIER_CONTRACT.md`](WALLET_PROOF_VERIFIER_CONTRACT.md)
- [`ipfs_datasets_py/ipfs_datasets_py/logic/zkp/onchain_pipeline.py`](../ipfs_datasets_py/ipfs_datasets_py/logic/zkp/onchain_pipeline.py)
- [`ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_recursive_export_contract.py`](../ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_recursive_export_contract.py)
- Upstream: https://github.com/worldfnd/provekit
