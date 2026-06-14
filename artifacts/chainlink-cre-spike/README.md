# Chainlink CRE Access And Capability Spike

Generated: 2026-06-13

Task: `CLZKML-020 Chainlink CRE Access And Capability Spike`

## Scope

This artifact records the Chainlink Runtime Environment (CRE) assumptions needed
to implement LLM router consensus through Chainlink infrastructure. It is based
on official Chainlink documentation checked on 2026-06-13.

Companion machine-readable matrix:

- `artifacts/chainlink-cre-spike/cre-capability-matrix.json`

## Findings

### CRE is the correct target

Use CRE, not Chainlink Functions, for new work.

Relevant source:

- `https://docs.chain.link/chainlink-functions/resources/billing`

Current note: Chainlink Functions docs state Functions testnet sunset was
2026-06-02 and mainnet sunset is 2026-09-01, and direct users to migrate to
CRE.

### Deployment access

CRE workflow deployment requires Early Access approval.

Relevant source:

- `https://docs.chain.link/cre/account/deploy-access`

Required action for this project:

- Run `cre account access` under the intended Chainlink account.
- Confirm the organization ID.
- Request deploy access if not enabled.
- Keep building and simulating locally while access is pending.

### SDK and deployment model

CRE workflows are built with the CRE SDK in Go or TypeScript, compiled with the
CRE CLI, and deployed to a DON.

Relevant source:

- `https://docs.chain.link/cre`

Project implication:

- The Python router should not embed CRE workflow logic directly.
- Python should produce canonical request envelopes and verify returned receipts.
- The CRE workflow should be a separate Go or TypeScript artifact.

### Registry models

CRE supports two deployment registry models:

- `private`: Chainlink-hosted offchain registry, authorized by CRE login
  session, no wallet/gas/RPC required for registry operations.
- `onchain:ethereum-mainnet`: public onchain registry, authorized by linked
  web3 wallet key, requires Ethereum mainnet RPC and ETH for registry gas.

Relevant source:

- `https://docs.chain.link/cre/guides/operations/deploying-workflows`

Recommended first path:

- Use `private` for early testing and project-managed workflows.
- Move to `onchain:ethereum-mainnet` only when public registry ownership,
  multisig governance, or production audit requirements justify it.

### Capability consensus

CRE execution capabilities automatically include built-in consensus. The docs
state that HTTP, Confidential HTTP, and EVM execution capabilities validate
results across multiple nodes.

Relevant sources:

- `https://docs.chain.link/cre/capabilities`
- `https://docs.chain.link/cre/concepts/consensus-computing`

Router implication:

- A CRE-backed inference workflow should treat the CRE result as
  consensus-verified for the CRE capability calls it performs.
- The Python receipt must still bind the CRE result to the router request hash,
  model commitment, output hash, workflow ID, registry, and verifier policy.

### HTTP capability

The HTTP client can call external APIs and wraps HTTP requests in consensus.
The TypeScript SDK's high-level `sendRequest()` helper handles the node-mode
pattern and consensus aggregation.

Relevant sources:

- `https://docs.chain.link/cre/guides/workflow/using-http-client`
- `https://docs.chain.link/cre/reference/sdk/http-client-ts`

Router implication:

- Deterministic GET or idempotent POST inference endpoints are the simplest CRE
  target.
- For POST inference, the endpoint must be idempotent by request hash or the
  workflow must use the documented single-execution/cache pattern.
- Inference responses must be stable enough for consensus aggregation:
  deterministic decoding, fixed seed where supported, structured JSON output,
  and explicit timeout/error behavior.

### Confidential HTTP capability

Confidential HTTP can run requests inside a secure enclave, inject secrets via
templates, and optionally encrypt responses.

Relevant sources:

- `https://docs.chain.link/cre/guides/workflow/using-confidential-http-client`
- `https://docs.chain.link/cre/reference/sdk/confidential-http-client-ts`

Router implication:

- Use Confidential HTTP when prompts, credentials, or tenant-specific inference
  headers must not be exposed to Workflow DON nodes.
- Do not paste secrets fetched with regular runtime secret APIs into plaintext
  request headers or bodies. Use the documented vault-style template pattern.
- Confidential HTTP is TEE/confidential-compute evidence, not automatically a
  ZKML proof of model execution.

### HTTP trigger path

Deployed HTTP-triggered workflows require signed requests from authorized EVM
addresses.

Relevant source:

- `https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/overview-ts`

Router implication:

- The Python CRE bridge should support an authenticated trigger flow, including
  authorized signing key configuration and replay-safe request IDs.
- The first local implementation should keep live trigger calls behind
  `IPFS_ACCELERATE_PY_RUN_CHAINLINK_CRE_TESTS=1`.

### Service quotas

CRE service quotas are documented as subject to change. Current documented
defaults include organization membership and registry workflow limits.

Relevant source:

- `https://docs.chain.link/cre/service-quotas`

Current quota notes from docs:

- Maximum users per organization: 40.
- Private registry workflows per organization: 3.
- Onchain linked keys per organization: 1.
- Onchain workflows per linked key: 3.

Router implication:

- Do not assume unlimited workflow deployments for per-model variants.
- Prefer one configurable workflow that receives model/proof policy IDs instead
  of many per-model workflows.

### Billing and subscription needs

The current public CRE pages reviewed here document deploy access and quotas,
but do not expose a complete CRE billing/subscription model equivalent to the
legacy Functions billing pages.

Relevant source for the legacy warning:

- `https://docs.chain.link/chainlink-functions/resources/billing`

Project implication:

- Do not use Chainlink Functions subscriptions for this new feature.
- Confirm CRE pricing, billing account, usage limits, and any LINK/native-token
  funding requirements with Chainlink before production deployment.
- Keep CRE integration tests opt-in so normal CI does not create paid usage.

### Verifier contract requirements

CRE itself can return consensus-verified workflow results. An additional
verifier contract is only required if the project wants onchain anchoring,
public auditability, wallet/API contract checks, or downstream smart contracts
to consume receipt state.

Recommended verifier contract fields:

- `workflowId`
- `registry`
- `chainId`
- `requestHash`
- `modelCommitment`
- `outputHash`
- `proofPolicy`
- `proofHash`
- `receiptCid`
- `operatorSetHash` or CRE report metadata when available
- `timestamp`

Registry implication:

- If using `onchain:ethereum-mainnet`, registry operations need Ethereum mainnet
  RPC and ETH for gas.
- If using a separate app verifier contract on another chain, the CRE workflow
  needs EVM write capability and that chain's deployment/configuration details.

## Recommended First CRE Architecture

1. Python builds a `ConsensusRequest` and pins or encrypts large request
   material if needed.
2. Python calls a deployed CRE HTTP-triggered workflow with the request hash,
   request payload or CID, model policy ID, and proof policy ID.
3. CRE workflow calls an approved deterministic inference endpoint through HTTP
   or Confidential HTTP.
4. CRE capability DONs perform their built-in consensus and return a single
   verified result to the workflow.
5. Workflow returns or anchors a receipt with request hash, output hash,
   workflow ID, registry, and proof metadata.
6. Python verifies the returned receipt against the original request before
   exposing `receipt.text` to callers.

## Open Items Before Production

- Obtain CRE deploy access for the project organization.
- Select `private` or `onchain:ethereum-mainnet` registry for first deployment.
- Confirm CRE billing/pricing and operational quotas with Chainlink.
- Choose Go or TypeScript for the first workflow.
- Decide whether the first workflow is HTTP-triggered only, EVM-triggered, or
  both.
- Decide whether an app verifier contract is required in the first release.
- Identify the deterministic inference endpoint and its model/version
  commitments.
- Decide whether prompts require Confidential HTTP and encrypted response
  handling.

