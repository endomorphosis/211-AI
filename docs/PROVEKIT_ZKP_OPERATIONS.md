# ProveKit ZKP Operations Runbook

> **Scope:** Operators — DevOps, SRE, and integration engineers responsible for
> deploying and monitoring the ProveKit ZKP backend in `ipfs_datasets_py`.
>
> **Security boundary:** This document covers public operational commands only.
> No witness material (private axioms, `Prover.toml` contents, derivation
> traces) should appear in operator terminals, CI logs, or incident tickets.
> Redact before sharing.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Environment Variables](#2-environment-variables)
3. [Binary Availability Check](#3-binary-availability-check)
4. [Circuit Manifest Check](#4-circuit-manifest-check)
5. [Artifact Integrity Check](#5-artifact-integrity-check)
6. [Backend Enablement Check](#6-backend-enablement-check)
7. [Preparing ProveKit Artifacts](#7-preparing-provekit-artifacts)
8. [Fail-Closed Readiness Verification](#8-fail-closed-readiness-verification)
9. [Health Check Command Summary](#9-health-check-command-summary)
10. [Witness Boundary Rules](#10-witness-boundary-rules)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Overview

`ipfs_datasets_py` integrates [World Foundation ProveKit](https://github.com/worldfnd/provekit)
(`v1` branch) as an optional ZKP backend that generates and verifies WHIR proofs
for bounded Noir circuit statements. The backend is **fail-closed**: any missing
binary, artifact, or configuration causes `ZKPError` rather than falling back to
simulated proofs.

The integration consists of:

| Component | Location |
|-----------|----------|
| ProveKit backend shell | `ipfs_datasets_py/logic/zkp/backends/provekit.py` |
| CLI subprocess wrapper | `ipfs_datasets_py/logic/zkp/provekit/cli.py` |
| Artifact manifest helpers | `ipfs_datasets_py/logic/zkp/provekit/artifacts.py` |
| Private witness renderer | `ipfs_datasets_py/logic/zkp/provekit/witness.py` |
| Packaged circuits | `ipfs_datasets_py/logic/zkp/provekit/circuits/` |
| Build/prepare helper | `ipfs_datasets_py/processors/provekit_backend/build.sh` |

Proof system: **ProveKit-WHIR** (Spartan-based, Noir/R1CS).

---

## 2. Environment Variables

All environment variables are optional. Missing values cause the backend to
report itself unavailable; they do not raise errors at import or install time.

| Variable | Purpose |
|----------|---------|
| `IPFS_DATASETS_PROVEKIT_CLI` | Absolute path to the `provekit-cli` executable. Takes priority over all other discovery paths. |
| `IPFS_DATASETS_PROVEKIT_BIN` | Alias for `IPFS_DATASETS_PROVEKIT_CLI`. |
| `PROVEKIT_CLI` | Fallback alias (lower priority than the `IPFS_DATASETS_*` variants). |
| `PROVEKIT_BIN` | Fallback alias. |
| `IPFS_DATASETS_PROVEKIT_HOME` | ProveKit install root. The discovery path checks `$HOME/bin/provekit-cli`, `$HOME/target/release/provekit-cli`, and `$HOME/provekit-cli` in that order. |
| `PROVEKIT_HOME` | Fallback alias for `IPFS_DATASETS_PROVEKIT_HOME`. |
| `IPFS_DATASETS_PROVEKIT_BUILD_DIR` | Output directory for `build.sh --prepare`. Defaults to `processors/provekit_backend/artifacts/`. |

Set one of the binary variables or the home variable; never set both pointing to
different binaries.

---

## 3. Binary Availability Check

### 3.1 Python check

```python
from ipfs_datasets_py.logic.zkp.provekit.cli import discover_provekit_binary

binary = discover_provekit_binary()
if binary is None:
    print("ProveKit binary: NOT FOUND")
else:
    print(f"ProveKit binary: {binary}")
```

Expected output when configured:

```
ProveKit binary: /usr/local/bin/provekit-cli
```

Expected output when not configured (non-fatal — backend simply unavailable):

```
ProveKit binary: NOT FOUND
```

### 3.2 Shell one-liner

```bash
python -c "
from ipfs_datasets_py.logic.zkp.provekit.cli import discover_provekit_binary
b = discover_provekit_binary()
print('OK:', b) if b else print('UNAVAILABLE: no provekit-cli found')
"
```

### 3.3 Direct binary check

```bash
# Check the binary pointed to by the env var
"${IPFS_DATASETS_PROVEKIT_CLI:-provekit-cli}" --version 2>&1 || true
```

### 3.4 Backend object availability flag

```python
from ipfs_datasets_py.logic.zkp.backends.provekit import ProveKitBackend

backend = ProveKitBackend()
print("binary_available:", backend.binary_available())
```

---

## 4. Circuit Manifest Check

The `build.sh` script in `--check` mode validates that all packaged Noir circuit
sources are present and structurally complete **without** requiring a ProveKit
binary, network access, or Rust tooling.

```bash
cd ipfs_datasets_py
processors/provekit_backend/build.sh --check
```

Expected output:

```
ProveKit circuit: /path/to/logic/zkp/provekit/circuits/knowledge_of_axioms
ProveKit CLI: not configured
Packaging check passed. Use --prepare to create local keys explicitly.
```

To check a specific circuit:

```bash
processors/provekit_backend/build.sh --check --circuit tdfol_v1_trace
```

### 4.1 Python circuit manifest enumeration

```python
from pathlib import Path

circuits_root = Path("ipfs_datasets_py/logic/zkp/provekit/circuits")
for circuit_dir in sorted(circuits_root.iterdir()):
    if not circuit_dir.is_dir():
        continue
    nargo = circuit_dir / "Nargo.toml"
    main_nr = circuit_dir / "src" / "main.nr"
    status = "OK" if (nargo.is_file() and main_nr.is_file()) else "INCOMPLETE"
    print(f"  [{status}] {circuit_dir.name}")
```

Packaged circuits:

| Circuit directory | Nargo package name | Purpose |
|-------------------|--------------------|---------|
| `knowledge_of_axioms` | `provekit_knowledge_of_axioms` | Prove knowledge of private axioms matching public commitment |
| `tdfol_v1_trace` | `provekit_tdfol_v1_trace` | Prove bounded TDFOL v1 derivation trace |

---

## 5. Artifact Integrity Check

Artifact integrity uses SHA-256 digests recorded in a `provekit-artifacts.json`
manifest. **Validation fails closed**: any digest mismatch raises `ZKPError` and
halts proof generation.

### 5.1 Validate a manifest file

```python
from ipfs_datasets_py.logic.zkp.provekit.artifacts import load_provekit_artifact_manifest

manifest = load_provekit_artifact_manifest(
    "/path/to/provekit-artifacts.json",
    validate_files=True,  # default; set False only for offline schema checks
)
print("Manifest OK:", manifest.circuit_ref)
print("ProveKit branch:", manifest.provekit_branch)
print("ProveKit commit:", manifest.provekit_commit)
```

### 5.2 Compute digests for existing key files

```python
from ipfs_datasets_py.logic.zkp.provekit.artifacts import sha256_file, sha256_directory

print("prover key sha256:   ", sha256_file("/path/to/circuit.pkp"))
print("verifier key sha256: ", sha256_file("/path/to/circuit.pkv"))
print("Noir package sha256: ", sha256_directory("/path/to/knowledge_of_axioms"))
```

### 5.3 Inspect manifest without file validation

```python
import json
from pathlib import Path

raw = json.loads(Path("provekit-artifacts.json").read_text())
print("Schema version:", raw["schema_version"])
print("Circuit ref:   ", raw["circuit_ref"])
print("Prover key:    ", raw["prover_key_path"])
print("  sha256:      ", raw["prover_key_sha256"])
print("Verifier key:  ", raw["verifier_key_path"])
print("  sha256:      ", raw["verifier_key_sha256"])
```

### 5.4 Manifest fields (reference)

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | string | Always `provekit-artifact-manifest-v1` |
| `circuit_id` | string | Unversioned circuit identifier, e.g. `provekit_knowledge_of_axioms` |
| `circuit_version` | int | Integer circuit version, e.g. `1` |
| `circuit_ref` | string | Canonical ref, e.g. `provekit_knowledge_of_axioms@v1` |
| `ruleset_id` | string | Ruleset bound to this circuit, e.g. `TDFOL_v1` |
| `hash_backend` | string | Hash backend used at prepare time, e.g. `sha256` |
| `noir_package_path` | string | Absolute path to the Noir package directory |
| `noir_package_sha256` | string | SHA-256 over Noir package source files |
| `prover_key_path` | string | Absolute path to `.pkp` file |
| `prover_key_sha256` | string | SHA-256 of `.pkp` file |
| `verifier_key_path` | string | Absolute path to `.pkv` file |
| `verifier_key_sha256` | string | SHA-256 of `.pkv` file |
| `provekit_branch` | string | ProveKit source branch, e.g. `v1` |
| `provekit_commit` | string | ProveKit source commit hash |
| `provekit_binary_path` | string | Optional: absolute path to `provekit-cli` used for `prepare` |
| `provekit_binary_sha256` | string | Optional: SHA-256 of that binary |

The manifest does **not** and must **not** contain:
- Private axioms or witness text
- `Prover.toml` contents
- Derivation trace data

---

## 6. Backend Enablement Check

### 6.1 List all registered backends

```python
from ipfs_datasets_py.logic.zkp.backends import list_backends

for backend_id, meta in list_backends().items():
    print(f"  {backend_id}: {meta['description']}")
```

### 6.2 Check backend is selectable

```python
from ipfs_datasets_py.logic.zkp.backends import backend_is_available

print("provekit selectable:", backend_is_available("provekit"))
```

Note: `backend_is_available` checks whether the backend *class* can be
instantiated from the registry. It does **not** check whether the ProveKit
binary is installed or artifacts are prepared.

### 6.3 Instantiate and probe

```python
from ipfs_datasets_py.logic.zkp.backends import get_backend

backend = get_backend("provekit")
print("backend_id:   ", backend.backend_id)
print("proof_system: ", backend.proof_system)
print("binary_available:", backend.binary_available())
```

### 6.4 Supported aliases

| Alias | Resolves to |
|-------|-------------|
| `provekit` | ProveKitBackend |
| `pk` | ProveKitBackend |
| `provekit-whir` | ProveKitBackend |
| `whir` | ProveKitBackend |

---

## 7. Preparing ProveKit Artifacts

Artifact preparation (`provekit-cli prepare`) generates `.pkp` and `.pkv` key
files. This step requires a configured `provekit-cli` binary. It must be run
**manually** — never at install or import time.

### 7.1 Via build.sh

```bash
export IPFS_DATASETS_PROVEKIT_CLI=/usr/local/bin/provekit-cli
export IPFS_DATASETS_PROVEKIT_BUILD_DIR=/opt/provekit-artifacts

cd ipfs_datasets_py
processors/provekit_backend/build.sh --prepare --circuit knowledge_of_axioms
processors/provekit_backend/build.sh --prepare --circuit tdfol_v1_trace
```

Output artifacts per circuit:

```
/opt/provekit-artifacts/knowledge_of_axioms/knowledge_of_axioms.pkp
/opt/provekit-artifacts/knowledge_of_axioms/knowledge_of_axioms.pkv
/opt/provekit-artifacts/tdfol_v1_trace/tdfol_v1_trace.pkp
/opt/provekit-artifacts/tdfol_v1_trace/tdfol_v1_trace.pkv
```

### 7.2 Via Python API

```python
from pathlib import Path
from ipfs_datasets_py.logic.zkp.provekit.cli import ProveKitCLI

cli = ProveKitCLI(binary_path="/usr/local/bin/provekit-cli")
circuits_root = Path("ipfs_datasets_py/logic/zkp/provekit/circuits")

result = cli.prepare(
    program_dir=circuits_root / "knowledge_of_axioms",
    prover_key_path="/opt/provekit-artifacts/knowledge_of_axioms.pkp",
    verifier_key_path="/opt/provekit-artifacts/knowledge_of_axioms.pkv",
)
result.raise_for_failure()
print("Prepared OK, elapsed:", result.elapsed_seconds)
```

### 7.3 Record the manifest after preparation

```python
from ipfs_datasets_py.logic.zkp.provekit.artifacts import (
    build_provekit_artifact_manifest,
    save_provekit_artifact_manifest,
)

manifest = build_provekit_artifact_manifest(
    circuit_id="provekit_knowledge_of_axioms",
    noir_package_path="ipfs_datasets_py/logic/zkp/provekit/circuits/knowledge_of_axioms",
    prover_key_path="/opt/provekit-artifacts/knowledge_of_axioms.pkp",
    verifier_key_path="/opt/provekit-artifacts/knowledge_of_axioms.pkv",
    provekit_branch="v1",
    provekit_commit="<commit-sha>",
    provekit_binary_path="/usr/local/bin/provekit-cli",
)
save_provekit_artifact_manifest(manifest, "/opt/provekit-artifacts/provekit-artifacts.json")
print("Manifest saved:", manifest.circuit_ref)
```

---

## 8. Fail-Closed Readiness Verification

Run these checks to confirm the backend will raise `ZKPError` rather than
silently producing simulated proofs when something is missing.

### 8.1 Confirm binary-missing raises ZKPError

```python
import os
from ipfs_datasets_py.logic.zkp import ZKPError
from ipfs_datasets_py.logic.zkp.backends.provekit import ProveKitBackend

# Remove all env vars so no binary is found.
for var in ("IPFS_DATASETS_PROVEKIT_CLI", "IPFS_DATASETS_PROVEKIT_HOME",
            "PROVEKIT_CLI", "PROVEKIT_HOME"):
    os.environ.pop(var, None)

backend = ProveKitBackend()
assert not backend.binary_available(), "Expected binary to be unavailable"

try:
    backend.generate_proof("Q", ["P -> Q"], metadata={})
    print("FAIL: should have raised ZKPError")
except ZKPError as exc:
    print("OK: ZKPError raised as expected:", exc)
```

### 8.2 Confirm missing artifacts raise ZKPError

```python
import os, tempfile, stat
from ipfs_datasets_py.logic.zkp import ZKPError
from ipfs_datasets_py.logic.zkp.backends.provekit import ProveKitBackend

with tempfile.TemporaryDirectory() as tmpdir:
    binary = os.path.join(tmpdir, "provekit-cli")
    with open(binary, "w") as f:
        f.write("#!/bin/sh\nexit 0\n")
    os.chmod(binary, stat.S_IRWXU)

    backend = ProveKitBackend(binary_path=binary)
    try:
        backend.generate_proof("Q", ["P"], metadata={})
        print("FAIL: should have raised ZKPError")
    except ZKPError as exc:
        print("OK: ZKPError raised for missing artifacts:", exc)
```

### 8.3 Automated unit test suite

```bash
pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_backend_health.py -v
```

All tests in that suite must pass on a clean checkout **without** a real
ProveKit binary installed.

---

## 9. Health Check Command Summary

Quick reference for common operator commands:

```bash
# 1. Packaging check (no binary required)
cd ipfs_datasets_py && processors/provekit_backend/build.sh --check

# 2. Binary availability
python -c "
from ipfs_datasets_py.logic.zkp.provekit.cli import discover_provekit_binary
b = discover_provekit_binary()
print('binary:', b or 'NOT FOUND')
"

# 3. Backend availability
python -c "
from ipfs_datasets_py.logic.zkp.backends import get_backend
b = get_backend('provekit')
print('backend_id:', b.backend_id)
print('binary_available:', b.binary_available())
"

# 4. Circuit manifest integrity (requires prepared keys)
python -c "
from ipfs_datasets_py.logic.zkp.provekit.artifacts import load_provekit_artifact_manifest
m = load_provekit_artifact_manifest('provekit-artifacts.json')
print('circuit_ref:', m.circuit_ref)
print('manifest OK')
"

# 5. Full health test suite
pytest ipfs_datasets_py/tests/unit_tests/logic/zkp/test_provekit_backend_health.py -q
```

---

## 10. Witness Boundary Rules

These rules are invariants, not preferences. Violating them constitutes a
security defect.

1. **Private axioms** (user knowledge-base text) must never appear in:
   - `ZKPProof.public_inputs`
   - `ZKPProof.metadata`
   - artifact manifest JSON
   - IPFS proof cache payloads
   - operator terminals or CI log output
   - exception messages or tracebacks

2. **`Prover.toml` contents** are classified private. The file lives in a
   temporary directory that is cleaned up after proving. The path is passed to
   `provekit-cli prove --input` and immediately marked as a sensitive value in
   `ProveKitCommand.sensitive_values`, ensuring it is redacted before any
   diagnostic output.

3. **Derivation traces** (TDFOL rule applications, CEC steps, etc.) are private
   when they would expose which axioms triggered which inferences. Only the
   bounded trace *commitment* (an opaque field element) is public.

4. **Verifier keys** (`.pkv`) are public and may be logged. **Prover keys**
   (`.pkp`) are semi-secret operational data: they do not contain private axioms
   but should not be distributed to untrusted parties.

5. **ProveKit CLI stdout/stderr** is captured, redacted, and truncated before
   any exception message. Operators should not pipe raw CLI output to external
   systems without reviewing it.

---

## 11. Troubleshooting

### `ZKPError: ProveKit CLI binary not found`

**Cause:** No binary path is configured and `provekit-cli` is not on `PATH`.

**Fix:**

```bash
export IPFS_DATASETS_PROVEKIT_CLI=/path/to/provekit-cli
# or
export IPFS_DATASETS_PROVEKIT_HOME=/path/to/provekit-install-root
```

Then confirm:

```bash
python -c "from ipfs_datasets_py.logic.zkp.provekit.cli import discover_provekit_binary; print(discover_provekit_binary())"
```

---

### `ZKPError: Configured ProveKit CLI from IPFS_DATASETS_PROVEKIT_CLI is not executable`

**Cause:** The env var points to a path that does not exist or is not executable.

**Fix:**

```bash
chmod +x "$IPFS_DATASETS_PROVEKIT_CLI"
ls -la "$IPFS_DATASETS_PROVEKIT_CLI"
```

---

### `ZKPError: ProveKit backend requires explicit artifact metadata`

**Cause:** `generate_proof` was called without a `provekit_artifacts` key in
`metadata`.

**Fix:** Pass a manifest-derived artifact dict:

```python
manifest = load_provekit_artifact_manifest("provekit-artifacts.json")
artifacts = manifest.to_backend_artifacts()
proof = backend.generate_proof(theorem, axioms, metadata={**other_meta, **artifacts})
```

---

### `ZKPError: prover key … does not exist`

**Cause:** The prover key path recorded in the manifest does not exist on disk
(files moved or not yet prepared).

**Fix:** Re-run `build.sh --prepare` and update the manifest.

---

### `ZKPError: … digest mismatch`

**Cause:** A key or Noir package file has changed since the manifest was
recorded. This is a security-relevant event.

**Actions:**

1. Do not proceed with proof generation.
2. Investigate whether the file was modified intentionally (re-preparation) or
   unexpectedly (integrity incident).
3. If intentional, re-prepare and re-record the manifest.
4. If unexpected, treat as a potential integrity compromise and escalate.

---

### `ZKPError: ProveKit command timed out after N seconds`

**Cause:** The `provekit-cli` subprocess exceeded `timeout_seconds` (default: 60s).

**Fix:**

```python
from ipfs_datasets_py.logic.zkp.backends.provekit import ProveKitBackend

backend = ProveKitBackend(timeout_seconds=300.0)
```

Or via `ProveKitCLI`:

```python
from ipfs_datasets_py.logic.zkp.provekit.cli import ProveKitCLI

cli = ProveKitCLI(timeout_seconds=300.0)
```

---

### Tests fail with `ModuleNotFoundError: No module named 'tomllib'`

**Cause:** Running Python < 3.11.

**Fix:** Install the `tomli` backport:

```bash
pip install tomli
```

The test module imports `tomllib` and falls back to `tomli` automatically.

---

*Document maintained alongside `docs/PROVEKIT_ZKP_LOGIC_TODO.md` task
PROVEKIT-170. Generated: 2026-06-13.*
