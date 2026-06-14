# World ID IDKit UI Workflow Matrix

This matrix connects the World ID backend routes, TypeScript wallet API client,
visible UI workflows, and Playwright coverage that must stay aligned as IDKit is
integrated across Abby surfaces.

## Shared Contract

| Boundary | Contract |
| --- | --- |
| Backend config | `GET /wallets/{wallet_id}/world-id/config` returns enabled state, `app_id`, `rp_id`, environment, action allowlist, credential policy, legacy proof policy, user-presence policy, and non-secret operational hints. |
| Wallet status | `GET /wallets/{wallet_id}/world-id/status?actor_did=...` returns private wallet binding counts and sanitized binding records for authorized wallet actors only. |
| RP signature | `POST /wallets/{wallet_id}/world-id/rp-signature` returns the relying-party action, nonce, expiry, RP id, and signature needed by IDKit. |
| Verification | `POST /wallets/{wallet_id}/world-id/verifications` accepts the raw IDKit payload only over the private API boundary, then returns a sanitized binding, proof receipt, and Developer Portal result. |
| Revoke | `POST /wallets/{wallet_id}/world-id/bindings/{binding_id}/revoke` revokes an active binding and refreshes wallet status. |
| Proof/export review | Wallet proof list, QR proof import, and export import views must display only sanitized proof metadata and public commitments. |

## Workflow Matrix

| Workflow | Backend Routes | TypeScript API Calls | Expected UI States | Error And Fallback Copy | Privacy Assertions | Playwright Coverage |
| --- | --- | --- | --- | --- | --- | --- |
| Proof Center verification | Config, status, RP signature, verification, proofs, revoke | `loadWalletWorldIdConfig`, `loadWalletWorldIdStatus`, `createWalletWorldIdRpSignature`, `registerWalletWorldIdVerification`, `revokeWalletWorldIdBinding`, `listWalletProofs` | Unavailable, unverified, verifying, verified, revoke pending, revoked | Disabled config: "World ID is not available"; signature or verify failure: "Verification could not be completed"; conflict: "already bound to another wallet" | No raw nullifier, IDKit proof, RP signature, Developer Portal response, or PII appears in panel, proof card, logs, or route error text | `world-id.spec.ts`; `world-id-fullstack.spec.ts` |
| Wallet uploads | Config, status, proofs, records | `loadWalletWorldIdConfig`, `loadWalletWorldIdStatus`, `listWalletProofs`, `listWalletDocuments` | Upload guidance shows World ID verified/unverified status without blocking manual document upload | Missing actor DID hides launch action and keeps manual upload available | Uploaded-document summaries can reference proof-of-human status but never expose nullifier/proof material | `smoke.spec.ts`; `world-id-ux.spec.ts` |
| Register and intake | Config, status, provider staff RP signature where applicable | `loadWalletWorldIdConfig`, `loadWalletWorldIdStatus`, `createWalletWorldIdRpSignature` or provider-staff equivalent | Intake checklist marks proof-of-human as satisfying bot check when verified; assisted intake shows provider-staff action separately | Disabled or unverified World ID keeps manual fallback available | Intake form fields and staff verification cards do not echo raw IDKit payloads or wallet-private nullifier refs | `smoke.spec.ts`; `world-id-ux.spec.ts` |
| Security surface | Status, revoke, audit | `loadWalletWorldIdStatus`, `revokeWalletWorldIdBinding`, `listWalletAuditEvents` | Active binding count, credential policy, last verified time, revoke action, audit trail | Unauthorized revoke reports a sanitized authorization error; revoked state offers reverify path | Audit rows show binding/proof ids and reasons only, not raw nullifiers or portal responses | `smoke.spec.ts`; `wallet-ux-review.spec.ts` |
| QR proof review | Proofs, imported QR proof bundle | `listWalletProofs`, QR proof review helpers | Imported proof displays proof type, verifier, status, proof system, public inputs, and sanitized artifact refs | Invalid QR proof shows schema/hash failure without raw witness details | QR payload and rendered review omit IDKit proof, RP signature, raw nullifier, Developer Portal response, and user PII | `fullstack-wallet.spec.ts`; `world-id-fullstack.spec.ts` |
| Export/import | Export bundle create, verify, storage verify, import encrypted descriptor | Export helpers plus `listWalletProofs` | Export review includes sanitized World ID proof receipt and storage health | Verification or storage failure marks the bundle unsafe to import until resolved | Bundle JSON, import preview, and export receipts include public commitments only | `fullstack-wallet.spec.ts`; `world-id-fullstack.spec.ts` |

## Fixture Requirements

`wallet_interface/ui/tests/fixtures/world-id-fixtures.ts` is the shared source of
deterministic World ID payloads for mocked and full-stack Playwright tests. It
must provide:

- Config fixtures for enabled, disabled, and missing app id states.
- Status fixtures for unverified, verified, conflict, and revoked wallets.
- RP signature fixtures with deterministic nonce, action, expiry, and signature sentinel.
- IDKit completion fixtures with raw private sentinels reserved for backend-only requests.
- Verification, proof receipt, revoke, QR, export, and conflict payloads that are sanitized.
- A single forbidden-token list that Playwright tests can assert against visible UI text, exported JSON, QR review text, and error messages.

## No-Leak Sentinel Policy

The following token classes are intentionally private and must never appear in
visible UI, public proof receipts, QR review payloads, export bundle review, or
frontend logs:

- Raw nullifier and legacy nullifier hash values.
- IDKit proof strings and Merkle root values.
- RP signatures, RP signing nonces outside the launch request context, and raw signed messages.
- Raw Developer Portal verification response bodies.
- User PII used to build the signal, including legal name, phone, email, and precise address.

Tests should use the fixture module's forbidden token list so new workflows are
checked consistently rather than each spec inventing its own sentinel strings.
