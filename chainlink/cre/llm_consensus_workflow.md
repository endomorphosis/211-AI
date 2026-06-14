# Chainlink CRE LLM Consensus Workflow Template

This is a deployment template and detailed pseudocode for a Chainlink Runtime
Environment (CRE) workflow that produces an `ipfs_accelerate_py` LLM consensus
receipt. It is intentionally not a Chainlink Functions workflow: do not use
Functions routers, DON-hosted JavaScript source, Functions subscriptions, or
Functions secrets. The workflow target is CRE HTTP or Confidential HTTP
capabilities executed by a DON and reported back through the CRE bridge.

## Purpose

The workflow accepts a canonical LLM consensus request, has independent DON
nodes call an approved deterministic inference endpoint, aggregates matching
node results through DON consensus, and returns a receipt-shaped result that
the local `ChainlinkCREBridgeClient` can verify.

The returned result must bind:

- the CRE workflow identity,
- the DON identity,
- the canonical request hash,
- the selected raw output hash,
- the selected normalized output hash,
- model and endpoint policy metadata,
- optional Confidential HTTP, TEE, ZKML, or onchain report metadata.

## Canonical Request Input

The bridge submits this envelope to the CRE workflow:

```json
{
  "schema_version": "chainlink-cre-llm-consensus-request-v1",
  "workflow_id": "wf-llm-router-v1",
  "don_id": "don-42",
  "registry": "private",
  "chain_id": "11155111",
  "request_id": "req-2026-06-13-0001",
  "request_hash": "sha256:7d6d0f...",
  "deadline_unix_ms": 1781395152000,
  "request": {
    "schema_version": "llm-router-consensus-request-v1",
    "request_id": "req-2026-06-13-0001",
    "request_hash": "sha256:7d6d0f...",
    "provider": "hf_inference_api",
    "model_name": "Qwen/Qwen2.5-1.5B-Instruct",
    "model_commitment": "hf:Qwen/Qwen2.5-1.5B-Instruct@revision-or-digest",
    "comparison": "canonical_json",
    "quorum": 3,
    "min_operators": 5,
    "deadline_unix_ms": 1781395152000,
    "proof_policy": {
      "mode": "chainlink_cre",
      "cre_workflow_id": "wf-llm-router-v1"
    },
    "metadata": {
      "nonce": "nonce-cre-1",
      "prompt_hash": "sha256:95f3c2...",
      "generation_params_hash": "sha256:1a4cf8...",
      "response_schema_hash": "sha256:75a2c0..."
    }
  },
  "prompt": "Return JSON with answer=yes",
  "metadata": {
    "model_policy_id": "policy-qwen-json-v1",
    "endpoint_policy_id": "policy-inference-http-v1"
  }
}
```

Request rules:

- `request_hash` must be the hash computed by the local consensus request
  builder over its canonical stable JSON payload.
- `prompt` may be omitted when the workflow receives only encrypted request
  material or a CID. If omitted, the workflow must use `prompt_cid`,
  `encrypted_prompt_cid`, or an equivalent policy-approved reference in
  `request.metadata`.
- `deadline_unix_ms` must be checked before any capability call and again before
  returning the report.
- `model_policy_id` must resolve to the exact endpoint allowlist, model
  commitment, deterministic generation parameters, output schema, and
  comparison mode.
- Private prompt text, PII, credentials, and secret material must not be placed
  onchain or in public receipt fields. Use hashes, encrypted CIDs, or
  Confidential HTTP.

## Inference Capability Calls

Each participating DON node performs the same capability call with the same
canonical request fields.

HTTP mode:

```text
POST {policy.endpoint_url}
headers:
  content-type: application/json
  authorization: secret(policy.credential_ref)
body:
  request_id
  request_hash
  prompt or encrypted_prompt_cid
  model
  model_commitment
  deterministic_generation_params
  response_schema
  nonce
```

Confidential HTTP mode:

```text
POST {policy.confidential_endpoint_url}
confidential_context:
  secret_template_id
  expected_enclave_measurement
  attestation_nonce = request.metadata.nonce
body:
  encrypted request material or prompt CID
  public request_hash
  model_policy_id
```

The endpoint response from each node must be normalized into:

```json
{
  "node_id": "don-node-redacted",
  "status": "completed",
  "output_text": "{\"answer\":\"yes\"}",
  "output_hash": "sha256:7543a1...",
  "normalized_output_hash": "sha256:bb1e43...",
  "latency_ms": 842,
  "proof_metadata": {
    "model_policy_id": "policy-qwen-json-v1",
    "endpoint_policy_id": "policy-inference-http-v1",
    "confidential_http_attestation_hash": null,
    "tee_attestation_hash": null,
    "zkml_proof_cid": null
  }
}
```

Node response rules:

- The HTTP status must be 2xx and the body must match the policy response
  schema.
- `output_hash` is `sha256` over the raw selected output string.
- `normalized_output_hash` is computed using the request `comparison` mode.
- For `canonical_json`, JSON must parse, serialize with stable key order and
  compact separators, and then hash.
- Non-deterministic fields such as timestamps, request traces, and provider
  token counters must not be part of the selected output unless explicitly
  included in the response schema and normalization policy.
- Confidential HTTP evidence must bind `request_hash`, `output_hash`, nonce, and
  the approved enclave or secret template policy.

## DON Consensus Aggregation

The workflow aggregates node responses by `normalized_output_hash`.

Pseudocode:

```text
function run(input):
  assert input.workflow_id == configured.workflow_id
  assert input.don_id == configured.don_id
  assert input.request.request_hash == input.request_hash
  assert now_ms() <= input.deadline_unix_ms

  policy = load_model_policy(input.metadata.model_policy_id)
  assert policy.model_commitment == input.request.model_commitment
  assert policy.comparison == input.request.comparison
  assert policy.quorum >= input.request.quorum
  assert policy.min_nodes >= input.request.min_operators

  node_results = []
  for node in DON.participants:
    result = node.call_http_or_confidential_http(input, policy)
    node_results.append(validate_node_result(result, input, policy))

  successful = [r for r in node_results if r.status == "completed"]
  groups = group_by(successful, r.normalized_output_hash)
  selected_group = largest_group(groups)

  if count(successful) < input.request.min_operators:
    return failure("insufficient_successful_nodes", node_results)

  if selected_group.count < input.request.quorum:
    return failure("quorum_not_met", node_results)

  selected = deterministic_tie_break(selected_group)
  report_body = build_report_body(input, selected, selected_group, node_results)
  report_hash = sha256(stable_json(report_body))

  return {
    schema_version: "chainlink-cre-inference-result-v1",
    status: "completed",
    submission_id: sha256(stable_json({
      workflow_id, don_id, request_hash, request_id
    })),
    workflow_id,
    don_id,
    request_hash,
    output_text: selected.output_text,
    output_hash: selected.output_hash,
    normalized_output_hash: selected.normalized_output_hash,
    cre_round: current_cre_round(),
    cre_report_hash: report_hash,
    cre_report_id: report_id_or_report_hash(report_hash),
    chain_id: optional_chain_id,
    tx_hash: optional_tx_hash,
    nonce: input.request.metadata.nonce,
    latency_ms: elapsed_ms(),
    metadata: report_body.metadata
  }
```

Tie-breaking must be deterministic. If two groups both satisfy quorum, prefer
the group with the highest count, then the lowest lexicographic
`normalized_output_hash`, then the lowest lexicographic `output_hash`.

## Error Handling

The workflow is fail-closed. It must return `status: "failed"` or no verified
report for these cases:

| Reason | Status | Metadata |
| --- | --- | --- |
| `invalid_workflow_id` | `failed` | Expected and received workflow IDs |
| `invalid_don_id` | `failed` | Expected and received DON IDs |
| `request_hash_mismatch` | `failed` | Top-level and nested request hashes |
| `deadline_expired` | `timeout` | Deadline and observed time |
| `model_policy_not_found` | `failed` | Requested policy ID |
| `model_policy_mismatch` | `failed` | Expected model commitment/comparison |
| `http_capability_error` | `failed` | Per-node status codes and error hashes |
| `confidential_attestation_mismatch` | `failed` | Expected measurement and evidence hash |
| `malformed_model_output` | `failed` | Schema validation error hash |
| `insufficient_successful_nodes` | `failed` | Successful node count and minimum |
| `quorum_not_met` | `failed` | Group counts and quorum |
| `report_anchoring_failed` | `failed` | Chain ID, verifier contract, transaction error |

Failure results must still include `schema_version`, `submission_id`,
`workflow_id`, `don_id`, `request_hash`, `status`, `cre_round` when available,
and `metadata.error`. They must not include a selected `output_text`,
`output_hash`, or `normalized_output_hash` unless the verifier policy explicitly
supports non-fail-closed diagnostics. The Python bridge will reject incomplete
or mismatched proof metadata.

## Proof Metadata

The workflow result must expose the fields consumed by `ChainlinkCREVerifier`:

```json
{
  "request_hash": "sha256:7d6d0f...",
  "output_hash": "sha256:7543a1...",
  "cre_workflow_id": "wf-llm-router-v1",
  "cre_don_id": "don-42",
  "cre_round": 7,
  "cre_report_hash": "sha256:c491e3...",
  "cre_report_id": "cre-report-2026-06-13-0007",
  "nonce": "nonce-cre-1",
  "chain_id": "11155111",
  "tx_hash": "0xabc123..."
}
```

Optional proof metadata may also be placed under `metadata.proof`:

- `model_policy_id`
- `model_commitment`
- `endpoint_policy_id`
- `operator_set_hash`
- `node_response_hashes`
- `confidential_http_attestation_hash`
- `tee_attestation_hash`
- `zkml_proof_cid`
- `verifier_contract`
- `verifier_event`

CRE consensus metadata is not a ZKML proof by itself. Only set
`zkml_proof_cid` or ZKML verifier fields when a real proof binds the prompt,
model commitment, output commitment, and verifier key.

## Returned Receipt Fields

The successful CRE result returned to the local bridge must be compatible with
`CREInferenceResult`:

```json
{
  "schema_version": "chainlink-cre-inference-result-v1",
  "submission_id": "sha256:b96f8c...",
  "workflow_id": "wf-llm-router-v1",
  "don_id": "don-42",
  "request_hash": "sha256:7d6d0f...",
  "output_hash": "sha256:7543a1...",
  "normalized_output_hash": "sha256:bb1e43...",
  "output_text": "{\"answer\":\"yes\"}",
  "status": "completed",
  "cre_round": 7,
  "cre_report_hash": "sha256:c491e3...",
  "cre_report_id": "cre-report-2026-06-13-0007",
  "chain_id": "11155111",
  "tx_hash": "0xabc123...",
  "latency_ms": 1288,
  "nonce": "nonce-cre-1",
  "metadata": {
    "model_policy_id": "policy-qwen-json-v1",
    "endpoint_policy_id": "policy-inference-http-v1",
    "aggregation": {
      "comparison": "canonical_json",
      "quorum": 3,
      "min_operators": 5,
      "successful_nodes": 5,
      "selected_count": 5
    }
  }
}
```

The bridge converts this into a shared `ConsensusReceipt` with:

- a single `OperatorResponse` using `transport: "chainlink_cre"`,
- `ConsensusResult.accepted: true` when verification passes,
- `ProofReceipt.policy: "chainlink_cre"`,
- `ProofReceipt.cre_workflow_id`,
- `ProofReceipt.cre_report_id`,
- optional `chain_id` and `tx_hash`,
- verification metadata from the CRE report.

## Deployment Checklist

- Configure CRE workflow ID, DON ID, registry, and optional chain ID.
- Register the model policy with exact model commitment, generation parameters,
  comparison mode, schema hash, endpoint allowlist, quorum, and minimum node
  count.
- Choose HTTP or Confidential HTTP. Use Confidential HTTP for sensitive prompts,
  private retrieval context, or endpoints requiring enclave-bound secrets.
- Ensure each node computes hashes from canonical bytes, not provider-formatted
  traces.
- Ensure failures do not return unverifiable selected outputs.
- Configure optional verifier contract/event anchoring only if required by the
  deployment path.
- Test locally with `ChainlinkCREBridgeClient.simulated(...)` before connecting
  a live CRE adapter.
