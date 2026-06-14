# Git Migration Review 2026-05-07

This directory captures the current local Git state for migration to `https://github.com/211-ai/211-ai.github.io`.

## Current findings

- `origin` and `upstream` both point to `https://github.com/211-ai/211-ai.github.io`.
- The new origin currently exposes only `main` and `copilot/211-ai-pull-changes`.
- Local `main` is ahead of `origin/main` and includes the WALLET-210 readiness merge at `141580cf`.
- A push to the new origin is currently blocked by GitHub permission errors for the configured credentials.
- Fourteen attached implementation worktrees still contain uncommitted changes. Those edits are not preserved by branch pushes and were exported as patch files here.
- A compact migration path now exists: the rescue history can be preserved by pushing `main` plus four archive branches instead of dozens of individual rescue refs.

## Auth blocker

The current machine-level auth state is:

- Git HTTPS credentials are delegated through GitHub CLI via `gh auth git-credential`.
- The active GitHub CLI account is currently `hallucinate-llc`.
- Pushes to `211-ai/211-ai.github.io` fail with `403`, which means that account does not have write access to the target repo.
- GitHub SSH auth is not currently usable on this machine for `git@github.com`.

Quick re-check command:

- `artifacts/git-migration-20260507/check-github-auth.sh`

To finish migration later, the simplest path is to re-authenticate `gh` with an account that has push access to `211-ai/211-ai.github.io`, then run the compact push and verification scripts.

## Size blocker

Full-history migration of this repository to `211-ai/211-ai.github.io` is still blocked by repository size:

- local reachable tracked blob payload is approximately `2233958269` bytes, which is above the `2147483648` byte limit enforced during push
- pushing branches rooted in the full local history fails with a remote `422` size error

The current `main` tree itself is much smaller, about `738082404` bytes, so a history-free snapshot migration is feasible.

## Remote fallback branch

A pair of slim history-free snapshot branches has already been pushed successfully to the target remote:

- `migration/slim-main-20260507`
- `migration/slim-worktree-patches-20260507`

These branches are fresh-root snapshots that preserve the current repository contents on the target remote without carrying the oversized prior history.

- `migration/slim-main-20260507`: snapshot of the current local `main` tree
- `migration/slim-worktree-patches-20260507`: snapshot of `archive/worktree-patches-20260507`, including the patch archive and migration handoff artifacts

## Preserved artifacts

- Offline bundle containing all committed refs: `/home/barberb/git-migration-artifacts/211-AI-all-refs-20260507.bundle`
- `branch-inventory.txt`: local and remote refs with tip SHAs and subjects.
- `origin-heads.txt`: branch heads currently visible on the new origin.
- `worktree-list.txt`: registered worktrees.
- `worktree-patch-summary.txt`: dirty worktrees with exported patch file paths.
- `worktree-patches/`: per-worktree patch exports, excluding `wallet_interface/ui/node_modules`.

## High-level branch groups

- `implementation/*`: attached ephemeral worktree branches. Their committed tips are already reachable from `main`, but many still have uncommitted edits in their worktrees.
- `rescue/wallet-210-*`: failed-validation snapshots. Attempt 19 was merged into local `main`; earlier attempts remain as historical refs.
- `rescue/portal-*`, `rescue/agent-071`, `rescue/graphrag-021`, `rescue/mixed-daemon`, `rescue/abby-ui-style-in-progress`: local rescue branches with unique commits not present on local `main`.
- `backup/pre-merge-*`: local backup refs. `backup/pre-merge-20260504-0003` still has one unique commit not on local `main`.
- `merge/pr2-ready-20260507` and `pr/endomorphosis/2`: preserved PR-era refs pointing at `a67efc93`.

## Compact migration option

The smallest practical remote preservation set is now:

- `main`
- `archive/worktree-patches-20260507`
- `archive/rescue-portal-family-20260507`
- `archive/rescue-wallet210-family-20260507`
- `archive/rescue-misc-family-20260507`

These archive family branches were built with `ours`-strategy merges so that the original rescue branch tips are reachable from the archive refs without changing current file contents.

## To complete migration after credentials are fixed

1. Preferred compact push set:
	`git -C /home/barberb/211-AI push origin main`
	`git -C /home/barberb/211-AI push origin archive/worktree-patches-20260507`
	`git -C /home/barberb/211-AI push origin archive/rescue-portal-family-20260507`
	`git -C /home/barberb/211-AI push origin archive/rescue-wallet210-family-20260507`
	`git -C /home/barberb/211-AI push origin archive/rescue-misc-family-20260507`
	or run `artifacts/git-migration-20260507/push-compact-migration.sh`
2. Verify the push with `artifacts/git-migration-20260507/verify-compact-migration.sh`
3. If you want every original branch name preserved on the new remote, use the full-fidelity branch list in `PUSH_PLAN.md` instead.
4. Push tags if needed: `git -C /home/barberb/211-AI push origin --tags`
5. Keep the external bundle at `/home/barberb/git-migration-artifacts/211-AI-all-refs-20260507.bundle` until the new remote has been verified.
6. Remove stale temporary worktrees only after any wanted patches have been committed or separately archived.

## Current best available remote state

- Full-history compact migration: prepared locally but still blocked by repository size.
- Current-state slim migration: already published on the remote as `migration/slim-main-20260507`.
- Patch-archive slim migration: already published on the remote as `migration/slim-worktree-patches-20260507`.