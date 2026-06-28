# HMIS Integration Todo

This backlog is the executable implementation queue for
`docs/HMIS_INTEGRATION_IMPLEMENTATION_PLAN.md`.

The implementation daemon parses tasks with the heading format `## HMIS-...`
and the metadata bullets directly below each heading.

Priority guide:

- `P0`: foundation or blocker work
- `P1`: core workflow work
- `P2`: adjacent capability or hardening work
- `P3`: polish or optional production refinement

Track guide:

- `platform`: contracts, adapter interfaces, config, shared tests
- `governance`: approvals, access matrix, consent, policy artifacts
- `data`: field mapping, code tables, matching, reconciliation
- `api`: backend orchestration, adapter execution, audit, jobs
- `ui`: Abby staff workflows, review queues, timelines
- `privacy`: consent, redaction, threat model, retention, masking
- `ops`: environment setup, release gates, monitoring, incident response

## HMIS-000 HMIS Control Plane
- Status: todo
- Completion: artifact
- Priority: P0
- Track: platform
- Depends on: none
- Outputs: docs/HMIS_INTEGRATION_IMPLEMENTATION_PLAN.md, docs/HMIS_INTEGRATION_TODO.md, scripts/hmis_implementation_daemon.py, scripts/hmis_implementation_supervisor.py, tests/test_hmis_implementation_daemon.py
- Validation: python scripts/hmis_implementation_daemon.py --once --no-implement; python scripts/hmis_implementation_supervisor.py --once --no-implement; python -m pytest tests/test_hmis_implementation_daemon.py -q
- Acceptance: The HMIS backlog can be parsed, durable task state is written, the next HMIS task is selected, and the supervisor can revise sequence without mutating source code.

## HMIS-010 Governance And Access Matrix
- Status: todo
- Completion: artifact
- Priority: P0
- Track: governance
- Depends on: HMIS-000
- Outputs: docs/HMIS_GOVERNANCE_ACCESS_MATRIX.md, docs/HMIS_INTEGRATION_IMPLEMENTATION_PLAN.md
- Validation: test -f docs/HMIS_GOVERNANCE_ACCESS_MATRIX.md
- Acceptance: Named actors, read/write scopes, approval owners, environment boundaries, and launch workflow permissions are documented for the first deployment.

## HMIS-011 Consent And Disclosure Contract
- Status: todo
- Completion: artifact
- Priority: P0
- Track: privacy
- Depends on: HMIS-010
- Outputs: docs/HMIS_CONSENT_DISCLOSURE_CONTRACT.md, wallet_interface/hmis/consent.py, tests/test_hmis_consent.py
- Validation: python -m pytest tests/test_hmis_consent.py -q
- Acceptance: HMIS reads and writes can be evaluated against explicit consent scope, operational authority, expiry, revocation, and audit evidence rules.

## HMIS-020 Canonical HMIS Models And Adapter Interface
- Status: todo
- Completion: artifact
- Priority: P0
- Track: platform
- Depends on: HMIS-010
- Outputs: wallet_interface/hmis/models.py, wallet_interface/hmis/adapters/base.py, wallet_interface/hmis/errors.py, tests/test_hmis_models.py
- Validation: python -m pytest tests/test_hmis_models.py -q
- Acceptance: Canonical client, household, program link, referral, enrollment, consent, sync event, and adapter result contracts are stable and independently testable.

## HMIS-021 Environment Config And Feature Flags
- Status: todo
- Completion: artifact
- Priority: P0
- Track: platform
- Depends on: HMIS-020
- Outputs: wallet_interface/hmis/__init__.py, wallet_interface/config.py, tests/test_hmis_config.py
- Validation: python -m pytest tests/test_hmis_config.py -q
- Acceptance: The app can distinguish disabled, sandbox, UAT, and production HMIS modes and can scope settings per deployment or CoC.

## HMIS-030 Field Mapping Registry
- Status: todo
- Completion: artifact
- Priority: P0
- Track: data
- Depends on: HMIS-020
- Outputs: wallet_interface/hmis/mapper.py, state/hmis/field_mappings.json, tests/test_hmis_mapper.py
- Validation: python -m pytest tests/test_hmis_mapper.py -q
- Acceptance: Local-to-canonical and canonical-to-adapter mappings are versioned, validated, and reject missing required fields or stale code values.

## HMIS-031 Program And Provider Link Registry
- Status: todo
- Completion: artifact
- Priority: P1
- Track: data
- Depends on: HMIS-030
- Outputs: state/hmis/program_links.json, scraper/build_service_portal_package.py, tests/test_hmis_program_links.py
- Validation: python -m pytest tests/test_hmis_program_links.py -q
- Acceptance: 211 provider/service records can be mapped to HMIS project or program identifiers with confidence, status, and review metadata.

## HMIS-032 Client And Household Matching Engine
- Status: todo
- Completion: artifact
- Priority: P0
- Track: data
- Depends on: HMIS-020, HMIS-011
- Outputs: wallet_interface/hmis/matching.py, tests/test_hmis_matching.py
- Validation: python -m pytest tests/test_hmis_matching.py -q
- Acceptance: Matching returns scored candidates, preserves rejected candidates, and never auto-verifies ambiguous matches.

## HMIS-040 Audit Event Schema And Storage
- Status: todo
- Completion: artifact
- Priority: P0
- Track: api
- Depends on: HMIS-020, HMIS-011
- Outputs: wallet_interface/hmis/audit.py, wallet_interface/app_service.py, tests/test_hmis_audit.py
- Validation: python -m pytest tests/test_hmis_audit.py -q
- Acceptance: Every lookup, draft, submit, sync, reject, retry, and reconciliation action emits durable audit events with local and external references.

## HMIS-041 HMIS Service Orchestrator
- Status: todo
- Completion: artifact
- Priority: P0
- Track: api
- Depends on: HMIS-021, HMIS-030, HMIS-032, HMIS-040
- Outputs: wallet_interface/hmis/service.py, tests/test_hmis_service.py
- Validation: python -m pytest tests/test_hmis_service.py -q
- Acceptance: The service layer enforces policy gates, runs adapter calls, returns normalized results, and records retry and reconciliation state.

## HMIS-042 Manual Review Adapter
- Status: todo
- Completion: artifact
- Priority: P0
- Track: api
- Depends on: HMIS-041
- Outputs: wallet_interface/hmis/adapters/manual_review.py, tests/test_hmis_manual_review_adapter.py
- Validation: python -m pytest tests/test_hmis_manual_review_adapter.py -q
- Acceptance: Staff can create structured HMIS drafts and review packets without requiring a live vendor connection.

## HMIS-043 Vendor API Adapter Skeleton
- Status: todo
- Completion: artifact
- Priority: P1
- Track: api
- Depends on: HMIS-041
- Outputs: wallet_interface/hmis/adapters/vendor_api.py, tests/test_hmis_vendor_api_adapter.py
- Validation: python -m pytest tests/test_hmis_vendor_api_adapter.py -q
- Acceptance: The adapter translates canonical payloads to vendor transport contracts, handles auth, normalizes errors, and can run entirely against fixtures.

## HMIS-044 File Exchange Adapter Skeleton
- Status: todo
- Completion: artifact
- Priority: P1
- Track: api
- Depends on: HMIS-041
- Outputs: wallet_interface/hmis/adapters/file_exchange.py, tests/test_hmis_file_exchange_adapter.py
- Validation: python -m pytest tests/test_hmis_file_exchange_adapter.py -q
- Acceptance: The adapter produces deterministic outbound batches, records staging metadata, and supports import reconciliation from fixture files.

## HMIS-050 Read-Only Lookup API
- Status: todo
- Completion: artifact
- Priority: P1
- Track: api
- Depends on: HMIS-041, HMIS-042
- Outputs: wallet_interface/api.py, tests/test_wallet_interface_hmis_api.py
- Validation: python -m pytest tests/test_wallet_interface_hmis_api.py -q
- Acceptance: Authorized staff can search for clients, households, and linked programs through a stable API that masks or limits fields by policy.

## HMIS-051 Referral Draft And Validation API
- Status: todo
- Completion: artifact
- Priority: P1
- Track: api
- Depends on: HMIS-050, HMIS-030, HMIS-031
- Outputs: wallet_interface/api.py, tests/test_wallet_interface_hmis_api.py
- Validation: python -m pytest tests/test_wallet_interface_hmis_api.py -q
- Acceptance: The API can create, validate, and persist referral drafts with mapping, consent, and required-field checks.

## HMIS-052 Submission, Retry, And Reconciliation Jobs
- Status: todo
- Completion: artifact
- Priority: P1
- Track: api
- Depends on: HMIS-051, HMIS-043, HMIS-044
- Outputs: wallet_interface/hmis/service.py, scripts/hmis_reconciliation_job.py, tests/test_hmis_reconciliation.py
- Validation: python -m pytest tests/test_hmis_reconciliation.py -q; python scripts/hmis_reconciliation_job.py --once --dry-run
- Acceptance: The system prevents duplicate submissions, retries transient failures, and produces a reviewable reconciliation queue.

## HMIS-060 Abby Lookup Panel
- Status: todo
- Completion: artifact
- Priority: P1
- Track: ui
- Depends on: HMIS-050
- Outputs: wallet_interface/ui/src/components/hmis/HmisLookupPanel.tsx, wallet_interface/ui/src/services/walletApi.ts
- Validation: npm --prefix wallet_interface/ui run build
- Acceptance: Staff can run HMIS lookup from relevant Abby screens and see masked candidate results, link status, and last-sync metadata.

## HMIS-061 Match Review And Link Workflow
- Status: todo
- Completion: artifact
- Priority: P1
- Track: ui
- Depends on: HMIS-060, HMIS-032
- Outputs: wallet_interface/ui/src/components/hmis/HmisMatchReviewDrawer.tsx, wallet_interface/ui/src/services/walletApi.ts
- Validation: npm --prefix wallet_interface/ui run build
- Acceptance: Staff can review candidate confidence drivers, verify a link, reject a candidate, and preserve rejection history.

## HMIS-062 Referral Draft UI
- Status: todo
- Completion: artifact
- Priority: P1
- Track: ui
- Depends on: HMIS-051, HMIS-031
- Outputs: wallet_interface/ui/src/components/hmis/HmisReferralDraftPanel.tsx, wallet_interface/ui/src/app/App.tsx
- Validation: npm --prefix wallet_interface/ui run build
- Acceptance: Staff can prepare a referral draft from an Abby service plan, resolve validation errors, and submit or stage it for review.

## HMIS-063 Sync Timeline And Reconciliation Queue
- Status: todo
- Completion: artifact
- Priority: P1
- Track: ui
- Depends on: HMIS-052, HMIS-040
- Outputs: wallet_interface/ui/src/components/hmis/HmisSyncTimeline.tsx, wallet_interface/ui/src/components/hmis/HmisReconciliationQueue.tsx
- Validation: npm --prefix wallet_interface/ui run build
- Acceptance: Abby shows submission history, sync outcome, retry state, and unresolved reconciliation items without exposing raw transport payloads.

## HMIS-070 Prompt And Disclosure Guards
- Status: todo
- Completion: artifact
- Priority: P1
- Track: privacy
- Depends on: HMIS-011, HMIS-040
- Outputs: wallet_interface/ui/src/agent/promptGuards.ts, tests/test_hmis_prompt_guards.py
- Validation: python -m pytest tests/test_hmis_prompt_guards.py -q
- Acceptance: HMIS-linked data is only exposed to chat and summaries when the actor, scope, and purpose are authorized and auditable.

## HMIS-071 Threat Model And Retention Review
- Status: todo
- Completion: artifact
- Priority: P1
- Track: privacy
- Depends on: HMIS-011
- Outputs: docs/HMIS_INTEGRATION_THREAT_MODEL.md, docs/HMIS_RETENTION_AND_LOGGING_REVIEW.md
- Validation: test -f docs/HMIS_INTEGRATION_THREAT_MODEL.md && test -f docs/HMIS_RETENTION_AND_LOGGING_REVIEW.md
- Acceptance: HMIS trust boundaries, incident classes, retention rules, and logging constraints are documented and tied to release gates.

## HMIS-080 Sandbox Fixtures And End-To-End Test Harness
- Status: todo
- Completion: artifact
- Priority: P1
- Track: ops
- Depends on: HMIS-043, HMIS-044, HMIS-050, HMIS-051
- Outputs: tests/fixtures/hmis/, tests/test_hmis_end_to_end.py
- Validation: python -m pytest tests/test_hmis_end_to_end.py -q
- Acceptance: Synthetic HMIS fixtures cover lookup, match review, referral draft, submit, rejection, retry, and reconciliation flows.

## HMIS-081 Runbook And Launch Checklist
- Status: todo
- Completion: artifact
- Priority: P1
- Track: ops
- Depends on: HMIS-052, HMIS-071, HMIS-080
- Outputs: docs/HMIS_INTEGRATION_RUNBOOK.md, data/hmis/release_checklist.json
- Validation: test -f docs/HMIS_INTEGRATION_RUNBOOK.md && test -f data/hmis/release_checklist.json
- Acceptance: Operators have environment setup, credential rotation, outage handling, reconciliation, monitoring, and launch gates documented.

## HMIS-090 Production Readiness Gate
- Status: todo
- Completion: artifact
- Priority: P1
- Track: ops
- Depends on: HMIS-081, HMIS-063, HMIS-080
- Outputs: docs/HMIS_INTEGRATION_THREAT_MODEL.md, docs/HMIS_INTEGRATION_RUNBOOK.md, data/hmis/release_checklist.json
- Validation: python -m pytest tests/test_hmis_end_to_end.py -q; npm --prefix wallet_interface/ui run build
- Acceptance: Governance approval, consent controls, audit completeness, reconciliation, UI review, and incident response evidence are complete for the first deployment.