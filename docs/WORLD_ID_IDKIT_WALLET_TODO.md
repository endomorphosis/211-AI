# World ID IDKit Wallet Todo

This backlog is the executable implementation queue for
`docs/WORLD_ID_IDKIT_WALLET_IMPLEMENTATION_PLAN.md`.

The wallet implementation daemon can consume this file with a custom task
prefix:

```bash
python scripts/wallet_implementation_daemon.py \
  --once \
  --no-implement \
  --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md \
  --task-prefix "## WORLDID-" \
  --state-dir data/world_id_implementation/state \
  --state-prefix worldid
```

Supervisor example:

```bash
python scripts/wallet_implementation_supervisor.py \
  --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md \
  --task-prefix "## WORLDID-" \
  --state-dir data/world_id_implementation/state \
  --state-prefix worldid \
  --no-implement
```

Priority guide:

- `P0`: foundation, safety, or MVP blocker work
- `P1`: user-visible wallet, proof, test, or deployment work
- `P2`: post-MVP hardening or provider/staff expansion
- `P3`: polish or optional refinement

Track guide:

- `ops`: configuration, deployment, readiness, staging, signoff
- `proofs`: IDKit, RP signatures, verification, proof receipt boundaries
- `core`: canonical `ipfs_datasets_py.wallet` models and snapshot behavior
- `wallet`: `wallet_interface` service and FastAPI orchestration
- `ui`: Abby React app, wallet API client, proof-center workflows
- `privacy`: nullifier handling, sanitization, public export boundaries
- `quality`: unit, API, Playwright, and staging test harnesses

## WORLDID-000 Plan And Executable Backlog
- Status: completed
- Completion: artifact
- Priority: P0
- Track: ops
- Depends on: none
- Outputs: docs/WORLD_ID_IDKIT_WALLET_IMPLEMENTATION_PLAN.md, docs/WORLD_ID_IDKIT_WALLET_TODO.md
- Validation: python scripts/wallet_implementation_daemon.py --once --no-implement --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md --task-prefix "## WORLDID-" --state-dir data/world_id_implementation/state --state-prefix worldid
- Acceptance: The World ID implementation plan and daemon-consumable backlog exist, use stable WORLDID task IDs, and can be parsed by the shared implementation daemon without source mutations.

## WORLDID-010 Backend World ID Configuration Boundary
- Status: completed
- Completion: evidence
- Priority: P0
- Track: ops
- Depends on: WORLDID-000
- Outputs: wallet_interface/world_id.py, tests/test_world_id_wallet.py
- Validation: pytest tests/test_world_id_wallet.py -q
- Acceptance: World ID backend configuration loads enabled state, environment, app ID, RP ID, action allowlist, signature TTL, legacy-proof policy, user-presence policy, verify base URL, timeout, and secret references while rejecting missing or client-exposed signing/nullifier secrets.

## WORLDID-020 RP Signature Generation And Hashing
- Status: completed
- Completion: evidence
- Priority: P0
- Track: proofs
- Depends on: WORLDID-010
- Outputs: wallet_interface/world_id.py, tests/test_world_id_wallet.py, requirements.txt
- Validation: pytest tests/test_world_id_wallet.py -q
- Acceptance: Backend RP signature generation implements World ID 4.x `hash_to_field`, signed message construction, Keccak-256 hashing, secp256k1 EIP-191 signatures, fresh nonces, TTL handling, and official test-vector coverage without exposing the RP signing key.

## WORLDID-030 Developer Portal Verification Client
- Status: completed
- Completion: evidence
- Priority: P0
- Track: proofs
- Depends on: WORLDID-010
- Outputs: wallet_interface/world_id.py, tests/test_world_id_wallet.py
- Validation: pytest tests/test_world_id_wallet.py -q
- Acceptance: The backend verification client forwards the IDKit result payload as-is to `/api/v4/verify/{rp_id}`, supports staging and production base URLs, enforces timeout/error handling, redacts proof payloads from exceptions/logs, and returns a normalized verification result.

## WORLDID-040 IDKit Response Normalization
- Status: completed
- Completion: evidence
- Priority: P0
- Track: proofs
- Depends on: WORLDID-010
- Outputs: wallet_interface/world_id.py, tests/test_world_id_wallet.py
- Validation: pytest tests/test_world_id_wallet.py -q
- Acceptance: IDKit response parsing extracts action, protocol version, environment, signal hash, credential identifiers, nullifier values, and verification timestamps from supported v3 legacy and v4 result shapes while rejecting malformed or unsupported responses.

## WORLDID-050 World ID Binding Wallet Model
- Status: completed
- Completion: evidence
- Priority: P0
- Track: core
- Depends on: WORLDID-000
- Outputs: ipfs_datasets_py/ipfs_datasets_py/wallet/models.py, ipfs_datasets_py/ipfs_datasets_py/wallet/service.py, ipfs_datasets_py/tests/unit/test_data_wallet.py
- Validation: pytest ipfs_datasets_py/tests/unit/test_data_wallet.py -q
- Acceptance: `ipfs_datasets_py.wallet` has a durable `WorldIdBinding` model, in-memory indexes for wallet bindings and nullifier lookups, import/export snapshot compatibility for the new binding list, and backward-compatible snapshot loading for wallets without World ID fields.

## WORLDID-060 Nullifier Privacy And Replay Policy
- Status: completed
- Completion: evidence
- Priority: P0
- Track: privacy
- Depends on: WORLDID-050
- Outputs: ipfs_datasets_py/ipfs_datasets_py/wallet/service.py, ipfs_datasets_py/tests/unit/test_data_wallet.py
- Validation: pytest ipfs_datasets_py/tests/unit/test_data_wallet.py -q
- Acceptance: Raw nullifiers are stored only in private wallet security state, public nullifier references are HMAC or wallet-secret commitments, same-wallet repeats are idempotent, different-wallet reuse is rejected, and tests prove raw nullifiers do not appear in public binding/proof/export dictionaries.

## WORLDID-070 World ID Proof Receipt Construction
- Status: completed
- Completion: evidence
- Priority: P0
- Track: proofs
- Depends on: WORLDID-050, WORLDID-060
- Outputs: ipfs_datasets_py/ipfs_datasets_py/wallet/service.py, ipfs_datasets_py/tests/unit/test_data_wallet.py
- Validation: pytest ipfs_datasets_py/tests/unit/test_data_wallet.py -q
- Acceptance: Registering a verified binding creates a `ProofReceipt` with `proof_type=world_id_proof_of_human`, `proof_system=world_id_idkit_v4`, sanitized public inputs, verifier metadata, no raw IDKit proof or nullifier, and an auditable `proof/world_id_bind` event.

## WORLDID-080 Wallet Interface Service Methods
- Status: completed
- Completion: evidence
- Priority: P0
- Track: wallet
- Depends on: WORLDID-020, WORLDID-030, WORLDID-040, WORLDID-070
- Outputs: wallet_interface/app_service.py, wallet_interface/world_id.py, tests/test_world_id_wallet_api.py
- Validation: pytest tests/test_world_id_wallet_api.py -q
- Acceptance: `WalletInterfaceService` exposes World ID config, status, RP signature creation, verification/binding registration, and local revocation helpers, persists configured wallet snapshots after successful mutations, and preserves the existing wallet authorization boundary.

## WORLDID-090 FastAPI World ID Routes
- Status: completed
- Completion: evidence
- Priority: P0
- Track: wallet
- Depends on: WORLDID-080
- Outputs: wallet_interface/api.py, tests/test_world_id_wallet_api.py
- Validation: pytest tests/test_world_id_wallet_api.py tests/test_wallet_interface_api.py -q
- Acceptance: FastAPI exposes `/wallets/{wallet_id}/world-id/config`, `/status`, `/rp-signature`, `/verifications`, and a guarded revoke route with request/response models, actor authorization checks, secret redaction, replay/conflict errors, and proof/audit refresh behavior.

## WORLDID-100 Deployment And Runtime Configuration Wiring
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ops
- Depends on: WORLDID-010
- Outputs: wallet_interface/deploy/env.local.mock.example, wallet_interface/deploy/env.production.example, wallet_interface/deploy/runtime-config.template.json, wallet_interface/deploy/40-runtime-config.sh, wallet_interface/deploy/kubernetes/configmap.yaml, wallet_interface/deploy/kubernetes/secrets.example.yaml
- Validation: python wallet_interface/deploy/smoke_local_mock_stack.py --help; pytest tests/test_world_id_wallet_api.py -q
- Acceptance: Local, Docker, and Kubernetes deployment examples document World ID public config, secret references, staging/production environment selection, nullifier commitment key requirements, and runtime UI flags without placing secrets in public runtime config.

## WORLDID-110 TypeScript Wallet API Client
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: WORLDID-090
- Outputs: wallet_interface/ui/src/services/walletApi.ts, wallet_interface/ui/tests/agent-unit.spec.ts
- Validation: npm --prefix wallet_interface/ui run build
- Acceptance: The UI wallet API client defines World ID config/status/signature/verification types, fetches all new routes, maps returned proof receipts through the existing proof receipt view mapper, and surfaces typed errors for disabled, replayed, conflict, expired, and verification-failed states.

## WORLDID-120 IDKit Dependency And UI Runtime Guard
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: WORLDID-100
- Outputs: wallet_interface/ui/package.json, wallet_interface/ui/package-lock.json, wallet_interface/ui/src/lib/runtimeConfig.ts, wallet_interface/ui/src/vite-env.d.ts
- Validation: npm --prefix wallet_interface/ui ci; npm --prefix wallet_interface/ui run build
- Acceptance: `@worldcoin/idkit` is installed, runtime config exposes only public World ID settings, builds remain deterministic, and the UI renders a disabled/fallback World ID state when the backend feature flag is off.

## WORLDID-130 World ID Verification Panel
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: WORLDID-110, WORLDID-120
- Outputs: wallet_interface/ui/src/components/world-id/WorldIdVerificationPanel.tsx, wallet_interface/ui/src/app/App.tsx, wallet_interface/ui/src/styles/global.css
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/agent-unit.spec.ts
- Acceptance: A reusable React panel requests a fresh RP signature immediately before opening IDKit, starts the configured proof-of-human flow, sends the IDKit result to backend verification, refreshes proof/audit/status state on success, and handles cancellation, credential unavailable, RP expiry, replay, and backend failure states.

## WORLDID-140 Proof Center Integration
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: WORLDID-130
- Outputs: wallet_interface/ui/src/app/App.tsx, wallet_interface/ui/src/styles/global.css, wallet_interface/ui/tests/smoke.spec.ts
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
- Acceptance: Proof Center shows World ID wallet status, launches verification, displays the `world_id_proof_of_human` receipt through the existing proof card, and makes clear that proof-of-human does not disclose or prove legal identity attributes.

## WORLDID-150 Wallet, Register, And Security Status Surfaces
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: WORLDID-130
- Outputs: wallet_interface/ui/src/app/App.tsx, wallet_interface/ui/src/styles/global.css, wallet_interface/ui/tests/smoke.spec.ts
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
- Acceptance: Wallet/uploads, Register, and Security surfaces display consistent World ID verified/unverified state, offer verification only when wallet API config and actor DID are available, and avoid blocking emergency or essential-service flows when World ID is unavailable.

## WORLDID-160 Public Proof Bundle And Export Sanitization
- Status: completed
- Completion: evidence
- Priority: P1
- Track: privacy
- Depends on: WORLDID-070, WORLDID-140
- Outputs: wallet_interface/ui/src/services/walletProofReview.ts, ipfs_datasets_py/ipfs_datasets_py/wallet/service.py, tests/test_world_id_wallet_api.py, wallet_interface/ui/tests/fullstack-wallet.spec.ts
- Validation: pytest tests/test_world_id_wallet_api.py -q; npm --prefix wallet_interface/ui test -- tests/fullstack-wallet.spec.ts
- Acceptance: Wallet QR proof bundles and encrypted export bundles include sanitized World ID proof metadata while excluding raw nullifiers, IDKit proofs, Developer Portal responses, RP signatures, and user PII; imported QR review displays the sanitized World ID proof correctly.

## WORLDID-170 Backend API Regression Tests
- Status: completed
- Completion: evidence
- Priority: P1
- Track: quality
- Depends on: WORLDID-090, WORLDID-160
- Outputs: tests/test_world_id_wallet_api.py, tests/test_wallet_interface_api.py
- Validation: pytest tests/test_world_id_wallet_api.py tests/test_wallet_interface_api.py -q
- Acceptance: API tests cover disabled config, signature authorization, mocked Developer Portal success/failure, action and signal enforcement, route response/error shapes consumed by the TypeScript wallet API client, idempotent same-wallet replay, different-wallet conflict, proof/audit creation, snapshot save/load, and sanitized export behavior.

## WORLDID-180 Frontend Mocked IDKit Tests
- Status: completed
- Completion: evidence
- Priority: P1
- Track: quality
- Depends on: WORLDID-140, WORLDID-150
- Outputs: wallet_interface/ui/tests/world-id.spec.ts, wallet_interface/ui/tests/smoke.spec.ts, wallet_interface/ui/tests/fullstack-wallet.spec.ts
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/world-id.spec.ts; npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
- Acceptance: Playwright tests mock IDKit and wallet API responses to verify disabled state, successful verification, proof refresh, backend failure, nullifier conflict messaging, mobile layout, and no raw nullifier exposure in visible UI.

## WORLDID-181 UI Workflow Contract Matrix And Fixtures
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: WORLDID-150, WORLDID-170
- Outputs: docs/WORLD_ID_IDKIT_UI_WORKFLOW_MATRIX.md, wallet_interface/ui/tests/fixtures/world-id-fixtures.ts
- Validation: python scripts/wallet_implementation_daemon.py --once --no-implement --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md --task-prefix "## WORLDID-" --state-dir data/world_id_implementation/state --state-prefix worldid; npm --prefix wallet_interface/ui run build
- Acceptance: A workflow matrix maps Proof Center, Wallet/uploads, Register/intake, Security, QR proof review, and export/import journeys to backend routes, TypeScript API calls, user-visible states, error/fallback copy, privacy no-leak assertions, and desktop/mobile Playwright coverage; shared fixtures provide deterministic IDKit, RP signature, status, proof receipt, conflict, revoke, and sanitizer sentinel payloads.

## WORLDID-182 Full-Stack World ID Playwright Harness
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: WORLDID-170, WORLDID-180, WORLDID-181
- Outputs: wallet_interface/ui/tests/world-id-fullstack.spec.ts, wallet_interface/ui/tests/fixtures/world-id-fixtures.ts
- Validation: pytest tests/test_world_id_wallet_api.py tests/test_wallet_interface_api.py -q; npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/world-id-fullstack.spec.ts
- Acceptance: Playwright launches the real Abby UI and live wallet API with a mocked World Developer Portal verification path, then verifies disabled/missing-config guards, RP signature creation, IDKit completion, backend verification, proof/status/audit refresh, same-wallet idempotent replay, different-wallet nullifier conflict, revoke/status refresh, and sanitized QR/export review without exposing raw nullifiers, IDKit proofs, RP signatures, Developer Portal responses, or PII.

## WORLDID-183 Cross-Surface UX Accessibility And No-Leak Review
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: WORLDID-182, WORLDID-210
- Outputs: wallet_interface/ui/tests/world-id-ux.spec.ts, wallet_interface/ui/tests/wallet-ux-review.spec.ts, artifacts/world-id-idkit-ui-review
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/world-id-ux.spec.ts; npm --prefix wallet_interface/ui test -- tests/wallet-ux-review.spec.ts
- Acceptance: Desktop Chrome, Mobile Chrome, and Mobile Safari Playwright coverage proves World ID controls across Proof Center, Wallet/uploads, Register/intake, Security, and QR proof review have keyboard focus, accessible names, no horizontal overflow or incoherent text overlap, visible fallback paths for emergency/essential access, no legal-identity overclaiming, and archived screenshot or trace evidence for signoff.

## WORLDID-190 Ops Health And Production Readiness Checks
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ops
- Depends on: WORLDID-090, WORLDID-170, WORLDID-182
- Outputs: wallet_interface/ops.py, tests/test_wallet_interface_ops.py, docs/WALLET_TARGET_PRODUCTION_SIGNOFF.md
- Validation: pytest tests/test_wallet_interface_ops.py tests/test_world_id_wallet_api.py -q; python -m wallet_interface.ops --validate-production-readiness
- Acceptance: Ops readiness fails when World ID is enabled without app/RP IDs, signing secret refs, nullifier commitment secret refs, vector-tested RP signing, production verify endpoint reachability, production environment selection, or proof sanitization evidence.

## WORLDID-200 Staging Simulator Runbook
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ops
- Depends on: WORLDID-182, WORLDID-190
- Outputs: docs/WORLD_ID_IDKIT_STAGING_RUNBOOK.md, docs/WALLET_TARGET_PRODUCTION_SIGNOFF.md
- Validation: python scripts/wallet_implementation_daemon.py --once --no-implement --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md --task-prefix "## WORLDID-" --state-dir data/world_id_implementation/state --state-prefix worldid
- Acceptance: A staging runbook documents Developer Portal setup, simulator use, local env, successful verification, same-wallet retry, different-wallet conflict, snapshot save/load, QR proof review, and evidence expected for signoff.

## WORLDID-210 Client Intake Bot-Check Replacement
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ui
- Depends on: WORLDID-150, WORLDID-180
- Outputs: wallet_interface/ui/src/app/App.tsx, wallet_interface/ui/tests/smoke.spec.ts, wallet_interface/ui/tests/fullstack-wallet.spec.ts
- Validation: npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts; npm --prefix wallet_interface/ui test -- tests/fullstack-wallet.spec.ts
- Acceptance: Client registration/intake can use World ID verified status instead of the demo captcha/easy-bot check when enabled, while preserving an explicit manual fallback path for accessibility, device availability, and emergency service access.

## WORLDID-220 Provider Staff Verification Action
- Status: completed
- Completion: evidence
- Priority: P2
- Track: ui
- Depends on: WORLDID-210
- Outputs: wallet_interface/ui/src/app/App.tsx, wallet_interface/api.py, tests/test_world_id_wallet_api.py, wallet_interface/ui/tests/smoke.spec.ts
- Validation: pytest tests/test_world_id_wallet_api.py -q; npm --prefix wallet_interface/ui run build; npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
- Acceptance: Provider staff verification uses a separate action such as `provider-staff-world-id-v1`, does not mix staff and client nullifiers, and updates staff verification state only after provider organization policy checks pass.

## WORLDID-230 World ID Assisted Login And Recovery Design
- Status: completed
- Completion: evidence
- Priority: P2
- Track: privacy
- Depends on: WORLDID-200
- Outputs: docs/WORLD_ID_IDKIT_WALLET_IMPLEMENTATION_PLAN.md, docs/WALLET_SECURITY_ARCHITECTURE_ADR.md, docs/WALLET_TARGET_PRODUCTION_SIGNOFF.md
- Validation: python scripts/wallet_implementation_daemon.py --once --no-implement --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md --task-prefix "## WORLDID-" --state-dir data/world_id_implementation/state --state-prefix worldid
- Acceptance: A post-MVP design explains how World ID can assist login or account recovery without becoming a wallet encryption key, sole recovery factor, controller-add bypass, or replacement for threshold governance/user presence.

## WORLDID-240 Credential Policy Expansion Review
- Status: completed
- Completion: evidence
- Priority: P2
- Track: privacy
- Depends on: WORLDID-200
- Outputs: docs/WORLD_ID_IDKIT_WALLET_IMPLEMENTATION_PLAN.md, docs/WALLET_TARGET_PRODUCTION_SIGNOFF.md
- Validation: python scripts/wallet_implementation_daemon.py --once --no-implement --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md --task-prefix "## WORLDID-" --state-dir data/world_id_implementation/state --state-prefix worldid
- Acceptance: Passport/NFC, selfie, and identity-check credential policies are documented separately from proof-of-human, with explicit allowed claims, prohibited claims, UI wording, privacy review, and provider eligibility constraints before any legal identity or eligibility wording is shipped.

## WORLDID-250 Pilot Production Signoff Packet
- Status: completed
- Completion: evidence
- Priority: P1
- Track: ops
- Depends on: WORLDID-183, WORLDID-190, WORLDID-200, WORLDID-210
- Outputs: docs/WALLET_TARGET_PRODUCTION_SIGNOFF.md, docs/WALLET_TARGET_PRODUCTION_SIGNOFF_PACKET.template.json, artifacts/world-id-idkit-signoff
- Validation: python -m wallet_interface.ops --validate-production-readiness; python -m wallet_interface.ops --validate-target-signoff-packet
- Acceptance: Pilot launch has archived staging evidence, production credential secret references, readiness output, full-stack Playwright evidence, accessibility/fallback review, privacy/nullifier review, security signoff, support playbook, and product-owner approval before `WORLD_ID_ENVIRONMENT=production` is enabled.

## WORLDID-260 Parallel-Agent Coordination Notes
- Status: completed
- Completion: evidence
- Priority: P3
- Track: ops
- Depends on: WORLDID-000
- Outputs: docs/WORLD_ID_IDKIT_AGENT_COORDINATION.md
- Validation: python scripts/wallet_implementation_daemon.py --once --no-implement --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md --task-prefix "## WORLDID-" --state-dir data/world_id_implementation/state --state-prefix worldid
- Acceptance: Coordination notes document which WORLDID tasks can be assigned concurrently, how agents should update task status, how to avoid overlapping edits, and which validation commands each lane must run before marking a task complete.
