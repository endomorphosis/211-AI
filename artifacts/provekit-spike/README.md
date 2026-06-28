# ProveKit v1 Spike

Spike date: 2026-06-13T12:54:08-07:00

This artifact records the local smoke test for World Foundation ProveKit `v1` against the upstream `noir-examples/basic-4` package. The purpose is to pin the integration surface before adding an `ipfs_datasets_py.logic.zkp` backend wrapper.

## Selected Upstream

- Repository: https://github.com/worldfnd/provekit
- Branch: `v1`
- Commit: `4c085f03aa583c255dda4831f1dba7e8c3f284cb`
- Local checkout: `/tmp/provekit-v1-spike`
- Rust toolchain: `nightly-2026-03-04-x86_64-unknown-linux-gnu`
- Built binary: `/tmp/provekit-v1-spike/target/release/provekit-cli`
- Binary size: 25,995,936 bytes
- Binary SHA-256: `5ae5c5aee8142354de690b3f6a6dd4d1b903a213b6e862e54c975e7fc9286123`

The ProveKit CLI embeds the Noir compiler crates used by the `v1` checkout. No external `nargo`, `noir`, or `noirup` binary was present on PATH during this smoke run.

## Commands Run

From `/tmp/provekit-v1-spike/noir-examples/basic-4`:

```sh
/usr/bin/time -f 'elapsed_seconds=%e max_rss_kb=%M' /tmp/provekit-v1-spike/target/release/provekit-cli prepare
/usr/bin/time -f 'elapsed_seconds=%e max_rss_kb=%M' /tmp/provekit-v1-spike/target/release/provekit-cli prove
/usr/bin/time -f 'elapsed_seconds=%e max_rss_kb=%M' /tmp/provekit-v1-spike/target/release/provekit-cli verify
/tmp/provekit-v1-spike/target/release/provekit-cli show-inputs basic.pkv proof.np --hex
```

Initial release build command:

```sh
/usr/bin/time -f 'elapsed_seconds=%e' cargo run --release --bin provekit-cli -- --help
```

The first release build took 723.89 seconds, mostly due to the repository-pinned Rust toolchain install, dependency build, and fat LTO for `provekit-cli`.

## Smoke Results

| Step | Exit | Elapsed | Max RSS | Result |
| --- | ---: | ---: | ---: | --- |
| `prepare` | 0 | 0.21s | 43,808 KiB | Generated `basic.pkp`, `basic.pkv`, and `target/basic.json` |
| `prove` | 0 | 0.19s | 20,236 KiB | Generated `proof.np` |
| `verify` | 0 | 0.04s | 9,396 KiB | Verified `proof.np` against `basic.pkv` |

Generated artifact sizes:

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `basic.pkp` | 724 bytes | `0806ba0b7c916728385da1ecaf251d7afa6ecfcc189ed2ff83c1c689e24a0576` |
| `basic.pkv` | 600 bytes | `2c7c5935a223d966d1d0269e3e35b2958b5feaf0aac5ee6ace37404da8583bed` |
| `proof.np` | 286,709 bytes | `026955e2e7f5c81f293ea0fe125e80e3339aedbf089ae47ed107be946c3ae319` |
| `target/basic.json` | 1,221 bytes | `c76b6fac4f0cf74ee9f5307aaf8ba849c421a0afca7199948880d4bdbb21301e` |

The public input reported by `show-inputs` was:

```text
return: 0x0000000000000000000000000000000000000000000000000000000000000010
```

This matches the example witness in `Prover.toml`: `(5 + 3) * (5 - 3) = 16`.

## CLI Contract Observed

- `prepare [program_dir]` compiles the Noir package and writes `<circuit>.pkp` and `<circuit>.pkv`.
- `prepare` supports explicit `--target-dir`, `--pkp`/`-p`, `--pkv`/`-v`, `--package`, `--workspace`, and `--force`.
- `prove` reads `--prover`/`-p` and `--input`/`-i` and writes `--out`/`-o`, defaulting to `<circuit>.pkp`, `./Prover.toml`, and `./proof.np`.
- `verify` reads `--verifier`/`-v` and `--proof`, defaulting to `<circuit>.pkv` and `./proof.np`.
- `show-inputs <pkv> <proof> --hex` displays public inputs from a generated proof.

## Integration Notes

- The Python backend should treat ProveKit as an externally provisioned binary and should not build Rust artifacts at import time or proof time.
- The wrapper should set explicit `--pkp`, `--pkv`, `--input`, `--out`, and `--proof` paths rather than relying on circuit-name defaults.
- The wrapper should capture stdout/stderr as diagnostic metadata but redact private witness input paths and contents.
- Upstream `v1` release build emitted warnings about unused `FinalClaim` values in `provekit-verifier/src/whir_r1cs.rs`; our integration should pin the commit and rely on end-to-end verification tests before accepting new upstream revisions.
- The basic example proof is much larger than the key files for this tiny circuit, so cache and IPFS payload policy must keep `.np` proof bytes public but never publish private Prover.toml inputs.
