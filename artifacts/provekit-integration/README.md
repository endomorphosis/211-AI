# ProveKit Integration Gate

This artifact documents the opt-in real ProveKit integration test.

Default validation is safe and does not require Rust or ProveKit:

```sh
pytest ipfs_datasets_py/tests/integration/test_provekit_zkp.py -q
```

To run the real prepare/prove/verify path, provide a ProveKit v1 CLI binary and
opt in explicitly:

```sh
IPFS_DATASETS_RUN_PROVEKIT_TESTS=1 \
IPFS_DATASETS_PROVEKIT_CLI=/tmp/provekit-v1-spike/target/release/provekit-cli \
IPFS_DATASETS_PROVEKIT_COMMIT=4c085f03aa583c255dda4831f1dba7e8c3f284cb \
pytest ipfs_datasets_py/tests/integration/test_provekit_zkp.py -q
```

The test prepares the `provekit_knowledge_of_axioms` Noir package into a pytest
temporary directory, renders a private temporary `Prover.toml`, generates a real
`.np` proof through `ProveKitBackend`, verifies it through ProveKit, round-trips
the result through `ZKPProof.to_dict()` / `ZKPProof.from_dict()`, and checks that
private axiom text is absent from serialized proof metadata.

The test does not build ProveKit. Build or install the CLI outside the Python
package and pass the binary path via environment variable.

