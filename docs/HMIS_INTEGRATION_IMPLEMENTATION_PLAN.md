# HMIS Integration Implementation Plan

Last updated: 2026-05-18

## Goal

Integrate 211-AI services with HMIS in a way that improves referral coordination,
service navigation, and case-work support without weakening privacy,
consent, auditability, or local Continuum of Care governance.

The HMIS integration should let approved users and systems:

- see whether a client, household, referral, enrollment, or service event
  already exists in HMIS when that is operationally necessary;
- create or update approved HMIS records from 211-AI workflows when consent,
  program policy, and local governance allow it;
- track outbound and inbound referral status between 211-AI and HMIS;
- reduce duplicate data entry for staff while keeping user-controlled wallet and
  disclosure boundaries intact;
- produce an auditable record of what was read, written, matched, shared, or
  rejected.

This plan assumes HMIS standards are defined by HUD, but that the concrete
integration mechanics vary by local CoC, HMIS lead, and vendor. The design must
therefore separate HUD-standard concepts from vendor-specific transport,
authentication, and deployment choices.

## Current Repo Fit

This repository already has the right layers to host an HMIS integration if the
boundaries stay clear.

- `wallet_interface/` already owns the API, policy, storage, grants, audit, and
  user workflow surfaces.
- `wallet_interface/ui/` already contains Abby service-navigation, recipient
  access, exports, audit, uploads, and proof-center flows that can expose HMIS
  tasks without creating a parallel app.
- `docs/211_SERVICE_NAVIGATION_PORTAL_PLAN.md` already defines service-search,
  action, and interaction-tracking workflows that HMIS referrals and outcomes
  can extend.
- `docs/AI_AGENT_CHAT_IMPLEMENTATION_PLAN.md` already establishes the shared
  command pattern that can later expose HMIS actions through the same typed
  facade used by the GUI.
- `scraper/` and the portal package flows already normalize service/provider
  data, which can help with provider matching and referral destination mapping.

The HMIS integration should be implemented as an extension of existing wallet,
audit, and service-navigation contracts, not as a separate sidecar app that
duplicates identity, consent, or history.

## External Program Assumptions

These are working assumptions and must be confirmed with the local CoC, HMIS
lead, legal/privacy review, and current HUD guidance before production work.

- HUD defines HMIS data standards, privacy expectations, and security
  requirements at the program level.
- Real-world HMIS interoperability is often constrained by local governance,
  vendor capabilities, hosted environment rules, and role-based access policy.
- Some HMIS deployments may expose APIs; others may rely on scheduled file
  exchange, managed reports, vendor middleware, direct database exports, or
  manual workflows.
- Coordinated entry, assessment, shelter, outreach, diversion, prevention, and
  housing workflows may each have different permission and data-quality rules.
- 211-AI must not assume blanket permission to write into HMIS merely because a
  user interacts with Abby or stores data in the wallet.
- Sensitive data categories may be further restricted by program type,
  domestic-violence boundaries, local policy, or data-sharing agreements.

Because public HUD source pages were not fetchable from this workspace due to
network domain policy, every standards-specific field list, workflow, and
compliance control below should be treated as implementation guidance that must
be validated against the current local HMIS program documents before build-out.

## Success Criteria

The integration is successful when:

- authorized staff can complete common referral and status-update tasks with
  less duplicate entry than current workflows;
- client consent and disclosure scope are enforced before any HMIS read or
  write;
- every cross-system action is auditable by actor, reason, data scope, result,
  and external record reference;
- HMIS data quality does not regress because of stale mappings, ambiguous
  matching, or silent write failures;
- Abby can explain what is known locally, what was fetched from HMIS, what was
  sent to HMIS, and what still requires staff review;
- vendor-specific transports can be swapped without rewriting the product-level
  workflow model.

## Non-Goals For V1

The first production version should not attempt to do everything.

- Do not mirror the full HMIS database into 211-AI.
- Do not bypass local HMIS governance, lead approval, or vendor terms.
- Do not treat the wallet as the system of record for regulated HMIS fields.
- Do not auto-enroll people into programs without explicit staff review.
- Do not auto-resolve identity matches where confidence is low or conflicting.
- Do not expose highly sensitive HMIS data to general chat prompts or broad UI
  surfaces.
- Do not assume one integration adapter will work for every CoC.

## Recommended Product Scope

Implement the integration in four bands, in this order.

### Band 1: HMIS Visibility

Read-only lookup for approved staff workflows:

- search for existing client/household/program/referral records;
- display canonical external identifiers and status;
- show last-sync timestamps and provenance;
- avoid write-back until consent, matching, and audit are proven.

### Band 2: Referral Coordination

Referral-centric interoperability:

- create outbound referral requests from 211-AI service plans;
- ingest referral status updates from HMIS;
- map local service-plan state to HMIS referral lifecycle state;
- support staff review queues for rejected or ambiguous records.

### Band 3: Enrollment And Outcome Support

Selective write-back for approved programs:

- draft client/program/enrollment payloads from verified local data;
- require review before submit for sensitive or high-impact operations;
- sync material state transitions and outcome events back into Abby.

### Band 4: Analytics And Case Coordination

Only after bands 1-3 are stable:

- warehouse-safe derived analytics with de-identification controls;
- cross-system case-task views for authorized workers;
- agent-assisted summaries that cite source provenance and policy gates.

## Stakeholders And Governance

The project needs explicit named owners before implementation begins.

- Product owner: defines staff workflows, launch sequence, and success metrics.
- HMIS lead / CoC governance body: approves allowed use cases, data access,
  environments, and deployment pattern.
- Legal/privacy owner: approves consent text, disclosure boundaries, retention,
  and incident handling.
- Security owner: approves secrets, audit, network boundaries, and operational
  controls.
- Data stewardship owner: approves field mappings, validation rules, and error
  remediation.
- Vendor/integration owner: approves API or file-exchange transport and test
  strategy.

Required pre-build artifacts:

- data-sharing agreement or equivalent approval memo;
- role matrix for who can read versus write each HMIS object type;
- environment and credential provisioning process;
- field-level mapping signoff;
- incident and rollback procedure;
- production cutover checklist.

## Target Use Cases

Prioritize concrete workflows rather than generic interoperability.

1. Staff searches for a client in Abby and checks whether the person or
   household already exists in HMIS.
2. Staff creates a service plan in Abby and sends an outbound referral to an
   HMIS-connected provider or program.
3. Abby receives referral status updates and reflects accepted, pending,
   waitlisted, closed, or unable-to-contact states.
4. Staff reviews a proposed client/program payload, fixes validation issues,
   and submits it to HMIS.
5. Abby shows a cross-system timeline that distinguishes local notes, HMIS
   source facts, and outbound write attempts.
6. Authorized supervisors export integration audit logs and reconciliation
   reports.

## High-Level Architecture

### Principle

The integration should use a canonical internal contract plus pluggable HMIS
adapters.

Bad shape:

- Abby screens call vendor-specific endpoints directly.
- Field mapping lives in UI components.
- Consent and audit are handled inconsistently.
- Changing HMIS vendors requires rewriting product workflows.

Target shape:

- Abby calls typed app actions such as `lookupHmisClient`,
  `createHmisReferralDraft`, `submitHmisReferral`, or
  `syncHmisReferralStatus`.
- Backend policy gates check actor role, consent scope, and record state.
- A canonical HMIS connector service maps local models to standard integration
  models.
- Vendor adapters translate the canonical model into API, file, or middleware
  transport specifics.
- Audit records capture both the user-facing action and the external transport
  result.

### Proposed Components

Add a new backend package under `wallet_interface/`:

```text
wallet_interface/hmis/
  __init__.py
  models.py
  policies.py
  consent.py
  matching.py
  mapper.py
  service.py
  audit.py
  errors.py
  adapters/
    __init__.py
    base.py
    vendor_api.py
    file_exchange.py
    manual_review.py
```

Responsibilities:

- `models.py`: canonical HMIS-facing objects and sync result types.
- `policies.py`: role, consent, program-scope, and operation gate checks.
- `consent.py`: disclosure scope evaluation, consent expiry, revocation, and
  evidence binding.
- `matching.py`: client/household/provider matching, confidence scoring, and
  duplicate prevention.
- `mapper.py`: local-to-canonical and canonical-to-adapter field transforms.
- `service.py`: application orchestration, transaction boundaries, retry, and
  reconciliation jobs.
- `audit.py`: append-only integration event logging tied to wallet audit.
- `adapters/base.py`: stable adapter contract.
- `adapters/vendor_api.py`: direct API adapter when vendor access is available.
- `adapters/file_exchange.py`: batch import/export adapter for SFTP/CSV/XML or
  similar exchange patterns.
- `adapters/manual_review.py`: controlled fallback when no write integration is
  approved yet.

UI additions should live inside existing Abby surfaces rather than a separate
application:

- `social-services`: HMIS referral state and destination matching.
- `recipient-access`: explicit authorization and disclosure explanation.
- `audit`: integration timeline and sync outcome view.
- `exports`: reconciliation reports and controlled outbound extracts.
- future `services/:docId/plan`: referral creation and status tracking.

## Integration Modes

Support three interchangeable execution modes.

### Mode A: Direct Vendor API

Use when the HMIS vendor and local governance provide supported API access.

- lowest operational latency;
- stronger synchronous validation feedback;
- simplest user experience for lookup and write-back;
- requires careful rate-limit, credential, and schema-version handling.

### Mode B: Managed File Exchange

Use when the vendor supports scheduled import/export rather than transactional
API access.

- practical for many real deployments;
- adds reconciliation delay and more operational overhead;
- requires durable export staging, import pickup confirmation, and idempotency.

### Mode C: Staff Review / Manual Bridge

Use as a safe first launch path when governance or vendor readiness is limited.

- Abby prepares structured referral or enrollment drafts;
- authorized staff review and submit through existing HMIS workflows;
- the system still captures consent, provenance, and audit;
- later transition to automated transport without redoing the product contract.

## Canonical Domain Model

Use canonical 211-AI integration models instead of binding directly to one
vendor schema.

### Core Entities

- `HmisClientLink`
  - local wallet/user/contact reference
  - external HMIS client identifier
  - match confidence
  - matched-by fields
  - status: proposed, verified, rejected, merged

- `HmisHouseholdLink`
  - local household/group identifier
  - external household identifier
  - relationship metadata

- `HmisProgramLink`
  - local service/provider/program reference
  - external project/program/site identifier
  - mapping confidence
  - active date window

- `HmisReferralRecord`
  - local service-plan identifier
  - external referral identifier
  - source and destination program identifiers
  - lifecycle state
  - reason/status codes
  - created/updated timestamps

- `HmisEnrollmentRecord`
  - local workflow reference
  - external enrollment identifier
  - program/project reference
  - active/inactive status
  - key dates

- `HmisConsentRecord`
  - subject reference
  - consent type and scope
  - actor capturing consent
  - effective/expiry timestamps
  - evidence reference
  - revocation status

- `HmisSyncEvent`
  - action type
  - actor/service principal
  - request payload hash
  - response/result summary
  - adapter name
  - external references
  - retry/reconciliation status

### Mapping Strategy

Separate mappings into three layers.

- local product model: Abby service plans, interactions, wallet contacts,
  uploaded documents, recipient permissions;
- canonical integration model: stable cross-vendor HMIS concepts;
- adapter model: vendor-specific payloads, files, codes, or endpoint shapes.

This lets the team update local product workflows without breaking transport
contracts and swap adapters without rewriting UI logic.

## Identity Resolution And Matching

Identity matching is the highest-risk functional area. Build it as a reviewed,
scored workflow, not a hidden helper.

### Matching Inputs

Potential match inputs may include:

- full legal name and aliases;
- date of birth;
- phone and email;
- household composition;
- partial identifiers if policy allows;
- program, provider, location, and time context;
- prior external IDs already verified by staff.

### Matching Rules

- require exact external ID match when already known;
- use configurable weighted scoring for demographic matches;
- distinguish likely duplicate, possible match, and no safe match;
- never auto-merge conflicting candidates;
- show staff which fields drove the score;
- preserve rejected candidates to prevent repeated false suggestions.

### Verification Gates

- low-risk read-only lookup may show candidate records with masking;
- write-back must require either a verified external ID or staff confirmation of
  a high-confidence match;
- any low-confidence or multi-candidate result must enter a review queue.

## Consent, Privacy, And Disclosure

HMIS integration must extend the wallet's disclosure model, not bypass it.

### Consent Principles

- consent must be specific to purpose, recipient/system scope, and time window;
- revocation must stop future writes and optional future reads where policy
  requires;
- the system must distinguish client consent from staff authorization;
- every outbound write should cite the consent basis or operational authority
  used;
- policy should support emergency or mandated exceptions only if explicitly
  approved and logged.

### Data Minimization

- only send the fields required for the approved HMIS workflow;
- default to referral and status data before broader case-detail sync;
- keep sensitive free-text notes out of outbound payloads unless explicitly
  approved;
- treat uploaded documents as out of scope for automatic HMIS sync in V1.

### Audit Requirements

For each read or write, record:

- actor identity and role;
- legal or operational basis;
- consent reference if applicable;
- local record IDs and external record IDs;
- fields requested or transmitted;
- adapter, environment, and endpoint/file batch reference;
- result status and any validation errors.

## Security Architecture

### Authentication

- service-to-service credentials must be isolated per environment and per CoC
  where feasible;
- do not expose vendor credentials to the browser;
- use backend-held secrets with least privilege;
- support credential rotation without redeploying UI assets.

### Authorization

- role gates must be enforced server-side;
- read permissions and write permissions must be distinct;
- program-scoped permissions must restrict visible and writable records;
- chat tools must inherit the same action contracts and policy gates as the GUI.

### Data Handling

- encrypt secrets and cached payloads at rest;
- define strict retention for raw transport payloads;
- store durable audit records separately from transient request logs;
- mask sensitive fields in UI, logs, error messages, and analytics;
- ensure sandbox/test fixtures never contain production HMIS data.

### Network Boundaries

- route outbound integration traffic through controlled backend services;
- if file exchange is used, stage files in a dedicated encrypted bucket or
  directory with lifecycle policy;
- block any direct browser-to-vendor network path.

## Operational Model

### Environment Strategy

Maintain separate:

- local development fixtures;
- integration sandbox or vendor test environment;
- pre-production/UAT environment;
- production environment.

Each environment needs distinct:

- credentials;
- endpoint or file-drop configuration;
- code tables and mapping bundles;
- synthetic or approved test data;
- audit partitioning.

### Reconciliation Jobs

Add scheduled jobs for:

- inbound status polling or file pickup;
- retry of transient failures;
- detection of partial writes and duplicate submissions;
- reconciliation reports for records changed in one system but not the other;
- stale mapping detection for providers/programs no longer active.

### Failure Handling

Classify failures as:

- validation failure;
- authorization/policy failure;
- transport failure;
- vendor-side rejection;
- ambiguous match requiring review;
- reconciliation drift.

Each class should have:

- user-facing status text;
- audit code;
- retry rules;
- escalation owner.

## Abby Product Surface Changes

### UI Capabilities

Add these staff-facing capabilities incrementally.

- HMIS lookup panel on relevant client/service-plan views.
- referral draft composer with destination-program selection.
- consent capture/review widget tied to wallet disclosure records.
- match-review drawer showing candidate records and confidence drivers.
- sync status pill and timeline event stream.
- reconciliation queue for failed or ambiguous submissions.

### Chat/Agent Capabilities

After typed backend actions exist, expose limited agent operations:

- explain whether an HMIS link already exists;
- summarize referral status changes with citations to audit records;
- prepare but not auto-submit sensitive drafts without confirmation;
- ask for missing fields needed for a referral or lookup;
- never reveal broader HMIS data than the actor is entitled to see.

## Proposed Backend Contracts

Expose backend actions first; UI and chat should both call them.

- `lookup_hmis_client(criteria)`
- `lookup_hmis_household(criteria)`
- `list_hmis_program_links(filters)`
- `create_hmis_referral_draft(input)`
- `validate_hmis_referral_draft(draft_id)`
- `submit_hmis_referral(draft_id)`
- `sync_hmis_referral_status(referral_id)`
- `create_hmis_enrollment_draft(input)`
- `submit_hmis_enrollment(draft_id)`
- `link_hmis_external_record(input)`
- `reject_hmis_match(candidate_id, reason)`
- `list_hmis_reconciliation_items(filters)`
- `resolve_hmis_reconciliation_item(item_id, resolution)`

Each action should return:

- normalized success/failure status;
- human-readable summary;
- audit event reference;
- external references if created or found;
- retryability metadata;
- policy warnings or required next steps.

## Data Quality Strategy

Treat data quality as a first-class workstream.

- maintain versioned mapping tables for providers, programs, sites, and code
  values;
- enforce required-field validation before outbound submission;
- detect stale source data when local provider/service metadata no longer maps
  to an active HMIS destination;
- create dashboards or reports for match ambiguity, rejection rate, retry rate,
  and reconciliation backlog;
- require periodic sample review of successful syncs.

## Implementation Phases

### Phase 0: Discovery And Governance

Deliverables:

- local CoC/HMIS governance interviews;
- vendor capability inventory;
- approved initial workflows;
- draft data-sharing and access matrix;
- field mapping worksheet;
- initial threat and privacy review addendum.

Exit criteria:

- one approved launch use case;
- one approved transport mode;
- named owners for product, security, privacy, and operations.

### Phase 1: Canonical Contracts And Audit Foundation

Deliverables:

- backend `wallet_interface/hmis/` package skeleton;
- canonical models and adapter interface;
- audit event schema;
- consent policy hooks;
- feature flags and environment config.

Exit criteria:

- all planned actions compile against a stable internal contract;
- audit events are emitted for mocked lookups and submissions.

### Phase 2: Read-Only Lookup And Matching

Deliverables:

- client and household lookup;
- match scoring and review queue;
- program/provider mapping registry;
- read-only Abby UI panels.

Exit criteria:

- staff can perform lookup without vendor-specific UI knowledge;
- ambiguous matches are never silently accepted.

### Phase 3: Referral Drafting And Validation

Deliverables:

- local referral draft model;
- destination mapping and required-field validation;
- consent capture linkage;
- review-before-submit UI.

Exit criteria:

- staff can prepare a compliant referral draft;
- validation failures are understandable and actionable.

### Phase 4: Outbound Submission And Status Sync

Deliverables:

- adapter-backed referral submission;
- idempotency keys and retry rules;
- inbound status sync/reconciliation job;
- audit-backed event timeline.

Exit criteria:

- duplicate submissions are prevented;
- status updates round-trip back into Abby reliably.

### Phase 5: Enrollment And Program Updates

Deliverables:

- approved enrollment draft flows;
- selective write-back for additional object types;
- tighter role-based policy controls;
- operational dashboards.

Exit criteria:

- expanded scope does not widen unauthorized visibility;
- support team can reconcile failures without engineering intervention.

### Phase 6: Agent And Analytics Extensions

Deliverables:

- agent access to approved typed HMIS actions;
- de-identified analytics extracts where approved;
- supervisor reporting and quality metrics.

Exit criteria:

- agent behavior is bounded by the same policy gates as staff UI;
- analytics outputs are privacy-reviewed and provenance-tagged.

## Validation And Release Gates

Before each phase moves forward, require:

- schema and mapping tests;
- permission and consent policy tests;
- synthetic fixture-based adapter tests;
- end-to-end happy-path and failure-path workflow tests;
- audit completeness checks;
- rollback drill for bad mappings or vendor outage.

Production go-live additionally requires:

- signed governance approval;
- sandbox/UAT evidence;
- credential rotation test;
- reconciliation report dry run;
- incident-response runbook;
- launch-day manual monitoring plan.

## Risks And Mitigations

### Risk: Vendor Capability Mismatch

Mitigation:

- start with a canonical contract and pluggable adapters;
- maintain a manual-review fallback;
- do not couple UI to vendor transport details.

### Risk: Bad Identity Matching

Mitigation:

- require explicit staff review for ambiguous matches;
- preserve rejected candidates;
- monitor false-positive and duplicate rates.

### Risk: Over-Disclosure

Mitigation:

- bind every write to consent or explicit operational authority;
- minimize field sets;
- keep free text and documents out of automatic sync by default.

### Risk: Silent Sync Failure

Mitigation:

- require durable audit records;
- surface sync status in the product;
- add reconciliation jobs and operator alerts.

### Risk: Local Governance Drift

Mitigation:

- version policies and field mappings;
- schedule periodic governance review;
- gate rollout by CoC or deployment, not with one global switch.

## Open Decisions

These decisions must be resolved early.

1. Which local CoC and HMIS vendor are in scope for the first deployment?
2. Is the initial transport mode API, file exchange, or manual bridge?
3. Which workflows are approved first: lookup only, referrals, enrollment, or
   coordinated-entry support?
4. What exact consent language and retention rules apply to HMIS-linked audit
   records?
5. Which Abby user roles are allowed to read versus submit HMIS actions?
6. How will provider/service records in the 211 corpus map to HMIS project or
   program identifiers?

## Recommended Next Steps

1. Confirm the first partner CoC, HMIS lead, and vendor.
2. Build a field-mapping workbook for one narrow workflow: outbound referral.
3. Approve a role-and-consent matrix before any adapter code is written.
4. Implement phase 1 with a manual-review adapter and synthetic fixtures before
   touching a live HMIS environment.