# Worktree Rescue Bundle

Created on 2026-05-06 to preserve local-only committed work and representative uncommitted worktree changes that were found outside `main`.

## Contents

- `agent-071-pattern.patch`
  - Source: `/tmp/211-ai-implementation-worktrees/agent-071-attempt-1-1778025365`
  - Preserves unique changes in:
    - `wallet_interface/ui/src/app/App.tsx`
    - `wallet_interface/ui/src/app/appActions.ts`
    - `wallet_interface/ui/src/agent/tools/serviceDetailTools.ts`

- `graphrag-021-pattern.patch`
  - Source: `/tmp/211-ai-implementation-worktrees/graphrag-021-attempt-1-1778026770`
  - Preserves unique changes in:
    - `wallet_interface/ui/src/workers/backendDetectionWorker.ts`
    - `wallet_interface/ui/src/workers/clientLLMWorker.ts`
    - `wallet_interface/ui/src/lib/warningSuppressionUtils.ts`

- `portal-021-core-pattern.patch`
  - Source: `/tmp/211-ai-implementation-worktrees/portal-021-attempt-10-1778055584`
  - Preserves representative service-detail changes in:
    - `wallet_interface/ui/src/app/App.tsx`
    - `wallet_interface/ui/src/app/ServiceDetailScreen.tsx`
    - `wallet_interface/ui/src/services/graphRagService.ts`
    - `wallet_interface/ui/src/components/services/ServiceProvenancePanel.tsx`

- `portal-021-css-pattern.patch`
  - Source: `/tmp/211-ai-implementation-worktrees/portal-021-attempt-15-1778059386`
  - Same core service-detail changes as above, plus:
    - `wallet_interface/ui/src/styles/global.css`

- `mixed-daemon-pattern.patch`
  - Source: `/tmp/211-ai-implementation-worktrees/portal-021-attempt-3-1778050426`
  - Preserves the smaller mixed set that still differed from `main` in:
    - `wallet_interface/ui/src/app/App.tsx`
    - `wallet_interface/ui/src/app/ServiceDetailScreen.tsx`
    - `wallet_interface/ui/src/services/graphRagService.ts`
    - `wallet_interface/ui/src/components/services/ServiceProvenancePanel.tsx`
    - `scripts/manage_implementation_services.py`
    - `scripts/run_wallet_release_checks.py`
    - `tests/test_implementation_service_manager.py`
    - `tests/test_wallet_release_check_runner.py`

- `backup-pre-merge-20260504-0003.patch`
  - Source branch: `backup/pre-merge-20260504-0003`
  - Captures the local-only committed branch diff against `main` for source-oriented files.

## Notes

- These patches are representative rescue artifacts, not a claim that every dirty worktree is unique.
- The portal/service-detail pattern appeared repeatedly across many linked worktrees.
- The backup branch commit still exists locally as `1788a4b7` on `backup/pre-merge-20260504-0003`.
- The linked worktree branches themselves did not contain commits ahead of `main`; the risk was uncommitted source changes inside the worktree directories.

## Suggested Use

1. Review the patch that matches the feature area you care about.
2. Apply it onto a fresh branch or worktree instead of directly onto `main`.
3. Deduplicate overlapping portal/service-detail patches before committing.
