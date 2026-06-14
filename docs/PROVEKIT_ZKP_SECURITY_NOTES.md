# ProveKit ZKP Security Notes

> **Audience:** Security engineers, privacy reviewers, and senior developers
> integrating or auditing the `ipfs_datasets_py` ZKP backend stack.
>
> **Scope:** Threat model, backend security claims, no-leak boundaries, artifact
> trust, cache/IPFS risks, verifier-key rotation, failure modes, and production
> cutover requirements.
>
> **Last reviewed:** 2026-06-13

---

## Table of Contents

1. [Backend Security Claims By Type](#1-backend-security-claims-by-type)
2. [No-Leak Witness Boundaries](#2-no-leak-witness-boundaries)
3. [Artifact Trust And Supply Chain](#3-artifact-trust-and-supply-chain)
4. [Cache And IPFS Risk Surface](#4-cache-and-ipfs-risk-surface)
5. [Verifier-Key Rotation](#5-verifier-key-rotation)
6. [Failure Modes And Fail-Closed Behavior](#6-failure-modes-and-fail-closed-behavior)
7. [Production Cutover Requirements](#7-production-cutover-requirements)
8. [Threat Model Summary](#8-threat-model-summary)

---

## 1. Backend Security Claims By Type

The codebase exposes four proof-system levels. Each makes different security
guarantees. **Treat these as strictly distinct — a simulated claim must never be
presented to users or downstream systems as a cryptographic claim.**

### 1.1 Simulated Backend (`backend_id = "simulated"`)

**Security level: None (educational/demo only)**

The simulated backend (`logic/zkp/backends/simulated.py`) constructs proof
objects whose bytes are deterministic SHA-256 digests of the theorem, circuit
metadata, and axiom commitment. It does not:

- Produce any cryptographic proof of knowledge.
- Hide private axioms from a determined observer who knows the input space.
- Provide soundness, zero-knowledge, or binding properties.

**Claim boundary:** A `ZKPProof` with `metadata.proof_system = "SIMZKP/1"` or
`backend = "simulated"` **asserts only that the input hash was computed
correctly.** It asserts nothing about knowledge of private axioms, derivation
correctness, or theorem provability.

**Production prohibition:** The simulated backend MUST NOT be used in any
context where proof objects leave the local process boundary (API responses,
attestation records, IPFS payloads, bridge outputs, on-chain submissions). All
code paths that emit proof attestations to external consumers MUST reject
`proof_system = "SIMZKP/1"` before serializing.

**Audit check:** Search for `"simulated"` or `"SIMZKP"` in attestation-view
exports and IPFS payloads in production logs. Any occurrence is a security
finding.

---

### 1.2 Groth16 Backend (`backend_id = "groth16"`)

**Security level: Cryptographic zkSNARK (BN254 curve, Rust FFI)**

The Groth16 backend (`logic/zkp/backends/groth16.py`) uses a Rust-backed
Groth16 proving system operating on the BN254 elliptic curve. It provides:

- **Soundness:** A verifier accepting a Groth16 proof is convinced (under
  standard assumptions) that the prover knows a valid witness for the circuit.
- **Zero-knowledge:** The proof bytes themselves leak no information about
  private axioms beyond what is already visible in the circuit's public inputs.
- **Succinct verification:** Proof size is constant (~128–200 bytes over BN254)
  and verification is fast regardless of circuit complexity.

**Claim boundary:** A `ZKPProof` with `metadata.proof_system = "Groth16/BN254"`
claims cryptographic knowledge of private axioms whose hash matches
`public_inputs.axioms_commitment`, bound to the specific circuit, ruleset, and
theorem hash. It does **not** claim full unbounded theorem derivation unless the
circuit explicitly encodes a derivation trace.

**Known limitations:**
- Trusted setup: Groth16 requires a per-circuit trusted setup (powers of tau /
  PTAU ceremony). If the setup toxic waste is not destroyed, a compromised
  prover can forge proofs. Treat `.pkp`/setup artifacts as high-trust material.
- EVM path only: the current Groth16 path targets BN254 for Ethereum
  compatibility. Non-EVM targets must use a different curve or backend.
- Thread safety: the Rust FFI (`groth16_ffi.py`) must be called from a single
  process-local context per the backend lock; concurrent calls across threads
  are not safe.

---

### 1.3 ProveKit WHIR Backend (`backend_id = "provekit"` / `"provekit-whir"`)

**Security level: Cryptographic proof of knowledge (Spartan-based WHIR protocol, Noir/R1CS)**

The ProveKit backend (`logic/zkp/backends/provekit.py`) integrates [World
Foundation ProveKit](https://github.com/worldfnd/provekit) (`v1` branch). It
uses a WHIR-based Spartan proving system with Noir/R1CS circuit semantics.

**Claim boundary:** A `ZKPProof` with `metadata.proof_system = "ProveKit-WHIR"`
and `metadata.provekit_branch = "v1"` claims:

- Knowledge of a private witness (axiom scalars) whose pedersen/hash commitment
  matches `public_inputs.axioms_commitment`.
- Binding to the specific `circuit_ref`, `circuit_version`, `ruleset_id`,
  `theorem_hash`, and optionally `compiler_guidance_ref`.
- The Noir program identified by `metadata.noir_package_hash` was used.
- The proving/verifying keys were prepared from the ProveKit binary identified
  by `metadata.provekit_commit` using hash backend `metadata.hash_backend`.

**It does not claim (unless the specific circuit encodes it):**
- Full theorem derivation or logical soundness of the derivation.
- Cross-circuit linking (a proof for one circuit provides no evidence for another).
- Correctness of upstream Python theorem-prover results.

**Circuit-specific claims — current families:**

| Circuit ref | Claim |
|---|---|
| `provekit_knowledge_of_axioms@v1` | Prover knows private axioms committing to `axioms_commitment`; proof is bound to theorem, ruleset, and circuit. |
| `provekit_tdfol_v1_trace@v1` | Prover knows a bounded TDFOL derivation trace that derives the public theorem from committed axioms (Python pre-validated). |
| `provekit_legal_norm_ir_attestation@v1` | Prover knows a LegalNormIR witness matching public `compiler_guidance_ref` and related commitment fields. |

**WHIR-specific notes:**
- WHIR does not require a trusted setup (transparent/SRS-free). Soundness rests
  on the collision resistance of the chosen hash backend.
- Hash backend choice matters: `skyscraper` (default) is optimized for ZK
  proving but is a newer primitive. `sha256` and `poseidon2` are well-analyzed.
  Do not switch hash backends in production without a key rotation and security
  review.
- ProveKit `v1` branch is the stability target; `main` has breaking proof/key
  format changes. Production deployments MUST pin to a reviewed commit on `v1`.

---

### 1.4 Future Recursive Wrapper (`backend_id = "provekit_recursive_groth16"`)

**Security level: Groth16 wrap of a ProveKit-WHIR proof (not yet production)**

A future circuit family (`provekit_recursive_groth16_wrapper@v1`) will use
ProveKit's recursive verifier export to wrap a WHIR proof in a Groth16 envelope
for EVM/on-chain verification. Until that path has its own verifier contract
tests and a dedicated security review, it MUST NOT be used in production.

**Additional claim boundary notes:**
- The outer Groth16 proof attests only that the inner WHIR proof verified under
  the specified verifier key. The inner circuit's claim boundaries still apply.
- A verifier contract accepting this output trusts both the Groth16 verifier
  key and the ProveKit verifier key embedded in the circuit.
- Double-rotation requirement: rotating keys requires updating both the WHIR
  verifier key and the Groth16 setup.

---

## 2. No-Leak Witness Boundaries

Private witness material — private axioms, raw policy text, `Prover.toml`
contents, and TDFOL derivation traces — must never cross the following
boundaries:

### 2.1 Proof Envelope

`ZKPProof.proof_data` holds raw proof bytes only. It MUST NOT contain:
- Axiom text or parsed axiom structures.
- Witness scalar arrays or their intermediate representations.
- File paths pointing to temporary witness files.

`ZKPProof.public_inputs` is serialized to IPFS and attestation records. Every
field in this dict MUST be safe to publish. Enforcement:

- `axioms_commitment` is a SHA-256/hash commitment, not the axioms themselves.
- `theorem_hash` is a canonical hash of the theorem text, not the text itself
  (unless the theorem is itself public, in which case including it is a
  deliberate disclosure decision).
- `compiler_guidance_ref` is a content CID, not the guidance text.

`ZKPProof.metadata` MUST NOT contain:
- `pkp_path` or any path to private key artifacts.
- Axiom text or witness scalars.
- The `Prover.toml` path or any witness file path.

Only the following metadata fields are permitted in serialized form:
`backend`, `proof_system`, `provekit_branch`, `provekit_commit`,
`provekit_cli_version`, `hash_backend`, `pkp_sha256`, `pkv_sha256`,
`noir_package_hash`, `attestation_view`, `circuit_ref`, `circuit_version`,
`ruleset_id`, `timestamp`.

### 2.2 Logging And Exceptions

All logging at DEBUG or above must redact witness material. The
`PRIVATE_WITNESS_REDACTION` sentinel (`"<redacted:provekit-private-witness>"`)
is the canonical replacement string defined in `provekit/witness.py`.

Exception messages raised from `generate_proof` or `verify_proof` MUST NOT
include:
- Axiom text or witness scalars.
- Contents of `Prover.toml`.
- Subprocess stderr lines that may echo input values.

**Subprocess stderr handling:** The CLI wrapper (`provekit/cli.py`) MUST capture
stderr, scan for known sensitive patterns, and strip them before including
any stderr excerpt in a `ZKPError` message. When in doubt, omit stderr from
exception text and write a generic error.

### 2.3 Temporary Files

The witness workspace context manager (`provekit/witness.py` —
`ProveKitWitnessWorkspace`) creates a private temp directory under the OS temp
path. It MUST:

- Set directory permissions to `0o700` (owner-only).
- Delete all files and the directory unconditionally on context manager exit,
  including on exceptions.
- Not log the directory path at INFO or above.
- Not return file paths in `to_backend_artifacts()` — that dict returns only
  `prover_key_path`, `proof_path`, and `private_witness_digest` (a hash, not
  the content).

If the temp-dir cleanup fails (e.g., disk-full, OS error), log the failure
at WARNING with the path redacted, and raise `ZKPError` — do not silently
proceed with a partially cleaned workspace.

### 2.4 Bridge And Attestation Views

`logic/bridge/zkp_attestation.py` converts proof records to LegalIR attestation
views and graph triples. These views are designed to be public. The bridge
adapter MUST:

- Only populate attestation view fields from `public_inputs` and proof metadata.
- Reject proofs whose `proof_system` is `"SIMZKP/1"` before emitting any
  attestation view.
- Not forward axiom text obtained from upstream theorem-prover context.

### 2.5 TDFOL / CEC / F-logic Integration

The hybrid prover interfaces (`TDFOL/zkp_integration.py`, etc.) pass axioms
into the ZKP backend for circuit witness construction. The integration layer
MUST:

- Sanitize theorem-prover error messages before propagating them through the
  ZKP error path (theorem-prover errors may contain partial axiom text).
- Not include derivation trace steps in proof metadata unless the trace is
  explicitly classified as public.

---

## 3. Artifact Trust And Supply Chain

### 3.1 Prover Keys (`.pkp`)

The `.pkp` prover key is used by the ProveKit prover to generate proofs for a
specific circuit. A corrupted or maliciously substituted `.pkp` can cause:
- Invalid proofs that pass local verification against a mismatched `.pkv`.
- Proof generation failures with confusing errors.
- (With a custom Noir circuit) proofs of false statements if the Noir program is
  modified.

Mitigations:
- The artifact manifest (`provekit/artifacts.py`) pins `pkp_sha256` for each
  circuit/version combination.
- `generate_proof` must verify `sha256(pkp_bytes) == pkp_sha256` before
  invoking the prover.
- `.pkp` files must not be world-readable. Store under `0o600`.
- Do not commit `.pkp` files to version control. Use the build/prepare helper
  (`processors/provekit_backend/build.sh --prepare`).

### 3.2 Verifier Keys (`.pkv`)

The `.pkv` verifier key is used by the ProveKit verifier to check proofs. A
substituted `.pkv` can cause:
- False-positive verification of invalid proofs (critical vulnerability if
  `.pkv` is attacker-controlled).
- False-negative verification of valid proofs (availability issue).

Mitigations:
- `pkv_sha256` is recorded in proof metadata and the VK registry
  (`logic/zkp/vk_registry.py`).
- Verification MUST check that the `.pkv` on disk matches the `pkv_sha256`
  recorded at proof-generation time before passing it to the verifier.
- If the `.pkv` hash does not match, treat the proof as unverifiable (not as
  invalid) and raise `ZKPError` with a key-mismatch message.
- On-chain consumers of recursive-Groth16-wrapped proofs need the verifier key
  hash checked at the Solidity level; the Python layer cannot enforce this
  for EVM callers.

### 3.3 Noir Program Integrity

The Noir program used to prepare keys determines the circuit semantics. A
modified Noir program yields different keys and different proofs.

Mitigations:
- `metadata.noir_package_hash` is the SHA-256 of the canonical Noir package
  source tree, computed at prepare time.
- The manifest must record `noir_package_hash` alongside `pkp_sha256` and
  `pkv_sha256`.
- When verifying a proof, confirm that the verifier was prepared from the same
  Noir program hash that was used for proving (or that the program is versioned
  and the version matches).

### 3.4 ProveKit Binary Provenance

The ProveKit CLI binary is the critical compute path. A compromised binary can
forge proofs or leak witness material.

Mitigations:
- Pin the binary by `provekit_commit` (git SHA of the `v1` branch).
- Record the binary SHA-256 in the artifact manifest.
- Do not download the binary at runtime; include it in the build process under
  CI review.
- Do not trust a binary discovered via `$PATH` without a matching commit and
  hash check.

---

## 4. Cache And IPFS Risk Surface

### 4.1 What Is Safe To Cache

The proof cache (`logic/common/proof_cache.py`,
`logic/integration/caching/ipfs_proof_cache.py`) and IPFS payloads
(`provekit/cache.py`) MUST contain only:

- Raw proof bytes (`proof_data`).
- Public inputs dict (commitment hashes, circuit ref, ruleset ID, theorem hash,
  attestation ref).
- Attestation view (public metadata).
- Artifact references: `pkv_sha256`, `noir_package_hash`, `provekit_commit`,
  `hash_backend`, `circuit_ref`.
- Timestamps and size information.

### 4.2 What Must Never Be Cached

The following MUST NOT appear in any cache record or IPFS payload:

| Prohibited content | Risk if leaked |
|---|---|
| Private axiom text | Exposes confidential policy/legal reasoning |
| Witness scalar arrays | Allows reconstruction of private axioms |
| `Prover.toml` contents | Equivalent to raw witness |
| `.pkp` bytes or path | Prover key compromise |
| Temp directory paths | Correlates proving sessions; may expose file-system layout |
| Theorem-prover derivation traces (private) | May expose intermediate reasoning |

**Cache key design:** The ProveKit cache key (`build_provekit_proof_cache_key`)
is a function only of `backend_id`, `circuit_ref`, `hash_backend`,
`verifier_key_sha256`, `provekit_commit`, and `ruleset_id`. It does NOT include
any witness material, ensuring that cache keys are safe to log or store.

### 4.3 IPFS Payload Review

Before writing a proof to IPFS (or any public content-addressed store), the
integration MUST:

1. Call `build_provekit_ipfs_payload()` and inspect the result for prohibited
   fields using `_PRIVATE_ARTIFACT_KEYS` blocklist.
2. Assert that `proof_system` is not `"SIMZKP/1"`.
3. Assert that `public_inputs` contains no field whose value matches known
   axiom-text patterns (heuristic/allowlist check at write time).

### 4.4 Cache Poisoning

Because proof cache keys are deterministic hashes of public parameters, a
cache record is authoritative only if:
- The `pkv_sha256` in the cached payload matches the current verifier key.
- The `provekit_commit` matches the pinned commit.
- The `circuit_ref` and `circuit_version` match the expected circuit.

On cache hit, the caller MUST re-verify the above fields before treating the
cached proof as valid. A stale or rotated key MUST invalidate the cache entry.

---

## 5. Verifier-Key Rotation

### 5.1 When To Rotate

Rotate verifier keys when:
- The ProveKit binary is updated to a new commit (breaking proof format).
- The Noir program source is modified (circuit semantics change).
- The hash backend is changed (produces incompatible key material).
- A `.pkv` file is suspected to be compromised or tampered.
- Scheduled rotation policy (e.g., annual, or per security review).

### 5.2 Rotation Procedure

1. **Prepare new keys:** Run `processors/provekit_backend/build.sh --prepare`
   with the new binary/Noir source. This produces a new `.pkp` and `.pkv`.
2. **Record new hashes:** Update the artifact manifest with the new
   `pkp_sha256`, `pkv_sha256`, and `noir_package_hash`. Bump `circuit_version`
   if circuit semantics changed.
3. **Update VK registry:** Add the new `(circuit_id, version) -> pkv_sha256`
   entry in `logic/zkp/vk_registry.py`. Do not delete the old entry until all
   proofs generated under the old key are retired from the cache.
4. **Invalidate cache:** Purge or version-fence all cached proof records whose
   `pkv_sha256` matches the old key.
5. **Re-prove if required:** If existing proofs must remain valid after
   rotation, they must be re-generated under the new key. Old proofs verified
   under the old `.pkv` remain valid only in contexts that still hold the old
   key.
6. **On-chain rotation (recursive/Groth16 path):** If a Groth16 verifier
   contract embeds the WHIR verifier key, deploying a new contract or updating
   the registry is required. This is a separate deployment process and requires
   additional sign-off per `PROVEKIT-200` (Recursive Gnark And On-Chain
   Evaluation).
7. **Announce rotation:** Communicate the new `pkv_sha256` and `circuit_version`
   to all verifying parties (bridge consumers, on-chain contracts, partner
   integrations).

### 5.3 Rotation Testing

Before promoting rotated keys to production:
- Re-run the backend health-check suite (`test_provekit_backend_health.py`).
- Confirm that old proofs fail verification against the new `.pkv` (expected).
- Confirm that new proofs pass verification against the new `.pkv`.
- Confirm that the cache key changes after rotation (it should, because
  `verifier_key_sha256` is a cache-key component).

---

## 6. Failure Modes And Fail-Closed Behavior

The ProveKit backend is **fail-closed**: any configuration, artifact, or
verification error raises `ZKPError` rather than silently falling back to the
simulated backend.

### 6.1 Failure Triggers

| Trigger | Behavior |
|---|---|
| `IPFS_DATASETS_ENABLE_PROVEKIT=0` (or absent) | `generate_proof` raises `ZKPError("ProveKit backend disabled")` |
| ProveKit binary not found | `generate_proof` raises `ZKPError("provekit-cli not found")` |
| Binary found but wrong version | `generate_proof` raises `ZKPError` with version mismatch detail |
| `.pkp` file missing | `generate_proof` raises `ZKPError("prover key not found")` |
| `.pkp` SHA-256 mismatch | `generate_proof` raises `ZKPError("prover key integrity check failed")` |
| `.pkv` file missing | `verify_proof` raises `ZKPError("verifier key not found")` |
| `.pkv` SHA-256 mismatch | `verify_proof` raises `ZKPError("verifier key integrity check failed")` |
| Noir package hash mismatch | `generate_proof` raises `ZKPError("circuit source integrity check failed")` |
| ProveKit CLI exits non-zero | `generate_proof`/`verify_proof` raises `ZKPError` with sanitized stderr |
| Proof attestation view mismatch | `verify_proof` raises `ZKPError("attestation view mismatch")` |
| Public inputs mismatch | `verify_proof` raises `ZKPError("public input mismatch")` |
| Timeout exceeded | `generate_proof`/`verify_proof` raises `ZKPError("ProveKit CLI timed out")` |
| Temp-dir cleanup failed | `generate_proof` raises `ZKPError` after attempting cleanup |

### 6.2 What Is Not A Fallback

The `get_backend()` registry (`backends/__init__.py`) does NOT fall back from
`"provekit"` to `"simulated"` on failure. Callers that request
`backend="provekit"` receive a `ZKPError` if ProveKit is unavailable. Callers
that want a graceful fallback MUST implement it explicitly and log the fallback
at WARNING level.

### 6.3 Partial-Proof Cleanup

If proof generation fails mid-way (e.g., after the temp dir is created but
before the CLI finishes), the context manager MUST still clean up the temp dir.
Partial proof files MUST NOT be returned or cached.

### 6.4 Verification-Only Failure

If a proof is presented for verification and the verifier key is not registered
in the VK registry for the claimed `(circuit_id, circuit_version)`, the
verifier MUST raise `ZKPError` — not return `False`. Returning `False` would
ambiguously conflate "proof invalid" with "proof unverifiable due to missing key."

---

## 7. Production Cutover Requirements

Before enabling the ProveKit backend in production (replacing or supplementing
the Groth16 backend), ALL of the following must be satisfied:

### 7.1 Binary And Key Artifacts

- [ ] ProveKit CLI binary is pinned to a reviewed `v1` commit with known SHA-256.
- [ ] `.pkp` and `.pkv` files are prepared from that binary and stored in a
      secure artifact store (not in version control).
- [ ] Artifact manifest records `pkp_sha256`, `pkv_sha256`, `noir_package_hash`,
      and `provekit_commit`.
- [ ] Manifest is reviewed and approved by at least one security engineer.

### 7.2 No-Leak Validation

- [ ] No-leak tests (`test_provekit_backend_health.py` witness-boundary suite)
      pass for all supported circuits.
- [ ] IPFS payload output does not contain any prohibited fields (verified by
      `_PRIVATE_ARTIFACT_KEYS` blocklist scan).
- [ ] Exception messages from intentionally-triggered failure scenarios contain
      no witness material (manual review or fuzzing).

### 7.3 Key Registry

- [ ] VK registry is populated with all production verifier key hashes.
- [ ] Registry entries are version-controlled and reviewed.

### 7.4 Attestation And Bridge

- [ ] `ZkpAttestationBridgeAdapter` rejects `"SIMZKP/1"` proofs at the
      attestation-view emission boundary.
- [ ] Bridge integration tests pass with the ProveKit backend mocked.

### 7.5 Deontic And TDFOL Integration

- [ ] TDFOL hybrid-prover tests pass with the ProveKit backend enabled.
- [ ] Deontic bridge integration tests confirm LegalNormIR proof-ready metadata
      survives into the ProveKit proof envelope without witness leakage.

### 7.6 Operational Readiness

- [ ] Operations runbook (`docs/PROVEKIT_ZKP_OPERATIONS.md`) is current and
      reviewed.
- [ ] Backend health check (`test_provekit_backend_health.py`) passes in the
      target deployment environment.
- [ ] Log-scraping alerts for `"SIMZKP"` and `"private_axiom"` patterns are
      active in production log pipelines.

### 7.7 Sign-Off Gate

- [ ] End-to-end sign-off evidence (`docs/PROVEKIT_ZKP_TARGET_SIGNOFF.md`) is
      complete per `PROVEKIT-220` requirements.
- [ ] Security engineer approval on this document (signature or PR approval).

**Until all items above are checked**, the ProveKit backend MUST remain disabled
in production (`IPFS_DATASETS_ENABLE_PROVEKIT` unset or `0`). The simulated
backend may continue to serve non-production/demo flows. The Groth16 backend
remains the default production cryptographic path.

---

## 8. Threat Model Summary

### 8.1 Assets

| Asset | Sensitivity | Protection |
|---|---|---|
| Private axioms / policy text | High — legal/confidential | No-leak witness boundaries; commitment-only public inputs |
| `Prover.toml` witness file | High | Temp-dir, owner-only permissions, deterministic cleanup |
| Prover key (`.pkp`) | High — forge risk if leaked | Owner-only file permissions; not in VCS; hash-pinned |
| Verifier key (`.pkv`) | Medium — false-positive verification if substituted | Hash-pinned; checked before verification; VK registry |
| Proof bytes (`proof_data`) | Low (public) | Content-addressed; attestation view validates binding |
| Public inputs / attestation view | Low (public by design) | Commitment hashes only; simulated-proof rejection |
| ProveKit binary | High — code execution trust | Commit-pinned; SHA-256 checked; not downloaded at runtime |

### 8.2 Threat Actors

| Actor | Capability | Mitigated By |
|---|---|---|
| External attacker with proof-cache read | Sees only public inputs and proof bytes | No-leak cache payload; commitment hashes |
| Malicious cache writer | Substitutes a forged proof in cache | Re-verify `pkv_sha256` and public inputs on cache hit |
| Compromised build system | Substitutes ProveKit binary | Commit-pinned binary; SHA-256 check at startup |
| Misconfigured operator | Runs with simulated backend in production | Attestation-view simulated-proof rejection; log alerts |
| Adversary supplying axioms | Supplies axioms designed to exploit the Noir circuit | Python pre-validation; circuit input range checks; bounded trace |
| IPFS gateway attacker | Intercepts IPFS content delivery | Content-addressed (CID verifies payload integrity); commitment hashes |

### 8.3 Residual Risks

- **Trusted setup (Groth16 only):** If the PTAU toxic waste is not destroyed,
  Groth16 proofs can be forged. ProveKit-WHIR eliminates this risk for the
  WHIR path.
- **Hash-backend weakness:** WHIR soundness depends on the collision resistance
  of `hash_backend`. `skyscraper` is a newer, less-analyzed primitive. Use
  `sha256` or `poseidon2` until `skyscraper` has broader cryptographic review.
- **ProveKit `v1` format stability:** Upstream may introduce breaking changes
  even on `v1`. Pin to a specific reviewed commit; audit upstream changes before
  upgrading.
- **Recursive/Groth16 wrapper (future):** The double-key trust surface is not
  yet fully specified. Defer production use until `PROVEKIT-200` is complete and
  a dedicated security review is done.
- **Python pre-validation bypass:** The TDFOL trace circuit requires Python-side
  derivation validation before proving. If the Python validator is buggy, proofs
  may be generated for invalid traces. The circuit provides commitment binding
  but not independent derivation checking unless the full trace circuit is used.

---

*This document should be updated when the ProveKit integration moves through
production cutover, when verifier keys are rotated, or when new circuit families
are added. Treat it as a living security review artifact.*
