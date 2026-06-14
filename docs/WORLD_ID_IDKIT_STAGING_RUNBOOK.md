# World ID IDKit Staging Simulator Runbook

Status: required before pilot or production World ID enablement.

Date: 2026-06-14

This runbook verifies that a staging World ID proof-of-human can be attached to
an Abby file wallet, persisted, reviewed in proof/export surfaces, and rejected
when the same nullifier is used by a different wallet. It is a staging evidence
procedure, not a production launch approval by itself.

## Prerequisites

- World Developer Portal staging app for Abby wallet binding.
- Staging action: `wallet-attach-world-id-v1`.
- Staging relying-party id and app id recorded in the target signoff packet.
- RP signing key and nullifier commitment HMAC key available to the wallet API
  from the target secret manager.
- `@worldcoin/idkit` installed in `wallet_interface/ui`.
- Local browser access to the World ID staging simulator or a staging World App
  account approved for proof-of-human simulator testing.
- Empty throwaway wallet repository and encrypted blob store for this run.

Do not record raw nullifiers, IDKit proofs, RP signatures, Developer Portal
responses, legal names, phone numbers, email addresses, or precise addresses in
screenshots, logs, or signoff packets.

## Developer Portal Setup

Record the following values in the environment evidence system, not in this
repo:

| Setting | Required value |
| --- | --- |
| Environment | Staging |
| App id | `app_...` from the staging app |
| RP id | `rp_...` from the staging relying party |
| Action | `wallet-attach-world-id-v1` |
| Credential policy | Proof of human |
| Verify endpoint | Staging Developer Portal verify endpoint |
| Allowed origins | Local UI origin and staging UI origin |
| Secret refs | RP signing key and nullifier HMAC key secret-manager paths |

Confirm the Portal action, app id, and RP id match the values returned by:

```bash
curl -fsS "${WALLET_API_ORIGIN}/wallets/${WALLET_ID}/world-id/config"
```

The config response must not contain signing secrets or nullifier HMAC material.

## Local Environment

Use a throwaway repository and storage root:

```bash
export WALLET_REPOSITORY_ROOT="$(pwd)/tmp/world-id-staging-wallet-repo"
export WALLET_STORAGE_CONFIG='{"primary":{"type":"local","root":"tmp/world-id-staging-wallet-blobs"}}'
export WALLET_AUTO_LOAD_REPOSITORY=true
export WALLET_AUTO_PERSIST=true
export WALLET_API_CORS_ORIGINS="http://127.0.0.1:${PLAYWRIGHT_PORT:-5174}"

export WORLD_ID_ENABLED=1
export WORLD_ID_ENVIRONMENT=staging
export WORLD_ID_APP_ID="app_replace_with_staging_app_id"
export WORLD_ID_RP_ID="rp_replace_with_staging_rp_id"
export WORLD_ID_ALLOWED_ACTIONS="wallet-attach-world-id-v1,provider-staff-world-id-v1"
export WORLD_ID_DEFAULT_ACTION="wallet-attach-world-id-v1"
export WORLD_ID_VERIFY_BASE_URL="https://developer.world.org"
export WORLD_ID_ALLOW_LEGACY_PROOFS=false
export WORLD_ID_REQUIRE_USER_PRESENCE=true
export WORLD_ID_RP_SIGNATURE_TTL_SECONDS=300
export WORLD_ID_RP_SIGNING_KEY_SECRET_REF="secret://staging/wallet/world-id-rp-signing"
export WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF="secret://staging/wallet/world-id-nullifier"
```

The API process also needs the resolved secret values at runtime. Inject them
from the target secret manager into the process environment or equivalent
runtime secret mount:

```bash
export WORLD_ID_RP_SIGNING_KEY="0x..."
export WORLD_ID_NULLIFIER_HMAC_KEY="..."
```

Start the API and UI:

```bash
python -m uvicorn wallet_interface.asgi:app --host 127.0.0.1 --port 8787
PLAYWRIGHT_PORT=5174 npm --prefix wallet_interface/ui run dev -- --host 127.0.0.1 --port 5174
```

Open:

```text
http://127.0.0.1:5174/?walletApiBaseUrl=http://127.0.0.1:8787&walletId=wallet-world-id-staging&actorDid=did:key:staging-owner#/proof-center
```

## Simulator Procedure

1. Create or open `wallet-world-id-staging` with actor DID
   `did:key:staging-owner`.
2. Open Proof Center.
3. Confirm World ID status is unverified and the copy says proof-of-human is
   not legal identity.
4. Select `Verify with World ID`.
5. Complete the staging simulator or approved staging World App flow.
6. Confirm the UI returns to the wallet and shows `World ID verified`.
7. Confirm proof list contains a `world_id_proof_of_human` receipt with:
   - `proof_system=world_id_idkit_v4`
   - `verification_status=verified`
   - `nullifier_commitment` in public inputs
   - no raw nullifier, IDKit proof, RP signature, or Developer Portal response
8. Save a wallet snapshot.
9. Reload the wallet from the snapshot and confirm the binding and proof receipt
   are still present.

Recommended command coverage:

```bash
python -m pytest tests/test_world_id_wallet_api.py tests/test_wallet_interface_api.py -q
PLAYWRIGHT_PORT=5601 npm --prefix wallet_interface/ui test -- tests/world-id-fullstack.spec.ts
PLAYWRIGHT_PORT=5602 npm --prefix wallet_interface/ui test -- tests/world-id-ux.spec.ts
```

## Same-Wallet Retry

Repeat the verification flow from the same wallet and actor DID with the same
staging simulator identity.

Expected result:

- The backend treats the existing active binding as idempotent for the same
  wallet and action.
- The UI remains verified.
- Audit evidence records a retry or existing-binding event without exposing the
  raw nullifier.

Archive:

- API response body with private fields redacted.
- Wallet status after retry.
- Screenshot of the verified Proof Center state.

## Different-Wallet Conflict

Open a second throwaway wallet:

```text
http://127.0.0.1:5174/?walletApiBaseUrl=http://127.0.0.1:8787&walletId=wallet-world-id-conflict&actorDid=did:key:staging-owner#/proof-center
```

Use the same staging simulator identity.

Expected result:

- Backend returns a conflict for the active nullifier commitment.
- The second wallet is not marked verified.
- UI copy says the proof is already bound to another wallet or active wallet
  binding.
- No response displays the raw nullifier or other wallet PII.

Archive:

- Redacted 409 response or Playwright trace.
- Screenshot of the sanitized conflict message.
- Audit event showing denied conflict without private proof material.

## Snapshot Save And Load

After successful verification:

1. Save the wallet snapshot through the UI or API.
2. Restart the API using the same `WALLET_REPOSITORY_ROOT`.
3. Reload the wallet route.
4. Confirm:
   - `world_id_bindings` are restored.
   - active binding count is correct.
   - proof receipt remains in `/proofs`.
   - exported snapshot text does not contain raw nullifier, IDKit proof, RP
     signature, Developer Portal response, or PII.

Recommended API checks:

```bash
curl -fsS "${WALLET_API_ORIGIN}/wallets/${WALLET_ID}/world-id/status?actor_did=${ACTOR_DID}"
curl -fsS "${WALLET_API_ORIGIN}/wallets/${WALLET_ID}/proofs?actor_did=${ACTOR_DID}"
```

## QR Proof And Export Review

Open the export route:

```text
http://127.0.0.1:5174/?walletApiBaseUrl=http://127.0.0.1:8787&walletId=wallet-world-id-staging&actorDid=did:key:staging-owner#/exports
```

Confirm:

- QR proof review displays `World ID proof of human is bound to this wallet`.
- Proof card shows `world_id_idkit_v4`, verifier id, and verification status.
- Export/import review includes public proof metadata and public commitments
  only.
- No visible text, download metadata, QR payload, or export review contains raw
  nullifier, IDKit proof, RP signature, Developer Portal response, or PII.

Archive desktop and mobile screenshots or traces. The repository-maintained
baseline evidence lives under:

```text
artifacts/world-id-idkit-ui-review/
```

## Production Readiness Evidence

Before enabling `WORLD_ID_ENVIRONMENT=production`, archive these references in
the target signoff packet:

| Evidence | Required artifact |
| --- | --- |
| Staging simulator success | Proof Center verified screenshot or Playwright trace |
| Same-wallet retry | Redacted status/audit evidence |
| Different-wallet conflict | Redacted 409 response and UI conflict screenshot |
| Snapshot save/load | Snapshot reload output and proof list output |
| QR/export review | Desktop/mobile screenshot or trace with no-leak assertion |
| Backend regression | `tests/test_world_id_wallet_api.py tests/test_wallet_interface_api.py` output |
| Full-stack regression | `tests/world-id-fullstack.spec.ts` output |
| UX/accessibility review | `tests/world-id-ux.spec.ts` output and artifact directory |
| Readiness gate | `python -m wallet_interface.ops --validate-production-readiness` report |

The readiness report must include `world_id_environment`,
`world_id_secret_references`, `world_id_rp_signature_vector`,
`world_id_verify_endpoint`, and `world_id_proof_sanitization` checks. A launch
packet is not complete until those checks are `ok` in the target environment.
