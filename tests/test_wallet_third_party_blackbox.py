from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request


ROOT = Path(__file__).resolve().parents[1]


def _write_service_directory(tmp_path: Path) -> Path:
    path = tmp_path / "services.jsonl"
    rows = [
        {
            "id": "housing-navigation",
            "name": "Portland Housing Navigation",
            "description": "Rent assistance, shelter placement, and housing case management.",
            "categories": "housing shelter rent case management",
            "city": "Portland",
            "state": "OR",
        },
        {
            "id": "food-benefits",
            "name": "Food Benefits Desk",
            "description": "SNAP screening and grocery support.",
            "categories": "food snap benefits",
            "city": "Portland",
            "state": "OR",
        },
    ]
    path.write_text("\n".join(json.dumps(row, sort_keys=True) for row in rows) + "\n", encoding="utf-8")
    return path


def _target_env(tmp_path: Path, services_jsonl: Path) -> dict[str, str]:
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
        "WALLET_SERVICES_JSONL": str(services_jsonl),
        "WALLET_STORAGE_CONFIG": json.dumps(
            {"primary": {"type": "local", "root": str(tmp_path / "wallet-blobs")}},
            sort_keys=True,
        ),
        "WALLET_AUTO_LOAD_REPOSITORY": "true",
        "WALLET_AUTO_PERSIST": "true",
        "WALLET_PROOF_MODE": "development",
        "WALLET_ALLOW_SIMULATED_PROOFS": "true",
    }


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _http_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    body = None if payload is None else json.dumps(payload, sort_keys=True).encode("utf-8")
    req = urllib_request.Request(
        url,
        data=body,
        headers={"content-type": "application/json"},
        method=method,
    )
    try:
        with urllib_request.urlopen(req, timeout=10) as response:
            response_body = response.read().decode("utf-8")
            return int(response.status), json.loads(response_body or "{}")
    except urllib_error.HTTPError as exc:
        response_body = exc.read().decode("utf-8")
        return int(exc.code), json.loads(response_body or "{}")


def _start_wallet_api(env: dict[str, str]) -> tuple[subprocess.Popen[str], str]:
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
        except Exception as exc:  # pragma: no cover - startup timing dependent.
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


def _assert_status(status: int, payload: dict[str, Any], expected: int = 200) -> None:
    assert status == expected, payload


def test_third_party_sharing_harness_exercises_public_wallet_api(tmp_path: Path) -> None:
    services_jsonl = _write_service_directory(tmp_path)
    env = _target_env(tmp_path, services_jsonl)
    process, base_url = _start_wallet_api(env)

    try:
        owner_did = "did:key:wallet-owner"
        analyst_did = "did:key:benefits-analyst"
        navigator_did = "did:key:service-navigator"
        proof_checker_did = "did:key:eligibility-checker"
        export_recipient_did = "did:key:export-recipient"
        owner_key = secrets.token_hex(32)
        analyst_key = secrets.token_hex(32)
        navigator_key = secrets.token_hex(32)
        export_recipient_key = secrets.token_hex(32)
        exact_lat = 45.515232
        exact_lon = -122.678385

        status, wallet = _http_json("POST", f"{base_url}/wallets", {"owner_did": owner_did})
        _assert_status(status, wallet)
        wallet_id = wallet["wallet_id"]

        status, document = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/documents/text",
            {
                "actor_did": owner_did,
                "key_hex": owner_key,
                "filename": "intake-note.txt",
                "title": "Benefits intake note",
                "text": (
                    "Jane Example emailed jane@example.org from a shelter intake desk. "
                    "Phone 503-555-1212. SSN 123-45-6789. Needs rent, SNAP, and clinic help."
                ),
            },
        )
        _assert_status(status, document)
        document_id = document["record_id"]

        status, location = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/locations",
            {"actor_did": owner_did, "lat": exact_lat, "lon": exact_lon},
        )
        _assert_status(status, location)
        location_id = location["record_id"]

        status, analysis_grant = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/records/{document_id}/grants",
            {
                "issuer_did": owner_did,
                "audience_did": analyst_did,
                "issuer_key_hex": owner_key,
                "audience_key_hex": analyst_key,
                "abilities": ["record/analyze"],
                "purpose": "benefits_screening",
                "output_types": ["redacted_derived_only"],
            },
        )
        _assert_status(status, analysis_grant)
        assert analysis_grant["abilities"] == ["record/analyze"]
        assert analysis_grant["caveats"]["output_types"] == ["redacted_derived_only"]

        status, analysis_invocation = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/records/{document_id}/analysis-invocations",
            {
                "grant_id": analysis_grant["grant_id"],
                "actor_did": analyst_did,
                "actor_key_hex": analyst_key,
                "purpose": "benefits_screening",
                "output_types": ["redacted_derived_only"],
            },
        )
        _assert_status(status, analysis_invocation)
        status, redacted_analysis = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/records/{document_id}/analyze/redacted",
            {
                "actor_did": analyst_did,
                "actor_key_hex": analyst_key,
                "invocation_token": analysis_invocation["token"],
            },
        )
        _assert_status(status, redacted_analysis)
        analysis_output = json.dumps(redacted_analysis["output"], sort_keys=True)
        assert redacted_analysis["output"]["output_policy"] == "redacted_derived_only"
        assert {"housing", "food", "health"}.issubset(
            set(redacted_analysis["output"]["derived_facts"]["need_categories"])
        )
        for secret in ("Jane Example", "jane@example.org", "503-555-1212", "123-45-6789"):
            assert secret not in analysis_output

        status, location_grant = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/locations/{location_id}/coarse-grants",
            {
                "issuer_did": owner_did,
                "audience_did": navigator_did,
                "audience_key_hex": navigator_key,
            },
        )
        _assert_status(status, location_grant)
        status, location_invocation = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/locations/{location_id}/coarse-invocations",
            {
                "grant_id": location_grant["grant_id"],
                "actor_did": navigator_did,
                "actor_key_hex": navigator_key,
                "purpose": "service_matching",
            },
        )
        _assert_status(status, location_invocation)
        status, service_matches = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/services/match",
            {
                "location_record_id": location_id,
                "actor_did": navigator_did,
                "actor_key_hex": navigator_key,
                "invocation_token": location_invocation["token"],
                "need_terms": ["housing"],
                "limit": 5,
            },
        )
        _assert_status(status, service_matches)
        assert service_matches["matches"][0]["service"]["id"] == "housing-navigation"
        assert "matches need:housing" in service_matches["matches"][0]["reasons"]
        assert str(exact_lat) not in json.dumps(service_matches, sort_keys=True)
        assert str(exact_lon) not in json.dumps(service_matches, sort_keys=True)

        status, region_grant = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/locations/{location_id}/region-proof-grants",
            {"issuer_did": owner_did, "audience_did": proof_checker_did},
        )
        _assert_status(status, region_grant)
        status, region_proof = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/locations/{location_id}/region-proofs",
            {
                "actor_did": proof_checker_did,
                "grant_id": region_grant["grant_id"],
                "region_id": "multnomah_county",
            },
        )
        _assert_status(status, region_proof)
        assert region_proof["proof_type"] == "location_region"
        assert region_proof["public_inputs"]["claim"] == "location_in_region"
        assert "lat" not in str(region_proof["public_inputs"]).lower()
        assert "lon" not in str(region_proof["public_inputs"]).lower()
        assert "witness" not in str(region_proof["public_inputs"]).lower()

        status, distance_grant = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/locations/{location_id}/distance-proof-grants",
            {
                "issuer_did": owner_did,
                "audience_did": proof_checker_did,
                "target_id": "shelter-west",
                "max_distance_km": 2.0,
            },
        )
        _assert_status(status, distance_grant)
        status, distance_proof = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/locations/{location_id}/distance-proofs",
            {
                "actor_did": proof_checker_did,
                "grant_id": distance_grant["grant_id"],
                "target_id": "shelter-west",
                "target_lat": 45.516,
                "target_lon": -122.679,
                "max_distance_km": 2.0,
            },
        )
        _assert_status(status, distance_proof)
        assert distance_proof["proof_type"] == "location_distance"
        assert distance_proof["public_inputs"]["claim"] == "location_within_distance"
        assert "lat" not in str(distance_proof["public_inputs"]).lower()
        assert "lon" not in str(distance_proof["public_inputs"]).lower()
        assert "witness" not in str(distance_proof["public_inputs"]).lower()
        proof_json = json.dumps({"region": region_proof, "distance": distance_proof}, sort_keys=True)
        for secret in (str(exact_lat), str(exact_lon), "45.516", "-122.679"):
            assert secret not in proof_json

        status, proofs = _http_json("GET", f"{base_url}/wallets/{wallet_id}/proofs")
        _assert_status(status, proofs)
        assert {proof["proof_id"] for proof in proofs["proofs"]} == {
            region_proof["proof_id"],
            distance_proof["proof_id"],
        }

        status, export_grant = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/exports/grants",
            {
                "issuer_did": owner_did,
                "audience_did": export_recipient_did,
                "audience_key_hex": export_recipient_key,
                "record_ids": [document_id, location_id],
                "purpose": "partner_case_transfer",
            },
        )
        _assert_status(status, export_grant)
        assert export_grant["caveats"]["output_types"] == ["encrypted_export_bundle"]
        status, export_invocation = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/exports/invocations",
            {
                "grant_id": export_grant["grant_id"],
                "actor_did": export_recipient_did,
                "actor_key_hex": export_recipient_key,
                "record_ids": [document_id, location_id],
                "purpose": "partner_case_transfer",
                "output_types": ["encrypted_export_bundle"],
            },
        )
        _assert_status(status, export_invocation)
        status, bundle = _http_json(
            "POST",
            f"{base_url}/wallets/{wallet_id}/exports",
            {
                "actor_did": export_recipient_did,
                "actor_key_hex": export_recipient_key,
                "invocation_token": export_invocation["invocation_token"],
                "record_ids": [document_id, location_id],
            },
        )
        _assert_status(status, bundle)
        assert bundle["bundle_type"] == "wallet_export_v1"
        assert bundle["bundle_id"] == f"export-{bundle['bundle_hash'][:24]}"
        assert len(bundle["records"]) == 2
        assert len(bundle["proofs"]) == 2
        assert len(bundle["derived_artifacts"]) == 1
        bundle_json = json.dumps(bundle, sort_keys=True)
        for secret in (
            "Jane Example",
            "jane@example.org",
            "503-555-1212",
            "123-45-6789",
            str(exact_lat),
            str(exact_lon),
        ):
            assert secret not in bundle_json

        status, verified = _http_json("POST", f"{base_url}/exports/verify", {"bundle": bundle})
        _assert_status(status, verified)
        assert verified["valid"] is True
        assert verified["hash_valid"] is True
        assert verified["schema_valid"] is True
        status, imported = _http_json("POST", f"{base_url}/exports/import", {"bundle": bundle})
        _assert_status(status, imported)
        assert imported["record_count"] == 2
        status, storage = _http_json("POST", f"{base_url}/exports/storage", {"bundle": bundle})
        _assert_status(status, storage)
        assert storage["record_count"] == 2

        for grant_id in [
            analysis_grant["grant_id"],
            location_grant["grant_id"],
            region_grant["grant_id"],
            distance_grant["grant_id"],
            export_grant["grant_id"],
        ]:
            status, revoked = _http_json(
                "POST",
                f"{base_url}/wallets/{wallet_id}/grants/{grant_id}/revoke",
                {"actor_did": owner_did},
            )
            _assert_status(status, revoked)
            assert revoked["status"] == "revoked"

        status, revoked_receipts = _http_json(
            "GET",
            f"{base_url}/wallets/{wallet_id}/grant-receipts?status=revoked",
        )
        _assert_status(status, revoked_receipts)
        assert {receipt["grant_id"] for receipt in revoked_receipts["receipts"]} == {
            analysis_grant["grant_id"],
            location_grant["grant_id"],
            region_grant["grant_id"],
            distance_grant["grant_id"],
            export_grant["grant_id"],
        }

        blocked_calls = [
            (
                "POST",
                f"{base_url}/wallets/{wallet_id}/records/{document_id}/analyze/redacted",
                {
                    "actor_did": analyst_did,
                    "actor_key_hex": analyst_key,
                    "invocation_token": analysis_invocation["token"],
                },
            ),
            (
                "POST",
                f"{base_url}/wallets/{wallet_id}/services/match",
                {
                    "location_record_id": location_id,
                    "actor_did": navigator_did,
                    "actor_key_hex": navigator_key,
                    "invocation_token": location_invocation["token"],
                    "need_terms": ["housing"],
                },
            ),
            (
                "POST",
                f"{base_url}/wallets/{wallet_id}/locations/{location_id}/region-proofs",
                {
                    "actor_did": proof_checker_did,
                    "grant_id": region_grant["grant_id"],
                    "region_id": "multnomah_county",
                },
            ),
            (
                "POST",
                f"{base_url}/wallets/{wallet_id}/exports",
                {
                    "actor_did": export_recipient_did,
                    "actor_key_hex": export_recipient_key,
                    "invocation_token": export_invocation["invocation_token"],
                    "record_ids": [document_id, location_id],
                },
            ),
        ]
        for method, url, payload in blocked_calls:
            status, blocked = _http_json(method, url, payload)
            _assert_status(status, blocked, expected=400)

        status, audit = _http_json("GET", f"{base_url}/wallets/{wallet_id}/audit")
        _assert_status(status, audit)
        actions = {event["action"] for event in audit["events"]}
        assert {
            "grant/create",
            "invocation/issue",
            "invocation/verify",
            "record/analyze_redacted",
            "location/read_coarse",
            "proof/create",
            "export/create",
            "grant/revoke",
        }.issubset(actions)
    finally:
        _stop_process(process)
