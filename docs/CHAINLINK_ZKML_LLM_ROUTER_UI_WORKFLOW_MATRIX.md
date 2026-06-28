# Chainlink ZKML LLM Router UI Workflow Matrix

Last updated: 2026-06-14

Task: `CLZKML-281 UI/API Consensus Workflow Matrix And Fixtures`

This matrix maps wallet UI workflows to the wallet API routes, TypeScript entry
points, consensus policy, fail-closed behavior, receipt metadata, no-leak checks,
and Playwright coverage required before Chainlink consensus metadata is surfaced
in the UI. It builds on `docs/CHAINLINK_ZKML_LLM_ROUTER_WALLET_POLICY.md` and the
optional wallet API consensus integration from `CLZKML-280`.

## Shared UI Contract

Consensus metadata rendered by the UI must be sanitized and compact. The UI may
render these fields:

- `schema_version`
- `mode`
- `comparison`
- `quorum_reached`
- `operator_count`
- `selected_operator_count`
- `proof_mode`
- `verification_label`
- `receipt_hash`
- `receipt_cid`
- `created_at`
- `failure_reason`
- `fail_closed_error`
- `proof_cid`
- `public_inputs_hash`
- `tee_attestation_hash`
- `cre_workflow_id`
- `cre_report_id`
- `chain_id`
- `tx_hash`

The UI must not render raw prompts, wallet plaintext, raw operator outputs,
operator secrets, raw ZK proof bytes, TEE quote bytes, CRE private reports, proof
witnesses, bearer tokens, private keys, or provider credentials.

Precise labels:

- `receipt_only`: "Consensus receipt"
- `libp2p_quorum`: "libp2p quorum receipt"
- `chainlink_cre`: "Chainlink CRE verified"
- `zkml_required`: "ZKML checker verified"
- `tee_or_zkml` with TEE evidence: "TEE attested"
- direct fast path: "Direct AI response"
- blocked high-impact workflow: "Manual review required"

TEE evidence and CRE consensus must not be labeled as a mathematical ZK proof.

## Workflow Matrix

| Workflow | Current backend routes | TypeScript calls | Consensus mode and comparison | Fail-closed errors | Receipt metadata fields | No-leak assertions | Desktop and mobile Playwright coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Recipient access redacted analysis and derived artifacts | `POST /wallets/{wallet_id}/records/{record_id}/analysis-grants`, `POST /wallets/{wallet_id}/records/{record_id}/analysis-invocations`, `POST /wallets/{wallet_id}/records/{record_id}/analyze/redacted`, `POST /wallets/{wallet_id}/records/{record_id}/vector-profile`, `POST /wallets/{wallet_id}/records/analyze/redacted`, `POST /wallets/{wallet_id}/records/graphrag/redacted` | `createRecordGrant`, `issueRecordAnalysisInvocation`, `analyzeRecordRedactedWithGrant`, `createRecordVectorProfileWithGrant`, `createRedactedGraphRAG` | Required when output drives access, routing, or claims. Use `libp2p_quorum` or `hybrid` with `canonical_json`; allow `receipt_only` only for advisory summaries. | `consensus_unavailable`, `quorum_not_reached`, `policy_requires_manual_review`, `receipt_replay_or_mismatch` | `mode`, `comparison`, `quorum_reached`, `operator_count`, `selected_operator_count`, `verification_label`, `receipt_hash`, `receipt_cid`, `created_at`, `failure_reason` | Redacted artifact cards and audit rows must not include raw document text, grant invocation token, private notes, wallet plaintext, raw operator outputs, or prompt text. | Extend `tests/smoke.spec.ts` recipient access coverage and `tests/fullstack-wallet.spec.ts` live redacted analysis flow on desktop and mobile; assert success badges, fail-closed manual action, and absence of sanitizer sentinel strings. |
| Wallet uploads and document profiling | `POST /wallets/{wallet_id}/documents`, `POST /wallets/{wallet_id}/documents/text`, `PATCH /wallets/{wallet_id}/records/{record_id}/metadata`, `POST /wallets/{wallet_id}/records/{record_id}/metadata/generate`, `POST /wallets/{wallet_id}/records/{record_id}/document-profile-proofs` | `addBinaryDocument`, `addTextDocument`, `updateWalletRecordMetadata`, `generateWalletRecordMetadata`, `createDocumentPrivacyProfileProof` | Optional for indexing; required before generated metadata becomes an automated eligibility, routing, or public claim. Use `receipt_only` for profiling, `libp2p_quorum` with `canonical_json` for claims, and `zkml_required` for bounded privacy-profile checker proofs. | `consensus_unavailable`, `quorum_not_reached`, `proof_verification_failed`, `policy_requires_manual_review` | `mode`, `proof_mode`, `verification_label`, `receipt_hash`, `receipt_cid`, `proof_cid`, `public_inputs_hash`, `created_at`, `failure_reason` | Upload cards must not expose file plaintext, OCR text, raw profile prompt, proof witness, raw proof payload, encrypted record key material, or Filecoin sidecar credentials. | Cover `/uploads` upload, metadata generation, profile proof creation, and failure state in desktop and mobile projects; assert layout does not hide retry/manual review actions. |
| Proof Center proof receipts | `GET /wallets/{wallet_id}/proofs`, `POST /wallets/{wallet_id}/locations/{location_record_id}/region-proofs`, `POST /wallets/{wallet_id}/locations/{location_record_id}/distance-proofs`, `POST /wallets/{wallet_id}/records/{record_id}/document-profile-proofs` | `listWalletProofReceipts`, `createLocationRegionProof`, `createLocationDistanceProof`, `createDocumentPrivacyProfileProof` | Proof receipts remain direct wallet proofs unless an AI-derived claim is attached. AI-derived proof cards require `zkml_required` for bounded checker proofs or `tee_or_zkml` when the accepted evidence is TEE. | `proof_verification_failed`, `receipt_replay_or_mismatch`, `policy_requires_manual_review` | `mode`, `proof_mode`, `verification_label`, `proof_cid`, `public_inputs_hash`, `receipt_hash`, `created_at`, `failure_reason`, `chain_id`, `tx_hash` | Proof cards must show public inputs only. They must not expose location witness coordinates, private wallet records, raw proof bytes, TEE quotes, or private verifier inputs. | Extend proof center desktop and mobile tests to render direct, ZKML, TEE, receipt-only, proof-failure, and manual-review states without calling TEE evidence a ZK proof. |
| QR proof review | `GET /ipfs-proxy/{cid}` for IPFS/Filecoin bundle resolution; inline QR payloads are client-side only | `reviewWalletProofBundleReference`, `reviewWalletProofBundlePayload`, `reviewWalletProofQrScreenshot` | QR review must preserve the consensus mode in imported proof metadata. `chainlink_cre`, `zkml_required`, and `tee_or_zkml` may be displayed only if the bundle contains matching sanitized fields. | `receipt_replay_or_mismatch`, `proof_verification_failed`, `cre_workflow_mismatch`, `policy_requires_manual_review` | `mode`, `proof_mode`, `verification_label`, `receipt_hash`, `receipt_cid`, `proof_cid`, `public_inputs_hash`, `tee_attestation_hash`, `cre_workflow_id`, `cre_report_id`, `created_at` | QR bundle summaries must not render encrypted record plaintext, raw QR-embedded prompt text, raw proof payload, proof witness, CRE private report, or TEE quote bytes. | Cover inline URL, IPFS proxy, and bad-bundle failure on desktop and mobile; assert imported cards keep source label and sanitized consensus badge. |
| Security and audit | `GET /wallets/{wallet_id}/audit`, `GET /wallets/{wallet_id}/audit-events`, `GET /wallets/{wallet_id}/grant-receipts`, `POST /exports/verify`, `POST /exports/import`, `POST /exports/storage` | `listWalletAuditEvents`, `listGrantReceipts`, `verifyExportBundle`, `importExportBundleView`, `verifyExportBundleStorage` | Audit views record every consensus activation and fail-closed event. Use the mode required by the initiating workflow; audit rows should never downgrade failed consensus to direct output. | `consensus_unavailable`, `quorum_not_reached`, `proof_verification_failed`, `cre_workflow_mismatch`, `receipt_replay_or_mismatch`, `policy_requires_manual_review` | `mode`, `quorum_reached`, `proof_mode`, `verification_label`, `receipt_hash`, `receipt_cid`, `created_at`, `failure_reason`, `fail_closed_error` | Audit exports must not include raw prompt, wallet plaintext, operator secrets, raw operator outputs, proof witness, raw proof payload, CRE private report, or TEE quote bytes. | Extend audit screen desktop and mobile tests with successful consensus, quorum failure, proof failure, and export verification rows; assert fail-closed events remain visible after reload. |
| Provider eligibility and automated claims | `POST /wallets/{wallet_id}/hmis/lookup-clients`, `POST /wallets/{wallet_id}/hmis/program-links`, `POST /wallets/{wallet_id}/hmis/referral-drafts`, `POST /wallets/{wallet_id}/hmis/referral-drafts/{referral_draft_id}/validate`, `POST /wallets/{wallet_id}/hmis/referral-drafts/{referral_draft_id}/submit`, `POST /services/match-derived` | Add typed CLZKML-282 wrappers for HMIS lookup, draft validation, draft submit, and service matching; provider portal currently uses local state for smoke coverage. | Required before accepting automated eligibility or referral claims. Use `hybrid` with `canonical_json`; allow `tee_or_zkml` for high-impact launch and `zkml_required` for bounded eligibility checkers. | `consensus_unavailable`, `quorum_not_reached`, `proof_verification_failed`, `cre_workflow_mismatch`, `policy_requires_manual_review` | `mode`, `comparison`, `quorum_reached`, `operator_count`, `selected_operator_count`, `proof_mode`, `verification_label`, `receipt_hash`, `receipt_cid`, `proof_cid`, `public_inputs_hash`, `created_at`, `failure_reason` | Provider screens must not expose raw eligibility prompt, client plaintext records, HMIS search secrets, private referral notes, operator secrets, proof witnesses, or raw proof payloads. | Extend provider case desktop and mobile coverage to show eligible, manual-review, quorum-failure, and proof-failure states before Submit is enabled. |
| Public analytics and proof dashboards | `GET /analytics/templates`, `GET /wallets/{wallet_id}/analytics/consents`, `POST /wallets/{wallet_id}/analytics/consents/from-template`, `POST /wallets/{wallet_id}/analytics/contributions`, `POST /analytics/{template_id}/count`, `POST /analytics/{template_id}/count-by-fields`, `GET /wallets/{wallet_id}/proofs` | `listAnalyticsTemplates`, `listWalletAnalyticsConsents`, `createWalletAnalyticsConsent`, `revokeWalletAnalyticsConsent`; add CLZKML-282 wrappers for contribution and aggregate count endpoints. | Required before publishing proof-backed release copy. Use `chainlink_cre` plus `zkml_required` where bounded proofs exist; `tee_or_zkml` may be accepted only with precise TEE labeling. | `consensus_unavailable`, `quorum_not_reached`, `proof_verification_failed`, `cre_workflow_mismatch`, `policy_requires_manual_review` | `mode`, `proof_mode`, `verification_label`, `receipt_hash`, `receipt_cid`, `proof_cid`, `public_inputs_hash`, `cre_workflow_id`, `cre_report_id`, `chain_id`, `tx_hash`, `created_at`, `failure_reason` | Public dashboards must contain aggregate facts and public inputs only. They must not expose wallet IDs for private cohorts, raw prompts, individual records, contribution plaintext, proof witnesses, raw proof payloads, CRE private reports, or TEE quote bytes. | Extend analytics and provider-proof desktop and mobile tests to render direct-blocked, CRE, ZKML, TEE, proof-failure, and sanitizer sentinel states; assert public export metadata excludes every sentinel. |

## Fixture Coverage

The shared TypeScript fixtures for this matrix live at
`wallet_interface/ui/tests/fixtures/chainlink-consensus-fixtures.ts`. They must
remain deterministic and safe for Playwright route mocks, unit tests, and future
wallet API client tests. The fixture set covers:

- direct fast path without consensus metadata
- receipt-only success
- libp2p quorum success
- Chainlink CRE success
- ZKML checker success
- TEE attested success
- quorum failure
- proof verification failure
- sanitizer sentinel payloads for no-leak assertions

Every fixture should include sanitized UI-visible metadata and an explicit list
of strings that must be absent from visible UI, exported public metadata, audit
summaries, and proof bundle review output.

## CLZKML-282 Wrapper Gaps

The current TypeScript client already wraps wallet router, wallet upload,
recipient access, proof center, QR proof review, audit, and analytics consent
routes. The next UI implementation task should add typed wrappers for:

- HMIS client lookup, program links, referral draft create/update/validate/submit.
- `POST /services/match-derived`.
- `POST /wallets/{wallet_id}/analytics/contributions`.
- `POST /analytics/{template_id}/count`.
- `POST /analytics/{template_id}/count-by-fields`.
- Consensus request and response metadata on `generateWalletRouterText`.

Those wrappers should consume the shared fixtures without changing fixture
semantics or introducing raw prompt/proof fields.
