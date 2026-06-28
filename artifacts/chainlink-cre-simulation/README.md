# Chainlink CRE Simulation Integration

**Task:** CLZKML-220  
**Track:** chainlink  
**Date:** 2026-06-13

This artifact documents the gated integration test added in
`tests/integration/test_chainlink_cre_consensus.py`.

## Gate

The test is skipped by default. Run it explicitly with:

```bash
IPFS_ACCELERATE_PY_RUN_CHAINLINK_CRE_TESTS=1 pytest tests/integration/test_chainlink_cre_consensus.py -q
```

When the run gate is enabled, the simulated workflow tests require explicit CRE
test identifiers:

```bash
export IPFS_ACCELERATE_PY_CHAINLINK_CRE_WORKFLOW_ID=wf-llm-router-v1
export IPFS_ACCELERATE_PY_CHAINLINK_CRE_DON_ID=don-42
```

Optional metadata:

- `IPFS_ACCELERATE_PY_CHAINLINK_CRE_REGISTRY`
- `IPFS_ACCELERATE_PY_CHAINLINK_CRE_CHAIN_ID`
- `IPFS_ACCELERATE_PY_CHAINLINK_CRE_ENDPOINT`

If the workflow ID or DON ID is absent, the workflow assertions skip with a
clear pytest reason instead of attempting live Chainlink access.

## Simulation Scenario

The test constructs a canonical `ConsensusRequest` for deterministic JSON
output with `proof_policy.mode = "chainlink_cre"`. It uses
`ChainlinkCREBridgeClient` with an injected simulated workflow result rather
than a live CRE transport.

The simulated CRE result returns:

- the configured workflow ID and DON ID,
- the request hash from the submitted canonical request,
- raw and normalized output hashes for the selected JSON output,
- CRE round, report hash, report ID, optional chain ID, and transaction hash,
- internal DON aggregation metadata showing a 3-of-5 selected result.

The bridge verifies the result with `ChainlinkCREVerifier` and converts it to a
shared `ConsensusReceipt` containing one `chainlink_cre` operator response and a
`chainlink_cre` proof receipt.

## Rejection Coverage

The integration test mutates the simulated CRE result and confirms fail-closed
rejection for:

- wrong workflow ID,
- wrong request hash,
- wrong output hash.

Each mutation must produce an unverified `VerificationResult`, and receipt
construction with `fail_closed=True` must raise `ChainlinkCREBridgeError`.

## Expected Acceptance Signal

The successful configured run proves:

- a simulated CRE workflow result is exercised end to end,
- receipt proof and operator metadata carry the CRE workflow/report bindings,
- wrong workflow/request/output identifiers are rejected,
- missing Chainlink test configuration skips cleanly.
