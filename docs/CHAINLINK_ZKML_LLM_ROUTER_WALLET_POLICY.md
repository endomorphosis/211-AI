# Chainlink ZKML LLM Router Wallet Policy

Last updated: 2026-06-14

This policy maps Chainlink/consensus LLM router capabilities onto 211-AI wallet
and UI workflows. It is the missing policy artifact for `CLZKML-270` and should
drive the later wallet/API and Playwright implementation tasks.

## Policy Goals

- Keep low-risk conversational help on the existing fast path unless a caller
  explicitly requests consensus.
- Require fail-closed consensus for high-impact automated decisions.
- Show clients and operators when an AI output was direct, receipt-only,
  libp2p quorum verified, Chainlink CRE verified, ZKML verified, or TEE
  attested.
- Keep raw prompts, PII, private wallet content, operator secrets, and proof
  witnesses out of public UI, audit summaries, exports, and onchain metadata.

## Workflow Classification

| Workflow | Surface | Consensus | Comparison | Proof Policy | Fallback | UI Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| General chat, drafting, and explainers | Assistant/chat | Optional | normalized_text | receipt_only | direct allowed | Hide by default; advanced receipt drawer only |
| Service category classification | Search/intake/router | Required when auto-routing | canonical_json | receipt_only or libp2p_quorum | manual review | Badge with quorum, mode, and receipt hash |
| Eligibility extraction or claims | Provider cases, intake, forms | Required | canonical_json | tee_or_zkml for high-impact launch | fail closed | Block action and explain missing verified consensus |
| Safety-critical advice | Safety planning, emergency pathways | Required for automation; advisory only for copy | canonical_json | libp2p_quorum plus receipt_only minimum | human/manual path | Show "manual review required" on no quorum |
| Redacted document analysis | Recipient access, wallet/uploads | Required when output drives decisions | canonical_json | receipt_only minimum | fail closed for gated automation | Show receipt metadata beside derived artifact |
| GraphRAG or vector profile creation | Recipient access, wallet/uploads | Optional for indexing; required for automated claims | canonical_json | receipt_only | degraded indexing allowed only when labeled | Show indexing mode and no-claim warning |
| Public analytics or proof-backed release text | Public dashboard, analytics | Required | canonical_json | ZKML checker or TEE where available | block release | Show proof/consensus freshness in proof details |

## Backend Contract

Wallet and API routes that request consensus must return a sanitized consensus
summary, not raw receipt internals. The frontend should be able to render:

- `schema_version`
- `mode`
- `comparison`
- `quorum_reached`
- `operator_count`
- `selected_operator_count`
- `proof_mode`
- `verification_label`
- `receipt_hash` or `receipt_cid`
- `created_at`
- `failure_reason`, redacted and user-safe

The response must not expose:

- raw prompt or document text
- raw operator outputs beyond the selected user-facing answer
- bearer tokens, API keys, private keys, or operator signing secrets
- raw ZK proof bytes, TEE quote bytes, or CRE private report payloads
- wallet plaintext or private witness values

Fail-closed routes must return an error shape that the TypeScript client can
distinguish from transient network failures:

- `consensus_unavailable`
- `quorum_not_reached`
- `proof_verification_failed`
- `cre_workflow_mismatch`
- `receipt_replay_or_mismatch`
- `policy_requires_manual_review`

## UI Contract

The UI must not imply that Chainlink, ZKML, or TEE evidence proves more than the
receipt actually proves. Use precise labels:

- "Consensus receipt" for receipt-only or libp2p quorum evidence.
- "Chainlink CRE verified" only when CRE workflow/report metadata is verified.
- "ZKML checker verified" for bounded model/checker proofs.
- "TEE attested" for enclave evidence; do not call it a mathematical ZK proof.
- "Manual review required" when a high-impact workflow cannot satisfy policy.

Required UI surfaces:

- Recipient access redacted analysis actions and derived artifact cards.
- Wallet/uploads document profiling and organizer metadata generation.
- Proof Center proof receipt cards and QR proof review.
- Security/audit views for fail-closed events and receipt hashes.
- Provider case/eligibility workflows before an automated claim is accepted.
- Public analytics/proof dashboard before publishing proof-backed release copy.

Required UI states:

- consensus disabled/direct fast path
- consensus pending
- receipt-only success
- libp2p quorum success
- Chainlink CRE verified success
- ZKML checker verified success
- TEE attested success
- quorum failure
- proof or CRE verification failure
- fail-closed manual fallback
- redacted receipt unavailable

## Test Requirements

Backend tests must cover request-field and environment-policy activation,
fail-closed behavior, typed error shapes, sanitized consensus metadata, and
no-leak guarantees for prompts, wallet plaintext, proof witnesses, and secrets.

Frontend Playwright tests must cover mocked UI states and full-stack live-wallet
API flows. The full-stack harness should start the wallet API with deterministic
mock consensus responses, then verify:

- recipient access redacted analysis shows consensus metadata on success.
- wallet/uploads profiling shows receipt state when consensus is required.
- Proof Center and QR proof review display sanitized receipt metadata.
- fail-closed consensus failures do not silently downgrade to direct LLM output.
- desktop and mobile layouts do not overflow or hide fallback actions.
- visible UI, exported public metadata, and audit summaries do not leak raw
  prompts, PII, operator secrets, proof witnesses, or raw proof payloads.
