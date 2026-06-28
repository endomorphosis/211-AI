#!/usr/bin/env bash
set -euo pipefail

repo_root="/home/barberb/211-AI"
remote_name="origin"

branches=(
  main
  archive/worktree-patches-20260507
  archive/rescue-portal-family-20260507
  archive/rescue-wallet210-family-20260507
  archive/rescue-misc-family-20260507
)

checks=(
  "archive/rescue-portal-family-20260507:rescue/portal-021-css"
  "archive/rescue-portal-family-20260507:rescue/portal-042-attempt-12-1778133045-failed-validation"
  "archive/rescue-portal-family-20260507:rescue/portal-042-attempt-12-interrupted"
  "archive/rescue-portal-family-20260507:rescue/portal-042-attempt-13-1778134563-failed-validation"
  "archive/rescue-portal-family-20260507:rescue/portal-070-attempt-1-1778151518-failed-validation"
  "archive/rescue-portal-family-20260507:rescue/portal-070-attempt-2-1778152269-failed-validation"
  "archive/rescue-portal-family-20260507:rescue/portal-070-attempt-3-1778153233-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-1-1778138353-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-2-1778139957-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-3-1778141637-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-4-1778150525-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-5-1778154060-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-6-1778155889-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-7-1778163280-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-8-1778165162-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-9-1778166243-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-10-1778167904-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-11-1778169369-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-12-1778171084-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-13-1778172684-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-14-1778174512-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-15-1778176402-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-16-1778181952-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-17-1778183571-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-18-1778187037-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-19-1778188297-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-20-1778190099-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-21-1778191683-failed-validation"
  "archive/rescue-wallet210-family-20260507:rescue/wallet-210-attempt-22-1778193213-failed-validation"
  "archive/rescue-misc-family-20260507:backup/pre-merge-20260504-0003"
  "archive/rescue-misc-family-20260507:rescue/abby-ui-style-in-progress"
  "archive/rescue-misc-family-20260507:rescue/agent-071"
  "archive/rescue-misc-family-20260507:rescue/graphrag-021"
  "archive/rescue-misc-family-20260507:rescue/mixed-daemon"
  "archive/rescue-misc-family-20260507:rescue/wallet-120-attempt-2-1778137769-unsafe-baseline"
  "archive/rescue-misc-family-20260507:rescue/worktree-artifacts"
)

echo "Checking remote refs on $remote_name"

for branch in "${branches[@]}"; do
  local_sha=$(git -C "$repo_root" rev-parse "$branch")
  remote_sha=$(git -C "$repo_root" ls-remote --heads "$remote_name" "$branch" | awk '{print $1}')

  if [[ -z "$remote_sha" ]]; then
    echo "MISSING remote ref: $branch"
    exit 1
  fi

  if [[ "$local_sha" != "$remote_sha" ]]; then
    echo "SHA mismatch for $branch"
    echo "  local:  $local_sha"
    echo "  remote: $remote_sha"
    exit 1
  fi

  echo "OK ref: $branch -> $remote_sha"
done

echo
echo "Checking archive ancestry coverage"

for item in "${checks[@]}"; do
  archive_branch=${item%%:*}
  source_branch=${item#*:}
  if git -C "$repo_root" merge-base --is-ancestor "$source_branch" "$archive_branch"; then
    echo "OK ancestry: $source_branch <= $archive_branch"
  else
    echo "Missing ancestry: $source_branch is not an ancestor of $archive_branch"
    exit 1
  fi
done

echo
echo "Compact migration verification passed"