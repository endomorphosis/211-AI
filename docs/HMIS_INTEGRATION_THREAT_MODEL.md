# HMIS Integration Threat Model

Status: operational guidance for HMIS-071 and HMIS-090. This document applies
to the HMIS integration described in `docs/HMIS_INTEGRATION_IMPLEMENTATION_PLAN.md`.

## Scope

The HMIS integration allows approved Abby workflows to look up HMIS-linked
records, prepare referral and enrollment drafts, submit approved outbound
updates through an adapter, ingest status changes, and display cross-system
audit and reconciliation state.

In scope:

- HMIS lookup, matching, link verification, rejection, and reconciliation.
- Referral and enrollment draft creation, validation, submission, retry, and
  status synchronization.
- Consent evaluation, disclosure scope checks, role-based permissions, and
  operational authority checks.
- Adapter execution for vendor API, file exchange, and manual-review modes.
- HMIS-linked audit records, staging metadata, operator runbooks, release gates,
  and incident handling.
- Abby UI surfaces and chat tools that expose HMIS-linked actions or summaries.

Out of scope:

- Redefining wallet cryptography, UCAN core semantics, or existing encrypted
  document storage behavior.
- Replacing the HMIS system of record with 211-AI.
- Bulk mirroring of all HMIS data into the wallet or public corpus.
- Automatic sync of uploaded documents or raw free-text case notes in V1.

## Trust Boundaries

| Boundary | Trusted component | Untrusted or constrained component | Required control |
| --- | --- | --- | --- |
| Abby UI to backend | Backend HMIS service, policy checks, audit hooks | Browser state, user-entered fields, stale UI assumptions | Enforce all permission, consent, and record-state checks server-side; never trust UI gating alone. |
| Canonical integration layer | `wallet_interface/hmis/service.py`, models, mapper, policies | Vendor-specific payload formats and code tables | Keep canonical contracts stable, validate mappings, and reject unrecognized or stale code values. |
| Adapter transport | Adapter implementations and environment config | Vendor APIs, file drops, batch imports, network outages, schema drift | Normalize errors, isolate credentials, use idempotency keys, and reconcile all external writes. |
| Identity matching | Matching engine, reviewed links, rejection history | Ambiguous demographic data, duplicates, conflicting external records | Score candidates, require review for ambiguity, preserve rejected candidates, and never auto-link low-confidence results. |
| Consent boundary | Consent contract, operational authority rules, audit evidence | Assumed consent, expired consent, revoked consent, role confusion | Bind every read/write to approved authority and log the basis used. |
| Audit and logging | Durable audit store, retention policy, operator review | App logs, support notes, screenshots, telemetry, error traces | Keep raw payloads and sensitive identifiers out of casual logs; store only reviewed, scoped audit metadata durably. |
| Chat exposure | Shared action facade, prompt guards, policy checks | Prompt assembly, broad summaries, user curiosity outside scope | Never inject HMIS-linked data into prompts or summaries unless the actor and purpose are allowed. |

## Data Classification

Restricted HMIS-linked data:

- external client, household, enrollment, referral, and program identifiers;
- demographic fields used for lookup or matching;
- referral status, enrollment status, and program participation details;
- consent basis, disclosure scope, and operational authority references;
- validation errors, rejection codes, and reconciliation notes tied to a
  specific person or household.

Highly sensitive categories:

- domestic-violence-related program context or location restrictions;
- free-text case narratives;
- uploaded documents or derived document text;
- credentials, API tokens, file-drop secrets, signed transport artifacts;
- raw request/response payloads that reveal unnecessary personal detail.

Lower-sensitivity operational metadata:

- adapter type;
- environment identifier;
- sync timestamp;
- job/run identifier;
- retry count;
- anonymized outcome counts and aggregate backlog metrics.

## Hard Privacy And Security Rules

- Do not expose HMIS credentials or vendor endpoints to the browser.
- Do not treat wallet ownership as blanket permission to read or write HMIS.
- Do not auto-link or auto-merge ambiguous candidate records.
- Do not write documents or unrestricted free-text notes into HMIS by default.
- Do not log full outbound or inbound payloads in general application logs.
- Do not show HMIS-linked summaries in chat unless the same actor could view the
  same data through the GUI action contract.
- Do not keep using revoked or expired consent as the basis for future writes.
- Do not assume external write success until adapter confirmation and audit
  persistence both succeed.

## Threats And Mitigations

| Threat | Mitigation |
| --- | --- |
| Staff links the wrong client due to ambiguous demographic matches | Weighted matching, explicit confidence display, required review for ambiguous candidates, preserved rejection history, and no silent auto-linking. |
| Abby writes data to HMIS without valid consent or authority | Server-side consent and policy gates, explicit purpose binding, expiry/revocation checks, and audit records citing the basis for each action. |
| Vendor API or batch schema drift causes silent bad writes | Canonical adapter contract, strict schema validation, normalized rejection handling, fixture-based contract tests, and reconciliation reports. |
| Duplicate referral or enrollment submission creates operational confusion | Idempotency keys, outbound submission ledger, duplicate detection, and operator-visible reconciliation queue. |
| Sensitive HMIS fields leak through logs, screenshots, telemetry, or chat prompts | Field masking, prompt guards, minimal audit metadata, restricted support procedures, and release review for logging surfaces. |
| Browser UI implies a write succeeded before backend confirmation | UI uses pending/submitted/confirmed/error states sourced from backend audit and adapter result, not optimistic success language. |
| Manual-review mode becomes a shadow integration path without audit | Manual review packets are created through the same service and audit pipeline and require explicit disposition tracking. |
| File exchange staging area leaks payloads or retains them too long | Encrypt staged files, use dedicated storage location, apply lifecycle deletion, restrict operator access, and record checksums and pickup events. |
| Chat agent over-shares HMIS data beyond role scope | Chat tools call the same typed backend actions as the GUI, inherit role checks, and redact unauthorized fields before prompt or response rendering. |
| Reconciliation backlog hides failed submissions | Scheduled reconciliation jobs, backlog dashboards, severity classes, and launch gates that block production if unresolved failure rates exceed thresholds. |

## Abuse And Misuse Cases

- An authorized user searches HMIS for people outside their program scope.
- A staff member uses broad demographic fields to probe for whether someone is
  in the system without a legitimate workflow reason.
- An operator downloads raw file-exchange artifacts and stores them outside the
  approved environment.
- A support ticket includes screenshots or copied payloads containing HMIS-only
  identifiers or sensitive status text.
- A future agent workflow starts summarizing HMIS-linked notes without explicit
  permission review.

Required controls:

- program-scoped authorization rules;
- reason-for-access capture where policy requires it;
- durable audit review;
- restricted operator procedures;
- regression tests for prompt and response redaction.

## Release Checklist

Before HMIS production rollout:

- Consent and operational authority rules are implemented and tested.
- Matching tests prove ambiguous candidates require review and rejected
  candidates are preserved.
- Adapter tests cover success, validation failure, auth failure, timeout,
  duplicate submission, and reconciliation drift.
- Application logs, telemetry, and support workflows are reviewed for sensitive
  field leakage.
- UI states distinguish draft, pending submit, submitted, confirmed, rejected,
  retrying, and reconciliation-required states.
- Manual-review mode, if enabled, records packet creation and resolution in the
  audit timeline.
- Credential rotation and environment cutover are tested.
- Incident response owners and contact paths are documented.

## Incident Handling

Treat these as security or privacy incidents:

- an HMIS write occurs without valid consent or approved authority;
- a user is linked to the wrong external HMIS record and downstream actions are
  taken on that basis;
- raw HMIS payloads or identifiers appear in logs, screenshots, support notes,
  analytics, or chat transcripts outside approved audit storage;
- reconciliation failure causes staff to act on stale or false submission
  status;
- expired or revoked credentials continue to function unexpectedly.

Immediate response:

1. Stop the affected adapter, route, or workflow.
2. Preserve evidence in the approved incident system with minimal necessary
   sensitive detail.
3. Revoke or rotate affected credentials, packets, links, or grants.
4. Reconcile impacted records and notify governance/privacy owners as required.
5. Add regression coverage and rerun the release checklist before re-enabling.