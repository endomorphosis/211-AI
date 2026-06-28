# HMIS Governance Access Matrix

Last updated: 2026-05-19

Purpose: define the minimum governance, role, environment, and approval model
for the first HMIS integration deployment described in
`docs/HMIS_INTEGRATION_IMPLEMENTATION_PLAN.md`.

This document is an implementation-facing policy artifact. It is not a legal
substitute for local CoC governance approval, vendor terms, or a signed
data-sharing agreement. Where local HMIS policy conflicts with this document,
local governance wins and the integration scope must be narrowed accordingly.

## Scope

This matrix covers:

- who may approve HMIS integration capabilities;
- which Abby roles may read, draft, submit, reconcile, or administer HMIS
  actions;
- which environments may connect to which HMIS transports;
- which workflows are allowed in the first launch wave.

This matrix does not independently authorize a deployment. Launch still
requires the approvals and release evidence listed in
`docs/HMIS_INTEGRATION_TODO.md` and
`docs/HMIS_INTEGRATION_THREAT_MODEL.md`.

## Governance Principles

- HMIS access is granted by workflow and scope, not by broad application role
  alone.
- Read authority and write authority are separate permissions.
- A wallet record or Abby account does not by itself authorize HMIS access.
- Every HMIS action must be attributable to a human or service principal with
  an approved purpose.
- The first deployment should start with the narrowest viable workflow set:
  lookup, referral draft, referral submit, and referral status sync.
- Enrollment or coordinated-entry write-back should remain disabled unless it
  has separate explicit approval.

## Governance Owners

| Owner | Responsibility | Required for launch |
| --- | --- | --- |
| Product owner | Defines staff workflow scope, rollout order, and UX boundaries | Yes |
| HMIS lead / CoC governance delegate | Approves allowed HMIS objects, workflow scope, environment access, and vendor path | Yes |
| Legal/privacy owner | Approves consent language, disclosure basis, retention, and incident handling | Yes |
| Security owner | Approves credential handling, transport model, logging boundaries, and operator controls | Yes |
| Data stewardship owner | Approves field mapping, code tables, validation rules, and reconciliation process | Yes |
| Operations owner | Approves environment setup, monitoring, retry, reconciliation, and rollback runbook | Yes |
| Vendor/integration contact | Confirms adapter capability, test environment, transport contract, and support path | Yes |

## Launch Workflow Scope

Allowed in initial deployment after approval:

- read-only client and household lookup for authorized staff;
- program and provider destination matching for referral workflows;
- referral draft creation from Abby service plans;
- referral submission through the approved adapter mode;
- referral status sync and reconciliation review.

Disabled by default in initial deployment:

- direct enrollment creation;
- coordinated-entry assessment write-back;
- bulk imports from Abby into HMIS;
- automatic sync of uploads, documents, or free-text notes;
- agent-triggered submission without explicit staff confirmation;
- broad analytics extracts containing HMIS-linked personal detail.

## Role Model

Recommended first-wave Abby roles:

- `abby_staff_basic`
- `abby_staff_case_manager`
- `abby_staff_supervisor`
- `abby_ops_hmis`
- `abby_admin_policy`
- `service_hmis_adapter`

All roles are subject to program scope, environment scope, and consent or
operational-authority checks.

## Permission Matrix

| Capability | `abby_staff_basic` | `abby_staff_case_manager` | `abby_staff_supervisor` | `abby_ops_hmis` | `abby_admin_policy` | `service_hmis_adapter` |
| --- | --- | --- | --- | --- | --- | --- |
| View whether HMIS integration is enabled for deployment | Yes | Yes | Yes | Yes | Yes | Yes |
| Read provider/program mapping status | Yes | Yes | Yes | Yes | Yes | No direct UI use |
| Search HMIS for client/household candidates | No | Yes | Yes | No routine use | No routine use | Service only |
| View masked lookup candidates | No | Yes | Yes | No routine use | No routine use | Service only |
| Verify external record link | No | Yes | Yes | No | No | No |
| Reject candidate link | No | Yes | Yes | No | No | No |
| Create referral draft | No | Yes | Yes | No | No | Service only |
| Validate referral draft | No | Yes | Yes | No | No | Service only |
| Submit referral to HMIS | No | Pilot only or approved case-manager subset | Yes | No | No | Service only |
| View referral sync timeline | No | Yes | Yes | Yes | Yes | Service only |
| Resolve reconciliation item | No | No | Yes | Yes | No | Service only |
| Manage adapter credentials or environment config | No | No | No | Yes | Yes | Service only |
| Change policy gate or role mapping | No | No | No | No | Yes | No |
| Read raw transport payloads | No | No | No | Restricted break-glass only | Restricted break-glass only | Service runtime only |

Notes:

- `abby_staff_basic` should not receive HMIS access in V1.
- `abby_staff_case_manager` submission authority should be pilot-limited unless
  governance explicitly approves broader direct write authority.
- `abby_ops_hmis` handles operations and reconciliation but should not act as a
  substitute for case workflow ownership.
- `service_hmis_adapter` is a backend service principal only and must never be
  exposed as a browser-held credential.

## Environment Matrix

| Environment | Allowed data | Allowed adapter modes | Allowed users | Required controls |
| --- | --- | --- | --- | --- |
| Local development | Synthetic fixtures only | Manual review, fixture API, fixture file exchange | Engineers only | No production credentials, no production identifiers, deterministic fixture packs |
| Sandbox / vendor test | Approved synthetic or vendor-provided non-production data | Manual review, vendor API test, file exchange test | Engineers, approved pilot staff, ops | Separate credentials, isolated audit partition, replay-safe test runs |
| UAT / staging | Approved UAT data only | Approved pre-production adapter mode | Pilot staff, supervisors, ops | Credential rotation test, reconciliation test, launch checklist evidence |
| Production | Live HMIS data under approved scope | Only governance-approved production adapter | Approved staff, supervisors, ops | Full audit, monitoring, incident handling, reconciliation, break-glass approval path |

Hard rules:

- Production credentials must never be used in local development.
- Synthetic fixture environments must not contain live personal data copied from
  HMIS.
- Manual-review mode may be enabled in production only if governance approves
  the operational process and audit trail.

## Approval Matrix By Workflow

| Workflow | Product | HMIS / CoC | Legal / Privacy | Security | Data stewardship | Ops |
| --- | --- | --- | --- | --- | --- | --- |
| Read-only client lookup | Yes | Yes | Yes | Yes | Yes | Yes |
| Referral draft creation | Yes | Yes | Yes | Yes | Yes | Yes |
| Referral submission | Yes | Yes | Yes | Yes | Yes | Yes |
| Referral status sync | Yes | Yes | Yes | Yes | Yes | Yes |
| Enrollment draft or submit | Yes | Yes | Yes | Yes | Yes | Yes |
| Bulk export or analytics extract | Yes | Yes | Yes | Yes | Yes | Yes |
| Agent-assisted HMIS summary | Yes | Yes | Yes | Yes | Yes | Yes |

Interpretation:

- first-wave launch should stop at the first four rows unless a later workflow
  gets separate written approval;
- any workflow lacking one required approval remains disabled in code and UI.

## Policy Gates

Each gate must have an explicit status: `disabled`, `pilot`, `approved`, or
`suspended`.

| Gate | Applies to | Default |
| --- | --- | --- |
| HMIS read lookup | Client and household lookup | `pilot` |
| HMIS referral draft | Draft creation and validation | `pilot` |
| HMIS referral submit | Outbound write to HMIS | `disabled` until adapter and consent controls are proven |
| HMIS enrollment write | Enrollment or assessment write-back | `disabled` |
| HMIS agent summary | Chat access to HMIS-linked summaries | `disabled` |
| HMIS raw payload review | Break-glass operator access to raw transport detail | `disabled` |

Gate changes require:

- named approver;
- effective date;
- reason for change;
- affected environments;
- rollback owner;
- audit record.

## Break-Glass Access

Break-glass access is for incident response only.

Allowed only for:

- unresolved reconciliation failure affecting active service delivery;
- security incident triage;
- vendor support incident requiring limited payload confirmation.

Required controls:

- supervisor or policy-admin approval;
- time-bounded access window;
- minimum necessary data review;
- audit record including reason and reviewer;
- post-incident review.

## Minimum Launch Artifacts

The first deployment should not proceed until these artifacts exist:

- `docs/HMIS_INTEGRATION_IMPLEMENTATION_PLAN.md`
- `docs/HMIS_INTEGRATION_TODO.md`
- `docs/HMIS_INTEGRATION_THREAT_MODEL.md`
- `docs/HMIS_CONSENT_DISCLOSURE_CONTRACT.md`
- environment configuration and credential reference inventory;
- approved field mapping workbook;
- reconciliation and rollback runbook;
- named approvers for each enabled workflow.

## Open Decisions

1. Which first-wave Abby staff group gets direct submit authority versus
   draft-only authority?
2. Whether `abby_ops_hmis` may resolve reconciliation by retry only, or also
   cancel/close records.
3. Whether agent-assisted HMIS summaries can be enabled in pilot once GUI and
   audit controls are proven.
4. Whether manual-review mode is a temporary launch bridge or a permanent
   fallback path.