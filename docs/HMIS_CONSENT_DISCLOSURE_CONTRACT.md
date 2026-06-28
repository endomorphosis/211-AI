# HMIS Consent And Disclosure Contract

Last updated: 2026-05-19

Purpose: define the policy and implementation contract for when Abby may read
from HMIS, prepare data for HMIS, or send approved writes to HMIS.

This document is a product and engineering contract. It does not replace local
legal review, HMIS privacy notices, or jurisdiction-specific consent
requirements. Where local CoC or program policy is stricter, the stricter rule
must apply.

## Scope

This contract governs:

- HMIS lookups initiated from Abby;
- creation and validation of HMIS referral or enrollment drafts;
- outbound submission to HMIS through any adapter mode;
- display of HMIS-linked status and summaries in Abby or approved chat tools;
- revocation and expiry behavior for future HMIS-linked actions.

This contract does not authorize:

- automatic export of uploaded documents;
- unrestricted sync of free-text case notes;
- bulk mirroring of HMIS records into the wallet;
- access outside approved user role, program scope, and workflow scope.

## Contract Principles

- Consent is specific to purpose, scope, and time window.
- Staff authorization and client consent are related but not interchangeable.
- The minimum necessary data should be read or transmitted for the approved
  workflow.
- The system must distinguish read authority, draft authority, and submit
  authority.
- Revocation stops future actions but does not erase already-completed,
  already-authorized external writes.
- Every HMIS-linked action must record the basis used: consent, operational
  authority, or approved exception.

## Allowed Legal Or Operational Bases

Every HMIS-linked action must cite exactly one primary basis.

| Basis | Description | Typical use |
| --- | --- | --- |
| `client_consent` | The client or authorized subject approved the specific HMIS-linked workflow and scope | Referral lookup, referral submit, limited status review |
| `program_operational_authority` | Local HMIS governance authorizes the staff workflow as part of approved case operations | Staff review of referral state, reconciliation, program-limited follow-up |
| `mandated_or_emergency_exception` | A separately approved emergency or mandatory reporting basis applies | Rare; must be policy-gated and specially audited |

Hard rules:

- `program_operational_authority` must not be used as a shortcut for broader
  disclosure than policy allows.
- `mandated_or_emergency_exception` must remain disabled unless separately
  approved and explicitly implemented.
- If no valid basis exists, the action must fail closed.

## Consent Object Contract

Each HMIS-linked consent record should contain at least:

- `consent_id`
- `subject_ref`
- `captured_by_actor_id`
- `capture_method`
- `status`
- `basis`
- `purpose`
- `authorized_scopes`
- `authorized_program_refs`
- `authorized_adapter_modes`
- `effective_at`
- `expires_at`
- `revoked_at`
- `revocation_reason`
- `evidence_ref`
- `copy_version`
- `policy_version`
- `notes_redaction_state`

Recommended statuses:

- `draft`
- `active`
- `expired`
- `revoked`
- `superseded`
- `policy_blocked`

## Scope Model

Authorize scopes explicitly rather than as a generic blanket.

Recommended scope vocabulary:

- `hmis_lookup_client`
- `hmis_lookup_household`
- `hmis_view_referral_status`
- `hmis_create_referral_draft`
- `hmis_submit_referral`
- `hmis_create_enrollment_draft`
- `hmis_submit_enrollment`
- `hmis_agent_summary`

Rules:

- read scopes do not imply write scopes;
- referral scopes do not imply enrollment scopes;
- agent summary scope must be separate from GUI scope;
- program references must be bound where policy requires program-limited access.

## Decision Matrix

| Action | Requires consent | Requires staff role | Requires program scope | Requires confirmation | Allowed basis |
| --- | --- | --- | --- | --- | --- |
| Lookup client candidates | Usually yes, unless approved operational lookup policy allows it | Yes | Yes | User/staff initiation | `client_consent`, `program_operational_authority` |
| View masked candidate status | Same as lookup | Yes | Yes | No extra confirmation | same as lookup |
| Verify external link | Yes | Yes | Yes | Yes | `client_consent`, `program_operational_authority` |
| Create referral draft | Yes | Yes | Yes | Yes | `client_consent` |
| Submit referral | Yes | Yes | Yes | Yes | `client_consent` |
| View referral sync status | Usually yes or approved operational basis | Yes | Yes | No extra confirmation | `client_consent`, `program_operational_authority` |
| Create enrollment draft | Yes | Yes | Yes | Yes | `client_consent` |
| Submit enrollment | Yes | Yes | Yes | Yes | `client_consent` |
| Show HMIS-linked chat summary | Yes | Yes | Yes | Yes | `client_consent`, tightly scoped |

If local governance allows lookup without prior client-specific consent for a
defined intake workflow, that policy must still be documented, role-limited,
and auditable.

## Data Minimization Rules

For outbound HMIS workflows:

- send only the fields required for the approved object and workflow;
- exclude uploaded documents by default;
- exclude unrestricted free-text notes by default;
- exclude unrelated wallet context, proofs, grants, analytics choices, or audit
  history;
- prefer structured referral fields over narrative blobs.

For inbound HMIS display in Abby:

- prefer status, identifiers, timestamps, and concise code interpretations;
- mask or omit fields that the current role does not need;
- do not surface raw vendor payloads in standard UI flows;
- keep chat summaries narrower than the equivalent GUI permission set.

## Capture Requirements

Consent capture UI or workflow must provide:

- plain-language purpose statement;
- which system or organization receives the data;
- which fields or categories are involved;
- whether the action is read-only lookup, draft, or submit;
- how long the consent lasts or when it will be reviewed;
- how to revoke future use;
- what revocation cannot undo retroactively.

Capture methods may include:

- self-service acceptance in Abby;
- staff-assisted capture with actor attribution;
- imported consent artifact from an approved external workflow.

All methods must store evidence and the copy version shown.

## Revocation And Expiry

Revocation must:

- block future lookup, draft, submit, and summary actions that depended on the
  revoked consent;
- preserve audit history and prior lawful actions;
- surface a clear failure reason when future actions are attempted;
- trigger review of pending unsent drafts where possible.

Expiry must:

- fail future actions that require active consent;
- allow display of historical audit events;
- require recapture before new submit operations.

## API Contract Assumptions

Common backend result fields:

- `status`
- `summary`
- `audit_event_id`
- `consent_id`
- `basis_used`
- `policy_warnings`
- `requires_confirmation`
- `external_refs`

Stable error codes should include at least:

- `consent_required`
- `consent_expired`
- `consent_revoked`
- `scope_not_authorized`
- `program_scope_required`
- `policy_gate_disabled`
- `confirmation_required`
- `role_not_authorized`

Every mutating response should be safe to display without exposing raw HMIS
payload content.

## Audit Requirements

Each HMIS-linked audit event should record:

- actor id and role;
- subject reference;
- local workflow or record reference;
- action type;
- consent id or operational-basis reference;
- policy version and copy version if consent-driven;
- requested scopes;
- authorized program refs;
- adapter mode;
- result status;
- external references if any;
- rejection or failure code.

Do not record in routine audit views:

- full request or response payload bodies;
- unrestricted narrative notes;
- secrets, tokens, or raw transport headers;
- more personal detail than needed to identify the workflow event.

## Chat And Agent Rules

- HMIS-linked chat access must stay disabled until the GUI workflow, audit
  trail, and prompt guards are proven.
- When enabled, chat must call the same backend policy gates and action
  contracts as the GUI.
- Chat may prepare drafts or explain status only within the actor's approved
  scope.
- Chat must require confirmation before any high-impact draft or submit action.

## Exceptions

Emergency or mandated exceptions require:

- an explicit policy gate;
- named approved roles;
- special audit tagging;
- documented legal basis;
- post-action review.

If the exception path is not fully approved, it must not exist in code as a
reachable production workflow.

## Implementation Checklist

- Model HMIS consent separately from generic wallet sharing or analytics
  consent.
- Bind every HMIS action to consent scope or approved operational basis.
- Enforce program scope server-side.
- Preserve copy version and policy version used at capture time.
- Surface revocation and expiry clearly in Abby.
- Keep documents and broad free text out of V1 HMIS sync.
- Ensure audits are durable, human-readable, and minimally disclosive.

## Open Decisions

1. Whether read-only lookup in the first intake workflow requires fresh
   client-specific consent every time or can rely on approved operational basis
   for a narrower role set.
2. Whether referral status review after submission remains valid under the same
   consent scope or requires a separate scope.
3. Which program types, if any, require shorter consent expiry windows.
4. Whether staff-assisted capture needs a distinct witness or dual-attestation
   record in pilot.