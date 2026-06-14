# ProveKit ZKP Wallet UI Workflow Matrix

Task: PROVEKIT-230 Wallet UI Proof Workflow Matrix And Fixtures

Dependency: PROVEKIT-220 End-To-End ProveKit ZKP Signoff

Fixture output: `wallet_interface/ui/tests/fixtures/provekit-proof-fixtures.ts`

## Scope

This matrix maps the wallet UI proof workflows that must stay accurate before
ProveKit-backed proofs are made production-visible. It uses the PROVEKIT-220
backend signoff and the security notes as the source of truth for proof claims:

- Simulated receipts are demo-only and never count as production ZKP evidence.
- Groth16 receipts are distinct from ProveKit WHIR receipts.
- ProveKit WHIR receipts are not EVM-verifiable or on-chain-ready unless a
  recursive Groth16 wrapper receipt is present and independently verified.
- Backend, artifact, verifier-key, cache, and verification failures are
  fail-closed UI states. The UI must not silently relabel them as simulated or
  verified.
- Public UI payloads may include commitments, verifier IDs, artifact refs,
  attestation refs, circuit refs, ruleset IDs, and proof-system metadata. They
  must not include private axioms, raw policy text, witness labels that reveal
  private facts, `Prover.toml` content, or local prover-key/witness paths.

## Proof System Labels

| Backend value | Required UI label | Production claim | On-chain claim |
| --- | --- | --- | --- |
| `simulated` or `SIMZKP/1` | Simulated proof, demo-only | Non-production placeholder only | None |
| `groth16` or `Groth16/BN254` | Groth16 BN254 | Verifier accepted a Groth16 proof for the named circuit and verifier key | Only if the verifier contract/key is explicitly referenced |
| `provekit`, `provekit-whir`, or `ProveKit-WHIR` | ProveKit WHIR | Prover knows a witness satisfying the ProveKit/Noir circuit bound to public commitments | None by default |
| `provekit_recursive_groth16` | ProveKit recursive Groth16 wrapper | Outer Groth16 proof verifies the inner ProveKit WHIR proof under the embedded verifier key | May be shown as on-chain-ready only with wrapper verifier evidence |

## Workflow Matrix

| Wallet surface | UI route or component | Backend routes and payloads | Proof systems to display | Error and transition states | Required labels | Privacy assertions | Desktop and mobile Playwright coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Proof Center proof creation, capability preview, and proof receipt cards | `/#/proof-center`, `ProofReceiptCard`, proof capability preview | `GET /wallets/{wallet_id}/proofs`; `POST /wallets/{wallet_id}/locations/{location_record_id}/region-proofs`; `POST /wallets/{wallet_id}/locations/{location_record_id}/distance-proofs`; `POST /wallets/{wallet_id}/records/{record_id}/document-profile-proofs`; QR inline bundle payloads | Simulated, Groth16 BN254, ProveKit WHIR, future ProveKit recursive Groth16 | Pending, verified, verification failure, backend disabled, backend unavailable, artifact hash mismatch, stale verifier key, cache hit, cache miss, on-chain unsupported/manual fallback | Do not collapse ProveKit WHIR to `unknown` or `simulated`; show simulated as demo-only; show recursive wrapper separately from WHIR | Public inputs may show `theorem_hash`, `axioms_commitment`, `circuit_ref`, `ruleset_id`, verifier digest, artifact refs; never show private axioms, lat/lon, `Prover.toml`, witness scalar values, or local key paths | Existing anchors: `smoke.spec.ts` proof center public inputs, API-backed proofs, QR review. Required ProveKit expansion: import `provekitProofFixtureScenarios` for Desktop Chrome, Mobile Chrome, and Mobile Safari projects. |
| Wallet/uploads proof receipts, saved wallet proof bundles, and QR sharing | `/#/uploads`, wallet QR proof bundle, encrypted record cards | `POST /wallets/{wallet_id}/documents/text`; `POST /wallets/{wallet_id}/documents`; `GET /wallets/{wallet_id}/records`; `GET /wallets/{wallet_id}/proofs`; `GET /wallets/{wallet_id}/records/{record_id}/storage`; `POST /wallets/{wallet_id}/records/{record_id}/storage/repair`; IPFS/Filecoin bundle refs | Simulated for local demos; Groth16 and ProveKit WHIR from wallet API receipts; recursive only when exported in receipt metadata | Proof QR unavailable, storage unavailable, pending proof bundle, cache hit/miss, artifact hash mismatch, stale verifier key, verification failure | QR card must say it opens public proof review, not private document review; WHIR label must stay ProveKit WHIR | QR bundle may include encrypted record CIDs and public proof receipts only. It must not include plaintext document fields or witness content. | Existing anchor: `smoke.spec.ts` uploads QR bundle. Required ProveKit expansion: fixture QR bundle rendered on desktop and mobile with no sentinel witness token in DOM. |
| QR review | `/#/proof-center` with `walletProofBundle` query param, QR screenshot import, IPFS proxy resolver | Inline bundle JSON; `GET /ipfs-proxy/{cid}`; `ipfs://{cid}` locators; linked proof artifacts from bundle | All four labels, with linked artifact refs preserved | Invalid QR, missing CID, IPFS fetch failure, malformed bundle, artifact hash mismatch, stale verifier key, verification failure, disabled backend | Source label must say `From QR bundle` or equivalent; linked WHIR proof must not be relabeled as Groth16 | QR review can display claim, verifier, public inputs, proof system, circuit ID, digest, and artifact ref; it cannot fetch or display witness files | Existing anchor: `smoke.spec.ts` QR screenshot review. Required ProveKit expansion: use `provekitWalletProofQrBundleFixture` across Desktop Chrome, Mobile Chrome, Mobile Safari. |
| Security, audit, and transparency-log views | `/#/security`, `/#/audit`, provider transparency log | `GET /wallets/{wallet_id}/audit`; `GET /wallets/{wallet_id}/approvals`; `POST /wallets/{wallet_id}/approvals/{approval_id}/approve`; wallet storage report/repair routes; proof receipt metadata embedded in audit events | All labels as audit metadata, never inferred from generic status alone | Pending approval, audit refresh failure, verifier-key rotation, stale verifier key, disabled backend, verification failure, cache invalidated | Audit rows must include proof system and verifier ID when present; stale verifier key must be a warning/error state, not success | Audit payloads may record proof IDs, public artifact refs, verifier digest, and status. They must not record witness labels that reveal private facts. | Existing anchors: `smoke.spec.ts` and `agent-action-convergence.spec.ts` audit/API state. Required ProveKit expansion: load stale-key and artifact-mismatch fixtures on desktop and mobile. |
| Provider eligibility, case proofs, and zero-knowledge certificates | `/#/provider-proofs`, `/#/provider-clients`, case proof queue | `GET /wallets/{wallet_id}/proofs`; `POST /wallets/{wallet_id}/records/{record_id}/document-profile-proofs`; `POST /wallets/{wallet_id}/portal/interactions`; `POST /wallets/{wallet_id}/portal/plans/{plan_id}/share-grants`; provider-side certificate queue state | Groth16 and ProveKit WHIR for provider-verifiable claims; simulated is demo-only; recursive wrapper only for on-chain certificate workflows | Needs certificate, processed, pending verifier, verification failure, backend disabled, stale verifier key, manual fallback | Provider cards must distinguish service attendance, document reviewed, benefits referral, eligibility criteria, and exact proof system | Provider views may show public commitments and service metadata only. They must not show raw client documents, private eligibility facts, private policy clauses, or witness text. | Existing anchors: `smoke.spec.ts` provider proof and analytics tests. Required ProveKit expansion: process WHIR and recursive fixtures in desktop and mobile projects. |
| Public analytics and proof dashboards | `/#/analytics`, `/#/provider-analytics`, proof dashboard cards | `GET /analytics/templates`; `GET /wallets/{wallet_id}/analytics/consents`; `POST /wallets/{wallet_id}/analytics/consents/from-template`; `POST /wallets/{wallet_id}/analytics/consents/{consent_id}/revoke`; `GET /wallets/{wallet_id}/proofs` for `analytics_*` receipts | Production counts include Groth16, ProveKit WHIR, and recursive verified receipts; simulated receipts are shown separately or excluded from production totals | Cohort hidden, provider floor hidden, consent revoked, proof pending, verification failure, cache miss, stale verifier key | Dashboard label must say proof coverage source and avoid calling mock/simulated data production ProveKit evidence | Analytics public inputs may show aggregates, county, template ID, cohort floor, and commitments. They must not expose row-level client attributes or witness records. | Existing anchors: provider analytics and public analytics UI. Required ProveKit expansion: fixture analytics receipts verify simulated exclusion and WHIR inclusion on desktop and mobile. |
| Export/import proof bundles, attestations, and wallet files | `/#/exports`, export bundle cards, import descriptors | `POST /wallets/{wallet_id}/exports/grants`; `POST /wallets/{wallet_id}/exports/invocations`; `POST /wallets/{wallet_id}/exports`; `POST /exports/verify`; `POST /exports/import`; `POST /exports/storage`; QR bundle payload built from public receipt fields | All labels preserved through export and import | Bundle hash mismatch, schema invalid, storage failed, import failed, verification failure, stale verifier key, artifact hash mismatch, manual fallback | Export card must retain proof system, verifier, circuit, digest, artifact ref, and verification status | Export/import descriptors may carry encrypted bundles, proof receipts, public inputs, and artifact refs. They must not carry private witness material or local prover-key/witness paths. | Existing anchors: exports flow in smoke tests. Required ProveKit expansion: import/export `provekitWalletProofQrBundleFixture` and failed-state fixtures on desktop and mobile. |

## Error State Matrix

| State | Fixture key | Backend route expectation | UI assertion | Privacy assertion |
| --- | --- | --- | --- | --- |
| Verified simulated receipt | `simulated` | `GET /wallets/{wallet_id}/proofs` may return demo receipt | Shows `Simulated proof, demo-only`; excluded from production ProveKit counts | No private witness fields; demo labels cannot overclaim |
| Verified Groth16 receipt | `groth16` | `GET /wallets/{wallet_id}/proofs` returns Groth16 metadata | Shows Groth16 BN254 and verifier digest | No trusted setup paths or witness material |
| Verified ProveKit WHIR receipt | `provekitWhir` | `GET /wallets/{wallet_id}/proofs` returns `proof_system: ProveKit-WHIR` and `.np` artifact ref | Shows ProveKit WHIR, not Groth16 or on-chain-ready | Public inputs are deterministic commitments and refs only |
| Verified recursive wrapper receipt | `recursive` | `GET /wallets/{wallet_id}/proofs` returns wrapper metadata and recursive circuit ref | Shows recursive Groth16 wrapper separately from WHIR | Inner and outer verifier refs are public; no inner witness data |
| Backend disabled | `disabled` | Proof creation route returns 503/disabled without fallback | Shows backend disabled/unavailable action state | No simulated proof is created as fallback |
| Artifact hash mismatch | `artifactHashMismatch` | Proof list or verification route returns mismatch status/error | Shows artifact integrity failure | Does not reveal local artifact paths or witness file names |
| Stale verifier key | `staleVerifierKey` | Proof list or verification route returns stale verifier-key status | Shows verifier key rotation/stale warning | Shows current/receipt verifier digests only |
| Verification failure | `verificationFailure` | Verification route returns failure status | Shows verification failed; disables success actions | Does not print verifier stderr containing witness values |
| Witness sentinel no-leak | `witnessSentinel` | Any route handling private witness test data | Receipt renders while sentinel stays absent from public payload and DOM | `PROVEKIT_PRIVATE_WITNESS_SENTINEL` must never appear in serialized public receipt |

## Fixture Contract

The TypeScript fixture module exports:

- `provekitProofFixtureScenarios`: scenario records for simulated, Groth16,
  ProveKit WHIR, recursive, disabled, artifact-hash-mismatch,
  stale-verifier-key, verification-failure, and witness-sentinel cases.
- `provekitProofFixtureApiReceipts`: API-shaped receipts suitable for
  `GET /wallets/{wallet_id}/proofs` mocks.
- `provekitProofFixtureUiReceipts`: normalized `ProofReceiptView` records for
  component or QR bundle tests.
- `provekitWalletProofQrBundleFixture`: an inline QR/import bundle containing
  only public proof data and encrypted record CIDs.
- `containsForbiddenWitnessToken()` and `PROVEKIT_PRIVATE_WITNESS_SENTINEL` for
  no-leak assertions.

The fixture deliberately does not include raw private axioms, `Prover.toml`
content, prover-key paths, local temp paths, or witness scalar values in any
receipt, QR bundle, artifact ref, or public input.
