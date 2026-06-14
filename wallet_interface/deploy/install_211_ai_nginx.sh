#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BOOTSTRAP_CONFIG="$SCRIPT_DIR/nginx.211-ai.com.bootstrap.conf"
SOURCE_CONFIG="$SCRIPT_DIR/nginx.211-ai.com.conf"
TARGET_AVAILABLE="/etc/nginx/sites-available/211-ai.com.conf"
TARGET_ENABLED="/etc/nginx/sites-enabled/211-ai.com.conf"
ACME_ROOT="/var/www/certbot"
PRIMARY_DOMAIN="${PRIMARY_DOMAIN:-211-ai.com}"
WWW_DOMAIN="${WWW_DOMAIN:-www.211-ai.com}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
USE_STAGING_CERTBOT="${USE_STAGING_CERTBOT:-false}"
CERT_DIR="/etc/letsencrypt/live/$PRIMARY_DOMAIN"
CERTBOT_BIN="${CERTBOT_BIN:-}"
CERTBOT_MODE="${CERTBOT_MODE:-auto}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root so the nginx site can be installed under /etc/nginx." >&2
    exit 1
fi

reload_nginx() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl reload nginx
    else
        nginx -s reload
    fi
}

ensure_certbot() {
    if command -v certbot >/dev/null 2>&1; then
        CERTBOT_BIN="$(command -v certbot)"
        return 0
    fi

    if [ -x /usr/bin/certbot ]; then
        CERTBOT_BIN="/usr/bin/certbot"
        return 0
    fi

    if [ -x /snap/bin/certbot ]; then
        CERTBOT_BIN="/snap/bin/certbot"
        return 0
    fi

    if command -v apt-get >/dev/null 2>&1; then
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y certbot
        if command -v certbot >/dev/null 2>&1; then
            CERTBOT_BIN="$(command -v certbot)"
            return 0
        fi
        if [ -x /usr/bin/certbot ]; then
            CERTBOT_BIN="/usr/bin/certbot"
            return 0
        fi
        if [ -L /usr/bin/certbot ] && [ ! -e /usr/bin/certbot ]; then
            echo "certbot is a broken symlink at /usr/bin/certbot; remove it or reinstall snap certbot." >&2
        fi
    fi

    echo "certbot is required but no executable was found on PATH, /usr/bin, or /snap/bin." >&2
    exit 1
}

install_site() {
    install -D -m 0644 "$1" "$TARGET_AVAILABLE"
    ln -sfn "$TARGET_AVAILABLE" "$TARGET_ENABLED"
    nginx -t
    reload_nginx
}

mkdir -p "$ACME_ROOT"

if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
    if [ -z "$LETSENCRYPT_EMAIL" ]; then
        echo "Set LETSENCRYPT_EMAIL so certbot can request a certificate for $PRIMARY_DOMAIN." >&2
        exit 1
    fi

    if [ "$CERTBOT_MODE" != "docker" ]; then
        ensure_certbot
    fi
    install_site "$BOOTSTRAP_CONFIG"

    certbot_args="certonly --webroot -w $ACME_ROOT -d $PRIMARY_DOMAIN -d $WWW_DOMAIN --non-interactive --agree-tos --email $LETSENCRYPT_EMAIL"
    if [ "$USE_STAGING_CERTBOT" = "true" ]; then
        certbot_args="$certbot_args --staging"
    fi
    if [ "$CERTBOT_MODE" = "docker" ]; then
        # shellcheck disable=SC2086
        docker run --rm \
            -v /etc/letsencrypt:/etc/letsencrypt \
            -v "$ACME_ROOT":"$ACME_ROOT" \
            certbot/certbot $certbot_args
    else
        ensure_certbot
        # shellcheck disable=SC2086
        "$CERTBOT_BIN" $certbot_args
    fi
fi

install_site "$SOURCE_CONFIG"

echo "Installed nginx site for 211-ai.com and reloaded nginx."
