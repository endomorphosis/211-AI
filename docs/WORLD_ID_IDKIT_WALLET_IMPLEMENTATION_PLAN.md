# World ID IDKit Wallet Integration Plan

Last updated: 2026-06-13

## Goal

Add World ID verification to the 211-AI file wallet so a client can prove they
control a valid World ID credential, bind that verification to their wallet, and
carry a wallet proof receipt alongside encrypted files, grants, audit events,
and existing zero-knowledge proof receipts.

The first production target is a privacy-preserving proof-of-human binding. It
does not claim a legal name, date of birth, immigration status, or government ID
unless we later add an explicit World ID credential policy for document-backed
attributes. The user-facing copy should say "verified human" or "World ID
verified" instead of "identity document verified" unless the selected World ID
credential actually proves that attribute.

## Upstream Facts To Design Around

- The referenced `worldcoin/idkit-js` repository is archived. Treat it as useful
  historical context, but implement against current World ID docs and packages.
- Current IDKit guidance says to use the latest `4.x` SDK flow, create a
  Developer Portal app, keep `app_id`, `rp_id`, and `signing_key`, and generate
  RP signatures in the backend only.
- World ID 4.0 proof requests require an `rp_context` signed by our backend.
  The RP signing key must never be exposed to browser code.
- After the user completes IDKit, the backend verifies the returned payload by
  forwarding the IDKit result as-is to:
  `POST https://developer.world.org/api/v4/verify/{rp_id}`.
- The backend must store nullifiers and enforce replay policy. A nullifier is
  scoped to the World ID user, app/RP, and action.
- IDKit credential presets include proof-of-human, passport/NFC style document
  credentials, selfie check, and a preview identity-check path. `signal` binds
  app context into the proof and must be enforced by the backend.

Primary references:

- `https://github.com/worldcoin/idkit-js`
- `https://docs.world.org/world-id/idkit/integrate`
- `https://docs.world.org/world-id/idkit/signatures`
- `https://docs.world.org/world-id/idkit/react`
- `https://docs.world.org/world-id/idkit/credentials`
- `https://docs.world.org/api-reference/developer-portal/verify`

Executable backlog: `docs/WORLD_ID_IDKIT_WALLET_TODO.md`

## Current 211-AI Integration Points

Use the existing wallet split:

- `ipfs_datasets_py.wallet` remains the durable wallet security boundary for
  records, proof receipts, snapshots, grants, audit events, export bundles, and
  analytics nullifiers.
- `wallet_interface/` remains the app/API orchestration layer.
- `wallet_interface/ui/src/services/walletApi.ts` remains the browser transport
  client.
- The Abby UI already has proof-center, file-wallet, QR proof bundle, audit,
  registration, provider, and security surfaces in `wallet_interface/ui`.

Important existing surfaces:

- `GET /wallets/{wallet_id}/proofs`
- `GET /wallets/{wallet_id}/audit`
- `POST /wallets/{wallet_id}/snapshot`
- `POST /wallets/{wallet_id}/documents`
- `POST /wallets/{wallet_id}/records/{record_id}/document-profile-proofs`
- `ProofReceipt` in `ipfs_datasets_py.wallet.models`
- `ProofReceiptView` in `wallet_interface/ui/src/models/abby.ts`
- `ProofCenterScreen` and wallet QR proof bundle rendering in
  `wallet_interface/ui/src/app/App.tsx`

## Product Scope

### MVP

1. Add a "Verify with World ID" flow for signed-in client wallets.
2. Bind successful World ID proof-of-human verification to one wallet.
3. Create a wallet proof receipt of type `world_id_proof_of_human`.
4. Store raw verification details and nullifiers in wallet-private state, not
   in public QR bundles by default.
5. Show a wallet-level World ID status badge in Proof Center, Wallet, Register,
   and Security.
6. Use the World ID binding as a replacement for the current demo bot check
   where appropriate, without making it the only access path for essential
   service workflows.
7. Persist the binding in wallet snapshots and include sanitized proof metadata
   in export bundles and QR proof review.

### Post-MVP

1. Provider staff World ID verification with a separate action and credential
   policy.
2. Login or account recovery assisted by World ID, gated by existing wallet
   recovery policy and never as a sole decrypt authority.
3. Passport/NFC or Identity Check flows for explicit eligibility attributes
   such as minimum age or nationality, only after policy review.
4. Admin review tooling for nullifier conflicts, unlink/transfer flows, and
   verifier health.

### Non-Goals

- Do not use World ID as a wallet encryption key.
- Do not make World ID the sole factor for wallet recovery or controller
  addition.
- Do not claim legal identity from a proof-of-human credential.
- Do not expose raw nullifiers in public proof QR bundles unless a future export
  mode explicitly asks the client for that disclosure.

## Post-MVP Login And Recovery Design

World ID may assist login or recovery only as a fresh proof-of-human signal
bound to an existing wallet recovery ceremony. It must not become a wallet key,
sole recovery factor, or bypass around wallet controller governance.

Allowed post-MVP uses:

- Step-up signal during account recovery when the wallet already has an active
  World ID binding for the same action family.
- Anti-duplication check before issuing a recovery request to human reviewers.
- Optional login hint that lets the UI find candidate wallets after the user
  separately proves control of an existing wallet controller, device key, or
  recovery contact.
- Risk signal for support staff that a recovery requester controls a valid
  proof-of-human credential.

Prohibited uses:

- Deriving wallet encryption keys, storage keys, UCAN signing keys, or recovery
  shares from a World ID nullifier, proof, or RP signature.
- Adding a controller, rotating a device, exporting a wallet, or decrypting a
  record solely because World ID verification succeeded.
- Treating World ID as a replacement for approval thresholds, user-presence
  checks, recovery-contact approval, emergency revoke rules, or audit logging.
- Logging into a wallet by nullifier lookup without a second factor that proves
  wallet authority.

Recovery ceremony requirements:

1. World ID must use a separate action, for example
   `wallet-recovery-assist-world-id-v1`, so login/recovery nullifiers do not mix
   with wallet attachment nullifiers.
2. The backend must store only a commitment to the recovery nullifier and must
   keep recovery attempts in wallet-private audit state.
3. The UI must say "World ID recovery assist" or "verified human recovery
   signal" and must not say "account owner verified" until controller or
   recovery-contact policy also passes.
4. Recovery still requires the configured wallet threshold, existing recovery
   contacts, active device/controller proof, or an approved human support
   workflow with auditable reviewer identity.
5. Any successful assisted recovery must create audit events for World ID
   request creation, verification, policy decision, controller/device changes,
   and support reviewer approval.

Production signoff for this post-MVP feature requires a new threat-model review,
Playwright coverage for login/recovery copy and fallback states, and updated
`wallet_interface.ops` readiness checks for the separate recovery action.

## Credential Policy Expansion Review

The MVP credential policy is proof-of-human only. Passport/NFC, selfie, and
identity-check credentials must be treated as separate product and policy
surfaces because they can imply legal identity, age, nationality, liveness, or
document attributes.

| Credential policy | Allowed claims before review | Prohibited claims before review | Required UI wording | Privacy review gate | Provider eligibility gate |
| --- | --- | --- | --- | --- | --- |
| `proof_of_human` | A valid World ID human credential is bound to this wallet for the configured action | Legal name, age, date of birth, citizenship, address, immigration status, document ownership, benefit eligibility | "World ID proof-of-human" or "verified human signal"; include "not legal identity" copy | Current nullifier/no-leak review and staging simulator evidence | May reduce bot/duplicate risk only; must not determine service eligibility alone |
| Passport or NFC document credential | Specific document-backed attribute explicitly selected in the reviewed credential, such as over-age threshold or document country, if supported by World ID policy | Full passport number, raw document image, legal identity blanket claims, immigration status, broad citizenship claims, unreviewed nationality use | Name the exact reviewed attribute, for example "age threshold credential"; do not say "identity verified" unless legal review approves it | Data minimization review, retention review, legal basis, export wording, support escalation path | Provider must document why the attribute is required and what fallback is available |
| Selfie or liveness check | Liveness/presence signal for a current session when documented by the credential policy | Legal identity, age, citizenship, address, document ownership, or eligibility | "Liveness check completed" or "session presence signal"; never "identity verified" | Biometric/liveness policy review, accessibility fallback review, deletion/retention review | Provider may use only as fraud-risk signal with non-biometric fallback |
| Identity Check preview or equivalent | Only the exact claims approved by privacy/legal/security review for the pilot | Any claim not listed in the approved policy, especially broad identity, citizenship, address, or eligibility claims | Claim-specific wording approved in the signoff packet | Full DPIA-style privacy review, legal/policy approval, support playbook, incident response | Provider eligibility use requires written policy, appeal path, and manual alternative |

Expansion checklist:

1. Create a separate World ID action per credential policy and workflow.
2. Confirm allowed claims and prohibited claims in the target signoff packet.
3. Update UI copy, API models, proof receipt labels, QR/export review, and
   Playwright no-overclaim tests before enabling the policy.
4. Add backend tests proving raw credential payloads, document identifiers,
   biometric material, Developer Portal responses, and PII are not exported.
5. Require provider policy approval and a manual fallback for any service
   eligibility use.
6. Keep proof-of-human as the default until the expanded policy has completed
   security, privacy, legal, accessibility, operations, and product signoff.

## Target User Flow

1. Client signs in through the current Abby flow and has a wallet API config.
2. Client opens Register, Wallet, Proof Center, or Security and chooses
   "Verify with World ID".
3. Browser asks the wallet API for a fresh RP signature for action
   `wallet-attach-world-id-v1`.
4. Browser opens IDKit using `@worldcoin/idkit` and the backend-provided
   `app_id`, `rp_context`, `action`, `signal`, environment, and credential
   policy.
5. Client approves in World App. IDKit returns a result payload to the browser.
6. Browser sends the IDKit result payload to the wallet API.
7. Backend verifies with World Developer Portal, checks action, environment,
   signal hash, nullifier replay, and wallet authority.
8. Backend creates or updates a wallet World ID binding and a sanitized
   `ProofReceipt`.
9. UI refreshes proof receipts and audit events, then shows the wallet as World
   ID verified.

## Privacy Model

World ID nullifiers are pseudonymous but still privacy-sensitive. Store them as
private wallet security state. Public proof receipts and QR bundles should
contain only:

- `proof_type`
- `credential_policy`
- `action`
- `rp_id`
- `app_id`
- `signal_hash`
- `nullifier_commitment`, computed with a server-side HMAC key or a wallet-local
  secret salt
- `verification_result_hash`
- `verified_at`
- verifier and protocol metadata

Private state may store:

- raw nullifier
- full Developer Portal verification response
- full IDKit result payload
- request nonce and RP signature metadata
- conflict/replay metadata

Default policy:

- One active World ID binding per wallet for `wallet-attach-world-id-v1`.
- One active wallet per nullifier for the same action.
- Repeating verification for the same wallet and same nullifier is idempotent.
- Reusing the same nullifier for a different wallet is rejected until an
  explicit unlink/transfer policy exists.

## Backend Design

### Configuration

Add backend env vars:

- `WORLD_ID_ENABLED=1`
- `WORLD_ID_ENVIRONMENT=staging|production`
- `WORLD_ID_APP_ID=app_...`
- `WORLD_ID_RP_ID=rp_...`
- `WORLD_ID_RP_SIGNING_KEY` or `WORLD_ID_RP_SIGNING_KEY_SECRET_REF`
- `WORLD_ID_VERIFY_BASE_URL=https://developer.world.org`
- `WORLD_ID_ALLOWED_ACTIONS=wallet-attach-world-id-v1`
- `WORLD_ID_DEFAULT_ACTION=wallet-attach-world-id-v1`
- `WORLD_ID_ALLOW_LEGACY_PROOFS=1`
- `WORLD_ID_REQUIRE_USER_PRESENCE=0|1`
- `WORLD_ID_RP_SIGNATURE_TTL_SECONDS=300`
- `WORLD_ID_NULLIFIER_HMAC_KEY` or
  `WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF`
- `WORLD_ID_HTTP_TIMEOUT_SECONDS=15`

Expose non-secret runtime config to the UI through either the existing runtime
config file or the API:

- enabled flag
- environment
- app id
- rp id
- default action
- credential policy
- `allow_legacy_proofs`
- `require_user_presence`

Never expose the RP signing key or nullifier HMAC key.

### New Backend Module

Create `wallet_interface/world_id.py` for:

- config loading and validation
- RP signature generation
- signal canonicalization and signal hashing
- Developer Portal verification HTTP client
- IDKit response sanitization
- nullifier extraction from v3 and v4 response shapes
- public proof receipt construction helpers

Implement RP signatures in Python and test against the official World ID test
vectors. Preferred dependencies:

- `eth-keys` or `coincurve` for secp256k1 signing
- `eth-utils` or `pycryptodome` Keccak for Keccak-256

If dependency risk is unacceptable, the fallback is a small internal Node
signing sidecar using `@worldcoin/idkit-core/signing`, but that adds runtime
complexity and should not be the first choice.

### API Routes

Add routes to `wallet_interface/api.py`:

#### `GET /wallets/{wallet_id}/world-id/config`

Returns public World ID configuration for the wallet.

Response:

```json
{
  "enabled": true,
  "environment": "staging",
  "app_id": "app_xxx",
  "rp_id": "rp_xxx",
  "default_action": "wallet-attach-world-id-v1",
  "credential_policy": "proof_of_human",
  "allow_legacy_proofs": true,
  "require_user_presence": false
}
```

#### `GET /wallets/{wallet_id}/world-id/status`

Returns sanitized binding status.

Response:

```json
{
  "verified": true,
  "binding_id": "worldid-binding-...",
  "proof_id": "proof-...",
  "action": "wallet-attach-world-id-v1",
  "credential_policy": "proof_of_human",
  "verified_at": "2026-06-13T00:00:00Z",
  "nullifier_commitment": "..."
}
```

#### `POST /wallets/{wallet_id}/world-id/rp-signature`

Creates a fresh signed RP context. Require `actor_did` to be a wallet principal
or a valid session actor for this wallet.

Request:

```json
{
  "actor_did": "did:key:...",
  "action": "wallet-attach-world-id-v1",
  "signal_context": "wallet_binding"
}
```

Response:

```json
{
  "app_id": "app_xxx",
  "action": "wallet-attach-world-id-v1",
  "signal": "211-ai:wallet-world-id:v1:<wallet_id>:<actor_did>",
  "environment": "staging",
  "allow_legacy_proofs": true,
  "require_user_presence": false,
  "rp_context": {
    "rp_id": "rp_xxx",
    "nonce": "0x...",
    "created_at": 1760000000,
    "expires_at": 1760000300,
    "signature": "0x..."
  }
}
```

#### `POST /wallets/{wallet_id}/world-id/verifications`

Verifies the IDKit result, enforces replay policy, creates the wallet binding,
and creates the proof receipt.

Request:

```json
{
  "actor_did": "did:key:...",
  "action": "wallet-attach-world-id-v1",
  "signal": "211-ai:wallet-world-id:v1:<wallet_id>:<actor_did>",
  "idkit_response": {}
}
```

Response:

```json
{
  "binding": {
    "binding_id": "worldid-binding-...",
    "wallet_id": "wallet-...",
    "action": "wallet-attach-world-id-v1",
    "credential_policy": "proof_of_human",
    "verified_at": "2026-06-13T00:00:00Z",
    "nullifier_commitment": "..."
  },
  "proof": {}
}
```

#### `POST /wallets/{wallet_id}/world-id/bindings/{binding_id}/revoke`

Post-MVP or admin-only initially. Revokes local trust in the binding. It cannot
erase a historical World ID verification from external systems, so the UI must
say "removed from this wallet" rather than "deleted from World ID".

### App Service Methods

Add methods to `WalletInterfaceService`:

- `world_id_config(wallet_id)`
- `world_id_status(wallet_id)`
- `create_world_id_rp_signature(wallet_id, actor_did, action, signal_context)`
- `verify_world_id_binding(wallet_id, actor_did, action, signal, idkit_response)`
- `revoke_world_id_binding(wallet_id, actor_did, binding_id)`

These methods should persist wallet snapshots when repository persistence is
configured, matching current proof and document behavior.

## Wallet Core Design

Add durable models to `ipfs_datasets_py.wallet.models`:

```python
@dataclass
class WorldIdBinding:
    binding_id: str
    wallet_id: str
    actor_did: str
    app_id: str
    rp_id: str
    action: str
    signal_hash: str
    credential_policy: str
    protocol_version: str
    environment: str
    nullifier: str
    nullifier_commitment: str
    verification_result_hash: str
    proof_id: str
    status: str = "active"
    created_at: str = field(default_factory=utc_now)
    revoked_at: str | None = None
```

Add wallet service indexes:

- `world_id_bindings: Dict[str, WorldIdBinding]`
- `world_id_nullifier_index: Dict[tuple[str, str, str], str]`
  keyed by `(rp_id, action, nullifier)`

Add service methods:

- `register_world_id_binding(...)`
- `get_world_id_bindings(wallet_id, include_inactive=False)`
- `revoke_world_id_binding(...)`

Binding registration must:

1. Confirm wallet exists.
2. Confirm actor is a wallet principal.
3. Confirm action is allowed.
4. Confirm signal binds to this wallet and actor.
5. Confirm nullifier replay policy.
6. Create or update a `WorldIdBinding`.
7. Create a `ProofReceipt` with `proof_type="world_id_proof_of_human"`.
8. Append an audit event with action `proof/world_id_bind`.
9. Add proof ID to wallet proof listings and export bundles.

Snapshot export/import must include `world_id_bindings`. Backward compatibility
must tolerate snapshots without the new key.

## Proof Receipt Shape

Use existing `ProofReceipt` rather than inventing a separate proof UI model.

Recommended public receipt:

```json
{
  "proof_type": "world_id_proof_of_human",
  "statement": {
    "claim": "wallet_actor_has_world_id_proof_of_human",
    "wallet_id": "wallet-...",
    "action": "wallet-attach-world-id-v1",
    "credential_policy": "proof_of_human"
  },
  "verifier_id": "world-developer-portal-v4:rp_...",
  "public_inputs": {
    "claim": "World ID proof of human is bound to this wallet",
    "rp_id": "rp_...",
    "app_id": "app_...",
    "action": "wallet-attach-world-id-v1",
    "signal_hash": "0x...",
    "credential_policy": "proof_of_human",
    "nullifier_commitment": "hmac-sha256:...",
    "verification_result_hash": "sha256:..."
  },
  "proof_system": "world_id_idkit_v4",
  "circuit_id": "world-id-proof-of-human-v4",
  "is_simulated": false,
  "verification_status": "verified"
}
```

The receipt should never include:

- raw nullifier
- full IDKit proof
- full Developer Portal response
- user PII
- RP signing key material

## Frontend Design

### Dependencies

Add to `wallet_interface/ui/package.json`:

- `@worldcoin/idkit`

Use React widgets or hooks from the current SDK. Prefer a headless hook or
controlled widget so the UI matches Abby's existing proof-center and wallet
layout.

### Wallet API Client

Extend `wallet_interface/ui/src/services/walletApi.ts` with:

- `WorldIdConfig`
- `WorldIdStatus`
- `WorldIdRpSignatureResponse`
- `WorldIdVerificationResponse`
- `loadWorldIdConfig(config)`
- `loadWorldIdStatus(config)`
- `createWorldIdRpSignature(config, action)`
- `verifyWorldIdProof(config, idkitResponse, action, signal)`

Map the returned proof through existing `toProofReceiptView`.

### UI Components

Create `wallet_interface/ui/src/components/world-id/WorldIdVerificationPanel.tsx`
or a similarly scoped component.

Responsibilities:

- Load config and status.
- Request a fresh RP signature immediately before opening IDKit.
- Use `IDKitRequestWidget` or `useIDKitRequest`.
- Select preset:
  - MVP: `proofOfHuman({ signal })` when available.
  - If we accept legacy fallback, set `allow_legacy_proofs=true`.
- Send `idkit_response` to the backend verification route in `handleVerify`.
- On success, refresh wallet proof receipts, audit events, and status.
- Render terminal states for cancellation, credential unavailable, RP signature
  expiry, nullifier replay, network errors, and backend verification failure.

Place the panel in:

- `ProofCenterScreen`: primary management surface.
- `Wallet`/uploads screen: status badge near file wallet proof bundle.
- `Register` screen: optional completion step after client profile setup.
- `Security` screen: verified-human status plus unlink/reverify action.

Use the existing proof card style for the resulting receipt. For dense badges,
use a small "human" World ID badge aligned with World ID design guidance.

### Login Flow

Do not replace current magic-link login in MVP. Add "verify after sign-in" first
because existing login/session code already resolves wallet config and actor
DID. A later login phase can add "Continue with World ID" once the binding and
recovery policy are proven durable.

## UI/UX Workflow Gap Review

The backend design and initial UI tasks cover the main routes and components,
but the workflow needs an explicit contract so parallel agents do not leave
World ID stranded as a backend-only feature. The UI implementation must prove
the following surfaces end to end:

- `ProofCenterScreen`: primary launch point, status, proof card, audit refresh,
  and retry/conflict messaging.
- `Wallet`/uploads: wallet status badge near file proof and QR/export actions.
- `Register`/client intake: optional completion step and bot-check replacement
  only when World ID is enabled, with a visible manual fallback.
- `Security`: verified-human status, local revoke/unlink language, and
  reverify action.
- QR proof review and export/import: sanitized World ID metadata appears, while
  raw nullifiers, IDKit proofs, RP signatures, Developer Portal responses, and
  user PII do not.

Add a workflow contract matrix before full-stack Playwright work. Each row
should name the surface, user intent, required backend routes, API error states,
required UI state transitions, privacy assertions, and desktop/mobile test
coverage. The matrix should also pin user-facing language: proof-of-human is not
legal identity, age, citizenship, or document possession.

Required UI states:

- feature disabled or missing public runtime config
- wallet API unavailable
- actor DID or wallet ID missing
- RP signature fetch pending, expired, or failed
- IDKit cancel/close
- credential unavailable
- backend verification failed
- same-wallet replay/idempotent success
- different-wallet nullifier conflict
- local revoke/unlink success
- verified status after proof/audit refresh

Do not rely only on route-level mocks. The final UI evidence must include a
full-stack Playwright harness that launches the Abby UI and a live wallet API
with mocked World Developer Portal verification, then exercises the browser
transport client against the actual FastAPI routes.

## Provider And Shelter Workflows

For client-side provider intake:

- Replace the current demo `captchaToken`/easy bot check with an optional World
  ID verification path when `WORLD_ID_ENABLED=1`.
- Keep a non-World-ID fallback for accessibility, device availability, and
  emergency service access.

For provider staff:

- Use a separate action such as `provider-staff-world-id-v1`.
- Do not mix client and staff nullifiers under one action.
- Staff verification should set staff account verification status only after
  operator policy confirms the provider organization and staff account.

For eligibility proofs:

- `world_id_proof_of_human` can support "unique human" or anti-duplication
  claims.
- It cannot support "US citizen", "minimum age", "passport holder", or "legal
  identity verified" until the chosen World ID credential proves those exact
  attributes and policy approves the wording.

## Security Controls

- Backend-generated RP signatures only.
- Fresh nonce per request.
- Short RP signature TTL, default 300 seconds.
- Server clock skew monitoring.
- Allowlist actions and reject unknown actions.
- Enforce expected `action`, `environment`, and `signal_hash`.
- Verify with Developer Portal from backend only.
- Store nullifiers as private security state.
- Use HMAC commitments for public nullifier references.
- Treat replay against the same wallet as idempotent and replay against another
  wallet as conflict.
- Redact IDKit proof payloads from logs.
- Add rate limits on RP signature and verification routes.
- Add audit events for request creation, verification success, replay, conflict,
  and revocation.
- Add production readiness checks for enabled World ID config, secret refs,
  staging/production environment mismatch, and successful verifier connectivity.

## Testing Plan

### Python Unit Tests

Add tests for:

- RP signature generation against official vectors.
- `hash_to_field` and signal hash compatibility.
- config validation and missing secret handling.
- action allowlist.
- nullifier extraction from legacy and v4 IDKit result shapes.
- public proof receipt sanitization.
- HMAC commitment stability and no raw nullifier leakage.

### Backend API Tests

Add tests in `tests/test_wallet_interface_api.py` or a dedicated
`tests/test_world_id_wallet_api.py`:

- config route hides secrets.
- RP signature route requires authorized actor.
- verification route forwards payload as-is to a mocked Developer Portal client.
- route response shapes and error codes match the TypeScript wallet API client.
- failed Developer Portal verification returns 400 and creates no binding.
- successful verification creates binding, proof receipt, and audit event.
- same nullifier/same wallet is idempotent.
- same nullifier/different wallet is rejected.
- snapshot save/load preserves binding.
- export bundle includes sanitized proof receipt but not raw nullifier.

### Frontend Tests

Add Playwright/unit coverage:

- World ID panel loads disabled state when feature is off.
- World ID panel fetches a fresh RP signature only when the user starts IDKit.
- IDKit result payload is passed to the backend verification route without
  client-side field remapping.
- Successful mocked IDKit flow refreshes proofs.
- Backend verification failure shows a retryable error.
- `nullifier_replayed` and credential-unavailable states are handled.
- Proof Center displays the World ID proof receipt without exposing raw
  nullifier.
- Mobile QR/invite-code display fits existing layouts.

### Full-Stack Playwright Tests

Add a dedicated Playwright suite that starts the real wallet API, configures a
mock World Developer Portal verification client, and drives the deployed Abby UI
against that API. It must cover:

- disabled config and missing actor/wallet guards.
- RP signature request, IDKit completion callback, backend verification, proof
  refresh, status refresh, and audit refresh.
- same-wallet replay/idempotency and different-wallet nullifier conflict.
- revoke/unlink flow wording and status refresh.
- QR proof bundle and export/import review with no raw nullifier, IDKit proof,
  RP signature, Developer Portal response, or user PII in visible UI or exported
  public metadata.
- desktop Chrome, mobile Chrome, and mobile Safari projects from the existing
  Playwright config.

### UX And Accessibility Regression Tests

Add Playwright evidence across Proof Center, Wallet/uploads, Register/intake,
Security, and QR proof review:

- no horizontal overflow or incoherent text overlap at mobile and desktop
  breakpoints.
- keyboard focus reaches the World ID controls and error/retry actions.
- accessible names describe the controls without overclaiming legal identity.
- manual fallback remains visible for emergency or essential-service workflows.
- screenshots or traces are archived for production signoff.

### Manual/Staging Tests

Use World ID staging and simulator before production:

1. Configure staging Developer Portal app and action.
2. Run local API with `WORLD_ID_ENVIRONMENT=staging`.
3. Verify a new wallet.
4. Retry same wallet to confirm idempotency.
5. Attempt a second wallet with same simulated identity to confirm conflict.
6. Save/load wallet snapshot.
7. Publish wallet proof QR and inspect proof-center import.

## Deployment And Operations

Update:

- `wallet_interface/deploy/env.local.mock.example`
- `wallet_interface/deploy/env.production.example`
- `wallet_interface/deploy/runtime-config.template.json`
- `wallet_interface/deploy/40-runtime-config.sh`
- Kubernetes `configmap.yaml` and `secrets.example.yaml`
- Docker API image dependencies
- ops health/readiness checks
- release check script if it has a wallet API smoke list

Production readiness should fail if:

- World ID is enabled but `WORLD_ID_RP_ID`, `WORLD_ID_APP_ID`, or signing secret
  is missing.
- `WORLD_ID_ENVIRONMENT=staging` in production.
- RP signature generation does not match test vectors.
- Developer Portal verify endpoint is unreachable.
- nullifier HMAC secret is missing.
- proof receipt sanitization test fails.

## Rollout Phases

### Phase 0: Policy And Developer Portal Setup

- Decide MVP credential: proof-of-human.
- Create Developer Portal app/action for staging.
- Enable World ID 4.0/RP registration.
- Store `app_id`, `rp_id`, and signing key in the target secret manager.
- Confirm fallback policy for clients without World App.

Deliverable: staging app credentials and approved action list.

### Phase 1: Backend Core

- Add `wallet_interface/world_id.py`.
- Add RP signature tests and verification client tests.
- Add API routes.
- Add app service methods.
- Add wallet models, snapshot import/export, and proof receipt creation.

Deliverable: API can create RP signatures and persist mocked verified bindings.

### Phase 2: UI Integration

- Add `@worldcoin/idkit`.
- Add wallet API client methods and TypeScript models.
- Add World ID verification panel.
- Add Proof Center and Wallet status badges.
- Add the UI/backend workflow contract matrix and shared Playwright fixtures.
- Add frontend tests with mocked IDKit responses.

Deliverable: users can complete a mocked or staging World ID flow in Abby.

### Phase 3: Wallet Proof And Export Integration

- Include sanitized World ID proof receipt in proof listings.
- Include sanitized receipt in wallet QR bundle and export bundles.
- Confirm proof QR review displays World ID proof correctly.
- Add no-raw-nullifier tests.

Deliverable: World ID proof travels with the file wallet as sanitized proof
metadata.

### Phase 4: Registration And Provider Workflow Integration

- Add optional verify step to client registration.
- Replace demo bot check with World ID status when enabled.
- Keep manual fallback.
- Add provider staff action only after client MVP is stable.

Deliverable: client intake can use World ID as a real anti-duplication proof.

### Phase 5: Production Hardening

- Add ops health checks.
- Add rate limits and structured redacted logs.
- Run full-stack Playwright World ID workflow coverage.
- Run UX/accessibility/no-leak Playwright review across all World ID surfaces.
- Run staging simulator checklist.
- Rotate test credentials into production credentials.
- Complete wallet target signoff packet.

Deliverable: production feature flag can be enabled for a pilot cohort.

## Open Decisions

1. Should one World ID be allowed to bind to more than one wallet? The proposed
   default is no for the MVP action.
2. Should raw nullifier ever be included in user exports? The proposed default
   is no unless an advanced export mode is approved.
3. Should World ID verification be mandatory for any service workflow? The
   proposed default is no; essential access needs a fallback path.
4. Which credential policies are acceptable for provider-facing eligibility
   claims? Proof-of-human is not enough for citizenship, age, or document
   possession claims.
5. Should unlink/transfer be self-service or staff/admin mediated? MVP can
   defer this behind support tooling.

## Implementation Checklist

- [ ] Create World ID Developer Portal staging app and action.
- [ ] Add backend env config and secret refs.
- [ ] Implement RP signature generation with vector tests.
- [ ] Implement Developer Portal verify client.
- [ ] Add wallet core binding model and nullifier index.
- [ ] Add FastAPI routes for config, status, signature, verify, revoke.
- [ ] Add proof receipt creation and audit events.
- [ ] Persist bindings in snapshots and sanitized exports.
- [ ] Add UI API client methods.
- [ ] Add World ID verification panel.
- [ ] Add Proof Center, Wallet, Register, and Security integration.
- [ ] Add frontend mocked IDKit tests.
- [ ] Add UI/backend workflow matrix and shared World ID test fixtures.
- [ ] Add full-stack Playwright coverage against live wallet API routes.
- [ ] Add UX/accessibility/no-leak Playwright evidence across World ID surfaces.
- [ ] Add staging simulator runbook.
- [ ] Add ops readiness checks.
- [ ] Complete production signoff before enabling production credentials.
