# Chainlink ZKML LLM Router Release Checklist

Last updated: 2026-06-14

Backlog item: `CLZKML-340`

This checklist is the production gate for enabling Chainlink/ZKML-backed LLM
router consensus on high-impact 211-AI wallet routes. It records the evidence
that is already in the repository and the remaining operational signoffs that
must be completed before production enablement.

## Current Signoff State

| Area | State | Evidence |
| --- | --- | --- |
| Local consensus core | Ready for staged deployment | `tests/test_llm_consensus.py`, `tests/test_llm_router_consensus.py` |
| Proof and receipt boundaries | Ready for staged deployment | `tests/test_llm_consensus_privacy.py`, `tests/test_llm_consensus_proof_verifiers.py` |
| Chainlink CRE bridge | Simulation-ready, live deployment pending | `tests/test_chainlink_cre_bridge.py`, `tests/integration/test_chainlink_cre_consensus.py` |
| Wallet/API contract | Ready for staged deployment | `tests/test_wallet_interface_api.py` |
| Frontend UX and no-leak evidence | Ready for staged deployment | `wallet_interface/ui/tests/chainlink-consensus-fullstack.spec.ts`, `wallet_interface/ui/tests/chainlink-consensus-ux.spec.ts`, `artifacts/chainlink-zkml-ui-review/` |
| Production high-impact enablement | Blocked until live ops signoff | See "Residual Production Risks" below |

## Required Backend Validation

Run these before release candidate tagging:

```bash
pytest tests/test_llm_consensus.py -q
pytest tests/test_llm_router_consensus.py -q
pytest tests/test_llm_consensus_p2p.py -q
pytest tests/test_llm_consensus_privacy.py -q
pytest tests/test_llm_consensus_proof_verifiers.py -q
pytest tests/test_chainlink_cre_bridge.py -q
pytest tests/test_llm_consensus_adversarial.py -q
pytest tests/test_wallet_interface_api.py -q
```

Gated tests require explicit live or simulated infrastructure:

```bash
IPFS_ACCELERATE_PY_RUN_LLM_CONSENSUS_P2P_TESTS=1 \
  pytest tests/integration/test_llm_consensus_p2p.py -q

IPFS_ACCELERATE_PY_RUN_CHAINLINK_CRE_TESTS=1 \
  IPFS_ACCELERATE_PY_CHAINLINK_CRE_WORKFLOW_ID=<workflow-id> \
  IPFS_ACCELERATE_PY_CHAINLINK_CRE_DON_ID=<don-id> \
  pytest tests/integration/test_chainlink_cre_consensus.py -q
```

## Required Frontend Validation

Run these before release candidate tagging:

```bash
npm --prefix wallet_interface/ui run build
npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
npm --prefix wallet_interface/ui test -- tests/chainlink-consensus-fullstack.spec.ts
npm --prefix wallet_interface/ui test -- tests/chainlink-consensus-ux.spec.ts
npm --prefix wallet_interface/ui test -- tests/wallet-ux-review.spec.ts
```

The UX evidence archive is `artifacts/chainlink-zkml-ui-review/` and currently
contains Desktop Chrome, Mobile Chrome, and Mobile Safari screenshots for home,
recipient access, uploads, Proof Center, QR/export review, security, audit, and
public analytics surfaces.

## Required Environment Variables

Production settings belong in an untracked deployment env file based on
`wallet_interface/deploy/env.production.example`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_ENABLED` | yes | Turns consensus mode on or off. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_MODE` | yes | `libp2p_quorum`, `local_quorum`, or approved CRE-backed mode. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_COMPARISON` | yes | Use `canonical_json` for structured high-impact workflows. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_QUORUM` | yes | Required agreement threshold. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_MIN_OPERATORS` | yes | Minimum independent operators. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_PEERS` | yes for libp2p | Comma-separated peer identities. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_OPERATOR_ID` | yes | Stable router/operator identity for receipts. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_FAIL_CLOSED` | yes | Must be `true` for high-impact automation. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_PROMPT_REDACTION_POLICY` | yes | Must remain `hash_only` for sensitive wallet prompts. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_RECEIPT_PATH` | recommended | Latest restricted receipt JSON path. |
| `IPFS_ACCELERATE_PY_LLM_CONSENSUS_RECEIPT_JSONL_PATH` | yes | Append-only restricted audit receipt log. |
| `IPFS_ACCELERATE_PY_LLM_PROOF_VERIFIER` | yes for proof modes | Active proof verifier policy ID. |
| `IPFS_ACCELERATE_PY_CHAINLINK_CRE_WORKFLOW_ID` | yes for CRE | Chainlink workflow ID expected by verifier policy. |
| `IPFS_ACCELERATE_PY_CHAINLINK_CRE_DON_ID` | yes for CRE tests | DON binding for live or simulated CRE receipts. |
| `IPFS_ACCELERATE_PY_CHAINLINK_CRE_REGISTRY` | yes for CRE | `private` or approved onchain registry. |
| `IPFS_ACCELERATE_PY_CHAINLINK_CRE_ENDPOINT` | yes for live CRE | HTTP trigger or gateway endpoint. |
| `IPFS_ACCELERATE_PY_CHAINLINK_VERIFIER_CONTRACT` | if onchain anchoring | Contract address used by verifier event parsing. |
| `IPFS_ACCELERATE_PY_RUN_CHAINLINK_CRE_TESTS` | CI opt-in | Enables gated CRE integration tests. |
| `IPFS_ACCELERATE_PY_RUN_LLM_CONSENSUS_P2P_TESTS` | CI opt-in | Enables gated libp2p integration tests. |

Do not put API keys, private keys, bearer tokens, TEE secrets, proof witnesses,
or raw CRE private report payloads in consensus config. Store secrets in the
existing wallet secret-manager references.

## Unsupported Downgrade Paths

The following downgrades are not allowed for high-impact production routes:

- quorum failure to direct LLM output
- proof verification failure to receipt-only output
- Chainlink CRE workflow mismatch to unverified output
- missing operator signatures when policy requires signed receipts
- missing verifier contract event when the policy requires onchain anchoring
- semantic-only comparison for eligibility, routing, entitlement, safety, or
  institutional audit automation
- public UI or export labels that call receipt-only, CRE-only, or TEE-only
  evidence a ZKML proof

Allowed fallback for high-impact routes is manual review with a typed
fail-closed error such as `quorum_not_reached`, `proof_verification_failed`,
`cre_workflow_mismatch`, or `policy_requires_manual_review`.

## Operator Identity Assumptions

Production quorum evidence assumes:

- each operator ID maps to a separately managed peer, key, and deployment owner
- duplicate operator IDs are rejected by tests and operational review
- signing key IDs are stable in receipts but private key material is never stored
  in receipt JSON, UI state, or public exports
- quorum thresholds are set against independent operators, not multiple workers
  sharing the same model endpoint, key, and failure domain
- operator timeouts are shorter than the route timeout so fail-closed responses
  are deterministic and user-visible
- receipt retention and key rotation policies are documented before launch

## Proof-Policy Limitations

- `receipt_only` proves agreement and receipt binding; it does not prove model
  execution.
- `chainlink_cre` verifies workflow execution and DON consensus metadata; it is
  not a zero-knowledge proof of model execution.
- `tee_or_zkml` may accept enclave attestation when policy allows it; TEE
  evidence must be labeled separately from mathematical ZK proof.
- `zkml_required` is valid only for bounded classifier or checker circuits with
  pinned verifier keys, circuit IDs, and model/tokenizer commitments.
- `semantic` comparison is advisory and must not be the sole consensus criterion
  for high-impact automation.
- Raw prompts, wallet plaintext, operator outputs, and private proof material
  must remain outside public receipts and frontend state.

## Chainlink CRE Deployment Evidence

Before live CRE enablement, attach or record:

- Chainlink account and organization with deploy access confirmed.
- CRE workflow ID, DON ID, registry mode, and deployment timestamp.
- Workflow source or build artifact matching `chainlink/cre/llm_consensus_workflow.md`.
- Deterministic inference endpoint policy with timeout and idempotency behavior.
- CRE report binding for request hash, output hash, model policy ID, and receipt
  CID or hash.
- Verifier contract address and transaction/event evidence when onchain anchoring
  is required.
- Confirmation that CRE pricing, quotas, billing, and usage limits are acceptable
  for the target launch scope.

## Frontend No-Leak Evidence

The release candidate must preserve the CLZKML-285 checks:

- consensus badges have precise labels for direct, receipt-only, libp2p quorum,
  Chainlink CRE, ZKML checker, TEE attestation, failure, and manual review states
- keyboard users can reach receipt details and fallback actions
- desktop and mobile routes avoid horizontal overflow and incoherent overlap
- public dashboards, QR/export views, audit summaries, and proof cards do not
  expose raw prompts, PII, operator secrets, raw proof bytes, private witnesses,
  or CRE private report payloads
- receipt-only, CRE-only, and TEE-only states are not labeled as ZKML proof

## Residual Production Risks

These items block high-impact production enablement until explicitly signed off:

- live Chainlink CRE deploy access and workflow deployment are not represented by
  a committed production deployment receipt
- live libp2p peer identities, signing keys, and operator independence need ops
  approval
- verifier contract deployment and event indexing are optional in code and must
  be required by policy before onchain audit claims
- ZKML coverage is limited to bounded checker circuits; do not claim full LLM
  generation is ZK-proven
- receipt retention, incident response, key rotation, and audit access controls
  need production owner signoff
- billing and quota limits for live CRE usage must be confirmed before traffic
  is routed through paid or limited infrastructure

## Release Decision

Staged release is acceptable for internal, mock, and simulation-backed flows
after the backend and frontend commands above pass. Production high-impact
routes must remain fail-closed and manually reviewed until the residual
production risks are signed off by the service owner, security owner, and
Chainlink/ops owner.
