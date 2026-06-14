"""Operations worker for wallet health checks."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, IO, Mapping, Sequence
from urllib import request as urllib_request

from .app_service import WalletInterfaceService

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TARGET_SIGNOFF_PACKET_TEMPLATE = _REPO_ROOT / "docs" / "WALLET_TARGET_PRODUCTION_SIGNOFF_PACKET.template.json"

_PRODUCTION_PLACEHOLDER_MARKERS = (
    "example.com",
    "example.test",
    "replace-",
    "replace_me",
    "replace-me",
    "changeme",
    "yyyy-mm-dd",
    "tbd",
    "todo",
)

_FALSE_VALUES = {"0", "false", "no", "off"}
_TRUE_VALUES = {"1", "true", "yes", "on"}

_SIGNOFF_REQUIRED_ENVIRONMENT_FIELDS = (
    "environment_name",
    "deployment_owner",
    "review_date",
    "wallet_api_origin",
    "wallet_ui_origin",
    "repository_configuration_id",
    "encrypted_storage_configuration_id",
    "proof_backend",
    "proof_verifier_service",
    "proof_verifier_id",
    "proof_system",
    "world_id_enabled_decision",
    "world_id_environment",
    "world_id_app_id",
    "world_id_rp_id",
    "world_id_verify_endpoint",
    "retention_policy_version",
)

_SIGNOFF_REQUIRED_SECRET_REFS = (
    "ops_health_secret",
    "alert_credentials",
    "proof_verifier_credentials",
    "storage_credentials",
    "world_id_rp_signing_key",
    "world_id_nullifier_commitment_key",
)

_SIGNOFF_REQUIRED_ARTIFACT_REFS = (
    "release_check_evidence",
    "readiness_report",
    "ops_health_report",
    "proof_contract_report",
    "distance_proof_contract_report",
    "world_id_staging_simulator",
    "world_id_fullstack_playwright",
    "world_id_ux_review",
    "world_id_privacy_nullifier_review",
    "world_id_security_signoff",
    "world_id_support_playbook",
)

_SIGNOFF_REQUIRED_RETENTION_FIELDS = (
    "policy_version",
    "repository_lifecycle",
    "encrypted_storage_lifecycle",
    "backup_purge_sla",
    "ipfs_pinning",
    "filecoin_deal_expiration",
    "s3_lifecycle",
    "log_retention",
    "alert_retention",
    "deletion_tombstone_retention",
)

_SIGNOFF_REQUIRED_REVIEW_AREAS = (
    "security",
    "privacy",
    "legal_policy",
    "accessibility_usability",
    "operations_on_call",
    "product_owner",
)

_SIGNOFF_ALLOWED_APPROVAL_DECISIONS = {"approved", "approved with tracked exception"}

_READINESS_TARGET_ENV_VARS = (
    "WALLET_REPOSITORY_ROOT",
    "WALLET_STORAGE_CONFIG",
    "WALLET_STORAGE_TYPE",
    "WALLET_PROOF_MODE",
    "WALLET_PROOF_BACKEND",
    "WALLET_PROOF_SERVICE_URL",
    "WALLET_OPS_HEALTH_SHARED_SECRET",
    "WALLET_OPS_ALERT_WEBHOOK_URL",
    "WALLET_OPS_HEALTH_SECRET_REF",
    "WALLET_OPS_ALERT_SECRET_REF",
    "WALLET_PROOF_CREDENTIAL_SECRET_REF",
    "WALLET_STORAGE_CREDENTIAL_SECRET_REF",
    "WORLD_ID_ENABLED",
    "WORLD_ID_APP_ID",
    "WORLD_ID_RP_ID",
    "WORLD_ID_RP_SIGNING_KEY_SECRET_REF",
    "WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF",
)

_WORLD_ID_REACHABILITY_EVIDENCE_ENV = "WORLD_ID_VERIFY_ENDPOINT_REACHABILITY_EVIDENCE"
_WORLD_ID_SANITIZATION_EVIDENCE_ENV = "WORLD_ID_PROOF_SANITIZATION_EVIDENCE"
_WORLD_ID_SIGNATURE_VECTOR_CREATED_AT = 1_770_000_000
_WORLD_ID_SIGNATURE_VECTOR_ENTROPY = bytes.fromhex("42" * 32)


@dataclass
class OpsHealthRunResult:
    """Summary returned by a bounded ops-health worker run."""

    report_count: int
    statuses: list[str] = field(default_factory=list)
    alert_count: int = 0
    exit_code: int = 0


def _alert_rank(status: str) -> int:
    if status == "error":
        return 2
    if status == "warning":
        return 1
    return 0


def _alert_headers_from_env() -> dict[str, str]:
    headers: dict[str, str] = {}
    bearer_token = str(os.getenv("WALLET_OPS_ALERT_BEARER_TOKEN") or "").strip()
    if bearer_token:
        headers["authorization"] = f"Bearer {bearer_token}"
    header_name = str(os.getenv("WALLET_OPS_ALERT_HEADER_NAME") or "").strip()
    header_value = str(os.getenv("WALLET_OPS_ALERT_HEADER_VALUE") or "").strip()
    if header_name and header_value:
        headers[header_name] = header_value
    return headers


def _default_alert_sender(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> None:
    body = json.dumps(payload, sort_keys=True).encode("utf-8")
    request_headers = {"content-type": "application/json"}
    if headers:
        request_headers.update(headers)
    req = urllib_request.Request(
        url,
        data=body,
        headers=request_headers,
        method="POST",
    )
    with urllib_request.urlopen(req, timeout=10) as response:
        if response.status >= 400:
            raise RuntimeError(f"alert webhook returned HTTP {response.status}")


def _env(env: Mapping[str, str] | None, name: str) -> str:
    source = env if env is not None else os.environ
    return str(source.get(name) or "").strip()


def _is_placeholder(value: str) -> bool:
    lowered = value.strip().lower()
    return not lowered or any(marker in lowered for marker in _PRODUCTION_PLACEHOLDER_MARKERS)


def _bool_env(env: Mapping[str, str] | None, name: str) -> bool | None:
    value = _env(env, name).lower()
    if not value:
        return None
    if value in _TRUE_VALUES:
        return True
    if value in _FALSE_VALUES:
        return False
    return None


def _world_id_production_readiness_checks(env: Mapping[str, str] | None) -> list[dict[str, Any]]:
    enabled_value = _env(env, "WORLD_ID_ENABLED")
    enabled = _bool_env(env, "WORLD_ID_ENABLED")
    if not enabled_value or enabled is False:
        return []

    from .world_id import (
        DEFAULT_WORLD_ID_VERIFY_BASE_URL,
        load_world_id_config,
        redact_world_id_payload,
        sign_world_id_request_from_config,
    )

    checks: list[dict[str, Any]] = []

    def add_check(name: str, status: str, summary: str, details: dict[str, Any] | None = None) -> None:
        checks.append(
            {
                "name": name,
                "status": status,
                "summary": summary,
                "details": details or {},
            }
        )

    config = None
    config_error = ""
    try:
        config = load_world_id_config(env=env)
    except Exception as exc:
        config_error = str(exc)

    environment_errors: list[str] = []
    if enabled is not True:
        environment_errors.append("WORLD_ID_ENABLED must be true or false")
    if config_error:
        environment_errors.append(config_error)
    if config is not None:
        if config.environment != "production":
            environment_errors.append("WORLD_ID_ENVIRONMENT must be production")
        if not _env(env, "WORLD_ID_VERIFY_BASE_URL"):
            environment_errors.append("WORLD_ID_VERIFY_BASE_URL")
        if config.verify_base_url.rstrip("/") != DEFAULT_WORLD_ID_VERIFY_BASE_URL.rstrip("/"):
            environment_errors.append("WORLD_ID_VERIFY_BASE_URL must target the production World Developer Portal")
    add_check(
        "world_id_environment",
        "error" if environment_errors else "ok",
        (
            "World ID app, RP, action, environment, and production verifier endpoint are configured."
            if not environment_errors
            else "World ID app, RP, action, environment, or verifier endpoint configuration is incomplete."
        ),
        {
            "missing_or_invalid": environment_errors,
            "environment": config.environment if config is not None else _env(env, "WORLD_ID_ENVIRONMENT"),
            "app_id_configured": bool(config.app_id if config is not None else _env(env, "WORLD_ID_APP_ID")),
            "rp_id_configured": bool(config.rp_id if config is not None else _env(env, "WORLD_ID_RP_ID")),
            "allowed_action_count": len(config.allowed_actions) if config is not None else 0,
            "verify_base_url_configured": bool(_env(env, "WORLD_ID_VERIFY_BASE_URL")),
        },
    )

    secret_ref_values = {
        "WORLD_ID_RP_SIGNING_KEY_SECRET_REF": _env(env, "WORLD_ID_RP_SIGNING_KEY_SECRET_REF"),
        "WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF": _env(env, "WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF"),
    }
    missing_secret_refs = [name for name, value in secret_ref_values.items() if not value]
    placeholder_secret_refs = [
        name for name, value in secret_ref_values.items() if value and _is_placeholder(value)
    ]
    add_check(
        "world_id_secret_references",
        "error" if missing_secret_refs or placeholder_secret_refs else "ok",
        (
            "World ID RP signing and nullifier commitment secret-manager references are configured."
            if not missing_secret_refs and not placeholder_secret_refs
            else "World ID RP signing or nullifier commitment secret-manager references are missing or placeholders."
        ),
        {
            "missing": missing_secret_refs,
            "placeholder_vars": placeholder_secret_refs,
            "configured": [name for name, value in secret_ref_values.items() if value],
        },
    )

    signature_errors: list[str] = []
    signature_details: dict[str, Any] = {
        "created_at": _WORLD_ID_SIGNATURE_VECTOR_CREATED_AT,
        "entropy_bytes": len(_WORLD_ID_SIGNATURE_VECTOR_ENTROPY),
    }
    if config is None:
        signature_errors.append("World ID config must load before RP signature vector testing")
    elif not config.rp_signing_key.value:
        signature_errors.append("WORLD_ID_RP_SIGNING_KEY value is required for RP signature vector testing")
    else:
        try:
            signature = sign_world_id_request_from_config(
                config,
                action=config.default_action,
                random_bytes=_WORLD_ID_SIGNATURE_VECTOR_ENTROPY,
                created_at=_WORLD_ID_SIGNATURE_VECTOR_CREATED_AT,
            )
            signature_details.update(
                {
                    "action": signature.action,
                    "ttl_seconds": signature.expires_at - signature.created_at,
                    "nonce_bytes": 32 if signature.nonce.startswith("0x") else 0,
                    "signature_bytes": 65 if signature.signature.startswith("0x") else 0,
                }
            )
            if len(signature.nonce) != 66:
                signature_errors.append("World ID RP signature vector produced an invalid nonce")
            if len(signature.signature) != 132:
                signature_errors.append("World ID RP signature vector produced an invalid signature")
            if signature.action != config.default_action:
                signature_errors.append("World ID RP signature vector action did not match default action")
        except Exception as exc:
            signature_errors.append(str(exc))
    add_check(
        "world_id_rp_signature_vector",
        "error" if signature_errors else "ok",
        (
            "World ID RP signing passed a deterministic vector check."
            if not signature_errors
            else "World ID RP signing did not pass the deterministic vector check."
        ),
        {"missing_or_invalid": signature_errors, **signature_details},
    )

    reachability_evidence = _env(env, _WORLD_ID_REACHABILITY_EVIDENCE_ENV)
    endpoint_errors: list[str] = []
    explicit_base_url = _env(env, "WORLD_ID_VERIFY_BASE_URL")
    if not explicit_base_url:
        endpoint_errors.append("WORLD_ID_VERIFY_BASE_URL")
    elif _is_placeholder(explicit_base_url):
        endpoint_errors.append("WORLD_ID_VERIFY_BASE_URL must not be a placeholder")
    elif explicit_base_url.rstrip("/") != DEFAULT_WORLD_ID_VERIFY_BASE_URL.rstrip("/"):
        endpoint_errors.append("WORLD_ID_VERIFY_BASE_URL must target the production World Developer Portal")
    if not reachability_evidence:
        endpoint_errors.append(_WORLD_ID_REACHABILITY_EVIDENCE_ENV)
    elif _is_placeholder(reachability_evidence):
        endpoint_errors.append(f"{_WORLD_ID_REACHABILITY_EVIDENCE_ENV} must not be a placeholder")
    add_check(
        "world_id_verify_endpoint",
        "error" if endpoint_errors else "ok",
        (
            "World ID production Developer Portal endpoint and reachability evidence are configured."
            if not endpoint_errors
            else "World ID production Developer Portal endpoint or reachability evidence is missing."
        ),
        {
            "missing_or_invalid": endpoint_errors,
            "production_endpoint": explicit_base_url.rstrip("/") == DEFAULT_WORLD_ID_VERIFY_BASE_URL.rstrip("/"),
            "reachability_evidence_configured": bool(reachability_evidence),
        },
    )

    sanitization_evidence = _env(env, _WORLD_ID_SANITIZATION_EVIDENCE_ENV)
    sanitization_errors: list[str] = []
    if not sanitization_evidence:
        sanitization_errors.append(_WORLD_ID_SANITIZATION_EVIDENCE_ENV)
    elif _is_placeholder(sanitization_evidence):
        sanitization_errors.append(f"{_WORLD_ID_SANITIZATION_EVIDENCE_ENV} must not be a placeholder")
    sentinels = (
        "WORLD_ID_RAW_NULLIFIER_READINESS_SENTINEL",
        "WORLD_ID_RAW_PROOF_READINESS_SENTINEL",
        "WORLD_ID_RAW_RP_SIGNATURE_READINESS_SENTINEL",
        "WORLD_ID_RAW_DEVELOPER_RESPONSE_READINESS_SENTINEL",
    )
    sample_payload = {
        "idkit_payload": {
            "responses": [
                {
                    "nullifier": sentinels[0],
                    "proof": [sentinels[1], "0x2", "0x3", "0x4", "0x5"],
                    "merkle_root": "WORLD_ID_RAW_MERKLE_ROOT_READINESS_SENTINEL",
                }
            ]
        },
        "rp_signature": sentinels[2],
        "developer_portal_response": {"nullifier": sentinels[3]},
    }
    try:
        rendered_redacted = json.dumps(redact_world_id_payload(sample_payload), sort_keys=True)
        leaked = [token for token in sentinels if token in rendered_redacted]
        if leaked:
            sanitization_errors.append("World ID proof sanitization leaked private sentinels")
    except Exception as exc:
        sanitization_errors.append(str(exc))
    add_check(
        "world_id_proof_sanitization",
        "error" if sanitization_errors else "ok",
        (
            "World ID proof sanitization evidence is configured and sentinel redaction passed."
            if not sanitization_errors
            else "World ID proof sanitization evidence is missing or sentinel redaction failed."
        ),
        {
            "missing_or_invalid": sanitization_errors,
            "sanitization_evidence_configured": bool(sanitization_evidence),
            "sentinel_count": len(sentinels),
        },
    )

    return checks


def _report_status(checks: list[dict[str, Any]]) -> str:
    if any(check["status"] == "error" for check in checks):
        return "error"
    if any(check["status"] == "warning" for check in checks):
        return "warning"
    return "ok"


def _missing_or_placeholder_fields(payload: Mapping[str, Any], names: Sequence[str]) -> list[str]:
    missing: list[str] = []
    for name in names:
        value = str(payload.get(name) or "").strip()
        if _is_placeholder(value):
            missing.append(name)
    return missing


def _signoff_review_status(review: Mapping[str, Any]) -> str:
    return str(review.get("decision") or "").strip().lower()


def validate_target_signoff_packet(packet_path: str | Path) -> dict[str, Any]:
    """Validate a completed target production signoff packet.

    The packet is intentionally JSON so CI can validate completion without
    scraping reviewer notes from the human-readable Markdown checklist.
    """

    generated_at = datetime.now(timezone.utc).isoformat()
    checks: list[dict[str, Any]] = []

    def add_check(name: str, status: str, summary: str, details: dict[str, Any] | None = None) -> None:
        checks.append(
            {
                "name": name,
                "status": status,
                "summary": summary,
                "details": details or {},
            }
        )

    resolved_path = Path(packet_path)
    try:
        payload = json.loads(resolved_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {
            "source": "wallet_interface.ops",
            "generated_at": generated_at,
            "status": "error",
            "summary": f"target signoff packet could not be read: {exc}",
            "packet_path": str(resolved_path),
            "checks": [
                {
                    "name": "packet_read",
                    "status": "error",
                    "summary": str(exc),
                    "details": {"error": str(exc)},
                }
            ],
        }
    if not isinstance(payload, dict):
        return {
            "source": "wallet_interface.ops",
            "generated_at": generated_at,
            "status": "error",
            "summary": "target signoff packet must be a JSON object",
            "packet_path": str(resolved_path),
            "checks": [
                {
                    "name": "packet_schema",
                    "status": "error",
                    "summary": "top-level packet value is not an object",
                    "details": {"type": type(payload).__name__},
                }
            ],
        }

    environment = payload.get("environment")
    environment = environment if isinstance(environment, dict) else {}
    missing_environment = _missing_or_placeholder_fields(
        environment,
        _SIGNOFF_REQUIRED_ENVIRONMENT_FIELDS,
    )
    add_check(
        "environment_record",
        "error" if missing_environment else "ok",
        (
            "Target environment record is complete."
            if not missing_environment
            else "Target environment record is missing required fields or still uses placeholders."
        ),
        {"missing_or_placeholder": missing_environment},
    )

    secret_refs = payload.get("secret_manager_refs")
    secret_refs = secret_refs if isinstance(secret_refs, dict) else {}
    missing_secret_refs = _missing_or_placeholder_fields(
        secret_refs,
        _SIGNOFF_REQUIRED_SECRET_REFS,
    )
    add_check(
        "secret_manager_references",
        "error" if missing_secret_refs else "ok",
        (
            "Required secret-manager references are present."
            if not missing_secret_refs
            else "Secret-manager references are missing or still placeholders."
        ),
        {"missing_or_placeholder": missing_secret_refs},
    )

    artifact_refs = payload.get("artifact_refs")
    artifact_refs = artifact_refs if isinstance(artifact_refs, dict) else {}
    missing_artifacts = _missing_or_placeholder_fields(
        artifact_refs,
        _SIGNOFF_REQUIRED_ARTIFACT_REFS,
    )
    add_check(
        "staging_artifacts",
        "error" if missing_artifacts else "ok",
        (
            "Release-check, readiness, ops-health, and verifier contract artifact references are present."
            if not missing_artifacts
            else "Release or staging validation artifact references are missing or still placeholders."
        ),
        {"missing_or_placeholder": missing_artifacts},
    )

    retention_mapping = payload.get("retention_mapping")
    retention_mapping = retention_mapping if isinstance(retention_mapping, dict) else {}
    missing_retention = _missing_or_placeholder_fields(
        retention_mapping,
        _SIGNOFF_REQUIRED_RETENTION_FIELDS,
    )
    add_check(
        "retention_mapping",
        "error" if missing_retention else "ok",
        (
            "Retention mapping covers datastore, storage, backup, pinning, logs, alerts, and deletion."
            if not missing_retention
            else "Retention mapping is incomplete or still uses placeholders."
        ),
        {"missing_or_placeholder": missing_retention},
    )

    reviews = payload.get("reviewer_signoff")
    reviews = reviews if isinstance(reviews, dict) else {}
    incomplete_reviews: list[str] = []
    deferred_reviews: list[str] = []
    for area in _SIGNOFF_REQUIRED_REVIEW_AREAS:
        review = reviews.get(area)
        review = review if isinstance(review, dict) else {}
        decision = _signoff_review_status(review)
        reviewer = str(review.get("reviewer") or "").strip()
        date = str(review.get("date") or "").strip()
        evidence = str(review.get("evidence") or "").strip()
        if decision == "deferred":
            deferred_reviews.append(area)
        if (
            decision not in _SIGNOFF_ALLOWED_APPROVAL_DECISIONS
            or _is_placeholder(reviewer)
            or _is_placeholder(date)
            or _is_placeholder(evidence)
        ):
            incomplete_reviews.append(area)
    add_check(
        "reviewer_signoff",
        "error" if incomplete_reviews or deferred_reviews else "ok",
        (
            "All required organization review areas are approved with reviewer evidence."
            if not incomplete_reviews and not deferred_reviews
            else "Organization review signoff is incomplete or deferred."
        ),
        {"incomplete": incomplete_reviews, "deferred": deferred_reviews},
    )

    analytics_review = payload.get("analytics_privacy_review")
    analytics_review = analytics_review if isinstance(analytics_review, dict) else {}
    no_live_templates = bool(analytics_review.get("no_live_analytics_templates"))
    reviewed_templates = analytics_review.get("approved_templates")
    reviewed_templates = reviewed_templates if isinstance(reviewed_templates, list) else []
    incomplete_templates: list[str] = []
    for index, item in enumerate(reviewed_templates):
        template = item if isinstance(item, dict) else {}
        template_id = str(template.get("template_id") or f"template[{index}]")
        required_template_fields = (
            "template_id",
            "reviewer",
            "review_date",
            "min_cohort_size",
            "epsilon_budget",
            "allowed_dimensions",
            "retention_decision",
            "withdrawal_behavior",
        )
        if _missing_or_placeholder_fields(template, required_template_fields):
            incomplete_templates.append(template_id)
        try:
            if int(template.get("min_cohort_size")) < 1:
                incomplete_templates.append(template_id)
        except Exception:
            incomplete_templates.append(template_id)
        try:
            if float(template.get("epsilon_budget")) <= 0:
                incomplete_templates.append(template_id)
        except Exception:
            incomplete_templates.append(template_id)
        if not isinstance(template.get("allowed_dimensions"), list) or not template.get("allowed_dimensions"):
            incomplete_templates.append(template_id)
    analytics_status = "ok"
    analytics_summary = "Analytics privacy review is complete for approved templates."
    if not no_live_templates and not reviewed_templates:
        analytics_status = "error"
        analytics_summary = "Analytics privacy review must list approved templates or declare no live analytics templates."
    elif incomplete_templates:
        analytics_status = "error"
        analytics_summary = "One or more analytics template privacy reviews are incomplete."
    add_check(
        "analytics_privacy_review",
        analytics_status,
        analytics_summary,
        {
            "no_live_analytics_templates": no_live_templates,
            "approved_template_count": len(reviewed_templates),
            "incomplete_templates": sorted(set(incomplete_templates)),
        },
    )

    launch_decision = payload.get("launch_decision")
    launch_decision = launch_decision if isinstance(launch_decision, dict) else {}
    decision = str(launch_decision.get("decision") or "").strip().lower()
    launch_missing = _missing_or_placeholder_fields(
        launch_decision,
        ("decision", "approved_launch_window", "first_post_launch_readiness_run", "first_post_launch_retention_audit"),
    )
    launch_error = bool(launch_missing) or decision not in _SIGNOFF_ALLOWED_APPROVAL_DECISIONS
    add_check(
        "launch_decision",
        "error" if launch_error else "ok",
        (
            "Launch decision is approved and includes post-launch readiness and retention audit timing."
            if not launch_error
            else "Launch decision is missing, not approved, or incomplete."
        ),
        {"missing_or_placeholder": launch_missing, "decision": decision},
    )

    return {
        "source": "wallet_interface.ops",
        "generated_at": generated_at,
        "status": _report_status(checks),
        "summary": "target production signoff packet validation completed",
        "packet_path": str(resolved_path),
        "check_count": len(checks),
        "checks": checks,
    }


def validate_target_signoff_packet_template(
    template_path: str | Path = _TARGET_SIGNOFF_PACKET_TEMPLATE,
) -> dict[str, Any]:
    """Validate that the committed signoff packet template has the required shape."""

    generated_at = datetime.now(timezone.utc).isoformat()
    resolved_path = Path(template_path)
    checks: list[dict[str, Any]] = []

    def add_check(name: str, status: str, summary: str, details: dict[str, Any] | None = None) -> None:
        checks.append(
            {
                "name": name,
                "status": status,
                "summary": summary,
                "details": details or {},
            }
        )

    try:
        payload = json.loads(resolved_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {
            "source": "wallet_interface.ops",
            "generated_at": generated_at,
            "status": "error",
            "summary": f"target signoff packet template could not be read: {exc}",
            "packet_path": str(resolved_path),
            "checks": [
                {
                    "name": "template_read",
                    "status": "error",
                    "summary": str(exc),
                    "details": {"error": str(exc)},
                }
            ],
        }

    if not isinstance(payload, dict):
        add_check(
            "template_schema",
            "error",
            "Target signoff packet template must be a JSON object.",
            {"type": type(payload).__name__},
        )
    else:
        required_sections = (
            "environment",
            "secret_manager_refs",
            "artifact_refs",
            "retention_mapping",
            "reviewer_signoff",
            "analytics_privacy_review",
            "launch_decision",
        )
        missing_sections = [
            section for section in required_sections if not isinstance(payload.get(section), dict)
        ]
        add_check(
            "template_sections",
            "error" if missing_sections else "ok",
            (
                "Target signoff packet template includes all required sections."
                if not missing_sections
                else "Target signoff packet template is missing required sections."
            ),
            {"missing": missing_sections},
        )

        environment = payload.get("environment")
        environment = environment if isinstance(environment, dict) else {}
        missing_environment_fields = [
            field for field in _SIGNOFF_REQUIRED_ENVIRONMENT_FIELDS if field not in environment
        ]
        add_check(
            "template_environment_fields",
            "error" if missing_environment_fields else "ok",
            (
                "Environment template fields cover the production readiness target record."
                if not missing_environment_fields
                else "Environment template fields are incomplete."
            ),
            {"missing": missing_environment_fields},
        )

        reviewer_signoff = payload.get("reviewer_signoff")
        reviewer_signoff = reviewer_signoff if isinstance(reviewer_signoff, dict) else {}
        missing_review_areas = [
            area for area in _SIGNOFF_REQUIRED_REVIEW_AREAS if not isinstance(reviewer_signoff.get(area), dict)
        ]
        add_check(
            "template_review_areas",
            "error" if missing_review_areas else "ok",
            (
                "Reviewer template covers security, privacy, legal, accessibility, ops, and product ownership."
                if not missing_review_areas
                else "Reviewer template does not cover every required review area."
            ),
            {"missing": missing_review_areas},
        )

        artifact_refs = payload.get("artifact_refs")
        artifact_refs = artifact_refs if isinstance(artifact_refs, dict) else {}
        missing_artifact_refs = [
            field for field in _SIGNOFF_REQUIRED_ARTIFACT_REFS if field not in artifact_refs
        ]
        add_check(
            "template_artifact_refs",
            "error" if missing_artifact_refs else "ok",
            (
                "Artifact template fields cover release-check, readiness, ops-health, and verifier-contract evidence."
                if not missing_artifact_refs
                else "Artifact template fields are incomplete."
            ),
            {"missing": missing_artifact_refs},
        )

        retention_mapping = payload.get("retention_mapping")
        retention_mapping = retention_mapping if isinstance(retention_mapping, dict) else {}
        missing_retention_fields = [
            field for field in _SIGNOFF_REQUIRED_RETENTION_FIELDS if field not in retention_mapping
        ]
        add_check(
            "template_retention_fields",
            "error" if missing_retention_fields else "ok",
            (
                "Retention template fields cover repository, storage, backup, IPFS, Filecoin, S3, logs, alerts, and deletion."
                if not missing_retention_fields
                else "Retention template fields are incomplete."
            ),
            {"missing": missing_retention_fields},
        )

    return {
        "source": "wallet_interface.ops",
        "generated_at": generated_at,
        "status": _report_status(checks),
        "summary": "target production signoff packet template validation completed",
        "packet_path": str(resolved_path),
        "check_count": len(checks),
        "checks": checks,
    }


def validate_proof_contract(service: WalletInterfaceService | None = None) -> dict[str, Any]:
    """Validate the configured external location proof verifier contract."""
    resolved_service = service or WalletInterfaceService()
    backend = resolved_service.wallet_service.proof_backend
    generated_at = datetime.now(timezone.utc).isoformat()
    if not hasattr(backend, "validate_contract"):
        return {
            "source": "wallet_interface.ops",
            "generated_at": generated_at,
            "status": "error",
            "summary": "configured proof backend does not support external contract validation",
            "backend": backend.__class__.__name__,
            "verifier_id": getattr(backend, "verifier_id", None),
            "proof_system": getattr(backend, "proof_system", None),
            "checks": [
                {
                    "name": "backend",
                    "status": "error",
                    "summary": "set WALLET_PROOF_BACKEND=http-location-region for contract validation",
                    "details": {"backend": backend.__class__.__name__},
                }
            ],
        }
    try:
        validation = backend.validate_contract()
    except Exception as exc:
        return {
            "source": "wallet_interface.ops",
            "generated_at": generated_at,
            "status": "error",
            "summary": f"proof verifier contract validation failed: {exc}",
            "backend": backend.__class__.__name__,
            "checks": [
                {
                    "name": "contract",
                    "status": "error",
                    "summary": str(exc),
                    "details": {"error": str(exc)},
                }
            ],
        }
    return {
        "source": "wallet_interface.ops",
        "generated_at": generated_at,
        "status": validation.get("status", "error"),
        "summary": "proof verifier contract validation completed",
        **validation,
    }


def validate_distance_proof_contract(service: WalletInterfaceService | None = None) -> dict[str, Any]:
    """Validate the configured external location-distance proof verifier contract."""
    resolved_service = service or WalletInterfaceService()
    backend = resolved_service.wallet_service.proof_backend
    generated_at = datetime.now(timezone.utc).isoformat()
    if not hasattr(backend, "validate_distance_contract"):
        return {
            "source": "wallet_interface.ops",
            "generated_at": generated_at,
            "status": "error",
            "summary": "configured proof backend does not support location-distance contract validation",
            "backend": backend.__class__.__name__,
            "verifier_id": getattr(backend, "verifier_id", None),
            "proof_system": getattr(backend, "proof_system", None),
            "checks": [
                {
                    "name": "backend",
                    "status": "error",
                    "summary": "set WALLET_PROOF_BACKEND=http-location-region for distance contract validation",
                    "details": {"backend": backend.__class__.__name__},
                }
            ],
        }
    try:
        validation = backend.validate_distance_contract()
    except Exception as exc:
        return {
            "source": "wallet_interface.ops",
            "generated_at": generated_at,
            "status": "error",
            "summary": f"distance proof verifier contract validation failed: {exc}",
            "backend": backend.__class__.__name__,
            "checks": [
                {
                    "name": "contract",
                    "status": "error",
                    "summary": str(exc),
                    "details": {"error": str(exc)},
                }
            ],
        }
    return {
        "source": "wallet_interface.ops",
        "generated_at": generated_at,
        "status": validation.get("status", "error"),
        "summary": "distance proof verifier contract validation completed",
        **validation,
    }


def validate_production_readiness(
    service: WalletInterfaceService | None = None,
    *,
    env: Mapping[str, str] | None = None,
    repository_root: str | None = None,
    verify_storage: bool = True,
    run_proof_contract: bool = True,
    run_distance_proof_contract: bool = True,
) -> dict[str, Any]:
    """Validate the production wallet operations gate for a target environment.

    The report intentionally records only whether secrets are configured, not
    the secret values themselves.
    """

    generated_at = datetime.now(timezone.utc).isoformat()
    checks: list[dict[str, Any]] = []

    def add_check(name: str, status: str, summary: str, details: dict[str, Any] | None = None) -> None:
        checks.append(
            {
                "name": name,
                "status": status,
                "summary": summary,
                "details": details or {},
            }
        )

    repository_value = str(repository_root or _env(env, "WALLET_REPOSITORY_ROOT")).strip()
    storage_configured = bool(_env(env, "WALLET_STORAGE_CONFIG") or _env(env, "WALLET_STORAGE_TYPE"))
    missing_persistence = [
        name
        for name, configured in {
            "WALLET_REPOSITORY_ROOT": bool(repository_value),
            "WALLET_STORAGE_CONFIG or WALLET_STORAGE_TYPE": storage_configured,
        }.items()
        if not configured
    ]
    placeholder_persistence = [
        name
        for name, value in {
            "WALLET_REPOSITORY_ROOT": repository_value,
            "WALLET_STORAGE_CONFIG": _env(env, "WALLET_STORAGE_CONFIG"),
            "WALLET_STORAGE_ROOT": _env(env, "WALLET_STORAGE_ROOT"),
            "WALLET_STORAGE_BUCKET": _env(env, "WALLET_STORAGE_BUCKET"),
        }.items()
        if value and _is_placeholder(value)
    ]
    add_check(
        "persistence_environment",
        "error" if missing_persistence or placeholder_persistence else "ok",
        (
            "Durable repository and encrypted storage env vars are configured."
            if not missing_persistence and not placeholder_persistence
            else "Durable repository or encrypted storage env vars are missing or still placeholders."
        ),
        {
            "missing": missing_persistence,
            "placeholder_vars": placeholder_persistence,
            "auto_load_repository": _bool_env(env, "WALLET_AUTO_LOAD_REPOSITORY"),
            "auto_persist": _bool_env(env, "WALLET_AUTO_PERSIST"),
        },
    )

    proof_mode = _env(env, "WALLET_PROOF_MODE").lower()
    proof_backend = _env(env, "WALLET_PROOF_BACKEND").lower()
    allow_simulated = _bool_env(env, "WALLET_ALLOW_SIMULATED_PROOFS")
    proof_required = {
        "WALLET_PROOF_MODE": proof_mode,
        "WALLET_PROOF_BACKEND": proof_backend,
        "WALLET_PROOF_SERVICE_URL": _env(env, "WALLET_PROOF_SERVICE_URL"),
        "WALLET_PROOF_VERIFIER_ID": _env(env, "WALLET_PROOF_VERIFIER_ID"),
        "WALLET_PROOF_SYSTEM": _env(env, "WALLET_PROOF_SYSTEM"),
        "WALLET_PROOF_CIRCUIT_ID": _env(env, "WALLET_PROOF_CIRCUIT_ID"),
    }
    proof_missing = [name for name, value in proof_required.items() if not value]
    proof_placeholders = [name for name, value in proof_required.items() if value and _is_placeholder(value)]
    proof_errors = list(proof_missing)
    if proof_mode not in {"production", "prod"}:
        proof_errors.append("WALLET_PROOF_MODE must be production")
    if proof_backend not in {"http-location-region", "http", "remote-http", "verifier-http"}:
        proof_errors.append("WALLET_PROOF_BACKEND must be http-location-region")
    if allow_simulated is True:
        proof_errors.append("WALLET_ALLOW_SIMULATED_PROOFS must not enable simulated proofs")
    add_check(
        "proof_environment",
        "error" if proof_errors or proof_placeholders else "ok",
        (
            "Production proof mode and HTTP location-region verifier env vars are configured."
            if not proof_errors and not proof_placeholders
            else "Production proof env vars are incomplete, non-production, or placeholders."
        ),
        {
            "missing_or_invalid": proof_errors,
            "placeholder_vars": proof_placeholders,
            "allow_simulated_proofs": allow_simulated,
        },
    )

    proof_bearer_configured = bool(_env(env, "WALLET_PROOF_BEARER_TOKEN"))
    proof_custom_header_configured = bool(
        _env(env, "WALLET_PROOF_HTTP_HEADER_NAME") and _env(env, "WALLET_PROOF_HTTP_HEADER_VALUE")
    )
    proof_secret_placeholders = [
        name
        for name in ("WALLET_PROOF_BEARER_TOKEN", "WALLET_PROOF_HTTP_HEADER_VALUE")
        if _env(env, name) and _is_placeholder(_env(env, name))
    ]
    add_check(
        "proof_credentials",
        "error" if (not proof_bearer_configured and not proof_custom_header_configured) or proof_secret_placeholders else "ok",
        (
            "External proof verifier credentials are configured."
            if (proof_bearer_configured or proof_custom_header_configured) and not proof_secret_placeholders
            else "External proof verifier credentials are missing or placeholders."
        ),
        {
            "bearer_token_configured": proof_bearer_configured,
            "custom_header_configured": proof_custom_header_configured,
            "placeholder_vars": proof_secret_placeholders,
        },
    )

    ops_secret = _env(env, "WALLET_OPS_HEALTH_SHARED_SECRET")
    alert_url = _env(env, "WALLET_OPS_ALERT_WEBHOOK_URL")
    alert_bearer_configured = bool(_env(env, "WALLET_OPS_ALERT_BEARER_TOKEN"))
    alert_custom_header_configured = bool(
        _env(env, "WALLET_OPS_ALERT_HEADER_NAME") and _env(env, "WALLET_OPS_ALERT_HEADER_VALUE")
    )
    ops_placeholders = [
        name
        for name in (
            "WALLET_OPS_HEALTH_SHARED_SECRET",
            "WALLET_OPS_ALERT_WEBHOOK_URL",
            "WALLET_OPS_ALERT_BEARER_TOKEN",
            "WALLET_OPS_ALERT_HEADER_VALUE",
        )
        if _env(env, name) and _is_placeholder(_env(env, name))
    ]
    ops_missing = []
    if not ops_secret:
        ops_missing.append("WALLET_OPS_HEALTH_SHARED_SECRET")
    if not alert_url:
        ops_missing.append("WALLET_OPS_ALERT_WEBHOOK_URL")
    if not alert_bearer_configured and not alert_custom_header_configured:
        ops_missing.append("WALLET_OPS_ALERT_BEARER_TOKEN or WALLET_OPS_ALERT_HEADER_NAME/VALUE")
    add_check(
        "ops_credentials",
        "error" if ops_missing or ops_placeholders else "ok",
        (
            "Ops health auth and alert credentials are configured."
            if not ops_missing and not ops_placeholders
            else "Ops health auth or alert credentials are missing or placeholders."
        ),
        {
            "missing": ops_missing,
            "placeholder_vars": ops_placeholders,
            "alert_bearer_token_configured": alert_bearer_configured,
            "alert_custom_header_configured": alert_custom_header_configured,
        },
    )

    secret_ref_values = {
        "WALLET_OPS_HEALTH_SECRET_REF": _env(env, "WALLET_OPS_HEALTH_SECRET_REF"),
        "WALLET_OPS_ALERT_SECRET_REF": _env(env, "WALLET_OPS_ALERT_SECRET_REF"),
        "WALLET_PROOF_CREDENTIAL_SECRET_REF": _env(env, "WALLET_PROOF_CREDENTIAL_SECRET_REF"),
        "WALLET_STORAGE_CREDENTIAL_SECRET_REF": _env(env, "WALLET_STORAGE_CREDENTIAL_SECRET_REF"),
    }
    missing_secret_refs = [name for name, value in secret_ref_values.items() if not value]
    placeholder_secret_refs = [
        name for name, value in secret_ref_values.items() if value and _is_placeholder(value)
    ]
    add_check(
        "secret_manager_references",
        "error" if missing_secret_refs or placeholder_secret_refs else "ok",
        (
            "Secret-manager references for ops, alert, proof, and storage credentials are configured."
            if not missing_secret_refs and not placeholder_secret_refs
            else "Secret-manager references are missing or placeholders."
        ),
        {
            "missing": missing_secret_refs,
            "placeholder_vars": placeholder_secret_refs,
            "configured": [name for name, value in secret_ref_values.items() if value],
        },
    )
    checks.extend(_world_id_production_readiness_checks(env))

    resolved_service = service
    if resolved_service is None:
        try:
            resolved_service = WalletInterfaceService(repository_root=repository_root)
        except Exception as exc:
            add_check(
                "service_configuration",
                "error",
                f"WalletInterfaceService could not start from production env: {exc}",
                {"error": str(exc)},
            )

    if resolved_service is not None:
        try:
            health = resolved_service.ops_health(verify_storage=verify_storage)
            add_check(
                "ops_health",
                str(health.get("status", "error")),
                "Ops health check completed.",
                {
                    "status": health.get("status"),
                    "check_count": health.get("check_count"),
                    "checks": [
                        {
                            "name": check.get("name"),
                            "status": check.get("status"),
                            "summary": check.get("summary"),
                        }
                        for check in health.get("checks", [])
                        if isinstance(check, dict)
                    ],
                },
            )
        except Exception as exc:
            add_check("ops_health", "error", f"Ops health check failed: {exc}", {"error": str(exc)})

        if run_proof_contract:
            contract = validate_proof_contract(resolved_service)
            add_check(
                "proof_contract",
                str(contract.get("status", "error")),
                str(contract.get("summary", "proof verifier contract validation completed")),
                {
                    "backend": contract.get("backend"),
                    "verifier_id": contract.get("verifier_id"),
                    "proof_system": contract.get("proof_system"),
                    "checks": contract.get("checks", []),
                    "receipt": contract.get("receipt"),
                },
            )
        if run_distance_proof_contract:
            distance_contract = validate_distance_proof_contract(resolved_service)
            add_check(
                "distance_proof_contract",
                str(distance_contract.get("status", "error")),
                str(distance_contract.get("summary", "distance proof verifier contract validation completed")),
                {
                    "backend": distance_contract.get("backend"),
                    "verifier_id": distance_contract.get("verifier_id"),
                    "proof_system": distance_contract.get("proof_system"),
                    "checks": distance_contract.get("checks", []),
                    "receipt": distance_contract.get("receipt"),
                },
            )

    return {
        "source": "wallet_interface.ops",
        "generated_at": generated_at,
        "status": _report_status(checks),
        "summary": "production wallet readiness validation completed",
        "check_count": len(checks),
        "checks": checks,
    }


def _has_target_readiness_environment(env: Mapping[str, str] | None = None) -> bool:
    source = env if env is not None else os.environ
    return any(str(source.get(name) or "").strip() for name in _READINESS_TARGET_ENV_VARS)


def validate_local_production_readiness_self_check(*, verify_storage: bool = True) -> dict[str, Any]:
    """Run the production-readiness validator against a local synthetic target.

    The no-argument CLI command uses this path only when no target readiness
    environment variables are configured. Explicit target env vars still run the
    strict production gate and fail closed when required values are missing.
    """

    from .proof_backends import HttpLocationRegionProofBackend

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
                "proof_id": "local-self-check-location-region",
                "wallet_id": str(payload["wallet_id"]),
                "proof_type": "location_region",
                "statement": payload["statement"],
                "verifier_id": "local-self-check-verifier-v1",
                "public_inputs": payload["public_inputs"],
                "proof_hash": "local-self-check-region-hash",
                "witness_record_ids": payload["witness_record_ids"],
                "is_simulated": False,
                "proof_system": "groth16",
                "circuit_id": "local-self-check-location-v1",
                "verification_status": "verified",
            }
        if url.endswith("/prove/location-distance"):
            return {
                "proof_id": "local-self-check-location-distance",
                "wallet_id": str(payload["wallet_id"]),
                "proof_type": "location_distance",
                "statement": payload["statement"],
                "verifier_id": "local-self-check-verifier-v1",
                "public_inputs": payload["public_inputs"],
                "proof_hash": "local-self-check-distance-hash",
                "witness_record_ids": payload["witness_record_ids"],
                "is_simulated": False,
                "proof_system": "groth16",
                "circuit_id": "local-self-check-location-v1",
                "verification_status": "verified",
            }
        return {"verified": True}

    with tempfile.TemporaryDirectory(prefix="wallet-readiness-self-check-") as tmp:
        root = Path(tmp)
        repository_root = root / "wallet-repository"
        storage_root = root / "wallet-blobs"
        service = WalletInterfaceService(
            repository_root=repository_root,
            storage_config={"primary": {"type": "local", "root": str(storage_root)}},
            proof_backend=HttpLocationRegionProofBackend(
                base_url="http://127.0.0.1/local-self-check-verifier",
                verifier_id="local-self-check-verifier-v1",
                proof_system="groth16",
                circuit_id="local-self-check-location-v1",
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
            "WALLET_ALLOW_SIMULATED_PROOFS": "false",
            "WALLET_PROOF_BACKEND": "http-location-region",
            "WALLET_PROOF_SERVICE_URL": "http://127.0.0.1/local-self-check-verifier",
            "WALLET_PROOF_VERIFIER_ID": "local-self-check-verifier-v1",
            "WALLET_PROOF_SYSTEM": "groth16",
            "WALLET_PROOF_CIRCUIT_ID": "local-self-check-location-v1",
            "WALLET_PROOF_BEARER_TOKEN": "local-self-check-proof-token",
            "WALLET_OPS_HEALTH_SHARED_SECRET": "local-self-check-ops-token",
            "WALLET_OPS_ALERT_WEBHOOK_URL": "https://ops.staging.211.local/hooks/wallet",
            "WALLET_OPS_ALERT_BEARER_TOKEN": "local-self-check-alert-token",
            "WALLET_OPS_HEALTH_SECRET_REF": "secret://local-self-check/wallet/ops-health",
            "WALLET_OPS_ALERT_SECRET_REF": "secret://local-self-check/wallet/ops-alert",
            "WALLET_PROOF_CREDENTIAL_SECRET_REF": "secret://local-self-check/wallet/proof-verifier",
            "WALLET_STORAGE_CREDENTIAL_SECRET_REF": "secret://local-self-check/wallet/storage",
            "WORLD_ID_ENABLED": "1",
            "WORLD_ID_ENVIRONMENT": "production",
            "WORLD_ID_APP_ID": "app_local_self_check_world_id",
            "WORLD_ID_RP_ID": "rp_local_self_check_world_id",
            "WORLD_ID_ALLOWED_ACTIONS": "wallet-attach-world-id-v1",
            "WORLD_ID_DEFAULT_ACTION": "wallet-attach-world-id-v1",
            "WORLD_ID_CREDENTIAL_POLICY": "proof_of_human",
            "WORLD_ID_ALLOW_LEGACY_PROOFS": "false",
            "WORLD_ID_REQUIRE_USER_PRESENCE": "true",
            "WORLD_ID_RP_SIGNATURE_TTL_SECONDS": "300",
            "WORLD_ID_RP_SIGNING_KEY": "0x" + "11" * 32,
            "WORLD_ID_RP_SIGNING_KEY_SECRET_REF": "secret://local-self-check/wallet/world-id-rp-signing",
            "WORLD_ID_NULLIFIER_HMAC_KEY": "local-self-check-world-id-nullifier-key",
            "WORLD_ID_NULLIFIER_HMAC_KEY_SECRET_REF": "secret://local-self-check/wallet/world-id-nullifier",
            "WORLD_ID_VERIFY_BASE_URL": "https://developer.world.org",
            _WORLD_ID_REACHABILITY_EVIDENCE_ENV: "artifact://local-self-check/world-id-reachability",
            _WORLD_ID_SANITIZATION_EVIDENCE_ENV: "artifact://local-self-check/world-id-sanitization",
        }
        report = validate_production_readiness(
            service,
            env=env,
            repository_root=str(repository_root),
            verify_storage=verify_storage,
            run_proof_contract=True,
            run_distance_proof_contract=True,
        )
    report["mode"] = "local_self_check"
    report["summary"] = (
        "local production-readiness self-check completed; configure target WALLET_* env vars "
        "to run the strict staging or production gate"
    )
    return report


class WalletOpsHealthWorker:
    """Run wallet ops-health checks on a schedule and emit JSONL reports."""

    def __init__(
        self,
        *,
        service: WalletInterfaceService | None = None,
        verify_storage: bool = True,
        interval_seconds: float = 300.0,
        max_runs: int | None = 1,
        fail_on_error: bool = False,
        fail_on_warning: bool = False,
        alert_webhook_url: str | None = None,
        alert_on: str = "error",
        alert_headers: dict[str, str] | None = None,
        alert_sender: Callable[[str, dict[str, Any], dict[str, str]], None] | None = None,
        output: IO[str] | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if interval_seconds < 0:
            raise ValueError("interval_seconds must be non-negative")
        if max_runs is not None and max_runs < 1:
            raise ValueError("max_runs must be at least 1")
        self.service = service or WalletInterfaceService()
        self.verify_storage = verify_storage
        self.interval_seconds = interval_seconds
        self.max_runs = max_runs
        self.fail_on_error = fail_on_error
        self.fail_on_warning = fail_on_warning
        self.alert_webhook_url = str(
            alert_webhook_url or os.getenv("WALLET_OPS_ALERT_WEBHOOK_URL") or ""
        ).strip() or None
        normalized_alert_on = str(alert_on or os.getenv("WALLET_OPS_ALERT_ON") or "error").strip().lower()
        if normalized_alert_on not in {"warning", "error"}:
            raise ValueError("alert_on must be warning or error")
        self.alert_on = normalized_alert_on
        self.alert_headers = dict(alert_headers or _alert_headers_from_env())
        self.alert_sender = alert_sender or _default_alert_sender
        self.output = output or sys.stdout
        self.sleep = sleep

    def run_once(self) -> dict[str, Any]:
        report = self.service.ops_health(verify_storage=self.verify_storage)
        self._write_report(report)
        self._send_alert_if_needed(report)
        return report

    def run(self) -> OpsHealthRunResult:
        statuses: list[str] = []
        report_count = 0
        alert_count = 0
        try:
            while self.max_runs is None or report_count < self.max_runs:
                report = self.run_once()
                statuses.append(str(report.get("status", "unknown")))
                report_count += 1
                if self._should_alert(str(report.get("status", "unknown"))):
                    alert_count += 1
                if self.max_runs is not None and report_count >= self.max_runs:
                    break
                self.sleep(self.interval_seconds)
        except KeyboardInterrupt:  # pragma: no cover - interactive shutdown path.
            pass
        return OpsHealthRunResult(
            report_count=report_count,
            statuses=statuses,
            alert_count=alert_count,
            exit_code=self._exit_code(statuses),
        )

    def _exit_code(self, statuses: list[str]) -> int:
        if self.fail_on_error and "error" in statuses:
            return 2
        if self.fail_on_warning and any(status in {"warning", "error"} for status in statuses):
            return 1
        return 0

    def _write_report(self, report: dict[str, Any]) -> None:
        self.output.write(json.dumps(report, sort_keys=True))
        self.output.write("\n")
        self.output.flush()

    def _should_alert(self, status: str) -> bool:
        return bool(self.alert_webhook_url) and _alert_rank(status) >= _alert_rank(self.alert_on)

    def _send_alert_if_needed(self, report: dict[str, Any]) -> None:
        status = str(report.get("status", "unknown"))
        if not self._should_alert(status):
            return
        check_summaries = [
            {
                "name": str(check.get("name")),
                "status": str(check.get("status")),
                "summary": str(check.get("summary")),
            }
            for check in report.get("checks", [])
            if isinstance(check, dict) and str(check.get("status")) in {"warning", "error"}
        ]
        payload = {
            "source": "wallet_interface.ops",
            "status": status,
            "generated_at": report.get("generated_at"),
            "wallet_count": report.get("wallet_count"),
            "check_count": report.get("check_count"),
            "checks": check_summaries,
            "report": report,
        }
        assert self.alert_webhook_url is not None
        self.alert_sender(self.alert_webhook_url, payload, dict(self.alert_headers))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run 211-AI wallet ops-health checks.")
    parser.add_argument(
        "--repository-root",
        help="Wallet repository root. Defaults to WALLET_REPOSITORY_ROOT.",
    )
    parser.add_argument(
        "--interval-seconds",
        type=float,
        default=300.0,
        help="Delay between checks in watch mode. Default: 300.",
    )
    parser.add_argument(
        "--max-runs",
        type=int,
        help="Bounded number of checks to run. Default: 1 unless --watch is set.",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Run until interrupted instead of exiting after one check.",
    )
    parser.add_argument(
        "--skip-storage-verify",
        action="store_false",
        dest="verify_storage",
        default=True,
        help="Do not read encrypted blob replicas during the health check.",
    )
    parser.add_argument(
        "--fail-on-error",
        action="store_true",
        help="Exit 2 when any emitted report has status=error.",
    )
    parser.add_argument(
        "--fail-on-warning",
        action="store_true",
        help="Exit 1 when any emitted report has status=warning or status=error.",
    )
    parser.add_argument(
        "--output-jsonl",
        help="Append JSONL reports to this file instead of stdout.",
    )
    parser.add_argument(
        "--alert-webhook-url",
        help="POST matching warning/error reports to this webhook. Defaults to WALLET_OPS_ALERT_WEBHOOK_URL.",
    )
    parser.add_argument(
        "--alert-on",
        choices=("warning", "error"),
        default=os.getenv("WALLET_OPS_ALERT_ON", "error"),
        help="Minimum report status that triggers webhook alerts. Default: error.",
    )
    parser.add_argument(
        "--alert-bearer-token",
        help="Bearer token for the alert webhook. Defaults to WALLET_OPS_ALERT_BEARER_TOKEN.",
    )
    parser.add_argument(
        "--alert-header-name",
        help="Custom header name for the alert webhook. Defaults to WALLET_OPS_ALERT_HEADER_NAME.",
    )
    parser.add_argument(
        "--alert-header-value",
        help="Custom header value for the alert webhook. Defaults to WALLET_OPS_ALERT_HEADER_VALUE.",
    )
    parser.add_argument(
        "--validate-proof-contract",
        action="store_true",
        help="Run health/prove/verify validation against the configured external proof verifier and exit.",
    )
    parser.add_argument(
        "--validate-distance-proof-contract",
        action="store_true",
        help=(
            "Run health/prove/verify validation against the configured external "
            "location-distance proof verifier and exit."
        ),
    )
    parser.add_argument(
        "--validate-production-readiness",
        action="store_true",
        help="Run the production env, ops-health, and verifier-contract release gate and exit.",
    )
    parser.add_argument(
        "--validate-target-signoff-packet",
        nargs="?",
        const="__template__",
        help="Validate a completed JSON target production signoff packet and exit.",
    )
    parser.add_argument(
        "--skip-proof-contract",
        action="store_true",
        help="Skip location-region verifier prove/verify during --validate-production-readiness.",
    )
    parser.add_argument(
        "--skip-distance-proof-contract",
        action="store_true",
        help="Skip location-distance verifier prove/verify during --validate-production-readiness.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    max_runs = args.max_runs
    if args.watch and max_runs is None:
        max_runs = None
    elif max_runs is None:
        max_runs = 1

    output: IO[str] | None = None
    try:
        if args.output_jsonl:
            output_path = Path(args.output_jsonl)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output = output_path.open("a", encoding="utf-8")
        alert_headers = _alert_headers_from_env()
        if args.alert_bearer_token:
            alert_headers["authorization"] = f"Bearer {args.alert_bearer_token}"
        if args.alert_header_name and args.alert_header_value:
            alert_headers[args.alert_header_name] = args.alert_header_value
        if args.validate_production_readiness:
            if args.repository_root is None and not _has_target_readiness_environment():
                report = validate_local_production_readiness_self_check(verify_storage=args.verify_storage)
            else:
                report = validate_production_readiness(
                    repository_root=args.repository_root,
                    verify_storage=args.verify_storage,
                    run_proof_contract=not args.skip_proof_contract,
                    run_distance_proof_contract=not args.skip_distance_proof_contract,
                )
            target_output = output or sys.stdout
            target_output.write(json.dumps(report, sort_keys=True))
            target_output.write("\n")
            target_output.flush()
            return 0 if report.get("status") == "ok" else 2
        if args.validate_target_signoff_packet:
            if args.validate_target_signoff_packet == "__template__":
                report = validate_target_signoff_packet_template()
            else:
                report = validate_target_signoff_packet(args.validate_target_signoff_packet)
            target_output = output or sys.stdout
            target_output.write(json.dumps(report, sort_keys=True))
            target_output.write("\n")
            target_output.flush()
            return 0 if report.get("status") == "ok" else 2
        service = WalletInterfaceService(repository_root=args.repository_root)
        if args.validate_proof_contract:
            report = validate_proof_contract(service)
            target_output = output or sys.stdout
            target_output.write(json.dumps(report, sort_keys=True))
            target_output.write("\n")
            target_output.flush()
            return 0 if report.get("status") == "ok" else 2
        if args.validate_distance_proof_contract:
            report = validate_distance_proof_contract(service)
            target_output = output or sys.stdout
            target_output.write(json.dumps(report, sort_keys=True))
            target_output.write("\n")
            target_output.flush()
            return 0 if report.get("status") == "ok" else 2
        worker = WalletOpsHealthWorker(
            service=service,
            verify_storage=args.verify_storage,
            interval_seconds=args.interval_seconds,
            max_runs=max_runs,
            fail_on_error=args.fail_on_error,
            fail_on_warning=args.fail_on_warning,
            alert_webhook_url=args.alert_webhook_url,
            alert_on=args.alert_on,
            alert_headers=alert_headers,
            output=output or sys.stdout,
        )
        return worker.run().exit_code
    finally:
        if output is not None:
            output.close()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
