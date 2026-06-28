from __future__ import annotations

import json
from io import StringIO

from wallet_interface import WalletInterfaceService
from wallet_interface.ops import (
    WalletOpsHealthWorker,
    main,
    validate_local_production_readiness_self_check,
    validate_distance_proof_contract,
    validate_production_readiness,
    validate_proof_contract,
    validate_target_signoff_packet,
    validate_target_signoff_packet_template,
)
from wallet_interface.proof_backends import HttpLocationRegionProofBackend


def test_ops_health_worker_emits_jsonl_report() -> None:
    service = WalletInterfaceService()
    output = StringIO()

    result = WalletOpsHealthWorker(
        service=service,
        verify_storage=False,
        max_runs=1,
        output=output,
    ).run()

    lines = output.getvalue().strip().splitlines()
    report = json.loads(lines[0])

    assert result.report_count == 1
    assert result.exit_code == 0
    assert report["status"] in {"ok", "warning"}
    assert {check["name"] for check in report["checks"]} >= {
        "repository",
        "storage_availability",
        "proof_registry",
        "revocation_propagation",
        "privacy_budget",
    }


def test_ops_health_worker_can_fail_on_error_status() -> None:
    service = WalletInterfaceService()
    service.wallet_service.analytics_query_budget_spent["bad-budget"] = -0.5
    output = StringIO()

    result = WalletOpsHealthWorker(
        service=service,
        verify_storage=False,
        max_runs=1,
        fail_on_error=True,
        output=output,
    ).run()
    report = json.loads(output.getvalue())

    assert result.exit_code == 2
    assert report["status"] == "error"
    checks = {check["name"]: check for check in report["checks"]}
    assert checks["privacy_budget"]["status"] == "error"


def test_ops_health_cli_writes_jsonl_file(tmp_path) -> None:
    output_path = tmp_path / "ops" / "health.jsonl"

    exit_code = main(
        [
            "--repository-root",
            str(tmp_path / "wallet-repository"),
            "--skip-storage-verify",
            "--output-jsonl",
            str(output_path),
        ]
    )

    assert exit_code == 0
    report = json.loads(output_path.read_text(encoding="utf-8"))
    assert report["check_count"] >= 5


def test_ops_health_worker_sends_webhook_alert_for_error_status() -> None:
    service = WalletInterfaceService()
    service.wallet_service.analytics_query_budget_spent["bad-budget"] = -0.5
    output = StringIO()
    sent: list[tuple[str, dict[str, object], dict[str, str]]] = []

    result = WalletOpsHealthWorker(
        service=service,
        verify_storage=False,
        max_runs=1,
        output=output,
        alert_webhook_url="https://ops.example.test/hooks/wallet",
        alert_on="error",
        alert_sender=lambda url, payload, headers: sent.append((url, payload, headers)),
    ).run()

    assert result.alert_count == 1
    assert len(sent) == 1
    url, payload, headers = sent[0]
    assert url == "https://ops.example.test/hooks/wallet"
    assert payload["status"] == "error"
    assert payload["source"] == "wallet_interface.ops"
    assert headers == {}
    assert any(check["name"] == "privacy_budget" for check in payload["checks"])


def test_ops_health_worker_does_not_send_webhook_alert_below_threshold() -> None:
    service = WalletInterfaceService()
    output = StringIO()
    sent: list[tuple[str, dict[str, object], dict[str, str]]] = []

    result = WalletOpsHealthWorker(
        service=service,
        verify_storage=False,
        max_runs=1,
        output=output,
        alert_webhook_url="https://ops.example.test/hooks/wallet",
        alert_on="error",
        alert_sender=lambda url, payload, headers: sent.append((url, payload, headers)),
    ).run()

    report = json.loads(output.getvalue())
    assert report["status"] == "warning"
    assert result.alert_count == 0
    assert sent == []


def test_ops_health_worker_reads_alert_auth_headers_from_env(monkeypatch) -> None:
    service = WalletInterfaceService()
    service.wallet_service.analytics_query_budget_spent["bad-budget"] = -0.5
    output = StringIO()
    sent: list[tuple[str, dict[str, object], dict[str, str]]] = []
    monkeypatch.setenv("WALLET_OPS_ALERT_BEARER_TOKEN", "alert-token")
    monkeypatch.setenv("WALLET_OPS_ALERT_HEADER_NAME", "x-wallet-alert-key")
    monkeypatch.setenv("WALLET_OPS_ALERT_HEADER_VALUE", "shared-header")

    WalletOpsHealthWorker(
        service=service,
        verify_storage=False,
        max_runs=1,
        output=output,
        alert_webhook_url="https://ops.example.test/hooks/wallet",
        alert_on="error",
        alert_sender=lambda url, payload, headers: sent.append((url, payload, headers)),
    ).run()

    assert len(sent) == 1
    _, _, headers = sent[0]
    assert headers["authorization"] == "Bearer alert-token"
    assert headers["x-wallet-alert-key"] == "shared-header"


def test_validate_proof_contract_reports_error_for_non_http_backend() -> None:
    report = validate_proof_contract(WalletInterfaceService())

    assert report["status"] == "error"
    assert report["checks"][0]["name"] == "backend"


def test_validate_proof_contract_reports_http_backend_success() -> None:
    def fake_request_json(
        method: str,
        url: str,
        payload: dict[str, object],
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> dict[str, object]:
        if url.endswith("/health"):
            return {"ok": True, "status": "ready"}
        if url.endswith("/prove/location-region"):
            return {
                "proof_id": "proof-contract-ops",
                "wallet_id": str(payload["wallet_id"]),
                "proof_type": "location_region",
                "statement": payload["statement"],
                "verifier_id": "verifier-http-v1",
                "public_inputs": payload["public_inputs"],
                "proof_hash": "proof-hash-1",
                "witness_record_ids": payload["witness_record_ids"],
                "is_simulated": False,
                "proof_system": "groth16",
                "circuit_id": "location-region-v1",
                "verification_status": "verified",
            }
        return {"verified": True}

    service = WalletInterfaceService(
        proof_backend=HttpLocationRegionProofBackend(
            base_url="https://verifier.example.test",
            verifier_id="verifier-http-v1",
            proof_system="groth16",
            circuit_id="location-region-v1",
            request_json=fake_request_json,
        ),
        allow_simulated_proofs=False,
    )

    report = validate_proof_contract(service)

    assert report["status"] == "ok"
    assert report["receipt"]["proof_id"] == "proof-contract-ops"
    assert {check["name"] for check in report["checks"]} == {
        "health",
        "prove",
        "public_input_safety",
        "verify",
    }


def test_validate_distance_proof_contract_reports_error_for_non_http_backend() -> None:
    report = validate_distance_proof_contract(WalletInterfaceService())

    assert report["status"] == "error"
    assert report["checks"][0]["name"] == "backend"


def test_validate_distance_proof_contract_reports_http_backend_success() -> None:
    def fake_request_json(
        method: str,
        url: str,
        payload: dict[str, object],
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> dict[str, object]:
        if url.endswith("/health"):
            return {"ok": True, "status": "ready"}
        if url.endswith("/prove/location-distance"):
            return {
                "proof_id": "proof-distance-contract-ops",
                "wallet_id": str(payload["wallet_id"]),
                "proof_type": "location_distance",
                "statement": payload["statement"],
                "verifier_id": "verifier-http-v1",
                "public_inputs": payload["public_inputs"],
                "proof_hash": "proof-hash-distance-1",
                "witness_record_ids": payload["witness_record_ids"],
                "is_simulated": False,
                "proof_system": "groth16",
                "circuit_id": "location-distance-v1",
                "verification_status": "verified",
            }
        return {"verified": True}

    service = WalletInterfaceService(
        proof_backend=HttpLocationRegionProofBackend(
            base_url="https://verifier.example.test",
            verifier_id="verifier-http-v1",
            proof_system="groth16",
            circuit_id="location-distance-v1",
            request_json=fake_request_json,
        ),
        allow_simulated_proofs=False,
    )

    report = validate_distance_proof_contract(service)

    assert report["status"] == "ok"
    assert report["receipt"]["proof_id"] == "proof-distance-contract-ops"
    assert {check["name"] for check in report["checks"]} == {
        "health",
        "prove",
        "public_input_safety",
        "verify",
    }


def test_ops_cli_accepts_distance_proof_contract_validation_flag(tmp_path) -> None:
    output_path = tmp_path / "ops" / "distance-proof-contract.jsonl"

    exit_code = main(
        [
            "--validate-distance-proof-contract",
            "--output-jsonl",
            str(output_path),
        ]
    )

    report = json.loads(output_path.read_text(encoding="utf-8"))
    assert exit_code == 2
    assert report["status"] == "error"
    assert report["checks"][0]["name"] == "backend"


def test_validate_production_readiness_reports_missing_target_environment() -> None:
    report = validate_production_readiness(
        WalletInterfaceService(),
        env={},
        run_proof_contract=False,
        run_distance_proof_contract=False,
        verify_storage=False,
    )

    checks = {check["name"]: check for check in report["checks"]}
    assert report["status"] == "error"
    assert checks["persistence_environment"]["status"] == "error"
    assert checks["proof_environment"]["status"] == "error"
    assert checks["proof_credentials"]["status"] == "error"
    assert checks["ops_credentials"]["status"] == "error"
    assert checks["secret_manager_references"]["status"] == "error"


def test_validate_production_readiness_fails_world_id_enabled_missing_release_gates() -> None:
    report = validate_production_readiness(
        WalletInterfaceService(),
        env={
            "WORLD_ID_ENABLED": "1",
            "WORLD_ID_ENVIRONMENT": "staging",
            "WORLD_ID_APP_ID": "",
            "WORLD_ID_RP_ID": "",
            "WORLD_ID_VERIFY_BASE_URL": "https://developer.world.org",
        },
        run_proof_contract=False,
        run_distance_proof_contract=False,
        verify_storage=False,
    )

    checks = {check["name"]: check for check in report["checks"]}
    assert report["status"] == "error"
    assert checks["world_id_environment"]["status"] == "error"
    assert checks["world_id_secret_references"]["status"] == "error"
    assert checks["world_id_rp_signature_vector"]["status"] == "error"
    assert checks["world_id_verify_endpoint"]["status"] == "error"
    assert checks["world_id_proof_sanitization"]["status"] == "error"
    assert "WORLD_ID_VERIFY_ENDPOINT_REACHABILITY_EVIDENCE" in checks["world_id_verify_endpoint"]["details"][
        "missing_or_invalid"
    ]
    assert "WORLD_ID_PROOF_SANITIZATION_EVIDENCE" in checks["world_id_proof_sanitization"]["details"][
        "missing_or_invalid"
    ]


def test_validate_production_readiness_passes_world_id_release_gates(tmp_path) -> None:
    def fake_request_json(
        method: str,
        url: str,
        payload: dict[str, object],
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> dict[str, object]:
        if url.endswith("/health"):
            return {"ok": True, "status": "ready"}
        return {"verified": True}

    repository_root = tmp_path / "wallet-repository"
    storage_root = tmp_path / "wallet-blobs"
    env = {
        "WALLET_REPOSITORY_ROOT": str(repository_root),
        "WALLET_STORAGE_CONFIG": json.dumps({"primary": {"type": "local", "root": str(storage_root)}}),
        "WALLET_AUTO_LOAD_REPOSITORY": "true",
        "WALLET_AUTO_PERSIST": "true",
        "WALLET_PROOF_MODE": "production",
        "WALLET_PROOF_BACKEND": "http-location-region",
        "WALLET_PROOF_SERVICE_URL": "https://verifier.staging.211.local",
        "WALLET_PROOF_VERIFIER_ID": "verifier-http-v1",
        "WALLET_PROOF_SYSTEM": "groth16",
        "WALLET_PROOF_CIRCUIT_ID": "location-region-v1",
        "WALLET_PROOF_BEARER_TOKEN": "proof-service-token",
        "WALLET_OPS_HEALTH_SHARED_SECRET": "ops-health-secret",
        "WALLET_OPS_ALERT_WEBHOOK_URL": "https://ops.staging.211.local/hooks/wallet",
        "WALLET_OPS_ALERT_BEARER_TOKEN": "ops-alert-token",
        "WALLET_OPS_HEALTH_SECRET_REF": "secret://staging/wallet/ops-health",
        "WALLET_OPS_ALERT_SECRET_REF": "secret://staging/wallet/ops-alert",
        "WALLET_PROOF_CREDENTIAL_SECRET_REF": "secret://staging/wallet/proof-verifier",
        "WALLET_STORAGE_CREDENTIAL_SECRET_REF": "secret://staging/wallet/storage",
        "WORLD_ID_ENABLED": "1",
        "WORLD_ID_ENVIRONMENT": "production",
        "WORLD_ID_APP_ID": "app_production_world_id_wallet",
        "WORLD_ID_RP_ID": "rp_production_world_id_wallet",
        "WORLD_ID_ALLOWED_ACTIONS": "wallet-attach-world-id-v1",
        "WORLD_ID_DEFAULT_ACTION": "wallet-attach-world-id-v1",
        "WORLD_ID_RP_SIGNING_KEY": "0x" + "11" * 32,
        "WORLD_ID_RP_SIGNING_KEY_SECRET_REF": "secret://staging/wallet/world-id-rp-signing",
        "WORLD_ID_NULLIFIER_HMAC_KEY": "world-id-nullifier-hmac-key",
        "WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF": "secret://staging/wallet/world-id-nullifier",
        "WORLD_ID_VERIFY_BASE_URL": "https://developer.world.org",
        "WORLD_ID_VERIFY_ENDPOINT_REACHABILITY_EVIDENCE": "artifact://staging/world-id/reachability",
        "WORLD_ID_PROOF_SANITIZATION_EVIDENCE": "artifact://staging/world-id/sanitization",
    }

    report = validate_production_readiness(
        WalletInterfaceService(
            repository_root=repository_root,
            storage_config={"primary": {"type": "local", "root": str(storage_root)}},
            proof_backend=HttpLocationRegionProofBackend(
                base_url="https://verifier.staging.211.local",
                verifier_id="verifier-http-v1",
                proof_system="groth16",
                circuit_id="location-region-v1",
                request_json=fake_request_json,
            ),
            allow_simulated_proofs=False,
        ),
        env=env,
        run_proof_contract=False,
        run_distance_proof_contract=False,
        verify_storage=False,
    )

    checks = {check["name"]: check for check in report["checks"]}
    assert report["status"] == "ok"
    assert checks["world_id_environment"]["status"] == "ok"
    assert checks["world_id_secret_references"]["status"] == "ok"
    assert checks["world_id_rp_signature_vector"]["status"] == "ok"
    assert checks["world_id_verify_endpoint"]["status"] == "ok"
    assert checks["world_id_proof_sanitization"]["status"] == "ok"
    rendered = json.dumps(report, sort_keys=True)
    assert "world-id-nullifier-hmac-key" not in rendered
    assert "WORLD_ID_RAW_NULLIFIER_READINESS_SENTINEL" not in rendered
    assert "WORLD_ID_RAW_RP_SIGNATURE_READINESS_SENTINEL" not in rendered


def test_validate_production_readiness_passes_with_configured_http_verifier(tmp_path) -> None:
    def fake_request_json(
        method: str,
        url: str,
        payload: dict[str, object],
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> dict[str, object]:
        if url.endswith("/health"):
            return {"ok": True, "status": "ready"}
        if url.endswith("/prove/location-region"):
            return {
                "proof_id": "proof-contract-ready",
                "wallet_id": str(payload["wallet_id"]),
                "proof_type": "location_region",
                "statement": payload["statement"],
                "verifier_id": "verifier-http-v1",
                "public_inputs": payload["public_inputs"],
                "proof_hash": "proof-hash-ready",
                "witness_record_ids": payload["witness_record_ids"],
                "is_simulated": False,
                "proof_system": "groth16",
                "circuit_id": "location-region-v1",
                "verification_status": "verified",
            }
        if url.endswith("/prove/location-distance"):
            return {
                "proof_id": "proof-distance-contract-ready",
                "wallet_id": str(payload["wallet_id"]),
                "proof_type": "location_distance",
                "statement": payload["statement"],
                "verifier_id": "verifier-http-v1",
                "public_inputs": payload["public_inputs"],
                "proof_hash": "proof-hash-distance-ready",
                "witness_record_ids": payload["witness_record_ids"],
                "is_simulated": False,
                "proof_system": "groth16",
                "circuit_id": "location-region-v1",
                "verification_status": "verified",
            }
        return {"verified": True}

    repository_root = tmp_path / "wallet-repository"
    storage_root = tmp_path / "wallet-blobs"
    service = WalletInterfaceService(
        repository_root=repository_root,
        storage_config={"primary": {"type": "local", "root": str(storage_root)}},
        proof_backend=HttpLocationRegionProofBackend(
            base_url="https://verifier.staging.211.local",
            verifier_id="verifier-http-v1",
            proof_system="groth16",
            circuit_id="location-region-v1",
            request_json=fake_request_json,
        ),
        allow_simulated_proofs=False,
    )
    env = {
        "WALLET_REPOSITORY_ROOT": str(repository_root),
        "WALLET_STORAGE_CONFIG": json.dumps({"primary": {"type": "local", "root": str(storage_root)}}),
        "WALLET_AUTO_LOAD_REPOSITORY": "true",
        "WALLET_AUTO_PERSIST": "true",
        "WALLET_PROOF_MODE": "production",
        "WALLET_PROOF_BACKEND": "http-location-region",
        "WALLET_PROOF_SERVICE_URL": "https://verifier.staging.211.local",
        "WALLET_PROOF_VERIFIER_ID": "verifier-http-v1",
        "WALLET_PROOF_SYSTEM": "groth16",
        "WALLET_PROOF_CIRCUIT_ID": "location-region-v1",
        "WALLET_PROOF_BEARER_TOKEN": "proof-service-token",
        "WALLET_OPS_HEALTH_SHARED_SECRET": "ops-health-secret",
        "WALLET_OPS_ALERT_WEBHOOK_URL": "https://ops.staging.211.local/hooks/wallet",
        "WALLET_OPS_ALERT_BEARER_TOKEN": "ops-alert-token",
        "WALLET_OPS_HEALTH_SECRET_REF": "secret://staging/wallet/ops-health",
        "WALLET_OPS_ALERT_SECRET_REF": "secret://staging/wallet/ops-alert",
        "WALLET_PROOF_CREDENTIAL_SECRET_REF": "secret://staging/wallet/proof-verifier",
        "WALLET_STORAGE_CREDENTIAL_SECRET_REF": "secret://staging/wallet/storage",
    }

    report = validate_production_readiness(
        service,
        env=env,
        run_proof_contract=True,
        verify_storage=False,
    )

    assert report["status"] == "ok"
    assert {check["name"]: check["status"] for check in report["checks"]} == {
        "persistence_environment": "ok",
        "proof_environment": "ok",
        "proof_credentials": "ok",
        "ops_credentials": "ok",
        "secret_manager_references": "ok",
        "ops_health": "ok",
        "proof_contract": "ok",
        "distance_proof_contract": "ok",
    }
    rendered = json.dumps(report)
    assert "proof-service-token" not in rendered
    assert "ops-alert-token" not in rendered
    assert "ops-health-secret" not in rendered


def test_validate_target_signoff_packet_reports_incomplete_packet(tmp_path) -> None:
    packet_path = tmp_path / "target-signoff.json"
    packet_path.write_text("{}", encoding="utf-8")

    report = validate_target_signoff_packet(packet_path)

    checks = {check["name"]: check for check in report["checks"]}
    assert report["status"] == "error"
    assert checks["environment_record"]["status"] == "error"
    assert checks["secret_manager_references"]["status"] == "error"
    assert checks["staging_artifacts"]["status"] == "error"
    assert checks["retention_mapping"]["status"] == "error"
    assert checks["reviewer_signoff"]["status"] == "error"
    assert checks["analytics_privacy_review"]["status"] == "error"
    assert checks["launch_decision"]["status"] == "error"


def test_ops_cli_accepts_target_signoff_packet_validation_flag(tmp_path) -> None:
    packet_path = tmp_path / "target-signoff.json"
    output_path = tmp_path / "ops" / "target-signoff-validation.jsonl"
    packet_path.write_text("{}", encoding="utf-8")

    exit_code = main(
        [
            "--validate-target-signoff-packet",
            str(packet_path),
            "--output-jsonl",
            str(output_path),
        ]
    )

    report = json.loads(output_path.read_text(encoding="utf-8"))
    assert exit_code == 2
    assert report["status"] == "error"
    assert {check["name"] for check in report["checks"]} >= {
        "environment_record",
        "retention_mapping",
        "reviewer_signoff",
    }


def test_ops_cli_validates_committed_signoff_template_without_packet_path(tmp_path) -> None:
    output_path = tmp_path / "ops" / "target-signoff-template-validation.jsonl"

    exit_code = main(
        [
            "--validate-target-signoff-packet",
            "--output-jsonl",
            str(output_path),
        ]
    )

    report = json.loads(output_path.read_text(encoding="utf-8"))
    assert exit_code == 0
    assert report["status"] == "ok"
    assert report["summary"] == "target production signoff packet template validation completed"
    assert {check["status"] for check in report["checks"]} == {"ok"}


def test_validate_target_signoff_packet_template_accepts_committed_template() -> None:
    report = validate_target_signoff_packet_template()

    assert report["status"] == "ok"
    assert {check["name"] for check in report["checks"]} >= {
        "template_sections",
        "template_environment_fields",
        "template_review_areas",
        "template_artifact_refs",
        "template_retention_fields",
    }


def test_local_production_readiness_self_check_passes_without_target_env() -> None:
    report = validate_local_production_readiness_self_check(verify_storage=False)

    assert report["status"] == "ok"
    assert report["mode"] == "local_self_check"
    assert {check["name"]: check["status"] for check in report["checks"]} == {
        "persistence_environment": "ok",
        "proof_environment": "ok",
        "proof_credentials": "ok",
        "ops_credentials": "ok",
        "secret_manager_references": "ok",
        "world_id_environment": "ok",
        "world_id_secret_references": "ok",
        "world_id_rp_signature_vector": "ok",
        "world_id_verify_endpoint": "ok",
        "world_id_proof_sanitization": "ok",
        "ops_health": "ok",
        "proof_contract": "ok",
        "distance_proof_contract": "ok",
    }


def test_validate_target_signoff_packet_accepts_completed_packet(tmp_path) -> None:
    packet_path = tmp_path / "target-signoff.json"
    packet = {
        "environment": {
            "environment_name": "staging-wallet",
            "deployment_owner": "211-AI platform",
            "review_date": "2026-05-05",
            "wallet_api_origin": "https://wallet-api.staging.211.local",
            "wallet_ui_origin": "https://wallet.staging.211.local",
            "repository_configuration_id": "repo-policy-2026-05",
            "encrypted_storage_configuration_id": "storage-policy-2026-05",
            "proof_backend": "http-location-region",
            "proof_verifier_service": "wallet-verifier.staging.svc",
            "proof_verifier_id": "verifier-http-v1",
            "proof_system": "groth16",
            "world_id_enabled_decision": "enabled-for-pilot",
            "world_id_environment": "production",
            "world_id_app_id": "app_staging_world_id_wallet",
            "world_id_rp_id": "rp_staging_world_id_wallet",
            "world_id_verify_endpoint": "https://developer.world.org",
            "retention_policy_version": "docs/WALLET_RETENTION_POLICY.md@2026-05-05",
        },
        "secret_manager_refs": {
            "ops_health_secret": "secret://staging/wallet/ops-health",
            "alert_credentials": "secret://staging/wallet/ops-alert",
            "proof_verifier_credentials": "secret://staging/wallet/proof-verifier",
            "storage_credentials": "secret://staging/wallet/storage",
            "world_id_rp_signing_key": "secret://staging/wallet/world-id-rp-signing",
            "world_id_nullifier_commitment_key": "secret://staging/wallet/world-id-nullifier",
        },
        "artifact_refs": {
            "release_check_evidence": "evidence://wallet/release-checks/2026-05-05",
            "readiness_report": "evidence://wallet/readiness/2026-05-05",
            "ops_health_report": "evidence://wallet/ops-health/2026-05-05",
            "proof_contract_report": "evidence://wallet/proof-contract/2026-05-05",
            "distance_proof_contract_report": "evidence://wallet/distance-proof-contract/2026-05-05",
            "world_id_staging_simulator": "evidence://wallet/world-id/staging-simulator/2026-05-05",
            "world_id_fullstack_playwright": "evidence://wallet/world-id/fullstack/2026-05-05",
            "world_id_ux_review": "evidence://wallet/world-id/ux-review/2026-05-05",
            "world_id_privacy_nullifier_review": "evidence://wallet/world-id/privacy-nullifier/2026-05-05",
            "world_id_security_signoff": "evidence://wallet/world-id/security/2026-05-05",
            "world_id_support_playbook": "evidence://wallet/world-id/support/2026-05-05",
        },
        "retention_mapping": {
            "policy_version": "wallet-retention-2026-05-05",
            "repository_lifecycle": "managed backup 35d, purge SLA 30d",
            "encrypted_storage_lifecycle": "primary plus S3 mirror lifecycle policy wallet-prod-v1",
            "backup_purge_sla": "30 days",
            "ipfs_pinning": "private pinset unpin on deletion ticket",
            "filecoin_deal_expiration": "no live Filecoin deals for staging",
            "s3_lifecycle": "wallet-prod-v1 lifecycle covers current and noncurrent encrypted objects",
            "log_retention": "90 days",
            "alert_retention": "90 days",
            "deletion_tombstone_retention": "7 years",
        },
        "reviewer_signoff": {
            "security": {
                "reviewer": "Security Reviewer",
                "decision": "approved",
                "date": "2026-05-05",
                "evidence": "ticket://security/WALLET-1",
            },
            "privacy": {
                "reviewer": "Privacy Reviewer",
                "decision": "approved",
                "date": "2026-05-05",
                "evidence": "ticket://privacy/WALLET-1",
            },
            "legal_policy": {
                "reviewer": "Legal Reviewer",
                "decision": "approved",
                "date": "2026-05-05",
                "evidence": "ticket://legal/WALLET-1",
            },
            "accessibility_usability": {
                "reviewer": "Accessibility Reviewer",
                "decision": "approved",
                "date": "2026-05-05",
                "evidence": "ticket://a11y/WALLET-1",
            },
            "operations_on_call": {
                "reviewer": "Ops Reviewer",
                "decision": "approved",
                "date": "2026-05-05",
                "evidence": "ticket://ops/WALLET-1",
            },
            "product_owner": {
                "reviewer": "Product Reviewer",
                "decision": "approved",
                "date": "2026-05-05",
                "evidence": "ticket://product/WALLET-1",
            },
        },
        "analytics_privacy_review": {
            "approved_templates": [
                {
                    "template_id": "needs_by_zip_v1",
                    "reviewer": "Privacy Reviewer",
                    "review_date": "2026-05-05",
                    "min_cohort_size": 10,
                    "epsilon_budget": 1.0,
                    "allowed_dimensions": ["zip3", "need_category"],
                    "retention_decision": "aggregate results retained for study window",
                    "withdrawal_behavior": "future contributions blocked; released aggregate audit preserved",
                }
            ]
        },
        "launch_decision": {
            "decision": "approved",
            "approved_launch_window": "2026-05-08T18:00:00Z/2026-05-08T20:00:00Z",
            "first_post_launch_readiness_run": "2026-05-08T21:00:00Z",
            "first_post_launch_retention_audit": "2026-06-08",
        },
    }
    packet_path.write_text(json.dumps(packet), encoding="utf-8")

    report = validate_target_signoff_packet(packet_path)

    assert report["status"] == "ok"
    assert {check["status"] for check in report["checks"]} == {"ok"}
    rendered = json.dumps(report)
    assert "secret://staging/wallet/proof-verifier" not in rendered
