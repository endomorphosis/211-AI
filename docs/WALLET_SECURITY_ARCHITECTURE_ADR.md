# Wallet Security Architecture ADR

Status: accepted for integrated implementation; target-environment signoff
required before production launch.

Date: 2026-05-05

## Context

The 211-AI data wallet stores documents, location records, profile attributes,
derived facts, proof receipts, analytics consents, grants, invocations, export
bundles, and audit events. The same wallet must support user-controlled sharing
with advocates and service providers while preventing raw data exposure during
service matching, analytics, proofs, and delegated document analysis.

The wallet core is implemented in `ipfs_datasets_py.wallet`. The 211-AI
`wallet_interface/` layer provides API, UI, deployment, and operations
workflows around that core.

## Decision

1. Keep cryptography, authorization, proof receipts, storage verification,
   privacy controls, and audit semantics in `ipfs_datasets_py.wallet`.
   211-AI code may orchestrate product workflows but must not implement a
   parallel wallet security model.
2. Encrypt every wallet record version with envelope encryption. Store payload
   and private metadata only through encrypted blob storage adapters. Treat
   IPFS CIDs, S3 paths, Filecoin references, filenames, and unguessable URLs as
   locators, not confidentiality controls.
3. Use `wallet-ucan-v1` invocation tokens for first production. Tokens carry
   issuer/audience, grant ID, wallet resource, ability, caveats, expiration,
   nonce, and signature. External `ucanto`/w3up interop remains a compatibility
   hardening track behind the wallet authorization boundary. See
   `docs/WALLET_UCAN_PROFILE.md` for the token profile and
   `docs/WALLET_PRODUCTION_DECISIONS_ADR.md` for the production decision
   record.
4. Fail closed for production proofs. Development may use simulated receipts
   only when simulated proofs are explicitly allowed. Production mode requires a
   non-simulated backend. The first supported production-style boundary is the
   HTTP `location_region` verifier contract, with `location_distance` defined
   as the next verifier family in
   `docs/WALLET_PROOF_VERIFIER_CONTRACT.md`.
5. Treat derived analysis as sensitive. Redacted text, form analysis,
   redacted summaries, GraphRAG outputs, vector profiles, and exports must
   enforce concrete output-type caveats and store derived payloads encrypted.
   First-production GraphRAG uses the wallet-local
   `wallet-local-redacted-graphrag-v1` backend with model-backed extraction
   disabled; model-backed or remote GraphRAG requires separate target review.
6. Analytics must use approved templates, consent records, contribution
   nullifiers, cohort thresholds, DP metadata, query-budget ledgers, and audit
   events. New templates must pass privacy review before status `approved`.
7. Production deployments must use durable wallet repositories, encrypted blob
   storage, ops-health auth, alert routing, and the production readiness gate:
   `python -m wallet_interface.ops --validate-production-readiness`. Target
   launch also requires a validated JSON signoff packet from
   `docs/WALLET_TARGET_PRODUCTION_SIGNOFF_PACKET.template.json`.
8. World ID proof-of-human is an optional wallet proof receipt and anti-duplication
   signal. It must not be used as a wallet encryption key, sole recovery factor,
   controller-add bypass, threshold-governance replacement, or substitute for
   user presence. Login or recovery assistance must use a separate action,
   remain wallet-private, and require existing controller, device, recovery
   contact, threshold, or approved support-review proof before authority changes.

## Threat Model

| Threat | Mitigation |
| --- | --- |
| Storage provider sees wallet payloads or metadata | Payloads and private metadata are AEAD-encrypted before local/IPFS/S3/Filecoin storage. Storage health checks verify encrypted availability without decrypting. |
| Delegate receives broader authority than intended | Grants and invocations enforce ability, resource, record ID, data type, purpose, output type, expiration, not-before, user-presence, and delegation attenuation caveats. |
| `record/analyze` is treated like plaintext decrypt | Analyze, decrypt, export, location, proof, and analytics capabilities are tested separately. Derived analysis endpoints enforce concrete output policies. |
| Revoked grants continue to unwrap data keys | Revocation blocks future invocations. Emergency revoke can revoke non-owner grants and rotate active record keys. Ops health checks for active wraps tied to revoked grants. |
| Simulated proofs are accepted in production | Production proof mode disables simulated receipts and requires a non-simulated verifier backend. The readiness gate runs a health/prove/verify/no-leak contract check. |
| Proof receipts leak witness data | Public inputs are constrained to claim, region or target IDs, thresholds, policy hashes, verifier metadata, and receipt identifiers. Tests plus `--validate-proof-contract` and `--validate-distance-proof-contract` scan for witness keys and synthetic wallet/target witness values. |
| Aggregate analytics identifies rare users | Templates enforce allowed fields, minimum cohort sizes, sparse-cell suppression, DP count metadata, query-budget spend, nullifier duplicate prevention, consent status, and audit records. |
| Operators lose state across restarts | `LocalWalletRepository` persists wallet snapshots and the analytics ledger. Production env requires repository and encrypted storage configuration. |
| Ops endpoints leak operational state | `/ops/health` supports shared-secret auth, and edge/deployment references forward only health routes through controlled paths. |
| User misunderstands revocation | UI and runbook language distinguish future access denial from plaintext that may already have been downloaded. |
| World ID becomes an account-takeover bypass | World ID is not an authority key. Recovery or login assistance must use a separate action and must still satisfy controller/device/recovery-contact thresholds, user presence, and audit requirements. |
| Expanded World ID credentials overclaim identity or eligibility | Passport/NFC, selfie, and identity-check credentials require claim-specific privacy/legal/security review, UI wording approval, provider eligibility policy, and manual fallback before launch. |

## Privacy Review Process

Before an analytics template can be approved:

1. Confirm the purpose and allowed derived fields are necessary for the study or
   operational question.
2. Confirm the template does not request raw payloads, precise location,
   plaintext document fields, or direct identifiers.
3. Set minimum cohort size, DP epsilon, query-budget key, expiration, and
   allowed dimensions.
4. Run sparse-cell and duplicate-nullifier regression tests for the template
   shape when adding new dimensions.
5. Record reviewer, approval time, and status transition in the analytics
   ledger and audit log.

Paused or retired templates must block new consent, contribution, and aggregate
query creation while preserving already released aggregate audit history.

## Production Signoff Gate

Before target production launch or verifier credential rotation:

```bash
pytest tests/test_wallet_interface_api.py tests/test_wallet_interface_ops.py tests/test_wallet_interface_proof_backends.py -q
python -m wallet_interface.ops --validate-production-readiness
python -m wallet_interface.ops \
  --validate-target-signoff-packet /path/to/target-signoff.json
```

The readiness report must be `status=ok`. It fails when durable
repository/storage env vars, proof mode, verifier credentials, ops-health auth,
alert routing, secret-manager references, ops health, or the external region
and distance verifier contracts are missing, unhealthy, simulated, or still set
to placeholders. For World ID-enabled targets, readiness and signoff must also
cover app/RP ids, secret-manager references, RP signing vector evidence,
Developer Portal reachability, proof sanitization, staging simulator evidence,
login/recovery non-key guardrails, and credential-policy expansion limits. The
signoff packet must validate security, privacy, legal/policy,
accessibility/usability, operations/on-call, product-owner, analytics privacy,
retention, and launch-decision evidence.

## Consequences

- Product code remains thinner and depends on the wallet package for security
  invariants.
- Production launch is blocked until target secrets and verifier services are
  provisioned and validated in the target environment.
- External UCAN interoperability can be added without changing product flows if
  it preserves the wallet authorization vocabulary and caveat semantics.
