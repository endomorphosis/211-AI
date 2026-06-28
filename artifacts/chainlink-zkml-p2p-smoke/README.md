# libp2p Local Worker Smoke

**Task:** CLZKML-190  
**Track:** p2p  
**Date:** 2026-06-13

This artifact documents the gated integration smoke test added in
`tests/integration/test_llm_consensus_p2p.py`.

## Gate

The smoke test is skipped by default. Run it explicitly with:

```bash
IPFS_ACCELERATE_PY_RUN_LLM_CONSENSUS_P2P_TESTS=1 pytest tests/integration/test_llm_consensus_p2p.py -q
```

The test skips with a clear pytest reason when one of the required pieces is not
available:

- `duckdb`, used by the local `TaskQueue` worker queues.
- `libp2p`, used by the local p2p transport.
- `ipfs_accelerate_py.p2p_tasks`, the canonical task queue client/service stack.

## Smoke Scenario

When the gate and dependencies are present, the test starts three localhost
libp2p task queue services on free TCP ports. Each service has a separate
DuckDB queue and a deterministic test worker that claims
`llm-consensus-generate-v1` tasks and writes a structured
`llm-consensus-generate-v1-response` record.

Two workers return the same canonical JSON answer with different whitespace:

```json
{"answer":"4"}
```

The third worker returns a divergent answer:

```json
{"answer":"5"}
```

The root consensus runner submits through the existing p2p fan-out path, waits
on all three peers, and asserts that canonical JSON comparison accepts the
2-of-3 majority while rejecting the divergent worker.

## Expected Acceptance Signal

The successful run proves:

- Three local libp2p workers can participate in one consensus request.
- A 2-of-3 quorum is selected through `run_p2p_consensus`.
- The divergent worker remains in the receipt and is listed as rejected.
- Environments without the p2p dependency stack skip instead of failing during
  normal test collection.
