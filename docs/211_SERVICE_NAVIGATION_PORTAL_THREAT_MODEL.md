# 211 Service Navigation Portal Threat Model

Status: operational guidance for PORTAL-080. This document applies to the 211
service-navigation portal described in
`docs/211_SERVICE_NAVIGATION_PORTAL_PLAN.md`.

## Scope

The portal helps users find public 211 services, inspect cited service details,
take mobile handoff actions, save services, create plans, track interactions,
share selected plan context with service workers, and use a public offline shell.

In scope:

- Public 211 corpus and portal package artifacts.
- Service search, service detail, provenance, action generation, and calendar
  generation.
- Saved services, service plans, service interactions, private notes, reminders,
  uploads, recipients, grants, proof receipts, revocations, and audit events.
- Worker service-plan sharing, redacted worker view, and grant revocation.
- PWA shell and public service detail cache behavior.
- Release evidence, artifact audit, accessibility review, mobile smoke review,
  privacy review, and launch exceptions.

Out of scope:

- Replacing wallet cryptography, UCAN authorization, proof verifier behavior,
  encrypted storage, retention policy, or audit semantics. Those remain owned by
  the wallet layer and wallet runbooks.
- Treating public 211 provider facts as private.
- Treating user interactions with public provider facts as public. User
  searches, saved services, action history, plans, notes, precise location, and
  worker assignments are private wallet context.

## Trust Boundaries

| Boundary | Trusted component | Untrusted or constrained component | Required control |
| --- | --- | --- | --- |
| Public corpus | Retrieval package, portal package, CIDs, source URLs, browser GraphRAG manifests | Stale or incomplete provider source text | Cite source URL and CIDs, show missing/stale warnings, never invent contact, eligibility, hours, or location facts. |
| Mobile handoff | `serviceActionService.ts` and `.ics` generator | OS/browser handlers, provider apps, share targets | Use explicit user taps, standards-compliant URLs, unavailable states, and safe "intent only" outcomes. |
| Interaction capture | `serviceInteractionService.ts` and wallet portal API | Browser events and action descriptors | Require user initiation, service ID, source CIDs where available, privacy level, and safe metadata. |
| Wallet records | Wallet API, encrypted wallet storage, app service models | UI session state, localStorage, release evidence | Store private state in wallet-backed records; do not persist private notes or interaction narratives in public logs or caches. |
| Worker access | Wallet grants, grant receipts, worker redaction helpers | Worker DID, revoked grants, raw service plan | Render only active-grant allowed fields; revocation must block future access and preserve audit history. |
| Offline cache | PWA service worker cache strategy | Browser Cache Storage and private URLs | Cache only public shell/detail artifacts; bypass wallet IDs, actor DIDs, records, grants, proofs, and wallet API URLs. |
| Artifact publication | `data/portal/upload_audit.json`, HF repository metadata | Remote package drift or stale release references | Verify size and SHA-256 for every artifact before release. |
| Release evidence | Release checklist and target ticket | Screenshots, logs, mobile notes, audit excerpts | Record only safe artifact references and summaries; never paste private wallet plaintext or secrets. |

## Data Classification

Public data:

- 211 scraped service text.
- Provider and program details from public source pages.
- Source URLs, source CIDs, page CIDs, scrape/build timestamps, and extraction
  confidence.
- Public service contact and location fields derived from source text.
- Public browser shell and service detail artifacts.

Private wallet data:

- Saved services, labels, reasons, priorities, and statuses tied to a wallet.
- Service plans, checklists, appointment times, reminders, travel targets, and
  assigned workers.
- Private notes and related wallet record IDs.
- Interaction history, call/text/email/map/share/calendar intents, outcomes,
  follow-up dates, and provider-contact narratives.
- Precise location, uploads, documents, OCR text, derived artifacts, grants,
  revocations, proof witnesses, export contents, analytics consent, and audit
  details tied to a wallet.

Sensitive release evidence categories:

- Private notes, exact locations, document text, OCR output, provider
  conversations, raw query history, grant tokens, proof witnesses, wallet keys,
  bearer tokens, secret-manager values, and storage URLs containing secrets.

## Privacy Rules

Hard rules:

- Do not store private portal state in public corpus artifacts, public PWA
  caches, screenshots, test snapshots, telemetry, or release tickets.
- Do not use localStorage as durable storage for saved services, plans,
  interaction history, worker assignments, or private notes.
- Do not mirror private notes, exact user location, document text, provider
  conversations, grant tokens, proof witnesses, or raw query history into audit
  logs.
- Do not expose service-plan fields to workers unless an active grant covers the
  plan, worker, scope, and field.
- Do not keep using a grant after revocation, even if the UI still has stale
  route or component state.
- Do not claim external outcomes the browser cannot observe, such as call
  connection, message delivery, calendar import, provider receipt, or visit
  completion.
- Do not aggregate analytics or feedback without explicit analytics consent and
  privacy review for dimensions, thresholds, joins, and retention.

## Threats And Mitigations

| Threat | Mitigation |
| --- | --- |
| Stale or incomplete 211 data causes a user to rely on wrong hours, eligibility, address, or contact details | Show source URL, source CIDs, scrape/build timestamp, confidence, and missing/stale warnings. Shared payloads tell recipients to verify before visiting or sharing private information. |
| Extracted phone, email, address, or hours field is malformed | Generate actions only when backing data validates; unavailable actions must not produce malformed handoff URLs. |
| App records a call, text, email, map, share, or calendar action as completed when only a handoff happened | Service action and interaction services use intent-only language and state what the browser cannot observe. |
| Private service interaction history leaks through public audit, logs, screenshots, telemetry, or release evidence | Store private narratives in wallet records; audit only safe metadata; release evidence contains safe artifact references only. |
| Worker sees ungranted service-plan fields | Worker view derives fields from active grant caveats and withholds private notes, wallet ID, plan ID, timestamps, and ungranted scopes. |
| Revoked worker grant still exposes future access | Wallet grant status is checked at access/render time; revocation removes active receipts while preserving revoked receipt and audit history. |
| Public PWA cache stores private wallet plaintext or wallet-bearing URLs | Service worker bypasses cache for wallet IDs, actor DIDs, wallet API URLs, records, grants, proofs, and non-public API requests. |
| Offline shell serves stale private state | Offline release scope is public shell/detail only unless encrypted wallet state is available through the wallet boundary; pending private sync requires a separate queue and audit review. |
| HF or browser artifact drift causes release to use an unverified package | Release gate requires upload audit with matching size and SHA-256 for every portal package artifact. |
| Mobile browser API differences break critical actions | Release matrix covers iOS Safari and Android Chrome for action handoffs, share fallback, calendar fallback, saved-service flows, worker view, and offline shell. |
| Accessibility regression prevents service discovery or action use | Release gate requires desktop/mobile smoke and manual accessibility review for keyboard, focus, screen reader labels, large text, contrast, and reduced motion. |
| Precise location is collected for service matching without need | Prefer user-entered city/ZIP, coarse location, or proof receipts. Precise browser geolocation requires explicit permission and a reviewed purpose. |
| Analytics reveals vulnerable users or rare service needs | Default to no raw query text or precise location; require consent, k-threshold review, allowed dimensions, and privacy-budget or aggregation controls. |
| Release ticket, screenshots, or support notes include private wallet data | Operators record artifact IDs, hashes, decisions, and sanitized summaries only. Any private plaintext in evidence is a privacy incident. |

## Security Review Checklist

Before a portal release ships:

- Service detail renders provider/program/source/CID/provenance and missing
  fact warnings without private wallet context.
- Action URL and `.ics` tests pass for call, text, email, map, share, and
  calendar helpers.
- Interaction-intent tests prove explicit user initiation is required and
  browser-observable limits are preserved.
- Wallet API tests pass for saved service, service plan, service interaction,
  worker grant, redaction, revocation, persistence, and audit behavior.
- Worker redaction tests prove private notes, exact travel target, ungranted
  fields, wallet-only IDs, and revoked grants are withheld.
- PWA cache review proves public artifacts are cached and private URLs bypass
  Cache Storage.
- `data/portal/upload_audit.json` proves local and remote package hashes match.
- Accessibility and mobile smoke evidence covers desktop, iOS Safari, and
  Android Chrome without storing private wallet data.
- Any analytics or feedback launch has explicit consent copy, allowed fields,
  retention, aggregation thresholds, and privacy reviewer approval.
- `data/portal/release_checklist.json` has no unresolved required gate without
  an approved launch exception.

## Incident Handling

Treat these as release blockers and privacy incidents:

- Private wallet plaintext appears in public corpus artifacts, public caches,
  logs, screenshots, telemetry, release tickets, or static assets.
- A worker can see private notes, precise location, document text, ungranted
  service-plan fields, or data after grant revocation.
- A release artifact hash or size differs from the audited package.
- A mobile action or interaction log falsely states an external provider action
  completed.
- Analytics or feedback collection includes raw query text, precise location,
  private notes, or provider conversations without explicit consent and privacy
  review.

Immediate response:

1. Stop rollout or disable the affected surface.
2. Preserve secure evidence with private values redacted or stored in the
   approved incident system.
3. Rotate or revoke affected grants, links, exports, keys, or caches as needed.
4. Follow `docs/WALLET_OPERATIONS_RUNBOOK.md` for wallet-private data impact.
5. Patch the control, add regression coverage, and rerun the release checklist
   before re-enabling.
