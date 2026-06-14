# 211 Service Navigation Portal Runbook

This runbook covers release validation, operations, troubleshooting, incident
response, and rollback for the 211 service-navigation portal described in
`docs/211_SERVICE_NAVIGATION_PORTAL_PLAN.md` and
`docs/211_SERVICE_NAVIGATION_PORTAL_THREAT_MODEL.md`.

## Baseline

The portal release must keep public 211 corpus data separate from private
wallet state.

Required baseline:

- Public service search and detail evidence comes from
  `wallet_interface/ui/public/corpus/211-info/current` and the portal package
  published under `portal/211-info/current/data`.
- Artifact publication is auditable through `data/portal/upload_audit.json`.
- Service detail, mobile actions, saved services, plans, interaction history,
  worker sharing, and offline shell paths reuse existing wallet and portal
  components rather than creating a second state store.
- Saved services, service plans, service interactions, private notes,
  reminders, worker assignments, grant receipts, proof receipts, and audit
  details are wallet-private.
- Public PWA caches contain only the app shell and public service detail
  artifacts. Wallet IDs, actor DIDs, records, grants, proofs, and wallet API
  URLs bypass Cache Storage.
- Mobile integrations are user-initiated handoffs. The app records the intent
  to call, text, email, map, share, or create a calendar reminder, but it must
  not claim that a call connected, a message was sent, a calendar import
  succeeded, or a user visited a provider.

## Standard Validation

Run the task-level validation before merging PORTAL-080 changes:

```bash
python -m pytest tests/test_wallet_interface_api.py -q
npm --prefix wallet_interface/ui test -- --runInBand
```

Run these focused checks when changing the corresponding portal area:

```bash
python -m pytest tests/test_service_portal_package.py -q
npm --prefix wallet_interface/ui test -- tests/service-action-service.spec.ts
npm --prefix wallet_interface/ui test -- tests/service-interaction-service.spec.ts
npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
```

Run the wallet production checks before any target environment launch that
handles live wallet data:

```bash
python -m wallet_interface.ops --validate-production-readiness
python scripts/run_wallet_release_checks.py --dry-run
```

Use `docs/WALLET_OPERATIONS_RUNBOOK.md` for wallet storage, proof verifier,
ops health, target signoff, and privacy incident procedures.

## Release Gates

Do not release the portal unless every required gate passes in the target
environment or has an approved launch exception recorded in
`data/portal/release_checklist.json`.

1. Accessibility and responsive layout:
   - Desktop Chrome and mobile Playwright smoke tests pass.
   - Manual iOS Safari and Android Chrome smoke tests cover search, detail,
     action bar, saved services, plans, interaction history, worker view,
     offline shell, keyboard focus, visible focus, large text, and reduced
     motion.
   - No P0/P1 accessibility issue remains open for service search/detail,
     mobile action buttons, plan checklist, interaction filters, worker
     redaction, or offline banners.
2. Mobile action integrity:
   - Call, text, email, map, share, and calendar actions render only when
     backing data exists.
   - URL generation and `.ics` generation tests pass.
   - Interaction intents require explicit user initiation and preserve
     `source_content_cid`, `source_page_cid`, privacy level, and safe outcome
     text.
3. Privacy and wallet boundary:
   - Public service corpus data, citations, source URLs, and CIDs remain public.
   - Saved services, plans, private notes, reminders, precise location,
     interaction history, worker assignments, grants, proof receipts, uploads,
     and audit details remain wallet-private.
   - Worker views expose only fields allowed by active service-plan grants.
   - Revocation removes future worker access while preserving grant and audit
     history.
   - Public PWA caches do not store wallet-private plaintext or wallet-bearing
     URLs.
4. Artifact auditing:
   - `data/portal/upload_audit.json` shows `upload_performed=true`,
     `verified_hashes=true`, `package_match=true`, no missing remote files, no
     hash mismatches, and no size mismatches for the published portal package.
   - The release references the retrieval build manifest CID
     `bafkreihcclqadxrfhx256soxaqdqvc66ejhsuy3krj5bf446zq2miaox4i`.
   - Any new browser or HF artifact has an archived SHA-256, size, source path,
     remote path, and manifest entry before launch.
5. Release operations:
   - This runbook, the threat model, and `data/portal/release_checklist.json`
     are current for the target build.
   - The listed validation commands pass.
   - Owners for go/no-go, rollback, privacy review, accessibility review,
     artifact publication, and on-call support are recorded in the target
     release ticket or signoff packet.

## Mobile Smoke Matrix

Minimum target-device coverage:

| Surface | iOS Safari | Android Chrome | Expected result |
| --- | --- | --- | --- |
| Search to service detail | Required | Required | Result opens detail page with provider, program, source URL, CID, and stale-data warning where relevant. |
| Call/text/email | Required when data exists | Required when data exists | OS handoff opens from explicit tap; app records intent only. |
| Maps | Required | Required | Google, Apple, or `geo:` handoff opens; fallback is source URL when no address exists. |
| Calendar | Required | Required | `.ics` download/share path works or shows unavailable state without data loss. |
| Web Share | Required | Required | `navigator.share()` works when available; clipboard fallback is tested. |
| Save and plan | Required | Required | Saved service and plan persist through wallet API or clearly show session-only mode when no API is configured. |
| Worker redaction | Required | Required | Active grants show only allowed fields; revoked grants hide plan fields. |
| Offline shell | Required | Required | Public shell/detail assets render offline; private wallet requests bypass cache. |

Record browser version, device or emulator, viewport, build artifact, corpus
CID, failures, and launch exceptions in the release ticket. Do not paste private
wallet notes, precise location, document text, grant tokens, proof witnesses, or
service interaction narratives into the ticket.

## Artifact Audit Procedure

1. Inspect `data/portal/upload_audit.json`.
2. Confirm the top-level fields:
   - `upload_enabled=true`
   - `upload_performed=true`
   - `verified_hashes=true`
   - `package_match=true`
3. Confirm `post_upload_audit.missing_remote_files`,
   `post_upload_audit.hash_mismatches`, and
   `post_upload_audit.size_mismatches` are empty.
4. Confirm every `post_upload_audit.files[*]` item has `status=ok` and
   `sha256_match=true`.
5. Confirm the manifest counts are plausible for the intended release:
   service count, contact count, location count, hours count, requirement
   count, action count, artifact count, and coverage fields.
6. Archive the audit file or release evidence reference. Do not re-run an upload
   from production unless the release owner has approved the package version.

If the audit fails, block release. Rebuild or re-upload the package, then rerun
the audit until local and remote hashes match.

## Privacy Review Procedure

Review these boundaries before release:

- Service detail pages may show public provider facts and provenance, but must
  not mix in saved-service notes, private eligibility notes, worker
  assignments, grants, or exact user location without explicit wallet action.
- Action telemetry must record intent metadata only: service ID, source CIDs,
  action kind, timestamp, privacy level, safe outcome text, and related IDs.
- Private notes must be stored as wallet records and referenced by record ID.
- Audit logs should contain safe metadata. They must not contain private notes,
  document text, OCR output, precise coordinates, provider conversations, grant
  tokens, proof witnesses, or secret values.
- Worker service-plan grants must include allowed scopes and fields. The worker
  view must derive rendered fields from the active grant caveats.
- PWA caches must bypass wallet URLs and private query parameters.
- Analytics or feedback aggregation requires explicit analytics consent and
  k-threshold review. Raw query text and precise location are not default
  analytics dimensions.

Treat any private plaintext in Cache Storage, logs, screenshots, telemetry, or
release evidence as a privacy incident and follow the wallet runbook.

## Troubleshooting

### Service Detail Does Not Load

1. Confirm `wallet_interface/ui/public/corpus/211-info/current` exists.
2. Check `artifacts.manifest.json` and `generated/generated-manifest.json`.
3. Confirm the route ID or document ID matches a service in `documents.json`.
4. Run `npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts`.
5. If a field is missing, keep the missing-fact warning visible rather than
   inventing provider details.

### Mobile Action Is Missing

1. Check whether the backing phone, email, address, URL, or calendar input is
   present and valid.
2. Run `npm --prefix wallet_interface/ui test -- tests/service-action-service.spec.ts`.
3. Confirm unavailable actions render a disabled or unavailable state instead
   of creating a malformed `tel:`, `sms:`, `mailto:`, map, share, or `.ics`
   handoff.

### Interaction Is Not Persisted

1. Confirm the user action was explicit and user-initiated.
2. Confirm a `serviceDocId` and source CID context exist.
3. Check wallet API configuration and `/wallets/{wallet_id}/portal/interactions`.
4. Run `python -m pytest tests/test_wallet_interface_api.py -q`.
5. If the API is unavailable, the UI may show session-only state, but release
   readiness for live wallet data requires durable wallet persistence.

### Worker Sees Too Much Or Too Little

1. Inspect the service-plan grant caveats for `service_plan_scopes` and
   `allowed_fields`.
2. Confirm the grant status is active and targeted to the expected worker DID.
3. Confirm the worker view uses redaction helpers rather than the raw plan.
4. Revoke the grant and verify future access disappears while audit history
   remains.
5. Run `python -m pytest tests/test_wallet_interface_api.py -q`.

### Offline Shell Caches Private Data

Treat this as a privacy incident until proven otherwise.

1. Stop release rollout for the affected build.
2. Inspect Cache Storage for wallet URLs, record paths, grant paths, proof
   paths, actor DIDs, wallet IDs, private notes, provider conversations, exact
   locations, or document text.
3. Check `wallet_interface/ui/src/pwa/serviceWorker.ts` private URL bypass
   rules.
4. Delete affected caches, patch the cache strategy, and rerun mobile/offline
   smoke tests.
5. Follow `docs/WALLET_OPERATIONS_RUNBOOK.md` if any wallet-private data was
   exposed outside the wallet boundary.

## Incident Severity

| Severity | Examples | Immediate action |
| --- | --- | --- |
| P0 | Private wallet plaintext cached or logged, worker sees ungranted notes/location/documents, revoked grant still exposes future access, artifact hashes mismatch after release | Stop rollout, disable affected surface, preserve secure evidence, follow wallet privacy incident procedures. |
| P1 | Mobile action records false outcome, service detail omits source/CID, offline shell caches wallet-bearing URL without plaintext, accessibility blocker on core service flow | Block release or roll back affected route until fixed and validated. |
| P2 | Browser-specific share/calendar fallback fails with clear unavailable state, non-critical layout issue, stale package audit reference in release ticket | Fix before broad release if user impact is material. |
| P3 | Non-sensitive documentation or copy mismatch | Patch through normal review. |

## Rollback

Use the smallest rollback that restores safety:

1. Disable or hide the affected action button, worker view, or offline
   registration path.
2. Fall back to public read-only service detail if wallet persistence, grants,
   or interaction writes are affected.
3. Disable service worker registration or bump the cache version to evict a bad
   public cache.
4. Revert to the previous verified portal package or browser corpus only after
   confirming hashes and CIDs.
5. If wallet writes, grants, proofs, exports, or private records are affected,
   follow the wallet runbook and rerun wallet production readiness checks
   before re-enabling the workflow.

## Launch Checklist

Before marking the portal ready:

- `data/portal/release_checklist.json` has no unresolved required gate without
  an approved launch exception.
- `data/portal/upload_audit.json` passes the artifact audit procedure.
- `python -m pytest tests/test_wallet_interface_api.py -q` passes.
- `npm --prefix wallet_interface/ui test -- --runInBand` passes.
- Accessibility and manual mobile smoke evidence is attached to the release
  ticket without private wallet content.
- Privacy review covers wallet state, worker grants, interaction history,
  offline cache behavior, analytics, and release evidence handling.
- On-call staff can find this runbook, the threat model, the wallet operations
  runbook, rollback steps, and privacy incident procedures.
