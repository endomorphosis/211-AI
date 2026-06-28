from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request


ROOT = Path(__file__).resolve().parents[1]
PROOF_TOKEN = "proof-token-ci"


def _send_json(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, sort_keys=True).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _start_mock_verifier(*, leak_witness: bool = False):
    requests: list[dict[str, Any]] = []

    class MockVerifierHandler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("content-length", "0") or "0"))
            payload = json.loads(body.decode("utf-8") or "{}")
            requests.append(
                {
                    "path": self.path,
                    "authorization": self.headers.get("authorization", ""),
                    "payload": payload,
                }
            )
            if self.headers.get("authorization") != f"Bearer {PROOF_TOKEN}":
                _send_json(self, 401, {"ok": False, "status": "unauthorized"})
                return
            if self.path == "/health":
                _send_json(self, 200, {"ok": True, "status": "ready"})
                return
            if self.path in {"/prove/location-region", "/prove/location-distance"}:
                proof_type = str(payload.get("proof_type") or "")
                public_inputs = dict(payload.get("public_inputs") or {})
                if leak_witness:
                    public_inputs["lat"] = payload.get("witness", {}).get("lat")
                _send_json(
                    self,
                    200,
                    {
                        "proof_id": f"mock-{proof_type}",
                        "wallet_id": str(payload.get("wallet_id") or ""),
                        "proof_type": proof_type,
                        "statement": payload.get("statement") or {},
                        "verifier_id": str(payload.get("verifier_id") or ""),
                        "public_inputs": public_inputs,
                        "proof_hash": f"mock-hash-{proof_type}",
                        "witness_record_ids": list(payload.get("witness_record_ids") or []),
                        "is_simulated": False,
                        "proof_system": str(payload.get("proof_system") or ""),
                        "circuit_id": str(payload.get("circuit_id") or ""),
                        "verification_status": "verified",
                        "proof_artifact_ref": f"mock://{proof_type}",
                    },
                )
                return
            if self.path == "/verify":
                _send_json(self, 200, {"verified": True})
                return
            _send_json(self, 404, {"ok": False, "status": "not_found"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), MockVerifierHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, thread, f"http://{host}:{port}", requests


def _run_ops(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "wallet_interface.ops", *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def _run_wallet_cli(
    args: list[str],
    *,
    tmp_path: Path,
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "ipfs_datasets_py.wallet.cli",
            "--wallet-dir",
            str(tmp_path / "cli-wallets"),
            "--blob-dir",
            str(tmp_path / "cli-blobs"),
            "--json",
            *args,
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _start_wallet_api(env: dict[str, str]):
    port = _free_port()
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "wallet_interface.asgi:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 15
    last_error = ""
    while time.time() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate(timeout=1)
            raise AssertionError(f"wallet API exited early: {stdout}\n{stderr}")
        try:
            status, payload = _http_json("GET", f"{base_url}/health")
            if status == 200 and payload.get("status") == "ok":
                return process, base_url
        except Exception as exc:
            last_error = str(exc)
            time.sleep(0.1)
    _stop_process(process)
    raise AssertionError(f"wallet API did not become healthy: {last_error}")


def _stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=5)


def _http_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any]]:
    body = None if payload is None else json.dumps(payload, sort_keys=True).encode("utf-8")
    request_headers = {"content-type": "application/json", **dict(headers or {})}
    req = urllib_request.Request(url, data=body, headers=request_headers, method=method)
    try:
        with urllib_request.urlopen(req, timeout=10) as response:
            response_body = response.read().decode("utf-8")
            return int(response.status), json.loads(response_body or "{}")
    except urllib_error.HTTPError as exc:
        response_body = exc.read().decode("utf-8")
        return int(exc.code), json.loads(response_body or "{}")


def _target_env(tmp_path: Path, verifier_url: str) -> dict[str, str]:
    existing_pythonpath = os.environ.get("PYTHONPATH", "")
    pythonpath = f"{ROOT / 'ipfs_datasets_py'}:{ROOT}"
    if existing_pythonpath:
        pythonpath = f"{pythonpath}:{existing_pythonpath}"
    return {
        **os.environ,
        "PYTHONPATH": pythonpath,
        "IPFS_DATASETS_AUTO_INSTALL": "false",
        "IPFS_AUTO_INSTALL": "false",
        "IPFS_DATASETS_PY_MINIMAL_IMPORTS": "1",
        "WALLET_REPOSITORY_ROOT": str(tmp_path / "wallet-repository"),
        "WALLET_STORAGE_CONFIG": json.dumps(
            {"primary": {"type": "local", "root": str(tmp_path / "wallet-blobs")}},
            sort_keys=True,
        ),
        "WALLET_AUTO_LOAD_REPOSITORY": "true",
        "WALLET_AUTO_PERSIST": "true",
        "WALLET_PROOF_MODE": "production",
        "WALLET_ALLOW_SIMULATED_PROOFS": "false",
        "WALLET_PROOF_BACKEND": "http-location-region",
        "WALLET_PROOF_SERVICE_URL": verifier_url,
        "WALLET_PROOF_VERIFIER_ID": "blackbox-verifier-v1",
        "WALLET_PROOF_SYSTEM": "groth16",
        "WALLET_PROOF_CIRCUIT_ID": "blackbox-location-v1",
        "WALLET_PROOF_PROVE_PATH": "/prove/location-region",
        "WALLET_PROOF_DISTANCE_PROVE_PATH": "/prove/location-distance",
        "WALLET_PROOF_VERIFY_PATH": "/verify",
        "WALLET_PROOF_BEARER_TOKEN": PROOF_TOKEN,
        "WALLET_OPS_HEALTH_SHARED_SECRET": "ops-health-token-ci",
        "WALLET_OPS_ALERT_WEBHOOK_URL": f"{verifier_url}/alerts",
        "WALLET_OPS_ALERT_BEARER_TOKEN": "alert-token-ci",
        "WALLET_OPS_HEALTH_SECRET_REF": "secret://ci/wallet/ops-health",
        "WALLET_OPS_ALERT_SECRET_REF": "secret://ci/wallet/ops-alert",
        "WALLET_PROOF_CREDENTIAL_SECRET_REF": "secret://ci/wallet/proof-verifier",
        "WALLET_STORAGE_CREDENTIAL_SECRET_REF": "secret://ci/wallet/storage",
    }


def _completed_signoff_packet(verifier_url: str) -> dict[str, Any]:
    review = {
        "reviewer": "CI Reviewer",
        "decision": "approved",
        "date": "2026-05-05",
        "evidence": "artifact://ci/review",
    }
    return {
        "environment": {
            "environment_name": "ci-blackbox-wallet",
            "deployment_owner": "211-AI CI",
            "review_date": "2026-05-05",
            "wallet_api_origin": "http://127.0.0.1/wallet-api",
            "wallet_ui_origin": "http://127.0.0.1/wallet-ui",
            "repository_configuration_id": "ci-repository-policy",
            "encrypted_storage_configuration_id": "ci-storage-policy",
            "proof_backend": "http-location-region",
            "proof_verifier_service": verifier_url,
            "proof_verifier_id": "blackbox-verifier-v1",
            "proof_system": "groth16",
            "world_id_enabled_decision": "enabled-for-pilot",
            "world_id_environment": "production",
            "world_id_app_id": "app_ci_world_id_wallet",
            "world_id_rp_id": "rp_ci_world_id_wallet",
            "world_id_verify_endpoint": "https://developer.world.org",
            "retention_policy_version": "docs/WALLET_RETENTION_POLICY.md@2026-05-05",
        },
        "secret_manager_refs": {
            "ops_health_secret": "secret://ci/wallet/ops-health",
            "alert_credentials": "secret://ci/wallet/ops-alert",
            "proof_verifier_credentials": "secret://ci/wallet/proof-verifier",
            "storage_credentials": "secret://ci/wallet/storage",
            "world_id_rp_signing_key": "secret://ci/wallet/world-id-rp-signing",
            "world_id_nullifier_commitment_key": "secret://ci/wallet/world-id-nullifier",
        },
        "artifact_refs": {
            "release_check_evidence": "artifact://ci/release-checks",
            "readiness_report": "artifact://ci/readiness",
            "ops_health_report": "artifact://ci/ops-health",
            "proof_contract_report": "artifact://ci/proof-contract",
            "distance_proof_contract_report": "artifact://ci/distance-proof-contract",
            "world_id_staging_simulator": "artifact://ci/world-id/staging-simulator",
            "world_id_fullstack_playwright": "artifact://ci/world-id/fullstack",
            "world_id_ux_review": "artifact://ci/world-id/ux-review",
            "world_id_privacy_nullifier_review": "artifact://ci/world-id/privacy-nullifier",
            "world_id_security_signoff": "artifact://ci/world-id/security",
            "world_id_support_playbook": "artifact://ci/world-id/support",
        },
        "retention_mapping": {
            "policy_version": "ci-retention-policy",
            "repository_lifecycle": "ci repository lifecycle",
            "encrypted_storage_lifecycle": "ci storage lifecycle",
            "backup_purge_sla": "30 days",
            "ipfs_pinning": "ci private pinset only",
            "filecoin_deal_expiration": "not used in CI",
            "s3_lifecycle": "ci S3 lifecycle fixture covers current and noncurrent encrypted objects",
            "log_retention": "90 days",
            "alert_retention": "90 days",
            "deletion_tombstone_retention": "7 years",
        },
        "reviewer_signoff": {
            "security": dict(review),
            "privacy": dict(review),
            "legal_policy": dict(review),
            "accessibility_usability": dict(review),
            "operations_on_call": dict(review),
            "product_owner": dict(review),
        },
        "analytics_privacy_review": {
            "approved_templates": [
                {
                    "template_id": "ci_needs_by_region_v1",
                    "reviewer": "CI Privacy Reviewer",
                    "review_date": "2026-05-05",
                    "min_cohort_size": 10,
                    "epsilon_budget": 1.0,
                    "allowed_dimensions": ["region", "need_category"],
                    "retention_decision": "retain aggregate CI artifact only",
                    "withdrawal_behavior": "future contributions blocked; prior aggregate audit retained",
                }
            ]
        },
        "launch_decision": {
            "decision": "approved",
            "approved_launch_window": "2026-05-05T18:00:00Z/2026-05-05T20:00:00Z",
            "required_exceptions": [],
            "first_post_launch_readiness_run": "2026-05-05T21:00:00Z",
            "first_post_launch_retention_audit": "2026-06-05",
        },
    }


def _last_json_line(output: str) -> dict[str, Any]:
    lines = [line for line in output.splitlines() if line.strip()]
    assert lines, "expected JSON output"
    return json.loads(lines[-1])


def _json_stdout(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(result.stdout)


def test_production_handoff_blackbox_accepts_mocked_staging_environment(tmp_path: Path) -> None:
    server, thread, verifier_url, requests = _start_mock_verifier()
    try:
        env = _target_env(tmp_path, verifier_url)

        readiness = _run_ops(["--validate-production-readiness"], env=env)
        assert readiness.returncode == 0, readiness.stderr or readiness.stdout
        readiness_report = _last_json_line(readiness.stdout)
        assert readiness_report["status"] == "ok"
        assert {check["name"]: check["status"] for check in readiness_report["checks"]} == {
            "persistence_environment": "ok",
            "proof_environment": "ok",
            "proof_credentials": "ok",
            "ops_credentials": "ok",
            "secret_manager_references": "ok",
            "ops_health": "ok",
            "proof_contract": "ok",
            "distance_proof_contract": "ok",
        }
        rendered = json.dumps(readiness_report, sort_keys=True)
        for secret in (PROOF_TOKEN, "alert-token-ci", "ops-health-token-ci", "45.5152", "-122.6784"):
            assert secret not in rendered

        packet_path = tmp_path / "target-signoff.json"
        packet_path.write_text(json.dumps(_completed_signoff_packet(verifier_url), sort_keys=True), encoding="utf-8")
        signoff = _run_ops(["--validate-target-signoff-packet", str(packet_path)], env=env)
        assert signoff.returncode == 0, signoff.stderr or signoff.stdout
        signoff_report = _last_json_line(signoff.stdout)
        assert signoff_report["status"] == "ok"

        paths = [entry["path"] for entry in requests]
        assert "/health" in paths
        assert "/prove/location-region" in paths
        assert "/prove/location-distance" in paths
        assert paths.count("/verify") >= 2
        assert all(entry["authorization"] == f"Bearer {PROOF_TOKEN}" for entry in requests)
        prove_payloads = [entry["payload"] for entry in requests if entry["path"].startswith("/prove/")]
        assert {payload["proof_type"] for payload in prove_payloads} == {"location_region", "location_distance"}
        assert all("witness" in payload for payload in prove_payloads)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_production_handoff_blackbox_rejects_verifier_that_leaks_witness(tmp_path: Path) -> None:
    server, thread, verifier_url, _requests = _start_mock_verifier(leak_witness=True)
    try:
        result = _run_ops(["--validate-production-readiness"], env=_target_env(tmp_path, verifier_url))

        assert result.returncode == 2
        report = _last_json_line(result.stdout)
        checks = {check["name"]: check for check in report["checks"]}
        assert report["status"] == "error"
        assert checks["proof_contract"]["status"] == "error"
        assert checks["distance_proof_contract"]["status"] == "error"
        region_safety = {
            check["name"]: check["status"]
            for check in checks["proof_contract"]["details"]["checks"]
        }
        distance_safety = {
            check["name"]: check["status"]
            for check in checks["distance_proof_contract"]["details"]["checks"]
        }
        assert region_safety["public_input_safety"] == "error"
        assert distance_safety["public_input_safety"] == "error"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_wallet_cli_blackbox_exercises_subprocess_sharing_export_and_analytics(tmp_path: Path) -> None:
    env = _target_env(tmp_path, "http://127.0.0.1:9")
    owner_did = "did:key:cli-owner"
    delegate_did = "did:key:cli-delegate"
    analyst_did = "did:key:cli-analyst"
    owner_key_hex = "33" * 32
    delegate_key_hex = "44" * 32

    created = _json_stdout(
        _run_wallet_cli(["create", "--owner-did", owner_did], tmp_path=tmp_path, env=env)
    )
    wallet_id = created["wallet_id"]

    plaintext = "CLI delegate may read this document after explicit authorization."
    source_path = tmp_path / "cli-document.txt"
    source_path.write_text(plaintext, encoding="utf-8")
    added = _json_stdout(
        _run_wallet_cli(
            [
                "add",
                "--wallet-id",
                wallet_id,
                "--actor-did",
                owner_did,
                "--key-hex",
                owner_key_hex,
                "--path",
                str(source_path),
                "--title",
                "CLI Blackbox Document",
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    record_id = added["record_id"]

    denied = _run_wallet_cli(
        [
            "decrypt",
            "--wallet-id",
            wallet_id,
            "--record-id",
            record_id,
            "--actor-did",
            delegate_did,
            "--key-hex",
            delegate_key_hex,
            "--out",
            str(tmp_path / "denied.txt"),
        ],
        tmp_path=tmp_path,
        env=env,
    )
    assert denied.returncode == 1
    assert "grant" in json.loads(denied.stdout)["error"]

    share = _json_stdout(
        _run_wallet_cli(
            [
                "share",
                "--wallet-id",
                wallet_id,
                "--record-id",
                record_id,
                "--issuer-did",
                owner_did,
                "--audience-did",
                delegate_did,
                "--issuer-key-hex",
                owner_key_hex,
                "--recipient-key-hex",
                delegate_key_hex,
                "--can",
                "record/decrypt",
                "--output-type",
                "plaintext",
                "--purpose",
                "benefits_application",
                "--issue-invocation",
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert share["invocation_token"].startswith("wallet-ucan-v1.")

    delegated_out = tmp_path / "delegated.txt"
    decrypted = _json_stdout(
        _run_wallet_cli(
            [
                "decrypt-invocation",
                "--wallet-id",
                wallet_id,
                "--record-id",
                record_id,
                "--actor-did",
                delegate_did,
                "--key-hex",
                delegate_key_hex,
                "--invocation-token",
                share["invocation_token"],
                "--out",
                str(delegated_out),
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert decrypted["size_bytes"] == len(plaintext)
    assert delegated_out.read_text(encoding="utf-8") == plaintext

    receipts = _json_stdout(
        _run_wallet_cli(
            ["grant-receipts", "--wallet-id", wallet_id, "--audience-did", delegate_did],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert any(receipt["grant_id"] == share["grant_id"] for receipt in receipts["receipts"])

    export_grant = _json_stdout(
        _run_wallet_cli(
            [
                "export-grant",
                "--wallet-id",
                wallet_id,
                "--record-id",
                record_id,
                "--issuer-did",
                owner_did,
                "--audience-did",
                delegate_did,
                "--issuer-key-hex",
                owner_key_hex,
                "--recipient-key-hex",
                delegate_key_hex,
                "--purpose",
                "benefits_portability",
                "--issue-invocation",
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert export_grant["invocation_token"].startswith("wallet-ucan-v1.")

    bundle_path = tmp_path / "cli-export.json"
    exported = _json_stdout(
        _run_wallet_cli(
            [
                "export-bundle",
                "--wallet-id",
                wallet_id,
                "--actor-did",
                delegate_did,
                "--key-hex",
                delegate_key_hex,
                "--invocation-token",
                export_grant["invocation_token"],
                "--record-id",
                record_id,
                "--out",
                str(bundle_path),
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert exported["record_count"] == 1
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    rendered_bundle = json.dumps(bundle, sort_keys=True)
    assert plaintext not in rendered_bundle
    assert bundle["bundle_id"] == f"export-{bundle['bundle_hash'][:24]}"

    verified = _json_stdout(
        _run_wallet_cli(["verify-export-bundle", "--path", str(bundle_path)], tmp_path=tmp_path, env=env)
    )
    assert verified["valid"] is True
    assert verified["hash_valid"] is True
    assert verified["schema_valid"] is True
    imported = _json_stdout(
        _run_wallet_cli(["import-export-bundle", "--path", str(bundle_path)], tmp_path=tmp_path, env=env)
    )
    assert imported["record_count"] == 1
    storage = _json_stdout(
        _run_wallet_cli(["export-bundle-storage", "--path", str(bundle_path)], tmp_path=tmp_path, env=env)
    )
    assert storage["ok"] is True

    revoked = _json_stdout(
        _run_wallet_cli(
            [
                "revoke",
                "--wallet-id",
                wallet_id,
                "--actor-did",
                owner_did,
                "--grant-id",
                share["grant_id"],
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert revoked["grant_status"] == "revoked"
    blocked = _run_wallet_cli(
        [
            "decrypt-invocation",
            "--wallet-id",
            wallet_id,
            "--record-id",
            record_id,
            "--actor-did",
            delegate_did,
            "--key-hex",
            delegate_key_hex,
            "--invocation-token",
            share["invocation_token"],
            "--out",
            str(tmp_path / "blocked.txt"),
        ],
        tmp_path=tmp_path,
        env=env,
    )
    assert blocked.returncode == 1
    assert "not active" in json.loads(blocked.stdout)["error"]

    revoked_receipts = _json_stdout(
        _run_wallet_cli(
            [
                "grant-receipts",
                "--wallet-id",
                wallet_id,
                "--audience-did",
                delegate_did,
                "--status",
                "revoked",
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert any(receipt["grant_id"] == share["grant_id"] for receipt in revoked_receipts["receipts"])

    template = _json_stdout(
        _run_wallet_cli(
            [
                "analytics-template",
                "--wallet-id",
                wallet_id,
                "--template-id",
                "cli_needs_v1",
                "--title",
                "CLI Needs",
                "--purpose",
                "CLI aggregate validation",
                "--record-type",
                "document",
                "--derived-field",
                "need_category",
                "--min-cohort-size",
                "1",
                "--epsilon-budget",
                "1.0",
                "--created-by",
                analyst_did,
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert template["status"] == "approved"

    consent = _json_stdout(
        _run_wallet_cli(
            [
                "analytics-consent",
                "--wallet-id",
                wallet_id,
                "--actor-did",
                owner_did,
                "--template-id",
                "cli_needs_v1",
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    contribution = _json_stdout(
        _run_wallet_cli(
            [
                "analytics-contribute",
                "--wallet-id",
                wallet_id,
                "--actor-did",
                owner_did,
                "--consent-id",
                consent["consent_id"],
                "--template-id",
                "cli_needs_v1",
                "--field",
                "need_category=housing",
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert contribution["template_id"] == "cli_needs_v1"
    aggregate = _json_stdout(
        _run_wallet_cli(
            [
                "analytics-count",
                "--wallet-id",
                wallet_id,
                "--template-id",
                "cli_needs_v1",
                "--epsilon",
                "0.25",
                "--min-cohort-size",
                "1",
            ],
            tmp_path=tmp_path,
            env=env,
        )
    )
    assert aggregate["released"] is True
    assert aggregate["privacy_budget_spent"] == 0.25

    audit = _json_stdout(
        _run_wallet_cli(["audit", "--wallet-id", wallet_id], tmp_path=tmp_path, env=env)
    )
    assert audit["event_count"] >= 10
    assert audit["audit_head"]


def test_wallet_api_blackbox_exercises_live_workflow_and_persistence(tmp_path: Path) -> None:
    server, thread, verifier_url, requests = _start_mock_verifier()
    api_process: subprocess.Popen[str] | None = None
    restarted_process: subprocess.Popen[str] | None = None
    try:
        env = _target_env(tmp_path, verifier_url)
        api_process, api_url = _start_wallet_api(env)
        owner_did = "did:key:blackbox-owner"

        status, unauthorized = _http_json("GET", f"{api_url}/ops/health?verify_storage=true")
        assert status == 401
        assert unauthorized["detail"] == "ops health authorization required"

        status, wallet = _http_json("POST", f"{api_url}/wallets", {"owner_did": owner_did})
        assert status == 200
        wallet_id = wallet["wallet_id"]

        status, document = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/documents/text",
            {
                "actor_did": owner_did,
                "filename": "blackbox-benefits.txt",
                "title": "Blackbox Benefits Note",
                "text": (
                    "Jane Example needs rent assistance. Email jane@example.org "
                    "or call 503-555-1212. SSN 123-45-6789. SNAP follow up."
                ),
            },
        )
        assert status == 200
        document_id = document["record_id"]

        status, location = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/locations",
            {"actor_did": owner_did, "lat": 45.515232, "lon": -122.678385},
        )
        assert status == 200
        location_id = location["record_id"]

        status, region_proof = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/locations/{location_id}/region-proofs",
            {"actor_did": owner_did, "region_id": "multnomah-county"},
        )
        assert status == 200
        assert region_proof["proof_type"] == "location_region"
        assert region_proof["is_simulated"] is False
        assert "45.515232" not in json.dumps(region_proof, sort_keys=True)

        status, distance_proof = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/locations/{location_id}/distance-proofs",
            {
                "actor_did": owner_did,
                "target_id": "shelter-west",
                "target_lat": 45.516,
                "target_lon": -122.679,
                "max_distance_km": 1.0,
            },
        )
        assert status == 200
        assert distance_proof["proof_type"] == "location_distance"
        assert distance_proof["public_inputs"]["target_id"] == "shelter-west"
        assert "45.516" not in json.dumps(distance_proof, sort_keys=True)

        status, redacted_analysis = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/records/{document_id}/analyze/redacted",
            {"actor_did": owner_did},
        )
        assert status == 200
        rendered_analysis = json.dumps(redacted_analysis, sort_keys=True)
        assert redacted_analysis["output"]["output_policy"] == "redacted_derived_only"
        assert "jane@example.org" not in rendered_analysis
        assert "503-555-1212" not in rendered_analysis
        assert "123-45-6789" not in rendered_analysis
        assert "Jane Example" not in rendered_analysis

        owner_key_hex = "11" * 32
        delegate_key_hex = "22" * 32
        delegate_did = "did:key:blackbox-delegate"
        status, shared_document = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/documents/text",
            {
                "actor_did": owner_did,
                "key_hex": owner_key_hex,
                "filename": "blackbox-shared-document.txt",
                "title": "Blackbox Shared Document",
                "text": "Delegate may view this document after explicit UCAN authorization.",
            },
        )
        assert status == 200
        shared_document_id = shared_document["record_id"]

        status, denied_decrypt = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/records/{shared_document_id}/decrypt",
            {"actor_did": delegate_did, "actor_key_hex": delegate_key_hex},
        )
        assert status == 400
        assert "grant" in denied_decrypt["detail"]

        status, record_grant = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/records/{shared_document_id}/grants",
            {
                "issuer_did": owner_did,
                "audience_did": delegate_did,
                "issuer_key_hex": owner_key_hex,
                "audience_key_hex": delegate_key_hex,
                "abilities": ["record/decrypt", "record/analyze"],
                "purpose": "benefits_application",
                "output_types": ["plaintext", "summary"],
                "user_presence_required": True,
            },
        )
        assert status == 200
        assert record_grant["caveats"]["user_presence_required"] is True

        status, receipts = _http_json(
            "GET",
            f"{api_url}/wallets/{wallet_id}/grant-receipts?audience_did={delegate_did}",
        )
        assert status == 200
        assert any(
            receipt["grant_id"] == record_grant["grant_id"] and receipt["status"] == "active"
            for receipt in receipts["receipts"]
        )

        status, missing_presence = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/records/{shared_document_id}/decrypt-invocations",
            {
                "actor_did": delegate_did,
                "actor_key_hex": delegate_key_hex,
                "grant_id": record_grant["grant_id"],
                "purpose": "benefits_application",
            },
        )
        assert status == 400
        assert "user presence" in missing_presence["detail"]

        status, decrypt_invocation = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/records/{shared_document_id}/decrypt-invocations",
            {
                "actor_did": delegate_did,
                "actor_key_hex": delegate_key_hex,
                "grant_id": record_grant["grant_id"],
                "purpose": "benefits_application",
                "user_present": True,
            },
        )
        assert status == 200
        decrypt_token = decrypt_invocation["token"]
        assert decrypt_token.startswith("wallet-ucan-v1.")

        status, delegated_plaintext = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/records/{shared_document_id}/decrypt",
            {
                "actor_did": delegate_did,
                "actor_key_hex": delegate_key_hex,
                "invocation_token": decrypt_token,
            },
        )
        assert status == 200
        assert delegated_plaintext["text"] == "Delegate may view this document after explicit UCAN authorization."

        status, export_without_grant = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/exports",
            {
                "actor_did": delegate_did,
                "actor_key_hex": delegate_key_hex,
                "record_ids": [shared_document_id, location_id],
            },
        )
        assert status == 400
        assert "grant" in export_without_grant["detail"]

        status, export_grant = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/exports/grants",
            {
                "issuer_did": owner_did,
                "audience_did": delegate_did,
                "issuer_key_hex": owner_key_hex,
                "audience_key_hex": delegate_key_hex,
                "record_ids": [shared_document_id, location_id],
                "purpose": "benefits_portability",
            },
        )
        assert status == 200
        assert export_grant["caveats"]["output_types"] == ["encrypted_export_bundle"]

        status, export_invocation = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/exports/invocations",
            {
                "actor_did": delegate_did,
                "actor_key_hex": delegate_key_hex,
                "grant_id": export_grant["grant_id"],
                "record_ids": [shared_document_id],
                "purpose": "benefits_portability",
            },
        )
        assert status == 200
        export_token = export_invocation["invocation_token"]
        assert export_token.startswith("wallet-ucan-v1.")

        status, bundle = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/exports",
            {
                "actor_did": delegate_did,
                "actor_key_hex": delegate_key_hex,
                "invocation_token": export_token,
                "record_ids": [shared_document_id],
            },
        )
        assert status == 200
        assert bundle["bundle_type"] == "wallet_export_v1"
        assert bundle["bundle_id"] == f"export-{bundle['bundle_hash'][:24]}"
        assert [record["record_id"] for record in bundle["records"]] == [shared_document_id]
        assert "controller_dids" not in bundle["wallet"]
        assert "device_dids" not in bundle["wallet"]
        rendered_bundle = json.dumps(bundle, sort_keys=True)
        assert "Delegate may view this document" not in rendered_bundle
        assert "45.515232" not in rendered_bundle
        assert "-122.678385" not in rendered_bundle

        status, verified_export = _http_json("POST", f"{api_url}/exports/verify", {"bundle": bundle})
        assert status == 200
        assert verified_export["valid"] is True
        status, export_storage = _http_json("POST", f"{api_url}/exports/storage", {"bundle": bundle})
        assert status == 200
        assert export_storage["ok"] is True
        assert export_storage["record_count"] == 1
        status, imported_export = _http_json("POST", f"{api_url}/exports/import", {"bundle": bundle})
        assert status == 200
        assert imported_export["bundle_hash"] == bundle["bundle_hash"]
        assert imported_export["record_count"] == 1

        tampered_bundle = {**bundle, "records": []}
        status, tampered_verification = _http_json(
            "POST",
            f"{api_url}/exports/verify",
            {"bundle": tampered_bundle},
        )
        assert status == 200
        assert tampered_verification["valid"] is False

        status, revoked_export = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/grants/{export_grant['grant_id']}/revoke",
            {"actor_did": owner_did},
        )
        assert status == 200
        assert revoked_export["status"] == "revoked"
        status, blocked_export = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/exports",
            {
                "actor_did": delegate_did,
                "actor_key_hex": delegate_key_hex,
                "invocation_token": export_token,
                "record_ids": [shared_document_id],
            },
        )
        assert status == 400
        assert "not active" in blocked_export["detail"]

        status, revoked_record_grant = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/grants/{record_grant['grant_id']}/revoke",
            {"actor_did": owner_did},
        )
        assert status == 200
        assert revoked_record_grant["status"] == "revoked"
        status, blocked_decrypt = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/records/{shared_document_id}/decrypt",
            {
                "actor_did": delegate_did,
                "actor_key_hex": delegate_key_hex,
                "invocation_token": decrypt_token,
            },
        )
        assert status == 400
        assert "not active" in blocked_decrypt["detail"]

        status, audit = _http_json("GET", f"{api_url}/wallets/{wallet_id}/audit")
        assert status == 200
        actions = [event["action"] for event in audit["events"]]
        assert "grant/create" in actions
        assert "invocation/issue" in actions
        assert "invocation/verify" in actions
        assert "record/decrypt" in actions
        assert "export/create" in actions
        assert actions.count("grant/revoke") >= 2

        status, template = _http_json(
            "POST",
            f"{api_url}/analytics/templates",
            {
                "template_id": "blackbox_needs_v1",
                "title": "Blackbox Needs",
                "purpose": "CI workflow validation",
                "allowed_record_types": ["document", "location"],
                "allowed_derived_fields": ["region", "need_category"],
                "min_cohort_size": 1,
                "epsilon_budget": 1.0,
                "created_by": "did:key:blackbox-analyst",
            },
        )
        assert status == 200
        assert template["status"] == "approved"

        status, consent = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/analytics/consents/from-template",
            {"actor_did": owner_did, "template_id": "blackbox_needs_v1"},
        )
        assert status == 200

        status, contribution = _http_json(
            "POST",
            f"{api_url}/wallets/{wallet_id}/analytics/contributions",
            {
                "actor_did": owner_did,
                "consent_id": consent["consent_id"],
                "template_id": "blackbox_needs_v1",
                "fields": {"region": "multnomah", "need_category": "housing"},
            },
        )
        assert status == 200
        assert contribution["template_id"] == "blackbox_needs_v1"

        status, aggregate = _http_json(
            "POST",
            f"{api_url}/analytics/blackbox_needs_v1/count",
            {"epsilon": 0.25, "min_cohort_size": 1},
        )
        assert status == 200
        assert aggregate["released"] is True
        assert aggregate["privacy_budget_spent"] == 0.25

        status, health = _http_json(
            "GET",
            f"{api_url}/ops/health?verify_storage=true",
            headers={"authorization": "Bearer ops-health-token-ci"},
        )
        assert status == 200
        assert health["status"] == "ok"
        assert {check["name"] for check in health["checks"]} >= {
            "repository",
            "storage_availability",
            "proof_registry",
            "revocation_propagation",
            "privacy_budget",
        }

        _stop_process(api_process)
        api_process = None

        restarted_process, restarted_url = _start_wallet_api(env)
        status, restored_wallet = _http_json("GET", f"{restarted_url}/wallets/{wallet_id}")
        assert status == 200
        assert restored_wallet["wallet_id"] == wallet_id
        status, restored_records = _http_json("GET", f"{restarted_url}/wallets/{wallet_id}/records")
        assert status == 200
        assert {record["record_id"] for record in restored_records["records"]} >= {
            document_id,
            location_id,
            shared_document_id,
        }
        status, restored_receipts = _http_json(
            "GET",
            f"{restarted_url}/wallets/{wallet_id}/grant-receipts?audience_did={delegate_did}&status=revoked",
        )
        assert status == 200
        assert {
            receipt["grant_id"]
            for receipt in restored_receipts["receipts"]
            if receipt["status"] == "revoked"
        } >= {record_grant["grant_id"], export_grant["grant_id"]}
        status, restored_audit = _http_json("GET", f"{restarted_url}/wallets/{wallet_id}/audit")
        assert status == 200
        restored_actions = [event["action"] for event in restored_audit["events"]]
        assert "export/create" in restored_actions
        assert restored_actions.count("grant/revoke") >= 2

        prove_paths = [entry["path"] for entry in requests if entry["path"].startswith("/prove/")]
        assert "/prove/location-region" in prove_paths
        assert "/prove/location-distance" in prove_paths
    finally:
        if api_process is not None:
            _stop_process(api_process)
        if restarted_process is not None:
            _stop_process(restarted_process)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
