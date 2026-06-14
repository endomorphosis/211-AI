# Abby UI

TypeScript-first frontend prototype for Abby safety check-ins, emergency
contacts, controlled disclosure, uploads, social services, shelter workflows,
recipient access, and benefits-protection opt-in.

The app currently uses local mock state and can be connected to the backend
later through `src/services/`.

## Dev server watcher limits

The Vite dev server uses polling by default and ignores generated output and
review artifacts: `artifacts/`, `dist/`, `test-results/`, `public/assets/`, and
`public/corpus/`. This keeps hot-reload focused on source files and avoids
Linux `EMFILE: too many open files, watch ...` failures on machines that already
have many editor/browser watchers open or have exhausted inotify watcher
instances.

On a machine with plenty of inotify capacity, native file watching can be used
instead:

```bash
npm run dev:native
```

The wallet implementation boundary now lives in Python. The browser app keeps
`src/services/walletApi.ts` as a typed HTTP client, while the canonical wallet
logic, snapshot persistence, audit history, grants, receipts, and proof state
live in `ipfs_datasets_py.wallet` and are exposed through
`ipfs_datasets_py.wallet.api` mounted on the shared FastAPI app.

Access requests and grant receipts can be loaded from the wallet API by setting:

```bash
VITE_WALLET_API_BASE_URL=http://localhost:8000
VITE_DEMO_WALLET_ID=wallet-...
VITE_DEMO_ACTOR_DID=did:key:owner
```

For the extracted Python-backed slice, the UI currently depends on these routes:

- `POST /wallets`
- `GET /wallets/{wallet_id}`
- `POST /wallets/{wallet_id}/documents/text`
- `POST /wallets/{wallet_id}/documents`
- `PATCH /wallets/{wallet_id}/records/{record_id}/metadata`
- `DELETE /wallets/{wallet_id}/records/{record_id}`
- `POST /wallets/{wallet_id}/locations/{location_record_id}/region-proofs`
- `POST /wallets/{wallet_id}/locations/{location_record_id}/distance-proofs`
- `POST /wallets/{wallet_id}/records/{record_id}/document-profile-proofs`
- `POST /wallets/{wallet_id}/records/{record_id}/metadata/generate`
- `GET /analytics/templates`
- `GET /wallets/{wallet_id}/analytics/consents`
- `POST /wallets/{wallet_id}/analytics/consents/from-template`
- `POST /wallets/{wallet_id}/analytics/consents/{consent_id}/revoke`
- `GET /wallets/{wallet_id}/dead-drops/missing-person`
- `PUT /wallets/{wallet_id}/dead-drops/missing-person`
- `POST /wallets/{wallet_id}/dead-drops/missing-person`
- `POST /wallets/{wallet_id}/dead-drops/missing-person/dispatch`
- `GET /wallets/{wallet_id}/portal/saved-services`
- `POST /wallets/{wallet_id}/portal/saved-services`
- `GET /wallets/{wallet_id}/portal/plans`
- `POST /wallets/{wallet_id}/portal/plans`
- `PATCH /wallets/{wallet_id}/portal/plans/{plan_id}`
- `POST /wallets/{wallet_id}/portal/plans/{plan_id}/share-grants`
- `GET /wallets/{wallet_id}/portal/interactions`
- `POST /wallets/{wallet_id}/portal/interactions`
- `GET /ops/health`
- `GET /wallets/snapshots`
- `POST /wallets/{wallet_id}/snapshot`
- `GET /wallets/{wallet_id}/snapshot`
- `POST /wallets/{wallet_id}/snapshot/load`
- `GET /wallets/{wallet_id}/records`
- `POST /wallets/{wallet_id}/records/{record_id}/rotate-key`
- `GET /wallets/{wallet_id}/records/{record_id}/storage`
- `POST /wallets/{wallet_id}/records/{record_id}/storage/repair`
- `GET /wallets/{wallet_id}/proofs`
- `GET /wallets/{wallet_id}/audit`
- `POST /wallets/{wallet_id}/records/{record_id}/grants`
- `POST /wallets/{wallet_id}/grants/{parent_grant_id}/delegate`
- `POST /wallets/{wallet_id}/grants/{grant_id}/revoke`
- `POST /wallets/{wallet_id}/records/{record_id}/analysis-invocations`
- `POST /wallets/{wallet_id}/records/{record_id}/decrypt-invocations`
- `POST /wallets/{wallet_id}/records/{record_id}/decrypt`
- `POST /wallets/{wallet_id}/records/{record_id}/analyze`
- `POST /wallets/{wallet_id}/records/{record_id}/analyze/redacted`
- `POST /wallets/{wallet_id}/records/{record_id}/vector-profile`
- `POST /wallets/{wallet_id}/records/{record_id}/extract-text/redacted`
- `POST /wallets/{wallet_id}/records/{record_id}/forms/analyze/redacted`
- `POST /wallets/{wallet_id}/records/graphrag/redacted`
- `POST /wallets/{wallet_id}/exports/grants`
- `POST /wallets/{wallet_id}/exports/invocations`
- `POST /wallets/{wallet_id}/exports`
- `POST /exports/verify`
- `POST /exports/import`
- `POST /exports/storage`
- `GET /wallets/{wallet_id}/access-requests`
- `POST /wallets/{wallet_id}/access-requests`
- `POST /wallets/{wallet_id}/access-requests/{request_id}/approve`
- `POST /wallets/{wallet_id}/access-requests/{request_id}/reject`
- `POST /wallets/{wallet_id}/access-requests/{request_id}/revoke`
- `GET /wallets/{wallet_id}/grant-receipts`
- `GET /wallets/{wallet_id}/approvals`
- `POST /wallets/{wallet_id}/approvals`
- `POST /wallets/{wallet_id}/approvals/{approval_id}/approve`
- `POST /wallets/{wallet_id}/emergency-revoke`
- `POST /wallets/{wallet_id}/controllers`
- `POST /wallets/{wallet_id}/controllers/remove`
- `POST /wallets/{wallet_id}/devices`
- `POST /wallets/{wallet_id}/devices/revoke`
- `POST /wallets/{wallet_id}/recovery-policy`
- `POST /wallets/{wallet_id}/recovery-bundles`
- `GET /wallets/{wallet_id}/recovery-bundles/latest`
- `GET /wallets/{wallet_id}/recovery-bundles/{bundle_id}`
- `POST /wallets/{wallet_id}/controllers/recover`
- `GET /wallets/{wallet_id}/storage`
- `POST /wallets/{wallet_id}/storage/repair`

Those routes are intended to be served by `ipfs_datasets_py.mcp_server.fastapi_service:app`.
The larger `walletApi.ts` surface still includes additional write and portal
routes that remain to be migrated into Python.

When those variables are absent, the recipient-access screen uses local mock
access-request and receipt state for demos and tests.
The uploads screen also uses the same API config to list encrypted document
records and add files through the multipart wallet document endpoint, with a
text-document fallback for simpler local API deployments.
That same extracted surface now also supports direct record metadata patching
and record deletion, so upload cards can persist user-facing metadata and prune
wallet records without using the legacy wallet-interface state store. Metadata
generation remains outside this extracted slice because it still depends on the
broader router/proof pipeline.
The canonical adapter now also serves owner-backed location region and distance
proof creation, and snapshot persistence preserves the principal secrets needed
for reloaded wallets to keep decrypting and proving against existing records.
It also now serves document privacy profile proof receipts with sanitized public
inputs, so the UI can persist privacy-profile proof artifacts without routing
that behavior through the legacy wallet-interface service.
The adapter now also generates wallet record metadata by orchestrating the
canonical redacted analysis, vector-profile, GraphRAG, text extraction, form
analysis, and privacy-profile proof steps, then writing the resulting
`privacyProfile*` fields back onto the record metadata payload.
The current extracted analytics slice also covers analytics template listing and
wallet consent list/create/revoke flows. The adapter discovers shared templates
by aggregating them from saved wallet snapshots, which is enough for the
existing UI contract without introducing a separate global analytics store yet.
The missing-person dead-drop safety setting also uses this API config: when a
wallet API and wallet actor are connected, Abby saves the dead-drop bundle on
the backend with `PUT /wallets/{wallet_id}/dead-drops/missing-person` and
routes it to `missing@police.portlandoregon.gov` from the server instead of
generating a local mailto draft.
API-backed uploads expose owner document viewing through the wallet decrypt
endpoint; plaintext is shown only after the connected wallet actor requests it.
Owners can also create record-scoped grants from an uploaded document for
analysis, document viewing, or bounded re-delegation. View and delegation
grants can request a record-scoped multi-sig approval inline, then reuse the
returned approval ID when creating the grant. Document-view grants can also
require recipient presence, which the recipient access flow satisfies through a
signed invocation before decrypting.
The Security screen lists threshold approvals for the wallet so controllers can
review pending record-grant and wallet-governance approvals without copying IDs
between screens.
API-loaded documents show encrypted storage health by calling each record's
storage verification endpoint. If a stored record reports a storage problem,
the uploads screen can call the wallet storage repair endpoint for that record.
The Security screen can also request a wallet-level encrypted storage report
showing total replicas, failed replicas, and the IPFS/S3/Filecoin provider mix,
then repair all configured replicas from available encrypted copies.
Active `record/analyze` receipts expose an analysis action that creates an
encrypted, derived-only artifact; the UI shows artifact metadata and storage
reference rather than raw document plaintext. Active `record/decrypt` receipts
expose a separate document-view action that decrypts only after the recipient
invokes that specific grant. Active receipts held by the current actor that
include `record/share` or `document/share` can also create attenuated delegated
grants for another DID through the wallet API.
Recipient receipts can also run redacted document analysis and vector-profile
creation when their output caveats allow it. Those actions now resolve through
the extracted Python wallet adapter routes for analysis invocation issuance,
decrypt invocation issuance, decrypt, summary analysis, redacted analysis,
vector profiles, redacted text extraction, redacted form analysis, and
redacted GraphRAG creation. The UI continues to consume those capabilities
through `src/services/walletApi.ts`.
The same extracted adapter also now serves the export bundle flow used by the
Exports screen: export grants, export invocations, bounded encrypted bundle
creation, bundle verification, import, and encrypted storage checks.
It also now covers delegated record grants, direct grant revocation, and
wallet-level emergency revoke so the UI can attenuate share-capable grants and
run incident-response revocations without falling back to the legacy API.
The same Python-backed surface now also covers controller add/remove, device
add/revoke, recovery-policy updates, and recovery-contact controller recovery
for the Security and recovery settings flows.
Recovery-bundle storage and magic-UCAN-protected encrypted bundle reads are now
also served by the extracted adapter, so the wallet recovery flow no longer has
to fall back to the legacy wallet-interface service for those endpoints.
When connected to the wallet API, the audit screen loads the wallet audit
timeline so grant, invocation, analysis, repair, and revocation events remain
traceable with actor, resource, decision, and grant metadata.

Approving, rejecting, and revoking access requests call the wallet API when
`VITE_DEMO_ACTOR_DID` is set. For demo wallets that need explicit key material
to issue useful decrypt grants, also set `VITE_DEMO_ISSUER_KEY_HEX` and
`VITE_DEMO_AUDIENCE_KEY_HEX`.
The multi-sig approval button calls the wallet approval endpoint when the
access-request review item includes an `approval_id`; otherwise it stays in the
local demo path.
For browser demos or smoke tests against a mock API, the same config can be
placed in `localStorage` under `abby-wallet-api-config` with `apiBaseUrl`,
`walletId`, and optional key/DID fields. Build-time env config takes precedence.
Non-secret demo config can also be supplied as URL parameters:
`walletApiBaseUrl`, `walletId`, and `actorDid`.

## Cloud-first LLM and audio routing (GitHub Pages)

The static GitHub Pages build is cloud-first: first user-visible text generation
is sent to the OpenRouter proxy immediately, and first voice/audio generation is
sent to the voice proxy immediately. Local model warmup is background-only and
must not block first responses.

Production proxy defaults:

```bash
VITE_OPENROUTER_PROXY_URL=https://animegf.chat:8787/api/openrouter/chat/completions
VITE_VOICE_PROXY_BASE_URL=https://animegf.chat:8790/api/voice
VITE_VOICE_PROXY_INFER_URL=https://animegf.chat:8790/api/voice/infer
```

Browser safety requirements:

- Use HTTPS proxy URLs only.
- Do not use private/internal browser endpoints (for example `10.8.0.1` or `10.8.0.0/24`).
- Do not send upstream provider API keys from the browser.
- OpenRouter requests with private wallet context remain blocked unless
  `VITE_OPENROUTER_ALLOW_PRIVATE_CONTEXT=true`.

Default OpenRouter model IDs:

```bash
VITE_OPENROUTER_INSTRUCT_MODEL=liquid/lfm-2.5-1.2b-instruct:free
VITE_OPENROUTER_THINKING_MODEL=liquid/lfm-2.5-1.2b-thinking:free
VITE_OPENROUTER_FALLBACK_DELAY=5000
VITE_CLIENT_REQUEST_TIMEOUT=12000
VITE_LOCAL_PROBE_TIMEOUT=10000
VITE_LOCAL_PERF_BENCHMARK_TIMEOUT=8000
```

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run build
npm run test
npm run test:fullstack
```

For focused checks:

```bash
npm run test:smoke
npm run test:filecoin-polling
npm run test:fullstack
npm run test:visual
npm run test:refinement
npm run review:visual:dry-run
npm run review:tasks
npm run review:prompts -- --include-blocked
```

Smoke and visual Playwright runs need host browser libraries in addition to the
downloaded browser bundles. On Ubuntu, inspect the required packages with:

```bash
npx playwright install-deps --dry-run
```

On this host, Chromium and WebKit were blocked until the system provided
`libnspr4`, `libgtk-4-1`, `libavif13`, and the GStreamer bad-plugins runtime
that provides `libgstcodecparsers-1.0.so.0`.

The Playwright npm scripts now run a Linux host-dependency preflight before any
browser launch. When that guard fails, fix the missing shared libraries instead
of retrying the same browser command. Set `PLAYWRIGHT_SKIP_HOST_DEPS_CHECK=1`
only when you intentionally want the raw Playwright launcher failure. To inspect
that preflight directly, run `npm run doctor:playwright`.

When Docker is available, you can bypass host browser libraries entirely with
the containerized runner:

```bash
npm run test:smoke:container -- --project="Desktop Chrome"
```

For arbitrary Playwright arguments, use:

```bash
npm run test:container -- tests/smoke.spec.ts --project="Desktop Chrome"
```

The container helper uses the matching official Playwright image for the
installed version and runs as the current UID/GID, so it does not leave
root-owned test artifacts behind in the workspace.

When those host libraries are unavailable, the repo also includes a manual
retry harness for the wallet-record Filecoin flow:

```bash
npm run build
npm run mock:filecoin-retry
```

Then open `http://127.0.0.1:4174/manual-filecoin-retry`. The helper page seeds
the demo wallet session and redirects to the uploads screen with a same-origin
mock wallet API and `/filecoin-upload` bridge. The expected manual sequence is:

- Click `Store on IPFS/Filecoin` for `Benefits letter`.
- Confirm the item changes to `IPFS only` and shows `Retry Filecoin`.
- Click `Retry Filecoin` and confirm the item finishes with `Stored on IPFS and confirmed by Filecoin persistence.`

For a browserless regression check of the same status-merge behavior, run:

```bash
npm run test:filecoin-polling
```

Avoid running UI builds as `root`. A root-owned `dist/` tree causes the
Playwright web server build to fail with `EACCES: permission denied, unlink
'dist/assets/...'`. If that happens, either restore ownership with `chown` or
move the whole `dist/` directory aside from its parent directory and rebuild.

The visual test writes review screenshots and manifests to
`artifacts/ui-screenshots/latest/`, including default and stateful UI scenarios.
The refinement test writes a smaller iteration packet to
`artifacts/ui-iterations/latest/` for faster multimodal review and UI/UX
revision loops.
See
`docs/multimodal-ui-review.md` for the `ipfs_datasets_py.multimodal_router`
review loop.

## GitHub Pages

The Vite app uses relative asset paths and hash-based routes, so the built app
works from a GitHub Pages project URL such as:

```text
https://<owner>.github.io/<repo>/
```

The repository workflow at `.github/workflows/abby-ui-pages.yml` builds this
subdirectory and publishes `wallet_interface/ui/dist` with GitHub Actions Pages.
In the repository settings, set Pages source to "GitHub Actions".

The workflow can also write `public/runtime-config.json` from non-secret GitHub
Actions variables before the build. Use repository or environment variables
such as `ABBY_PAGES_WALLET_API_BASE_URL`, `ABBY_PAGES_WALLET_ID`, optional
`ABBY_PAGES_ACTOR_DID`, optional `ABBY_PAGES_FILECOIN_UPLOAD_URL`, optional
Walrus publisher/aggregator variables, and optional
`ABBY_PAGES_PRECOMPUTED_AUDIO_MANIFEST_URL` when you want the Pages sandbox to
point at live backend/runtime assets like `https://211-ai.com` without
committing a runtime-config change. A bundled same-origin deployment can set
`ABBY_RUNTIME_FILECOIN_UPLOAD_URL=/filecoin-upload`; a Pages sandbox should
usually point `ABBY_PAGES_FILECOIN_UPLOAD_URL` at the live origin explicitly,
for example `https://211-ai.com/filecoin-upload`.

Walrus document storage is configured separately from IPFS/Filecoin. Use
`ABBY_RUNTIME_WALRUS_PUBLISHER_URL` for the publisher endpoint that accepts
`PUT /v1/blobs`; optionally set `ABBY_RUNTIME_WALRUS_AGGREGATOR_URL` for blob
links, `ABBY_RUNTIME_WALRUS_CLIENT_TOKEN` for a bearer token,
`ABBY_RUNTIME_WALRUS_EPOCHS` for storage duration, and
`ABBY_RUNTIME_WALRUS_DELETABLE=true` for deletable blobs. The same runtime
config can override Abby's precomputed audio manifest at runtime with:

```json
{
  "precomputedAudio": {
    "manifestUrl": "https://huggingface.co/datasets/Publicus/211-abby-tts/resolve/main/audio/abby-tts/current/metadata/abby_tts_runtime_manifest.json"
  }
}
```

The UI is mobile-first and also includes desktop layouts. The mobile home screen
keeps the required primary actions as two cards: "Emergency contacts" followed
by "Social services".
