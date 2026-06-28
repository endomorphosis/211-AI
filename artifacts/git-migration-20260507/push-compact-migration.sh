#!/usr/bin/env bash
set -euo pipefail

repo_root="/home/barberb/211-AI"

branches=(
  main
  archive/worktree-patches-20260507
  archive/rescue-portal-family-20260507
  archive/rescue-wallet210-family-20260507
  archive/rescue-misc-family-20260507
)

echo "Pushing compact migration branch set to origin from $repo_root"

for branch in "${branches[@]}"; do
  echo ">>> pushing $branch"
  git -C "$repo_root" push origin "$branch"
done

echo
echo "Remote heads after push:"
git -C "$repo_root" ls-remote --heads origin