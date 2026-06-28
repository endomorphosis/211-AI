#!/usr/bin/env bash
set -euo pipefail

repo_root="/home/barberb/211-AI"

echo "Remote configuration:"
git -C "$repo_root" remote -v

echo
echo "Git credential helper configuration:"
git -C "$repo_root" config --show-origin --get-regexp '^(credential|url\.|http\.)' || true

echo
echo "GitHub CLI auth status:"
if command -v gh >/dev/null 2>&1; then
  gh auth status || true
else
  echo "gh is not installed"
fi

echo
echo "GitHub SSH auth test:"
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new git@github.com || true