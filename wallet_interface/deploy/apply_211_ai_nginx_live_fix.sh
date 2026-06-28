#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo sh wallet_interface/deploy/apply_211_ai_nginx_live_fix.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/../.."

cp wallet_interface/deploy/nginx.211-ai.com.conf /etc/nginx/sites-available/211-ai.com.conf
ln -sfn /etc/nginx/sites-available/211-ai.com.conf /etc/nginx/sites-enabled/211-ai.com.conf

nginx -t
systemctl reload nginx

grep -n 'proxy_buffering\|proxy_request_buffering\|proxy_max_temp_file_size\|sendfile' \
  /etc/nginx/sites-enabled/211-ai.com.conf
