# Wallet Deployment

This directory contains reference deployment assets for the 211-AI wallet API,
wallet UI, and ops-health worker.

For the stable API, CLI, MCP, and release-check reference, see
`docs/WALLET_OPERATOR_INTEGRATOR_REFERENCE.md`. For the external proof verifier
HTTP contract, see `docs/WALLET_PROOF_VERIFIER_CONTRACT.md`.

Build context is the repository root:

```bash
docker compose -f wallet_interface/deploy/docker-compose.wallet.yml up --build
```

## Nginx Gateway On Public Domains

The bundled `wallet-ui` container already uses nginx. For `211-ai.com`, it now
acts as the default public same-origin gateway. With the optional
additional-domain site file, the same host can also front `abby.network` and
`abetterbridgetoyou.com`:

- `https://211-ai.com/`, `https://abby.network/`, and
  `https://abetterbridgetoyou.com/` serve the React UI.
- `/wallets`, `/analytics/*`, `/health`, and `/ops/*` proxy to the internal
  `wallet-api` service on whichever of those domains the user visited.
- `/messaging/*` proxies to the internal `sms-bridge` service so the same
  public domain can terminate Twilio inbound SMS plus SMS/voice delivery-status
  webhooks without exposing another port.
- `/docs`, `/redoc`, and `/openapi.json` stay available through the same
  domain.

That lets the UI use a same-origin `walletApi.apiBaseUrl`
without exposing the API container on a separate public port. In the compose
reference, `wallet-api` stays internal and `wallet-ui` binds only to
`127.0.0.1:8080` so host nginx can own `80/443` for those domains.
The UI build now defaults `VITE_WALLET_API_BASE_URL` to `same-origin`
so the app can create new wallets against the same-origin gateway even before a
specific `walletId` is written into `runtime-config.json`.

On the production box, the `wallet-ui` container now rewrites
`/runtime-config.json` from `ABBY_RUNTIME_*` environment variables at startup.
That lets you update browser-visible, non-secret config such as the active
`walletId`, Filecoin upload URL, or remote voice-proxy endpoints by editing
the env file and restarting the container, without rebuilding the UI image.

Recommended DNS / reverse-proxy shape:

1. Point `211-ai.com` and `www.211-ai.com` at the host running `wallet-ui`.
2. Install `wallet_interface/deploy/nginx.211-ai.com.conf` as the host nginx
  site and terminate TLS there.
3. Proxy the host nginx site to `127.0.0.1:8080`, which is the compose-bound
  `wallet-ui` gateway.
4. Keep `wallet-api` reachable only on the compose network unless you need a
  separate private ingress path.
5. Set `ABBY_RUNTIME_WALLET_API_BASE_URL=same-origin` in the runtime env
  file used by the `wallet-ui` container.

If the same host also runs OpenVPN on port 443, split the traffic by protocol:
nginx owns `tcp/443` for `https://211-ai.com`, and OpenVPN owns `udp/443`.
That lets both services use the familiar 443 port without a bind conflict.
OpenVPN cannot also bind `tcp/443` on the same public IP while nginx is using
`tcp/443`; use `udp/443`, a second public IP, or a TCP multiplexer such as
`sslh` if the VPN must remain TCP.

For an existing OpenVPN server, keep the current certificate, route, and
address-pool settings, but make sure the listener has these values:

```conf
port 443
proto udp
```

A minimal reference fragment is included at
`wallet_interface/deploy/openvpn-443-udp.fragment.conf`. After editing the
OpenVPN server config, bring the services back in this order:

```bash
sudo systemctl stop openvpn-server@server 2>/dev/null || sudo systemctl stop openvpn 2>/dev/null || true
sudo LETSENCRYPT_EMAIL=ops@211-ai.com sh wallet_interface/deploy/install_211_ai_nginx.sh
sudo systemctl restart openvpn-server@server 2>/dev/null || sudo systemctl restart openvpn
sudo ss -ltnup | grep -E ':(80|443)\b'
```

The final listener check should show nginx on `tcp/80` and `tcp/443`, plus
OpenVPN on `udp/443`.

If you also serve `abby.network` or `abetterbridgetoyou.com` from the same
host, install `wallet_interface/deploy/nginx.additional-public-domains.conf`
after those domains have valid certificate material. Keeping `211-ai.com` in a
dedicated site file prevents missing certs for optional domains from blocking
`nginx -t` and leaving `211-ai.com` on a placeholder config.

The primary `211-ai.com` site file expects Let's Encrypt certificates at:

```text
/etc/letsencrypt/live/211-ai.com/fullchain.pem
/etc/letsencrypt/live/211-ai.com/privkey.pem
```

The optional additional-domain site file expects:

```text
/etc/letsencrypt/live/abby.network/fullchain.pem
/etc/letsencrypt/live/abby.network/privkey.pem
/etc/letsencrypt/live/abetterbridgetoyou.com/fullchain.pem
/etc/letsencrypt/live/abetterbridgetoyou.com/privkey.pem
```

and proxies all traffic to the local compose gateway on `127.0.0.1:8080`.

Example host setup after certificates already exist:

```bash
sudo cp wallet_interface/deploy/nginx.211-ai.com.conf /etc/nginx/sites-available/211-ai.com.conf
sudo ln -s /etc/nginx/sites-available/211-ai.com.conf /etc/nginx/sites-enabled/211-ai.com.conf
sudo nginx -t
sudo systemctl reload nginx
```

Optional extra public domains on the same host:

```bash
sudo cp wallet_interface/deploy/nginx.additional-public-domains.conf /etc/nginx/sites-available/public-domains-extra.conf
sudo ln -s /etc/nginx/sites-available/public-domains-extra.conf /etc/nginx/sites-enabled/public-domains-extra.conf
sudo nginx -t
sudo systemctl reload nginx
```

Or run the helper directly on the host:

```bash
sudo LETSENCRYPT_EMAIL=ops@211-ai.com sh wallet_interface/deploy/install_211_ai_nginx.sh
```

The helper now bootstraps the host in the correct order for a fresh box:

1. installs an HTTP-only site from `wallet_interface/deploy/nginx.211-ai.com.bootstrap.conf`
2. serves `/.well-known/acme-challenge/` from `/var/www/certbot`
3. requests the `211-ai.com` and `www.211-ai.com` certificate with certbot
4. installs the final TLS site from `wallet_interface/deploy/nginx.211-ai.com.conf`

Use `USE_STAGING_CERTBOT=true` on a first dry run if you want to avoid Let's
Encrypt production rate limits while validating DNS and host reachability.

If you only need the UI to know where to create or look up wallets, the compose
build already injects `VITE_WALLET_API_BASE_URL=same-origin`.
The `ABBY_RUNTIME_*` env values now replace baked `runtime-config.json` edits on
the containerized public-domain hosts.

## GitHub Pages Split UI

The React UI can be deployed as a static bundle to GitHub Pages while the API,
ops worker, proof verifier, and storage backends run elsewhere.

Recommended wiring:

1. Build and publish `wallet_interface/ui/` with the existing Pages workflow.
2. Set GitHub repository or environment variables for the Pages workflow:
  `ABBY_PAGES_WALLET_API_BASE_URL`, `ABBY_PAGES_WALLET_ID`, optional
  `ABBY_PAGES_ACTOR_DID`, and optional `ABBY_PAGES_FILECOIN_UPLOAD_URL`.
3. Set `WALLET_API_CORS_ORIGINS` on the API to the exact GitHub Pages origin.
4. Keep secrets only on the API/proof/storage side. GitHub Pages assets are
   public.

This split is intentionally asymmetric:

- `211-ai.com` can inject runtime config from environment on the prod box.
- `github.io` remains a fully static artifact and uses the committed
  `runtime-config.json` file generated by the Pages workflow from non-secret
  GitHub Actions variables.

Example `runtime-config.json` for a split deployment:

```json
{
  "walletApi": {
    "apiBaseUrl": "https://wallet-api.example.com",
    "walletId": "wallet-demo"
  },
  "filecoinStorage": {
    "uploadUrl": "https://storage.example.com/upload"
  },
  "voiceProxy": {
    "inferUrl": "https://voice.example.com/api/voice/infer",
    "ttsUrl": "https://voice.example.com/api/voice/tts",
    "sttUrl": "https://voice.example.com/api/voice/stt"
  }
}
```

Example `runtime-config.json` for the same-origin `211-ai.com` deployment:

```json
{
  "walletApi": {
    "apiBaseUrl": "same-origin",
    "walletId": "wallet-demo"
  },
  "voiceProxy": {
    "inferUrl": "https://voice.example.com/api/voice/infer",
    "ttsUrl": "https://voice.example.com/api/voice/tts",
    "sttUrl": "https://voice.example.com/api/voice/stt"
  }
}
```

Equivalent env-driven runtime config for the containerized public-domain
deployment:

```bash
ABBY_RUNTIME_WALLET_API_BASE_URL=same-origin
ABBY_RUNTIME_WALLET_ID=wallet-demo
ABBY_RUNTIME_ACTOR_DID=did:key:demo
ABBY_RUNTIME_VOICE_PROXY_INFER_URL=https://voice.example.com/api/voice/infer
ABBY_RUNTIME_VOICE_PROXY_TTS_URL=https://voice.example.com/api/voice/tts
ABBY_RUNTIME_VOICE_PROXY_STT_URL=https://voice.example.com/api/voice/stt
```

When the same-origin wallet bridge targets the Publicus IndexTTS Space, set a
Hugging Face token for the bridge in addition to the Space URL. The wallet API
forwards `Authorization` and `X-HF-Bill-To` headers to every Gradio call.

```bash
WALLET_INDEXTTS_SPACE_URL=https://publicus-indextts-2-demo.hf.space
WALLET_INDEXTTS_MODEL_NAME=Publicus/IndexTTS-2-Demo
WALLET_INDEXTTS_HF_TOKEN=hf_your_token_here
WALLET_INDEXTTS_HF_BILL_TO=publicus

# Optional shared fallback for other HF helpers in the same container.
HF_TOKEN=hf_your_token_here
IPFS_DATASETS_PY_HF_BILL_TO=publicus
```

If those credentials are missing, the wallet API health surfaces report a
`publicus_indextts_missing_hf_token` warning.

For an explicit voice bridge diagnostics probe (separate from general
repository/storage checks), call:

```bash
curl -sS https://211-ai.com/ops/voice-proxy/status
```

When `WALLET_OPS_HEALTH_SHARED_SECRET` is configured, include it as either
`Authorization: Bearer <secret>` or `X-Wallet-Ops-Shared-Secret: <secret>`.

Equivalent GitHub Pages repository or environment variables for a sandbox build
that points at the prod API:

```text
ABBY_PAGES_WALLET_API_BASE_URL=https://211-ai.com
ABBY_PAGES_WALLET_ID=wallet-demo
ABBY_PAGES_ACTOR_DID=did:key:demo
```

If your GitHub Pages project URL is, for example,
`https://endomorphosis.github.io/211-AI/`, then the prod API should include
that exact origin in `WALLET_API_CORS_ORIGINS` when you want the sandbox to hit
live backend routes.

For quick sandboxing against a local backend, you can also keep the Pages build
static and point it at a local or tunneled API with URL params such as
`?walletApiBaseUrl=https://example-tunnel.ngrok.dev&walletId=wallet-demo`.

## Local Backend Bring-Up

For a local split stack without containers:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export WALLET_API_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
export WALLET_REPOSITORY_ROOT=$PWD/state/wallet-repository
export WALLET_STORAGE_CONFIG='{"primary":{"type":"local","root":"'$PWD'/state/wallet-blobs"}}'
export WALLET_PROOF_MODE=production
export WALLET_PROOF_BACKEND=deterministic-location-region
uvicorn wallet_interface.asgi:app --host 0.0.0.0 --port 8000
```

Then run the UI with `npm run dev` from `wallet_interface/ui` and set either
`wallet_interface/ui/public/runtime-config.json` or the `walletApiBaseUrl`
query param to `http://127.0.0.1:8000`.

Backend surfaces already present in this repo:

- DuckDB ETL/state stores for the scraper pipeline in `scraper/duckdb_etl.py`
  and `scraper/duckdb_state.py`
- IPFS/Filecoin-capable wallet blob storage via `WALLET_STORAGE_CONFIG`
- production proof verifier wiring via `WALLET_PROOF_BACKEND=http-location-region`

That means the GitHub Pages deployment should stay a static shell and public
corpus browser, while DuckDB, IPFS/Filecoin storage, and zero-knowledge proof
services stay on a separate trusted backend.

For environment-specific secrets, copy
`wallet_interface/deploy/env.production.example` to an ignored local file and
run compose with `--env-file`. Do not commit the populated file.

When using the compose file for anything beyond local integration, export:

```bash
export WALLET_OPS_HEALTH_SHARED_SECRET=replace-me
export WALLET_OPS_ALERT_WEBHOOK_URL=https://ops.example.com/hooks/211-wallet
export WALLET_OPS_ALERT_ON=error
export WALLET_OPS_ALERT_BEARER_TOKEN=replace-me
export WALLET_OPS_ALERT_HEADER_NAME=x-wallet-alert-key
export WALLET_OPS_ALERT_HEADER_VALUE=replace-me
export WALLET_OPS_HEALTH_SECRET_REF=secret-manager://replace-me
export WALLET_OPS_ALERT_SECRET_REF=secret-manager://replace-me
export WALLET_STORAGE_CREDENTIAL_SECRET_REF=secret-manager://replace-me
export WALLET_STORAGE_RETENTION_POLICY_REF=docs/WALLET_RETENTION_POLICY.md@2026-05-05
export WALLET_STORAGE_IPFS_PINNING_POLICY_REF=replace-with-private-ipfs-pinset-policy-id
export WALLET_STORAGE_FILECOIN_DEAL_POLICY_REF=replace-with-filecoin-deal-policy-id-or-not-used
export WALLET_STORAGE_S3_LIFECYCLE_POLICY_REF=replace-with-s3-lifecycle-policy-id
export WALLET_BACKUP_PURGE_POLICY_REF=replace-with-backup-purge-policy-id
export WALLET_ALERT_RETENTION_POLICY_REF=replace-with-alert-retention-policy-id
export WALLET_PROOF_BACKEND=http-location-region
export WALLET_PROOF_SERVICE_URL=https://verifier.example.com
export WALLET_PROOF_VERIFIER_ID=verifier-http-v1
export WALLET_PROOF_SYSTEM=groth16
export WALLET_PROOF_CIRCUIT_ID=location-region-v1
export WALLET_PROOF_DISTANCE_PROVE_PATH=/prove/location-distance
export WALLET_PROOF_BEARER_TOKEN=replace-me
export WALLET_PROOF_CREDENTIAL_SECRET_REF=secret-manager://replace-me
```

Services:

- `wallet-api`: runs `uvicorn wallet_interface.asgi:app` on port `8000`.
- `wallet-ops`: runs `python -m wallet_interface.ops --watch` every 300 seconds
  and appends JSONL reports under `/var/log/211-ai`.
- `wallet-ui`: serves the built React UI on port `8080`.

Kubernetes reference manifests live in `wallet_interface/deploy/kubernetes/`.
They cover namespace, config, persistent state, API, UI, ops worker, services,
and ingress.

Cloudflare reference edge assets live in `wallet_interface/deploy/cloudflare/`.
They provide a narrow Worker that proxies `/health` and `/ops/health` to the
origin API, supports Cloudflare Access/custom origin-auth headers, rejects
non-health routes at the edge, and can run scheduled ops-health checks.

Required production environment:

- `WALLET_REPOSITORY_ROOT`: durable wallet metadata, audit, grant, revocation,
  and analytics ledger snapshots.
- `WALLET_STORAGE_CONFIG`: encrypted blob storage config. Use replicated
  storage for production, for example local primary plus S3/IPFS/Filecoin
  mirrors.
- `WALLET_STORAGE_RETENTION_POLICY_REF`,
  `WALLET_STORAGE_IPFS_PINNING_POLICY_REF`,
  `WALLET_STORAGE_FILECOIN_DEAL_POLICY_REF`,
  `WALLET_STORAGE_S3_LIFECYCLE_POLICY_REF`,
  `WALLET_BACKUP_PURGE_POLICY_REF`, and
  `WALLET_ALERT_RETENTION_POLICY_REF`: non-secret policy/evidence references
  used by target operations to tie encrypted replica retention to IPFS pinning,
  Filecoin deal expiration, S3 lifecycle, backup purge, and alert-retention
  controls.
- `WALLET_PROOF_MODE=production`: disables simulated proof acceptance.
- `WALLET_PROOF_BACKEND`: production verifier backend selection. Supported
  values now include `http-location-region` for an external verifier service.
- `WALLET_PROOF_SERVICE_URL`: required when
  `WALLET_PROOF_BACKEND=http-location-region`.
- `WALLET_PROOF_VERIFIER_ID`, `WALLET_PROOF_SYSTEM`,
  `WALLET_PROOF_CIRCUIT_ID`: verifier metadata for the HTTP backend.
- `WALLET_PROOF_PROVE_PATH`, `WALLET_PROOF_DISTANCE_PROVE_PATH`,
  `WALLET_PROOF_VERIFY_PATH`: optional HTTP backend endpoint overrides.
- `WALLET_PROOF_BEARER_TOKEN`: optional bearer token for the proof service.
- `WALLET_PROOF_HTTP_HEADER_NAME` / `WALLET_PROOF_HTTP_HEADER_VALUE`: optional
  custom header pair for the proof service.
- `WALLET_PROOF_TIMEOUT_SECONDS`: optional proof backend timeout.
- `WALLET_AUTO_LOAD_REPOSITORY=true`: loads wallet snapshots on API/worker
  start.
- `WALLET_AUTO_PERSIST=true`: persists snapshots after state-changing wallet
  operations, including ops-health audit events.
- `WALLET_OPS_HEALTH_SHARED_SECRET`: when set, `/ops/health` requires either
  `Authorization: Bearer ...` or `X-Wallet-Ops-Shared-Secret`.
- `WALLET_API_CORS_ORIGINS`: comma-separated browser origin allow-list for
  split API/UI deployments. Leave unset when a same-origin gateway fronts both.
- `WALLET_OPS_ALERT_WEBHOOK_URL`: optional webhook target for warning/error
  ops-health alerts emitted by `python -m wallet_interface.ops`.
- `WALLET_OPS_ALERT_ON`: optional minimum alert severity, `warning` or `error`.
- `WALLET_OPS_ALERT_BEARER_TOKEN`: optional bearer token for the alert webhook.
- `WALLET_OPS_ALERT_HEADER_NAME` / `WALLET_OPS_ALERT_HEADER_VALUE`: optional
  custom header pair for receivers that do not use bearer auth.
- `WALLET_OPS_HEALTH_SECRET_REF`, `WALLET_OPS_ALERT_SECRET_REF`,
  `WALLET_PROOF_CREDENTIAL_SECRET_REF`, and
  `WALLET_STORAGE_CREDENTIAL_SECRET_REF`: non-secret secret-manager reference
  paths required by the production readiness report and target signoff packet.

Target IPFS/Filecoin/S3 storage operations:

- Use `wallet_interface/deploy/storage-retention.example.json` as the provider
  mapping template. Store the completed copy in the target evidence system, not
  in git.
- Keep live `WALLET_STORAGE_CONFIG` pointed at providers that the API runtime
  can instantiate. Filecoin mirrors require the deployment to inject a
  Filecoin-capable backend into `WalletInterfaceService`; leave Filecoin marked
  `not-used` in the target mapping until that provider is present.
- Run `GET /ops/health?verify_storage=true`, repair failed records with
  `POST /wallets/{wallet_id}/records/{record_id}/storage/repair` or
  `POST /wallets/{wallet_id}/storage/repair`, then run
  `python -m wallet_interface.ops --validate-production-readiness`.
- Storage repair evidence must show ciphertext hashes, storage types, failure
  counts, and repaired replica counts only. Plaintext wallet data, proof
  witnesses, precise coordinates, storage credentials, and alert/proof tokens
  must not appear in repair output or alert payloads.

The included compose file uses local volumes and defaults to the deterministic
location-region proof backend as an integration-safe production-mode stand-in.
Switch `WALLET_PROOF_BACKEND` to `http-location-region` and provide the proof
service vars before handling real user data. `GET /ops/health` will actively
probe that verifier backend when configured.

Before promoting a verifier-backed environment, run:

```bash
python -m wallet_interface.ops --validate-proof-contract --fail-on-error
python -m wallet_interface.ops --validate-distance-proof-contract --fail-on-error
python -m wallet_interface.ops --validate-production-readiness --fail-on-error
python -m wallet_interface.ops \
  --validate-target-signoff-packet /path/to/target-signoff.json \
  --fail-on-error
```

from the API/ops worker environment. This checks the external verifier health,
prove, verify, and no-witness-leak contract using synthetic witnesses, then
checks the completed retention, credential-reference, staging-artifact, and
organization-review packet.

For repository CI without target `WALLET_*` readiness variables,
`--validate-production-readiness` runs a local synthetic verifier self-check.
In staging and production, set the target env vars above so the same command
validates the real repository, storage, secret-manager references, alert route,
and verifier service.

The Cloudflare Worker assets are reference glue only. They do not replace the
Python API or local `wallet_interface.ops` worker; they front or trigger those
services.
