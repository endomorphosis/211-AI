# Worktree Patch Groups

This file collapses the 14 dirty attached worktrees into a smaller set of archival patch families.

## Group A: portal-050 interaction timeline variants

- `implementation/portal-050-attempt-1-1778145896`
- `implementation/portal-050-attempt-1-1778147893`

Touched area:

- Abby interaction agent schemas and guards
- `App.tsx` and `appState.ts`
- Abby model updates
- interaction timeline UI
- one variant also changes `global.css`

Representative patch files:

- `worktree-patches/implementation_portal-050-attempt-1-1778145896.patch`
- `worktree-patches/implementation_portal-050-attempt-1-1778147893.patch`

## Group B: wallet-210 docs-and-test only variants

- `implementation/wallet-210-attempt-16-1778178198`
- `implementation/wallet-210-attempt-18-1778185160`
- `implementation/wallet-210-attempt-20-1778190099`
- `implementation/wallet-210-attempt-5-1778152184`

Touched area:

- `docs/WALLET_OPERATIONS_RUNBOOK.md`
- `docs/WALLET_OPERATOR_INTEGRATOR_REFERENCE.md`
- `wallet_interface/ui/tests/fullstack-wallet.spec.ts`

These are closely related WALLET-210 variants that differ in patch contents but stay within the same pilot-readiness docs/test slice.

## Group C: wallet-210 docs-test plus `App.tsx`

- `implementation/wallet-210-attempt-16-1778180075`

Touched area:

- Group B files
- `wallet_interface/ui/src/app/App.tsx`

## Group D: wallet-210 app and wallet API variants

- `implementation/wallet-210-attempt-4-1778144896`
- `implementation/wallet-210-attempt-4-1778148649`
- `implementation/wallet-210-attempt-7-1778157649`
- `implementation/wallet-210-attempt-7-1778159527`

Touched area:

- Group B files
- `wallet_interface/ui/src/app/App.tsx`
- `wallet_interface/ui/src/services/walletApi.ts`

## Group E: wallet-210 app, wallet API, and style variant

- `implementation/wallet-210-attempt-4-1778143019`

Touched area:

- Group D files
- `wallet_interface/ui/src/styles/global.css`

## Group F: wallet-210 app, wallet API, and package variant

- `implementation/wallet-210-attempt-4-1778146772`

Touched area:

- Group D files
- `wallet_interface/ui/package.json`

## Group G: wallet-210 service-plan sharing variant

- `implementation/wallet-210-attempt-7-1778161403`

Touched area:

- Group D files
- `wallet_interface/ui/src/app/ServicePlanScreen.tsx`
- `wallet_interface/ui/src/components/services/ServicePlanSharingPanel.tsx`

## Recommended preservation model

- Preserve committed history by pushing existing local branches when credentials are available.
- Preserve uncommitted implementation worktree deltas by pushing one archival branch that contains this manifest and the exported patch files.
- Treat Groups A through G as the review units for later reconstruction or selective cherry-picking.