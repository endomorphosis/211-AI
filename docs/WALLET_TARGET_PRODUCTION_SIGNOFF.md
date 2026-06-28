# Wallet Target Production Signoff

Status: required checklist for each production-like environment.

Date: 2026-05-05

## Use

Create one completed copy of this checklist for every staging, pilot, and
production environment that handles live wallet data. Store the completed packet
in the organization's approved evidence system.

Do not paste secret values into this document. Record secret-manager paths,
configuration IDs, report artifact IDs, and reviewer names only.

For CI or release gates, copy
`docs/WALLET_TARGET_PRODUCTION_SIGNOFF_PACKET.template.json` into the target
evidence repository, replace every placeholder with target evidence references,
and validate it with:

```bash
python -m wallet_interface.ops \
  --validate-target-signoff-packet /path/to/target-signoff.json \
  --fail-on-error
```

The JSON packet is the machine-readable completion record for retention,
secret-manager references, staging readiness artifacts, analytics privacy
review, organization review, and the launch decision. The Markdown checklist
remains the human-readable reviewer guide. The packet validator requires the
environment record to include the approved `retention_policy_version` that
matches the target retention mapping.

Running `python -m wallet_interface.ops --validate-target-signoff-packet`
without a packet path validates the committed JSON template shape only. A
launch decision still requires validating the completed target packet path.

## Environment Record

| Field | Value |
| --- | --- |
| Environment name |  |
| Deployment owner |  |
| Review date |  |
| Wallet API origin |  |
| Wallet UI origin |  |
| Repository configuration ID |  |
| Encrypted storage configuration ID |  |
| Secret-manager path for ops-health secret |  |
| Secret-manager path for alert credentials |  |
| Secret-manager path for proof verifier credentials |  |
| Proof backend |  |
| Proof verifier service URL or private service name |  |
| Proof verifier ID |  |
| Proof system |  |
| World ID enabled decision |  |
| World ID environment |  |
| World ID app ID |  |
| World ID relying-party ID |  |
| World ID Developer Portal verify endpoint |  |
| Secret-manager path for World ID RP signing key |  |
| Secret-manager path for World ID nullifier commitment key |  |
| World ID endpoint reachability evidence artifact |  |
| World ID proof sanitization evidence artifact |  |
| World ID staging simulator evidence artifact |  |
| World ID full-stack Playwright evidence artifact |  |
| World ID UX review evidence artifact |  |
| World ID privacy/nullifier review evidence artifact |  |
| World ID security signoff evidence artifact |  |
| World ID support playbook evidence artifact |  |
| Release-check evidence artifact |  |
| Readiness report artifact |  |
| Ops-health report artifact |  |
| Proof contract report artifact |  |
| Retention policy version |  |
| S3 lifecycle policy ID |  |
| IPFS pinset policy ID |  |
| Filecoin deal policy ID or not-used decision |  |
| Backup purge policy ID |  |
| Alert retention policy ID |  |
| Incident-response contact path |  |

## Required Evidence

| Gate | Required Evidence | Status |
| --- | --- | --- |
| Production readiness | `python -m wallet_interface.ops --validate-production-readiness` returns `status=ok` in the target environment |  |
| Release-check archive | `python scripts/run_wallet_release_checks.py --playwright-port 5185` passes and its evidence bundle is archived |  |
| Durable wallet repository | `WALLET_REPOSITORY_ROOT` or equivalent managed datastore is configured, backed up, and covered by lifecycle policy |  |
| Encrypted storage replicas | `WALLET_STORAGE_CONFIG` and provider credentials are configured without placeholder values |  |
| Storage repair | `/ops/health?verify_storage=true` plus wallet or record storage repair checks pass with ciphertext/hash evidence only |  |
| External proof verifier | HTTP verifier health/prove/verify/no-leak contract passes with real staging credentials |  |
| World ID production config | When enabled, `WORLD_ID_ENVIRONMENT=production`, `WORLD_ID_APP_ID`, `WORLD_ID_RP_ID`, and `WORLD_ID_VERIFY_BASE_URL=https://developer.world.org` are configured in the target runtime |  |
| World ID secret references | RP signing and nullifier commitment secrets have approved secret-manager references and are not stored in browser-exposed env vars |  |
| World ID RP signing vector | `python -m wallet_interface.ops --validate-production-readiness` reports `world_id_rp_signature_vector=status=ok` using the target signing secret |  |
| World ID endpoint reachability | Target evidence proves the World Developer Portal verify endpoint was reachable from the deployment network before launch |  |
| World ID staging simulator | `docs/WORLD_ID_IDKIT_STAGING_RUNBOOK.md` was executed with successful verification, same-wallet retry, different-wallet conflict, snapshot save/load, QR proof review, and archived redacted evidence |  |
| World ID no-leak evidence | Backend sanitization and full-stack Playwright evidence prove raw nullifiers, IDKit proofs, RP signatures, Developer Portal responses, and PII are not rendered, exported, or logged |  |
| World ID login/recovery guardrails | Any login or recovery assist remains post-MVP, uses a separate action, is not a wallet encryption key or sole recovery factor, and cannot bypass controller, threshold, user-presence, recovery-contact, or support-review policy |  |
| World ID credential expansion | Passport/NFC, selfie, and identity-check policies are disabled unless claim-specific allowed/prohibited claims, UI wording, privacy/legal review, provider eligibility policy, and manual fallback are approved |  |
| Secret management | Ops-health, alert, storage, and verifier credentials live in the selected secret manager and are not committed to the repo |  |
| Alert routing | Warning/error reports reach the approved incident router with authenticated delivery |  |
| Security architecture | `docs/WALLET_SECURITY_ARCHITECTURE_ADR.md` reviewed for the target deployment boundary |  |
| UCAN profile | `docs/WALLET_UCAN_PROFILE.md` reviewed for the target delegation boundary and future interop expectations |  |
| Production decisions | `docs/WALLET_PRODUCTION_DECISIONS_ADR.md` accepted or amended for this deployment |  |
| Retention policy | `docs/WALLET_RETENTION_POLICY.md` mapped to datastore lifecycle, backup purge, IPFS pinning, Filecoin deal, S3 lifecycle, log, and alert retention settings |  |
| Privacy review | Approved analytics templates have cohort thresholds, epsilon budgets, allowed dimensions, nullifier handling, withdrawal behavior, and reviewer identity |  |
| Legal/policy review | User consent language, delegate terms, export behavior, revocation limits, and data-sharing obligations are approved |  |
| Accessibility/usability review | Live UI auth, registration, sharing, recipient access, consent, proof center, export, and emergency revoke flows pass the target accessibility and usability standard |  |
| World ID accessibility/fallback review | World ID proof center, wallet attach, client intake, security, QR review, and export/import flows pass desktop/mobile keyboard, accessible-name, no-overflow, emergency fallback, and no legal-identity-overclaim checks |  |
| Incident response | `docs/WALLET_OPERATIONS_RUNBOOK.md` is linked from the on-call system and the team has tested proof-backend, storage-outage, revoked-grant, lost-key, and privacy-incident paths |  |
| Operator reference | `docs/WALLET_OPERATOR_INTEGRATOR_REFERENCE.md` matches the deployed API, CLI, MCP, env, and release-check surface |  |
| Backup and restore | Wallet repository and encrypted storage restore tests pass without exposing plaintext outside the wallet service boundary |  |
| Deletion and purge | Record deletion, grant revocation, storage unpin/delete, backup purge tracking, and tombstone audit behavior are validated |  |
| Browser/session storage | UI stores no raw wallet plaintext, verifier secrets, or long-lived invocation tokens in browser storage |  |
| Rollback plan | API/UI/ops worker rollback path is documented and tested for the target environment |  |

## Required Commands

Run these commands from the target deployment context or CI job that has access
to the target environment variables and verifier service:

```bash
curl -fsS "${WALLET_API_ORIGIN}/health"
curl -fsS \
  -H "authorization: Bearer ${WALLET_OPS_HEALTH_SHARED_SECRET}" \
  "${WALLET_API_ORIGIN}/ops/health?verify_storage=true"
python -m wallet_interface.ops --validate-proof-contract --fail-on-error
python -m wallet_interface.ops --validate-distance-proof-contract --fail-on-error
python -m wallet_interface.ops --validate-production-readiness
python -m wallet_interface.ops \
  --validate-target-signoff-packet /path/to/target-signoff.json \
  --fail-on-error
```

The readiness report must not include secret values. A report that passes only
with `--skip-proof-contract` is not sufficient for production launch.

## Reviewer Signoff

| Review Area | Reviewer | Decision | Date | Evidence |
| --- | --- | --- | --- | --- |
| Security |  |  |  |  |
| Privacy |  |  |  |  |
| Legal/policy |  |  |  |  |
| Accessibility/usability |  |  |  |  |
| Operations/on-call |  |  |  |  |
| Product owner |  |  |  |  |

Allowed decisions are `approved`, `approved with tracked exception`, or
`deferred`. A production launch requires no `deferred` decisions.

## Launch Decision

| Field | Value |
| --- | --- |
| Launch decision |  |
| Approved launch window |  |
| Required exceptions |  |
| First post-launch readiness run |  |
| First post-launch retention audit |  |

Re-run this checklist after verifier credential rotation, storage-provider
changes, analytics template expansion, auth-provider changes, or any incident
that affects wallet confidentiality, availability, auditability, or deletion.
