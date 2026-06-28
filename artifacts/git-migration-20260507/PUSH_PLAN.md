# Push Plan To `211-ai/211-ai.github.io`

This plan assumes GitHub credentials for `https://github.com/211-ai/211-ai.github.io` have been fixed.

## Current target remote state

The target remote currently exposes only:

- `main`
- `copilot/211-ai-pull-changes`
- `migration/slim-main-20260507`
- `migration/slim-worktree-patches-20260507`

Local remote-tracking refs such as `origin/rescue/*` are historical and should not be treated as proof that those branches exist on the new remote.

## Reduction result

An ancestry and diff-equivalence pass was run across the non-merged local rescue/history branches.

- No duplicate effective diffs were found among the non-merged rescue/history branches.
- `rescue/wallet-210-attempt-19-1778188297-failed-validation` is covered by `rescue/wallet-210-attempt-21-1778191683-failed-validation` and does not need to be pushed separately.
- Aside from that single covered branch, the Phase 2 rescue/history list is already the smallest content-preserving branch set.

## Preferred compact push set

If the goal is to preserve all meaningful local history with the fewest remote refs, push these branches:

- `main`
- `archive/worktree-patches-20260507`
- `archive/rescue-portal-family-20260507`
- `archive/rescue-wallet210-family-20260507`
- `archive/rescue-misc-family-20260507`

These curated rescue archive branches were built with `ours`-strategy merges, and every original rescue-family branch tip was verified to be an ancestor of its corresponding archive branch.

Recommended compact commands:

```bash
git -C /home/barberb/211-AI push origin main
git -C /home/barberb/211-AI push origin archive/worktree-patches-20260507
git -C /home/barberb/211-AI push origin archive/rescue-portal-family-20260507
git -C /home/barberb/211-AI push origin archive/rescue-wallet210-family-20260507
git -C /home/barberb/211-AI push origin archive/rescue-misc-family-20260507
```

Helper script:

```bash
artifacts/git-migration-20260507/push-compact-migration.sh
```

Post-push verification:

```bash
artifacts/git-migration-20260507/verify-compact-migration.sh
```

Auth diagnosis:

```bash
artifacts/git-migration-20260507/check-github-auth.sh
```

## Full-history size blocker

The target remote accepts authentication, but full-history pushes rooted in local `main` still fail because the reachable tracked blob history is about `2233958269` bytes, above the `2147483648` byte limit enforced during push.

That means the compact five-branch migration set is still blocked as a full-history transfer, even though authentication is now correct.

## Published slim fallback

The history-free snapshot branch below has already been pushed successfully to the target remote:

- `migration/slim-main-20260507`
- `migration/slim-worktree-patches-20260507`

These are fresh-root snapshots of:

- the current local `main` tree
- the `archive/worktree-patches-20260507` tree containing the patch archive and migration handoff artifacts

They provide viable current-state fallback branches when full history cannot be transferred.

## Phase 1: Push immediately

These branches should be pushed first if you are using the full-fidelity branch-preservation path instead of the compact option above.

- `main`
- `archive/worktree-patches-20260507`

Commands:

```bash
git -C /home/barberb/211-AI push origin main
git -C /home/barberb/211-AI push origin archive/worktree-patches-20260507
```

## Phase 2: Push unique rescue and history refs

These branches contain commits not reachable from local `main` and should be preserved if you want the new remote to retain the current local forensic and rescue history.

- `backup/pre-merge-20260504-0003`
- `rescue/abby-ui-style-in-progress`
- `rescue/agent-071`
- `rescue/graphrag-021`
- `rescue/mixed-daemon`
- `rescue/portal-021-css`
- `rescue/portal-042-attempt-12-1778133045-failed-validation`
- `rescue/portal-042-attempt-12-interrupted`
- `rescue/portal-042-attempt-13-1778134563-failed-validation`
- `rescue/portal-070-attempt-1-1778151518-failed-validation`
- `rescue/portal-070-attempt-2-1778152269-failed-validation`
- `rescue/portal-070-attempt-3-1778153233-failed-validation`
- `rescue/wallet-120-attempt-2-1778137769-unsafe-baseline`
- `rescue/wallet-210-attempt-1-1778138353-failed-validation`
- `rescue/wallet-210-attempt-2-1778139957-failed-validation`
- `rescue/wallet-210-attempt-3-1778141637-failed-validation`
- `rescue/wallet-210-attempt-4-1778150525-failed-validation`
- `rescue/wallet-210-attempt-5-1778154060-failed-validation`
- `rescue/wallet-210-attempt-6-1778155889-failed-validation`
- `rescue/wallet-210-attempt-7-1778163280-failed-validation`
- `rescue/wallet-210-attempt-8-1778165162-failed-validation`
- `rescue/wallet-210-attempt-9-1778166243-failed-validation`
- `rescue/wallet-210-attempt-10-1778167904-failed-validation`
- `rescue/wallet-210-attempt-11-1778169369-failed-validation`
- `rescue/wallet-210-attempt-12-1778171084-failed-validation`
- `rescue/wallet-210-attempt-13-1778172684-failed-validation`
- `rescue/wallet-210-attempt-14-1778174512-failed-validation`
- `rescue/wallet-210-attempt-15-1778176402-failed-validation`
- `rescue/wallet-210-attempt-16-1778181952-failed-validation`
- `rescue/wallet-210-attempt-17-1778183571-failed-validation`
- `rescue/wallet-210-attempt-18-1778187037-failed-validation`
- `rescue/wallet-210-attempt-21-1778191683-failed-validation`
- `rescue/wallet-210-attempt-20-1778190099-failed-validation`
- `rescue/worktree-artifacts`

Recommended command:

```bash
git -C /home/barberb/211-AI push origin \
  backup/pre-merge-20260504-0003 \
  rescue/abby-ui-style-in-progress \
  rescue/agent-071 \
  rescue/graphrag-021 \
  rescue/mixed-daemon \
  rescue/portal-021-css \
  rescue/portal-042-attempt-12-1778133045-failed-validation \
  rescue/portal-042-attempt-12-interrupted \
  rescue/portal-042-attempt-13-1778134563-failed-validation \
  rescue/portal-070-attempt-1-1778151518-failed-validation \
  rescue/portal-070-attempt-2-1778152269-failed-validation \
  rescue/portal-070-attempt-3-1778153233-failed-validation \
  rescue/wallet-120-attempt-2-1778137769-unsafe-baseline \
  rescue/wallet-210-attempt-1-1778138353-failed-validation \
  rescue/wallet-210-attempt-2-1778139957-failed-validation \
  rescue/wallet-210-attempt-3-1778141637-failed-validation \
  rescue/wallet-210-attempt-4-1778150525-failed-validation \
  rescue/wallet-210-attempt-5-1778154060-failed-validation \
  rescue/wallet-210-attempt-6-1778155889-failed-validation \
  rescue/wallet-210-attempt-7-1778163280-failed-validation \
  rescue/wallet-210-attempt-8-1778165162-failed-validation \
  rescue/wallet-210-attempt-9-1778166243-failed-validation \
  rescue/wallet-210-attempt-10-1778167904-failed-validation \
  rescue/wallet-210-attempt-11-1778169369-failed-validation \
  rescue/wallet-210-attempt-12-1778171084-failed-validation \
  rescue/wallet-210-attempt-13-1778172684-failed-validation \
  rescue/wallet-210-attempt-14-1778174512-failed-validation \
  rescue/wallet-210-attempt-15-1778176402-failed-validation \
  rescue/wallet-210-attempt-16-1778181952-failed-validation \
  rescue/wallet-210-attempt-17-1778183571-failed-validation \
  rescue/wallet-210-attempt-18-1778187037-failed-validation \
  rescue/wallet-210-attempt-21-1778191683-failed-validation \
  rescue/wallet-210-attempt-20-1778190099-failed-validation \
  rescue/worktree-artifacts
```

## Phase 3: Optional historical refs

These are locally useful historical names, but they do not add new content relative to the key preservation set above.

- `merge/pr2-ready-20260507`
- `pr/endomorphosis/2`

Push them only if you want the old PR-local naming retained on the new remote.

## Phase 4: Skip unless you want every ephemeral branch name preserved

These branch tips are already reachable from local `main`, so pushing them does not preserve additional committed content.

- `implementation/*`
- `rescue/wallet-210-attempt-19-1778188297-failed-validation` is covered by `rescue/wallet-210-attempt-21-1778191683-failed-validation`
- `implementation/wallet-210-attempt-21-1778191683`
- `backup/pre-merge-20260504-0001`
- `backup/pre-merge-20260504-0002`
- `backup/pre-merge-20260504-0004`
- `backup/pre-merge-20260504-0005`

The uncommitted implementation worktree states tied to these branches are already preserved in:

- `archive/worktree-patches-20260507`
- `artifacts/git-migration-20260507/worktree-patches/`

## Final verification after push

Run:

```bash
git -C /home/barberb/211-AI ls-remote --heads origin
```

Confirm that `main`, `archive/worktree-patches-20260507`, and any selected rescue/history refs appear on the new remote.