"""Application-facing wallet service for 211-AI workflows."""

from __future__ import annotations

import json
import os
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence
from uuid import uuid4

from ._vendor import ensure_ipfs_datasets_py_path
from .service_matching import ServiceMatch, ServiceRecord, load_services_jsonl, match_services

ensure_ipfs_datasets_py_path()

from ipfs_datasets_py.wallet import (  # noqa: E402
    DeterministicLocationDistanceProofBackend,
    DeterministicLocationRegionProofBackend,
    LocalWalletRepository,
    ProofBackend,
    SimulatedProofBackend,
    WalletService,
    create_encrypted_blob_store,
)
from ipfs_datasets_py.wallet.audit import append_audit_event  # noqa: E402
from ipfs_datasets_py.wallet.ucan import (  # noqa: E402
    resource_for_export,
    resource_for_location,
    resource_for_record,
    resource_for_wallet,
)
from .proof_backends import HttpLocationRegionProofBackend
from .world_id import (
    WorldIdConfig,
    WorldIdRequestJson,
    WorldIdVerificationError,
    load_world_id_config,
    normalize_world_id_idkit_response,
    redact_world_id_payload,
    sign_world_id_request_from_config,
    verify_world_id_proof_from_config,
)

PROVIDER_STAFF_WORLD_ID_ACTION = "provider-staff-world-id-v1"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _storage_config_from_env() -> str | Dict[str, Any] | None:
    """Read wallet encrypted storage config from environment variables."""

    raw_config = os.getenv("WALLET_STORAGE_CONFIG")
    if raw_config:
        try:
            parsed = json.loads(raw_config)
        except json.JSONDecodeError as exc:
            raise ValueError("WALLET_STORAGE_CONFIG must be valid JSON") from exc
        if not isinstance(parsed, (str, dict)):
            raise ValueError("WALLET_STORAGE_CONFIG must decode to a string or object")
        return parsed

    storage_type = os.getenv("WALLET_STORAGE_TYPE")
    if not storage_type:
        return None

    config: Dict[str, Any] = {"type": storage_type}
    if root := os.getenv("WALLET_STORAGE_ROOT"):
        config["root"] = root
    if bucket := os.getenv("WALLET_STORAGE_BUCKET"):
        config["bucket"] = bucket
    if prefix := os.getenv("WALLET_STORAGE_PREFIX"):
        config["prefix"] = prefix
    if pin := os.getenv("WALLET_STORAGE_PIN"):
        config["pin"] = pin.lower() not in {"0", "false", "no"}
    if mirrors := os.getenv("WALLET_STORAGE_MIRRORS"):
        try:
            parsed_mirrors = json.loads(mirrors)
        except json.JSONDecodeError as exc:
            raise ValueError("WALLET_STORAGE_MIRRORS must be valid JSON") from exc
        if not isinstance(parsed_mirrors, list):
            raise ValueError("WALLET_STORAGE_MIRRORS must decode to a list")
        return {"primary": config, "mirrors": parsed_mirrors}
    return config


def _allow_simulated_proofs_from_env() -> bool:
    """Read wallet proof mode from environment variables."""

    explicit = os.getenv("WALLET_ALLOW_SIMULATED_PROOFS")
    if explicit is not None:
        return explicit.lower() not in {"0", "false", "no", "off"}

    mode = os.getenv("WALLET_PROOF_MODE", "development").lower()
    if mode in {"development", "dev", "test", "local"}:
        return True
    if mode in {"production", "prod"}:
        return False
    raise ValueError("WALLET_PROOF_MODE must be development or production")


def _proof_backend_from_env() -> ProofBackend | None:
    backend = os.getenv("WALLET_PROOF_BACKEND", "").strip().lower()
    if not backend or backend in {"default", "simulated"}:
        return None if not backend or backend == "default" else SimulatedProofBackend()
    if backend in {"deterministic", "deterministic-location-region", "integration"}:
        return DeterministicLocationRegionProofBackend()
    if backend in {"deterministic-location-distance", "integration-location-distance"}:
        return DeterministicLocationDistanceProofBackend()
    if backend in {"http", "http-location-region", "remote-http", "verifier-http"}:
        verifier_headers: Dict[str, str] = {}
        if header_name := str(os.getenv("WALLET_PROOF_HTTP_HEADER_NAME") or "").strip():
            header_value = str(os.getenv("WALLET_PROOF_HTTP_HEADER_VALUE") or "").strip()
            if not header_value:
                raise ValueError("WALLET_PROOF_HTTP_HEADER_VALUE is required when header name is set")
            verifier_headers[header_name] = header_value
        return HttpLocationRegionProofBackend(
            base_url=str(os.getenv("WALLET_PROOF_SERVICE_URL") or "").strip(),
            verifier_id=str(os.getenv("WALLET_PROOF_VERIFIER_ID") or "remote-location-region-v1").strip(),
            proof_system=str(os.getenv("WALLET_PROOF_SYSTEM") or "groth16").strip(),
            circuit_id=str(os.getenv("WALLET_PROOF_CIRCUIT_ID") or "location-region").strip(),
            prove_path=str(os.getenv("WALLET_PROOF_PROVE_PATH") or "/prove/location-region").strip(),
            distance_prove_path=str(
                os.getenv("WALLET_PROOF_DISTANCE_PROVE_PATH") or "/prove/location-distance"
            ).strip(),
            verify_path=str(os.getenv("WALLET_PROOF_VERIFY_PATH") or "/verify").strip(),
            bearer_token=str(os.getenv("WALLET_PROOF_BEARER_TOKEN") or "").strip() or None,
            extra_headers=verifier_headers,
            timeout_seconds=float(str(os.getenv("WALLET_PROOF_TIMEOUT_SECONDS") or "30").strip()),
        )
    raise ValueError(
        "WALLET_PROOF_BACKEND must be default, simulated, deterministic-location-region, "
        "deterministic-location-distance, or http-location-region"
    )


def _repository_root_from_env() -> str | None:
    return os.getenv("WALLET_REPOSITORY_ROOT")


def _flag_from_env(name: str, *, default: bool) -> bool:
    explicit = os.getenv(name)
    if explicit is None:
        return default
    return explicit.lower() not in {"0", "false", "no", "off"}


PORTAL_STATE_TYPE = "wallet_repository_portal_state_v1"
PORTAL_STATE_FILENAME = "portal-state.json"


def _portal_now() -> str:
    return _utc_now()


def _portal_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex}"


def _unique_strings(values: Sequence[str] | None) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []
    for value in values or []:
        item = str(value or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def _portal_resource(wallet_id: str, collection: str, entry_id: str) -> str:
    return f"{resource_for_wallet(wallet_id)}/portal/{collection}/{entry_id}"


@dataclass
class SavedServiceRecord:
    saved_service_id: str
    wallet_id: str
    service_doc_id: str
    source_content_cid: str
    source_page_cid: str = ""
    title: str = ""
    provider_name: str = ""
    program_name: str = ""
    source_url: str = ""
    label: str = ""
    reason: str = ""
    priority: str = "normal"
    status: str = "saved"
    created_at: str = ""
    updated_at: str = ""
    private_notes_record_id: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "saved_service_id": self.saved_service_id,
            "wallet_id": self.wallet_id,
            "service_doc_id": self.service_doc_id,
            "source_content_cid": self.source_content_cid,
            "source_page_cid": self.source_page_cid,
            "title": self.title,
            "provider_name": self.provider_name,
            "program_name": self.program_name,
            "source_url": self.source_url,
            "label": self.label,
            "reason": self.reason,
            "priority": self.priority,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "private_notes_record_id": self.private_notes_record_id,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "SavedServiceRecord":
        return cls(
            saved_service_id=str(payload.get("saved_service_id") or ""),
            wallet_id=str(payload.get("wallet_id") or ""),
            service_doc_id=str(payload.get("service_doc_id") or ""),
            source_content_cid=str(payload.get("source_content_cid") or ""),
            source_page_cid=str(payload.get("source_page_cid") or ""),
            title=str(payload.get("title") or ""),
            provider_name=str(payload.get("provider_name") or ""),
            program_name=str(payload.get("program_name") or ""),
            source_url=str(payload.get("source_url") or ""),
            label=str(payload.get("label") or ""),
            reason=str(payload.get("reason") or ""),
            priority=str(payload.get("priority") or "normal"),
            status=str(payload.get("status") or "saved"),
            created_at=str(payload.get("created_at") or ""),
            updated_at=str(payload.get("updated_at") or ""),
            private_notes_record_id=str(payload.get("private_notes_record_id") or ""),
            metadata=dict(payload.get("metadata") or {}),
        )


@dataclass
class ServicePlanRecord:
    plan_id: str
    wallet_id: str
    service_doc_id: str
    source_content_cid: str = ""
    source_page_cid: str = ""
    service_title: str = ""
    provider_name: str = ""
    goal: str = ""
    steps: List[str] = field(default_factory=list)
    documents_needed: List[str] = field(default_factory=list)
    questions_to_ask: List[str] = field(default_factory=list)
    appointment_at: str = ""
    reminder_at: str = ""
    travel_target: str = ""
    assigned_worker_recipient_id: str = ""
    status: str = "active"
    related_interaction_ids: List[str] = field(default_factory=list)
    private_notes_record_id: str = ""
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "wallet_id": self.wallet_id,
            "service_doc_id": self.service_doc_id,
            "source_content_cid": self.source_content_cid,
            "source_page_cid": self.source_page_cid,
            "service_title": self.service_title,
            "provider_name": self.provider_name,
            "goal": self.goal,
            "steps": list(self.steps),
            "documents_needed": list(self.documents_needed),
            "questions_to_ask": list(self.questions_to_ask),
            "appointment_at": self.appointment_at,
            "reminder_at": self.reminder_at,
            "travel_target": self.travel_target,
            "assigned_worker_recipient_id": self.assigned_worker_recipient_id,
            "status": self.status,
            "related_interaction_ids": list(self.related_interaction_ids),
            "private_notes_record_id": self.private_notes_record_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "ServicePlanRecord":
        return cls(
            plan_id=str(payload.get("plan_id") or ""),
            wallet_id=str(payload.get("wallet_id") or ""),
            service_doc_id=str(payload.get("service_doc_id") or ""),
            source_content_cid=str(payload.get("source_content_cid") or ""),
            source_page_cid=str(payload.get("source_page_cid") or ""),
            service_title=str(payload.get("service_title") or ""),
            provider_name=str(payload.get("provider_name") or ""),
            goal=str(payload.get("goal") or ""),
            steps=_unique_strings(payload.get("steps") or []),
            documents_needed=_unique_strings(payload.get("documents_needed") or []),
            questions_to_ask=_unique_strings(payload.get("questions_to_ask") or []),
            appointment_at=str(payload.get("appointment_at") or ""),
            reminder_at=str(payload.get("reminder_at") or ""),
            travel_target=str(payload.get("travel_target") or ""),
            assigned_worker_recipient_id=str(payload.get("assigned_worker_recipient_id") or ""),
            status=str(payload.get("status") or "active"),
            related_interaction_ids=_unique_strings(payload.get("related_interaction_ids") or []),
            private_notes_record_id=str(payload.get("private_notes_record_id") or ""),
            created_at=str(payload.get("created_at") or ""),
            updated_at=str(payload.get("updated_at") or ""),
        )


@dataclass
class ServiceInteractionRecord:
    interaction_id: str
    wallet_id: str
    service_doc_id: str
    source_content_cid: str = ""
    source_page_cid: str = ""
    provider_name: str = ""
    program_name: str = ""
    interaction_type: str = ""
    channel: str = ""
    actor_did: str = ""
    counterparty_name: str = ""
    counterparty_contact: str = ""
    timestamp: str = ""
    status: str = ""
    outcome: str = ""
    notes_record_id: str = ""
    next_action: str = ""
    next_follow_up_at: str = ""
    source_action_url: str = ""
    related_grant_ids: List[str] = field(default_factory=list)
    related_record_ids: List[str] = field(default_factory=list)
    privacy_level: str = "private"
    created_at: str = ""
    updated_at: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "interaction_id": self.interaction_id,
            "wallet_id": self.wallet_id,
            "service_doc_id": self.service_doc_id,
            "source_content_cid": self.source_content_cid,
            "source_page_cid": self.source_page_cid,
            "provider_name": self.provider_name,
            "program_name": self.program_name,
            "interaction_type": self.interaction_type,
            "channel": self.channel,
            "actor_did": self.actor_did,
            "counterparty_name": self.counterparty_name,
            "counterparty_contact": self.counterparty_contact,
            "timestamp": self.timestamp,
            "status": self.status,
            "outcome": self.outcome,
            "notes_record_id": self.notes_record_id,
            "next_action": self.next_action,
            "next_follow_up_at": self.next_follow_up_at,
            "source_action_url": self.source_action_url,
            "related_grant_ids": list(self.related_grant_ids),
            "related_record_ids": list(self.related_record_ids),
            "privacy_level": self.privacy_level,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "ServiceInteractionRecord":
        return cls(
            interaction_id=str(payload.get("interaction_id") or ""),
            wallet_id=str(payload.get("wallet_id") or ""),
            service_doc_id=str(payload.get("service_doc_id") or ""),
            source_content_cid=str(payload.get("source_content_cid") or ""),
            source_page_cid=str(payload.get("source_page_cid") or ""),
            provider_name=str(payload.get("provider_name") or ""),
            program_name=str(payload.get("program_name") or ""),
            interaction_type=str(payload.get("interaction_type") or ""),
            channel=str(payload.get("channel") or ""),
            actor_did=str(payload.get("actor_did") or ""),
            counterparty_name=str(payload.get("counterparty_name") or ""),
            counterparty_contact=str(payload.get("counterparty_contact") or ""),
            timestamp=str(payload.get("timestamp") or ""),
            status=str(payload.get("status") or ""),
            outcome=str(payload.get("outcome") or ""),
            notes_record_id=str(payload.get("notes_record_id") or ""),
            next_action=str(payload.get("next_action") or ""),
            next_follow_up_at=str(payload.get("next_follow_up_at") or ""),
            source_action_url=str(payload.get("source_action_url") or ""),
            related_grant_ids=_unique_strings(payload.get("related_grant_ids") or []),
            related_record_ids=_unique_strings(payload.get("related_record_ids") or []),
            privacy_level=str(payload.get("privacy_level") or "private"),
            created_at=str(payload.get("created_at") or ""),
            updated_at=str(payload.get("updated_at") or ""),
            metadata=dict(payload.get("metadata") or {}),
        )


class WalletInterfaceService:
    """Thin 211-AI interface around `ipfs_datasets_py.wallet`."""

    def __init__(
        self,
        *,
        wallet_service: WalletService | None = None,
        storage_config: str | Mapping[str, Any] | None = None,
        storage_backends: Mapping[str, object] | None = None,
        proof_backend: ProofBackend | None = None,
        allow_simulated_proofs: bool | None = None,
        ipfs_backend: object | None = None,
        s3_client: object | None = None,
        filecoin_backend: object | None = None,
        repository_root: str | Path | None = None,
        auto_persist: bool | None = None,
        auto_load_repository: bool | None = None,
        services: Sequence[ServiceRecord] | None = None,
        world_id_config: WorldIdConfig | None = None,
        world_id_request_json: WorldIdRequestJson | None = None,
    ) -> None:
        if wallet_service is None:
            storage = create_encrypted_blob_store(
                storage_config if storage_config is not None else _storage_config_from_env(),
                ipfs_backend=ipfs_backend,
                s3_client=s3_client,
                filecoin_backend=filecoin_backend,
                backends=storage_backends,
            )
            wallet_service = WalletService(
                storage_backend=storage,
                proof_backend=proof_backend if proof_backend is not None else _proof_backend_from_env(),
                allow_simulated_proofs=(
                    _allow_simulated_proofs_from_env()
                    if allow_simulated_proofs is None
                    else allow_simulated_proofs
                ),
            )
        self.wallet_service = wallet_service
        resolved_repository_root = repository_root if repository_root is not None else _repository_root_from_env()
        self.repository = LocalWalletRepository(resolved_repository_root) if resolved_repository_root else None
        self.saved_services: Dict[str, SavedServiceRecord] = {}
        self.service_plans: Dict[str, ServicePlanRecord] = {}
        self.service_interactions: Dict[str, ServiceInteractionRecord] = {}
        self.auto_persist = (
            _flag_from_env("WALLET_AUTO_PERSIST", default=True)
            if auto_persist is None
            else auto_persist
        )
        should_auto_load = (
            _flag_from_env("WALLET_AUTO_LOAD_REPOSITORY", default=True)
            if auto_load_repository is None
            else auto_load_repository
        )
        if self.repository is not None and should_auto_load:
            self.repository.load_all(self.wallet_service)
            self._load_portal_state(required=False)
        self.services = list(services or [])
        self.world_id_config = world_id_config if world_id_config is not None else load_world_id_config()
        self.world_id_request_json = world_id_request_json

    @classmethod
    def from_services_jsonl(
        cls,
        path: str | Path,
        *,
        wallet_service: WalletService | None = None,
        storage_config: str | Mapping[str, Any] | None = None,
        storage_backends: Mapping[str, object] | None = None,
        proof_backend: ProofBackend | None = None,
        allow_simulated_proofs: bool | None = None,
        ipfs_backend: object | None = None,
        s3_client: object | None = None,
        filecoin_backend: object | None = None,
        repository_root: str | Path | None = None,
        auto_persist: bool | None = None,
        auto_load_repository: bool | None = None,
        world_id_config: WorldIdConfig | None = None,
        world_id_request_json: WorldIdRequestJson | None = None,
    ) -> "WalletInterfaceService":
        return cls(
            wallet_service=wallet_service,
            storage_config=storage_config,
            storage_backends=storage_backends,
            proof_backend=proof_backend,
            allow_simulated_proofs=allow_simulated_proofs,
            ipfs_backend=ipfs_backend,
            s3_client=s3_client,
            filecoin_backend=filecoin_backend,
            repository_root=repository_root,
            auto_persist=auto_persist,
            auto_load_repository=auto_load_repository,
            world_id_config=world_id_config,
            world_id_request_json=world_id_request_json,
            services=load_services_jsonl(path),
        )

    def save_wallet_snapshot(self, wallet_id: str) -> Path:
        if self.repository is None:
            raise ValueError("Wallet repository is not configured")
        path = self.repository.save(self.wallet_service, wallet_id)
        self._save_portal_state()
        return path

    def load_wallet_snapshot(self, wallet_id: str) -> None:
        if self.repository is None:
            raise ValueError("Wallet repository is not configured")
        self.repository.load(self.wallet_service, wallet_id)
        self._load_portal_state(required=False)

    def verify_wallet_snapshot(self, wallet_id: str) -> Dict[str, Any]:
        if self.repository is None:
            raise ValueError("Wallet repository is not configured")
        return self.repository.verify(wallet_id)

    def save_all_wallet_snapshots(self) -> list[Path]:
        if self.repository is None:
            raise ValueError("Wallet repository is not configured")
        paths = self.repository.save_all(self.wallet_service)
        self._save_portal_state()
        return paths

    def load_all_wallet_snapshots(self) -> list[str]:
        if self.repository is None:
            raise ValueError("Wallet repository is not configured")
        wallet_ids = self.repository.load_all(self.wallet_service)
        self._load_portal_state(required=False)
        return wallet_ids

    def list_wallet_snapshots(self) -> list[str]:
        if self.repository is None:
            return []
        return self.repository.list_wallet_ids()

    def ops_health(self, *, verify_storage: bool = False) -> Dict[str, Any]:
        """Return actionable deployment health for wallet operations."""

        checks: list[Dict[str, Any]] = []

        def add_check(name: str, status: str, summary: str, **details: Any) -> None:
            checks.append(
                {
                    "name": name,
                    "status": status,
                    "summary": summary,
                    "details": details,
                }
            )

        if self.repository is None:
            add_check(
                "repository",
                "warning",
                "Wallet repository is not configured; API restarts keep only in-memory wallet state.",
                configured=False,
                env_var="WALLET_REPOSITORY_ROOT",
            )
        else:
            try:
                snapshot_wallet_ids = self.repository.list_wallet_ids()
                live_wallet_ids = sorted(self.wallet_service.wallets)
                missing_snapshots = [wallet_id for wallet_id in live_wallet_ids if wallet_id not in snapshot_wallet_ids]
                add_check(
                    "repository",
                    "warning" if missing_snapshots else "ok",
                    (
                        "Wallet repository is configured, but some live wallets have not been snapshotted."
                        if missing_snapshots
                        else "Wallet repository is configured and live wallets have snapshots."
                    ),
                    configured=True,
                    wallet_snapshot_count=len(snapshot_wallet_ids),
                    live_wallet_count=len(live_wallet_ids),
                    missing_snapshot_wallet_ids=missing_snapshots,
                )
            except Exception as exc:  # pragma: no cover - backend-specific failure path.
                add_check("repository", "error", str(exc), configured=True)

        storage_name = self.wallet_service.storage.__class__.__name__
        active_records = [
            record
            for record in self.wallet_service.records.values()
            if record.status == "active"
        ]
        storage_failures: list[Dict[str, Any]] = []
        if verify_storage:
            for record in active_records:
                try:
                    report = self.wallet_service.verify_record_storage(record.wallet_id, record.record_id)
                except Exception as exc:  # pragma: no cover - backend-specific failure path.
                    storage_failures.append(
                        {
                            "wallet_id": record.wallet_id,
                            "record_id": record.record_id,
                            "error": str(exc),
                        }
                    )
                    continue
                if not report.ok:
                    storage_failures.append(
                        {
                            "wallet_id": record.wallet_id,
                            "record_id": record.record_id,
                            "payload_failures": [
                                status.to_dict() for status in report.payload if not status.ok
                            ],
                            "metadata_failures": [
                                status.to_dict() for status in report.metadata if not status.ok
                            ],
                        }
                    )
        add_check(
            "storage_availability",
            "error" if storage_failures else "ok",
            (
                f"{len(storage_failures)} active records failed encrypted storage verification."
                if storage_failures
                else "Encrypted storage backend is configured and no verified records failed."
            ),
            backend=storage_name,
            active_record_count=len(active_records),
            verified=verify_storage,
            failures=storage_failures,
        )

        proof_backend_name = self.wallet_service.proof_backend.__class__.__name__
        simulated_enabled = bool(self.wallet_service.allow_simulated_proofs)
        proof_status = "warning" if simulated_enabled else "ok"
        proof_summary = (
            "Simulated proof receipts are enabled; configure a production proof backend before launch."
            if simulated_enabled
            else "Production proof mode rejects simulated proof receipts."
        )
        proof_health_details: Dict[str, Any] | None = None
        if not simulated_enabled and hasattr(self.wallet_service.proof_backend, "healthcheck"):
            try:
                raw_health = getattr(self.wallet_service.proof_backend, "healthcheck")()
                if isinstance(raw_health, Mapping):
                    proof_health_details = dict(raw_health)
                    if not bool(raw_health.get("ok", False)):
                        proof_status = "error"
                        proof_summary = "Configured proof backend health check failed."
                    elif str(raw_health.get("status") or "").lower() not in {"", "ok", "healthy", "ready"}:
                        proof_status = "warning"
                        proof_summary = "Configured proof backend reported a non-ready health status."
                else:
                    proof_status = "error"
                    proof_summary = "Configured proof backend health check returned an invalid payload."
                    proof_health_details = {"ok": False, "details": raw_health}
            except Exception as exc:  # pragma: no cover - backend/network specific failure path.
                proof_status = "error"
                proof_summary = "Configured proof backend health check raised an exception."
                proof_health_details = {"ok": False, "error": str(exc)}
        add_check(
            "proof_registry",
            proof_status,
            proof_summary,
            backend=proof_backend_name,
            verifier_id=getattr(self.wallet_service.proof_backend, "verifier_id", None),
            proof_system=getattr(self.wallet_service.proof_backend, "proof_system", None),
            backend_mode=getattr(self.wallet_service.proof_backend, "mode", None),
            is_simulated_backend=bool(getattr(self.wallet_service.proof_backend, "is_simulated", False)),
            backend_health=proof_health_details,
            allow_simulated_proofs=simulated_enabled,
            env_vars=["WALLET_PROOF_MODE", "WALLET_PROOF_BACKEND", "WALLET_ALLOW_SIMULATED_PROOFS"],
        )

        revoked_grant_ids = {
            grant.grant_id for grant in self.wallet_service.grants.values() if grant.status == "revoked"
        }
        dangling_key_wraps = []
        for version in self.wallet_service.versions.values():
            for key_wrap in version.key_wraps:
                if key_wrap.grant_id in revoked_grant_ids and key_wrap.status == "active":
                    dangling_key_wraps.append(
                        {
                            "record_id": key_wrap.record_id,
                            "version_id": key_wrap.version_id,
                            "recipient_did": key_wrap.recipient_did,
                            "grant_id": key_wrap.grant_id,
                        }
                    )
        add_check(
            "revocation_propagation",
            "error" if dangling_key_wraps else "ok",
            (
                f"{len(dangling_key_wraps)} active key wraps still reference revoked grants."
                if dangling_key_wraps
                else "Revoked grants do not have active delegated key wraps."
            ),
            revoked_grant_count=len(revoked_grant_ids),
            dangling_key_wraps=dangling_key_wraps,
        )

        budget_spent = dict(sorted(self.wallet_service.analytics_query_budget_spent.items()))
        negative_budgets = {key: value for key, value in budget_spent.items() if value < 0}
        add_check(
            "privacy_budget",
            "error" if negative_budgets else "ok",
            (
                "Privacy budget ledger contains invalid negative spend values."
                if negative_budgets
                else "Privacy budget ledger is readable."
            ),
            budget_key_count=len(budget_spent),
            spent=budget_spent,
            invalid_negative_spend=negative_budgets,
        )

        if any(check["status"] == "error" for check in checks):
            status = "error"
        elif any(check["status"] == "warning" for check in checks):
            status = "warning"
        else:
            status = "ok"

        report = {
            "status": status,
            "generated_at": _utc_now(),
            "wallet_count": len(self.wallet_service.wallets),
            "check_count": len(checks),
            "checks": checks,
        }
        self._audit_ops_health(report)
        self._persist_all_wallets_if_configured()
        return report

    def _audit_ops_health(self, report: Mapping[str, Any]) -> None:
        check_statuses = {
            str(check.get("name")): str(check.get("status"))
            for check in report.get("checks", [])
            if isinstance(check, Mapping)
        }
        for wallet_id in sorted(self.wallet_service.wallets):
            append_audit_event(
                self.wallet_service.audit_events.setdefault(wallet_id, []),
                wallet_id=wallet_id,
                actor_did="did:wallet:ops",
                action="ops/health",
                resource=resource_for_wallet(wallet_id),
                decision="deny" if report.get("status") == "error" else "allow",
                details={
                    "status": report.get("status"),
                    "check_statuses": check_statuses,
                },
            )

    def _persist_wallet_if_configured(self, wallet_id: str) -> None:
        if self.repository is not None and self.auto_persist:
            self.repository.save(self.wallet_service, wallet_id)
            self._save_portal_state()

    def _persist_all_wallets_if_configured(self) -> None:
        if self.repository is not None and self.auto_persist:
            self.repository.save_all(self.wallet_service)
            self._save_portal_state()

    def _portal_state_path(self) -> Path:
        if self.repository is None:
            raise ValueError("Wallet repository is not configured")
        return self.repository.root / PORTAL_STATE_FILENAME

    def _portal_state_payload(self) -> Dict[str, Any]:
        return {
            "snapshot_type": PORTAL_STATE_TYPE,
            "saved_services": [
                record.to_dict()
                for record in sorted(self.saved_services.values(), key=lambda item: (item.wallet_id, item.saved_service_id))
            ],
            "service_plans": [
                record.to_dict()
                for record in sorted(self.service_plans.values(), key=lambda item: (item.wallet_id, item.plan_id))
            ],
            "service_interactions": [
                record.to_dict()
                for record in sorted(
                    self.service_interactions.values(),
                    key=lambda item: (item.wallet_id, item.timestamp, item.interaction_id),
                )
            ],
        }

    def _save_portal_state(self) -> Path | None:
        if self.repository is None:
            return None
        path = self._portal_state_path()
        payload = self._portal_state_payload()
        tmp_path = path.with_name(f".{path.name}.tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp_path.replace(path)
        return path

    def _load_portal_state(self, *, required: bool = False) -> None:
        if self.repository is None:
            return
        path = self._portal_state_path()
        if not path.exists():
            if required:
                raise ValueError("Portal state snapshot not found")
            return
        payload = json.loads(path.read_text(encoding="utf-8"))
        if str(payload.get("snapshot_type") or "") != PORTAL_STATE_TYPE:
            raise ValueError("Unsupported portal state snapshot type")
        self.saved_services = {
            record.saved_service_id: record
            for record in (
                SavedServiceRecord.from_dict(item)
                for item in payload.get("saved_services", [])
                if isinstance(item, Mapping)
            )
            if record.saved_service_id
        }
        self.service_plans = {
            record.plan_id: record
            for record in (
                ServicePlanRecord.from_dict(item)
                for item in payload.get("service_plans", [])
                if isinstance(item, Mapping)
            )
            if record.plan_id
        }
        self.service_interactions = {
            record.interaction_id: record
            for record in (
                ServiceInteractionRecord.from_dict(item)
                for item in payload.get("service_interactions", [])
                if isinstance(item, Mapping)
            )
            if record.interaction_id
        }

    def _wallet_principals(self, wallet_id: str) -> set[str]:
        wallet = self.wallet_service._wallet(wallet_id)
        return {str(wallet.owner_did), *[str(item) for item in wallet.controller_dids], *[str(item) for item in wallet.device_dids]}

    def _require_portal_actor(self, wallet_id: str, actor_did: str) -> None:
        actor = str(actor_did or "").strip()
        if not actor:
            raise ValueError("actor_did is required")
        if actor not in self._wallet_principals(wallet_id):
            raise ValueError("actor_did is not authorized for this wallet")

    def _portal_audit(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        action: str,
        resource: str,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        append_audit_event(
            self.wallet_service.audit_events.setdefault(wallet_id, []),
            wallet_id=wallet_id,
            actor_did=actor_did,
            action=action,
            resource=resource,
            decision="allow",
            details=dict(details or {}),
        )

    def create_wallet(
        self,
        owner_did: str,
        *,
        controller_dids: Sequence[str] | None = None,
        approval_threshold: int | None = None,
    ):
        governance_policy = None
        if approval_threshold is not None:
            controllers = list(controller_dids or [owner_did])
            if owner_did not in controllers:
                controllers = [owner_did, *controllers]
            governance_policy = {
                "threshold": approval_threshold,
                "approver_dids": controllers,
            }
        wallet = self.wallet_service.create_wallet(
            owner_did=owner_did,
            controller_dids=list(controller_dids) if controller_dids is not None else None,
            governance_policy=governance_policy,
        )
        self._persist_wallet_if_configured(wallet.wallet_id)
        return wallet

    def get_wallet(self, wallet_id: str):
        return self.wallet_service.get_wallet(wallet_id)

    def add_controller(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        controller_did: str,
        controller_secret: bytes | None = None,
        approval_id: str | None = None,
    ):
        wallet = self.wallet_service.add_controller(
            wallet_id,
            actor_did=actor_did,
            controller_did=controller_did,
            controller_secret=controller_secret,
            approval_id=approval_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return wallet

    def remove_controller(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        controller_did: str,
        approval_id: str | None = None,
    ):
        wallet = self.wallet_service.remove_controller(
            wallet_id,
            actor_did=actor_did,
            controller_did=controller_did,
            approval_id=approval_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return wallet

    def add_device(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        device_did: str,
        device_secret: bytes | None = None,
        approval_id: str | None = None,
    ):
        wallet = self.wallet_service.add_device(
            wallet_id,
            actor_did=actor_did,
            device_did=device_did,
            device_secret=device_secret,
            approval_id=approval_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return wallet

    def revoke_device(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        device_did: str,
        approval_id: str | None = None,
    ):
        wallet = self.wallet_service.revoke_device(
            wallet_id,
            actor_did=actor_did,
            device_did=device_did,
            approval_id=approval_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return wallet

    def set_recovery_policy(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        contact_dids: Sequence[str],
        threshold: int = 1,
        approval_id: str | None = None,
    ):
        wallet = self.wallet_service.set_recovery_policy(
            wallet_id,
            actor_did=actor_did,
            contact_dids=list(contact_dids),
            threshold=threshold,
            approval_id=approval_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return wallet

    def recover_controller(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        controller_did: str,
        controller_secret: bytes | None = None,
        approval_id: str | None = None,
    ):
        wallet = self.wallet_service.recover_controller(
            wallet_id,
            actor_did=actor_did,
            controller_did=controller_did,
            controller_secret=controller_secret,
            approval_id=approval_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return wallet

    def add_location(self, wallet_id: str, *, actor_did: str, lat: float, lon: float):
        record = self.wallet_service.add_location(wallet_id, actor_did=actor_did, lat=lat, lon=lon)
        self._persist_wallet_if_configured(wallet_id)
        return record

    def add_document(
        self,
        wallet_id: str,
        path: str | Path,
        *,
        actor_did: str,
        actor_secret: bytes | None = None,
        metadata: Dict[str, Any] | None = None,
    ):
        record = self.wallet_service.add_document(
            wallet_id,
            path,
            actor_did=actor_did,
            actor_secret=actor_secret,
            metadata=metadata,
        )
        self._persist_wallet_if_configured(wallet_id)
        return record

    def add_text_document(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        text: str,
        actor_secret: bytes | None = None,
        filename: str = "document.txt",
        metadata: Dict[str, Any] | None = None,
    ):
        private_metadata = {"filename": filename, **(metadata or {})}
        record = self.wallet_service.add_record(
            wallet_id,
            data_type="document",
            plaintext=text.encode("utf-8"),
            actor_did=actor_did,
            actor_secret=actor_secret,
            private_metadata=private_metadata,
            sensitivity="restricted",
            public_descriptor="document",
        )
        self._persist_wallet_if_configured(wallet_id)
        return record

    def add_binary_document(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        data: bytes,
        actor_secret: bytes | None = None,
        filename: str = "document.bin",
        content_type: str | None = None,
        metadata: Dict[str, Any] | None = None,
    ):
        private_metadata = {
            "filename": filename,
            "content_type": content_type or "application/octet-stream",
            **(metadata or {}),
        }
        record = self.wallet_service.add_record(
            wallet_id,
            data_type="document",
            plaintext=data,
            actor_did=actor_did,
            actor_secret=actor_secret,
            private_metadata=private_metadata,
            sensitivity="restricted",
            public_descriptor="document",
        )
        self._persist_wallet_if_configured(wallet_id)
        return record

    def list_records(self, wallet_id: str, *, data_type: str | None = None):
        self.wallet_service._wallet(wallet_id)
        records = [
            record
            for record in self.wallet_service.records.values()
            if record.wallet_id == wallet_id
        ]
        if data_type is not None:
            records = [record for record in records if record.data_type == data_type]
        return sorted(records, key=lambda item: item.created_at)

    def save_service_for_wallet(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        service_doc_id: str,
        source_content_cid: str,
        source_page_cid: str = "",
        title: str = "",
        provider_name: str = "",
        program_name: str = "",
        source_url: str = "",
        label: str = "",
        reason: str = "",
        priority: str = "normal",
        status: str = "saved",
        private_notes_record_id: str = "",
        metadata: Mapping[str, Any] | None = None,
    ) -> SavedServiceRecord:
        self._require_portal_actor(wallet_id, actor_did)
        service_doc = str(service_doc_id or "").strip()
        content_cid = str(source_content_cid or "").strip()
        if not service_doc:
            raise ValueError("service_doc_id is required")
        if not content_cid:
            raise ValueError("source_content_cid is required")
        now = _portal_now()
        existing = next(
            (
                record
                for record in self.saved_services.values()
                if record.wallet_id == wallet_id and record.service_doc_id == service_doc
            ),
            None,
        )
        record = SavedServiceRecord(
            saved_service_id=existing.saved_service_id if existing is not None else _portal_id("saved-service"),
            wallet_id=wallet_id,
            service_doc_id=service_doc,
            source_content_cid=content_cid,
            source_page_cid=str(source_page_cid or (existing.source_page_cid if existing else "")),
            title=str(title or (existing.title if existing else "")),
            provider_name=str(provider_name or (existing.provider_name if existing else "")),
            program_name=str(program_name or (existing.program_name if existing else "")),
            source_url=str(source_url or (existing.source_url if existing else "")),
            label=str(label or (existing.label if existing else "")),
            reason=str(reason or (existing.reason if existing else "")),
            priority=str(priority or (existing.priority if existing else "normal")),
            status=str(status or (existing.status if existing else "saved")),
            created_at=existing.created_at if existing is not None else now,
            updated_at=now,
            private_notes_record_id=str(
                private_notes_record_id or (existing.private_notes_record_id if existing else "")
            ),
            metadata={**(existing.metadata if existing else {}), **dict(metadata or {})},
        )
        self.saved_services[record.saved_service_id] = record
        self._portal_audit(
            wallet_id,
            actor_did=actor_did,
            action="service/save" if existing is None else "service/update",
            resource=_portal_resource(wallet_id, "saved-services", record.saved_service_id),
            details={
                "service_doc_id": record.service_doc_id,
                "status": record.status,
                "priority": record.priority,
            },
        )
        self._persist_wallet_if_configured(wallet_id)
        return record

    def update_saved_service(
        self,
        wallet_id: str,
        saved_service_id: str,
        *,
        actor_did: str,
        source_content_cid: str | None = None,
        source_page_cid: str | None = None,
        title: str | None = None,
        provider_name: str | None = None,
        program_name: str | None = None,
        source_url: str | None = None,
        label: str | None = None,
        reason: str | None = None,
        priority: str | None = None,
        status: str | None = None,
        private_notes_record_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> SavedServiceRecord:
        self._require_portal_actor(wallet_id, actor_did)
        record = self.saved_services.get(saved_service_id)
        if record is None or record.wallet_id != wallet_id:
            raise ValueError("saved service not found")
        if source_content_cid is not None:
            record.source_content_cid = str(source_content_cid or "")
        if source_page_cid is not None:
            record.source_page_cid = str(source_page_cid or "")
        if title is not None:
            record.title = str(title or "")
        if provider_name is not None:
            record.provider_name = str(provider_name or "")
        if program_name is not None:
            record.program_name = str(program_name or "")
        if source_url is not None:
            record.source_url = str(source_url or "")
        if label is not None:
            record.label = str(label or "")
        if reason is not None:
            record.reason = str(reason or "")
        if priority is not None:
            record.priority = str(priority or "")
        if status is not None:
            record.status = str(status or "")
        if private_notes_record_id is not None:
            record.private_notes_record_id = str(private_notes_record_id or "")
        if metadata is not None:
            record.metadata = {**record.metadata, **dict(metadata)}
        record.updated_at = _portal_now()
        self._portal_audit(
            wallet_id,
            actor_did=actor_did,
            action="service/update",
            resource=_portal_resource(wallet_id, "saved-services", record.saved_service_id),
            details={"service_doc_id": record.service_doc_id, "status": record.status},
        )
        self._persist_wallet_if_configured(wallet_id)
        return record

    def list_saved_services(self, wallet_id: str, *, status: str | None = None) -> List[SavedServiceRecord]:
        self.wallet_service._wallet(wallet_id)
        records = [record for record in self.saved_services.values() if record.wallet_id == wallet_id]
        if status is not None:
            records = [record for record in records if record.status == status]
        return sorted(records, key=lambda item: (item.updated_at or item.created_at, item.saved_service_id))

    def create_service_plan(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        service_doc_id: str,
        source_content_cid: str = "",
        source_page_cid: str = "",
        service_title: str = "",
        provider_name: str = "",
        goal: str = "",
        steps: Sequence[str] | None = None,
        documents_needed: Sequence[str] | None = None,
        questions_to_ask: Sequence[str] | None = None,
        appointment_at: str = "",
        reminder_at: str = "",
        travel_target: str = "",
        assigned_worker_recipient_id: str = "",
        status: str = "active",
        related_interaction_ids: Sequence[str] | None = None,
        private_notes_record_id: str = "",
    ) -> ServicePlanRecord:
        self._require_portal_actor(wallet_id, actor_did)
        if not str(service_doc_id or "").strip():
            raise ValueError("service_doc_id is required")
        now = _portal_now()
        record = ServicePlanRecord(
            plan_id=_portal_id("service-plan"),
            wallet_id=wallet_id,
            service_doc_id=str(service_doc_id),
            source_content_cid=str(source_content_cid or ""),
            source_page_cid=str(source_page_cid or ""),
            service_title=str(service_title or ""),
            provider_name=str(provider_name or ""),
            goal=str(goal or ""),
            steps=_unique_strings(steps),
            documents_needed=_unique_strings(documents_needed),
            questions_to_ask=_unique_strings(questions_to_ask),
            appointment_at=str(appointment_at or ""),
            reminder_at=str(reminder_at or ""),
            travel_target=str(travel_target or ""),
            assigned_worker_recipient_id=str(assigned_worker_recipient_id or ""),
            status=str(status or "active"),
            related_interaction_ids=_unique_strings(related_interaction_ids),
            private_notes_record_id=str(private_notes_record_id or ""),
            created_at=now,
            updated_at=now,
        )
        self.service_plans[record.plan_id] = record
        self._portal_audit(
            wallet_id,
            actor_did=actor_did,
            action="service_plan/create",
            resource=_portal_resource(wallet_id, "plans", record.plan_id),
            details={"service_doc_id": record.service_doc_id, "status": record.status},
        )
        self._persist_wallet_if_configured(wallet_id)
        return record

    def update_service_plan(
        self,
        wallet_id: str,
        plan_id: str,
        *,
        actor_did: str,
        source_content_cid: str | None = None,
        source_page_cid: str | None = None,
        service_title: str | None = None,
        provider_name: str | None = None,
        goal: str | None = None,
        steps: Sequence[str] | None = None,
        documents_needed: Sequence[str] | None = None,
        questions_to_ask: Sequence[str] | None = None,
        appointment_at: str | None = None,
        reminder_at: str | None = None,
        travel_target: str | None = None,
        assigned_worker_recipient_id: str | None = None,
        status: str | None = None,
        related_interaction_ids: Sequence[str] | None = None,
        private_notes_record_id: str | None = None,
    ) -> ServicePlanRecord:
        self._require_portal_actor(wallet_id, actor_did)
        record = self.service_plans.get(plan_id)
        if record is None or record.wallet_id != wallet_id:
            raise ValueError("service plan not found")
        if source_content_cid is not None:
            record.source_content_cid = str(source_content_cid or "")
        if source_page_cid is not None:
            record.source_page_cid = str(source_page_cid or "")
        if service_title is not None:
            record.service_title = str(service_title or "")
        if provider_name is not None:
            record.provider_name = str(provider_name or "")
        if goal is not None:
            record.goal = str(goal or "")
        if steps is not None:
            record.steps = _unique_strings(steps)
        if documents_needed is not None:
            record.documents_needed = _unique_strings(documents_needed)
        if questions_to_ask is not None:
            record.questions_to_ask = _unique_strings(questions_to_ask)
        if appointment_at is not None:
            record.appointment_at = str(appointment_at or "")
        if reminder_at is not None:
            record.reminder_at = str(reminder_at or "")
        if travel_target is not None:
            record.travel_target = str(travel_target or "")
        if assigned_worker_recipient_id is not None:
            record.assigned_worker_recipient_id = str(assigned_worker_recipient_id or "")
        if status is not None:
            record.status = str(status or "")
        if related_interaction_ids is not None:
            record.related_interaction_ids = _unique_strings(related_interaction_ids)
        if private_notes_record_id is not None:
            record.private_notes_record_id = str(private_notes_record_id or "")
        record.updated_at = _portal_now()
        self._portal_audit(
            wallet_id,
            actor_did=actor_did,
            action="service_plan/update",
            resource=_portal_resource(wallet_id, "plans", record.plan_id),
            details={"service_doc_id": record.service_doc_id, "status": record.status},
        )
        self._persist_wallet_if_configured(wallet_id)
        return record

    def list_service_plans(
        self,
        wallet_id: str,
        *,
        service_doc_id: str | None = None,
        status: str | None = None,
    ) -> List[ServicePlanRecord]:
        self.wallet_service._wallet(wallet_id)
        records = [record for record in self.service_plans.values() if record.wallet_id == wallet_id]
        if service_doc_id is not None:
            records = [record for record in records if record.service_doc_id == service_doc_id]
        if status is not None:
            records = [record for record in records if record.status == status]
        return sorted(records, key=lambda item: (item.updated_at or item.created_at, item.plan_id))

    def create_service_interaction(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        service_doc_id: str,
        source_content_cid: str = "",
        source_page_cid: str = "",
        provider_name: str = "",
        program_name: str = "",
        interaction_type: str,
        channel: str = "",
        counterparty_name: str = "",
        counterparty_contact: str = "",
        timestamp: str = "",
        status: str = "",
        outcome: str = "",
        notes_record_id: str = "",
        next_action: str = "",
        next_follow_up_at: str = "",
        source_action_url: str = "",
        related_grant_ids: Sequence[str] | None = None,
        related_record_ids: Sequence[str] | None = None,
        privacy_level: str = "private",
        metadata: Mapping[str, Any] | None = None,
    ) -> ServiceInteractionRecord:
        self._require_portal_actor(wallet_id, actor_did)
        if not str(service_doc_id or "").strip():
            raise ValueError("service_doc_id is required")
        if not str(interaction_type or "").strip():
            raise ValueError("interaction_type is required")
        now = _portal_now()
        record = ServiceInteractionRecord(
            interaction_id=_portal_id("interaction"),
            wallet_id=wallet_id,
            service_doc_id=str(service_doc_id),
            source_content_cid=str(source_content_cid or ""),
            source_page_cid=str(source_page_cid or ""),
            provider_name=str(provider_name or ""),
            program_name=str(program_name or ""),
            interaction_type=str(interaction_type),
            channel=str(channel or ""),
            actor_did=str(actor_did),
            counterparty_name=str(counterparty_name or ""),
            counterparty_contact=str(counterparty_contact or ""),
            timestamp=str(timestamp or now),
            status=str(status or ""),
            outcome=str(outcome or ""),
            notes_record_id=str(notes_record_id or ""),
            next_action=str(next_action or ""),
            next_follow_up_at=str(next_follow_up_at or ""),
            source_action_url=str(source_action_url or ""),
            related_grant_ids=_unique_strings(related_grant_ids),
            related_record_ids=_unique_strings(related_record_ids),
            privacy_level=str(privacy_level or "private"),
            created_at=now,
            updated_at=now,
            metadata=dict(metadata or {}),
        )
        self.service_interactions[record.interaction_id] = record
        self._portal_audit(
            wallet_id,
            actor_did=actor_did,
            action="interaction/create",
            resource=_portal_resource(wallet_id, "interactions", record.interaction_id),
            details={
                "service_doc_id": record.service_doc_id,
                "interaction_type": record.interaction_type,
                "channel": record.channel,
            },
        )
        self._persist_wallet_if_configured(wallet_id)
        return record

    def update_service_interaction(
        self,
        wallet_id: str,
        interaction_id: str,
        *,
        actor_did: str,
        source_content_cid: str | None = None,
        source_page_cid: str | None = None,
        provider_name: str | None = None,
        program_name: str | None = None,
        channel: str | None = None,
        counterparty_name: str | None = None,
        counterparty_contact: str | None = None,
        timestamp: str | None = None,
        status: str | None = None,
        outcome: str | None = None,
        notes_record_id: str | None = None,
        next_action: str | None = None,
        next_follow_up_at: str | None = None,
        source_action_url: str | None = None,
        related_grant_ids: Sequence[str] | None = None,
        related_record_ids: Sequence[str] | None = None,
        privacy_level: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> ServiceInteractionRecord:
        self._require_portal_actor(wallet_id, actor_did)
        record = self.service_interactions.get(interaction_id)
        if record is None or record.wallet_id != wallet_id:
            raise ValueError("service interaction not found")
        if source_content_cid is not None:
            record.source_content_cid = str(source_content_cid or "")
        if source_page_cid is not None:
            record.source_page_cid = str(source_page_cid or "")
        if provider_name is not None:
            record.provider_name = str(provider_name or "")
        if program_name is not None:
            record.program_name = str(program_name or "")
        if channel is not None:
            record.channel = str(channel or "")
        if counterparty_name is not None:
            record.counterparty_name = str(counterparty_name or "")
        if counterparty_contact is not None:
            record.counterparty_contact = str(counterparty_contact or "")
        if timestamp is not None:
            record.timestamp = str(timestamp or "")
        if status is not None:
            record.status = str(status or "")
        if outcome is not None:
            record.outcome = str(outcome or "")
        if notes_record_id is not None:
            record.notes_record_id = str(notes_record_id or "")
        if next_action is not None:
            record.next_action = str(next_action or "")
        if next_follow_up_at is not None:
            record.next_follow_up_at = str(next_follow_up_at or "")
        if source_action_url is not None:
            record.source_action_url = str(source_action_url or "")
        if related_grant_ids is not None:
            record.related_grant_ids = _unique_strings(related_grant_ids)
        if related_record_ids is not None:
            record.related_record_ids = _unique_strings(related_record_ids)
        if privacy_level is not None:
            record.privacy_level = str(privacy_level or "")
        if metadata is not None:
            record.metadata = {**record.metadata, **dict(metadata)}
        record.updated_at = _portal_now()
        self._portal_audit(
            wallet_id,
            actor_did=actor_did,
            action="interaction/update",
            resource=_portal_resource(wallet_id, "interactions", record.interaction_id),
            details={"service_doc_id": record.service_doc_id, "interaction_type": record.interaction_type},
        )
        self._persist_wallet_if_configured(wallet_id)
        return record

    def list_service_interactions(
        self,
        wallet_id: str,
        *,
        service_doc_id: str | None = None,
        interaction_type: str | None = None,
        status: str | None = None,
    ) -> List[ServiceInteractionRecord]:
        self.wallet_service._wallet(wallet_id)
        records = [record for record in self.service_interactions.values() if record.wallet_id == wallet_id]
        if service_doc_id is not None:
            records = [record for record in records if record.service_doc_id == service_doc_id]
        if interaction_type is not None:
            records = [record for record in records if record.interaction_type == interaction_type]
        if status is not None:
            records = [record for record in records if record.status == status]
        return sorted(records, key=lambda item: (item.timestamp or item.created_at, item.interaction_id))

    def create_record_analysis_grant(
        self,
        wallet_id: str,
        record_id: str,
        *,
        issuer_did: str,
        audience_did: str,
        issuer_secret: bytes | None = None,
        audience_secret: bytes | None = None,
        output_types: Sequence[str] = ("summary",),
        expires_at: str | None = None,
    ):
        grant = self.wallet_service.create_grant(
            wallet_id=wallet_id,
            issuer_did=issuer_did,
            audience_did=audience_did,
            resources=[resource_for_record(wallet_id, record_id)],
            abilities=["record/analyze"],
            caveats={"output_types": list(output_types), "purpose": "service_matching"},
            expires_at=expires_at,
            issuer_secret=issuer_secret,
            audience_secret=audience_secret,
        )
        self._persist_wallet_if_configured(wallet_id)
        return grant

    def create_record_grant(
        self,
        wallet_id: str,
        record_id: str,
        *,
        issuer_did: str,
        audience_did: str,
        abilities: Sequence[str],
        purpose: str = "service_matching",
        issuer_secret: bytes | None = None,
        audience_secret: bytes | None = None,
        approval_id: str | None = None,
        expires_at: str | None = None,
        max_delegation_depth: int | None = None,
        output_types: Sequence[str] | None = None,
        user_presence_required: bool = False,
        extra_caveats: Mapping[str, Any] | None = None,
    ):
        allowed_abilities = {"record/analyze", "record/decrypt", "record/share"}
        normalized_abilities = []
        for ability in abilities:
            if ability not in allowed_abilities:
                raise ValueError(f"record grants do not support ability: {ability}")
            if ability not in normalized_abilities:
                normalized_abilities.append(ability)
        if not normalized_abilities:
            raise ValueError("record grants require at least one ability")
        if normalized_abilities == ["record/share"]:
            raise ValueError("record/share must be paired with analyze or decrypt access")

        caveats: Dict[str, Any] = dict(extra_caveats or {})
        caveats["purpose"] = purpose or caveats.get("purpose") or "service_matching"
        if output_types is not None:
            caveats["output_types"] = list(output_types)
        elif "output_types" not in caveats and "allowed_output_types" not in caveats:
            default_output_types = []
            if "record/analyze" in normalized_abilities:
                default_output_types.append("summary")
            if "record/decrypt" in normalized_abilities:
                default_output_types.append("plaintext")
            if default_output_types:
                caveats["output_types"] = default_output_types
        if user_presence_required:
            caveats["user_presence_required"] = True
        if max_delegation_depth is not None:
            caveats["max_delegation_depth"] = max(0, int(max_delegation_depth))

        grant = self.wallet_service.create_grant(
            wallet_id=wallet_id,
            issuer_did=issuer_did,
            audience_did=audience_did,
            resources=[resource_for_record(wallet_id, record_id)],
            abilities=normalized_abilities,
            caveats=caveats,
            expires_at=expires_at,
            approval_id=approval_id,
            issuer_secret=issuer_secret,
            audience_secret=audience_secret,
        )
        self._persist_wallet_if_configured(wallet_id)
        return grant

    def analyze_record_for_delegate(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        grant_id: str,
        actor_secret: bytes | None = None,
        max_chars: int = 200,
    ):
        artifact = self.wallet_service.analyze_record_summary(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=grant_id,
            actor_secret=actor_secret,
            max_chars=max_chars,
        )
        self._persist_wallet_if_configured(wallet_id)
        return artifact

    def analyze_record_redacted(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        grant_id: str | None = None,
        actor_secret: bytes | None = None,
        max_chars: int = 500,
    ) -> Dict[str, Any]:
        result = self.wallet_service.analyze_document_with_redaction(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=grant_id,
            actor_secret=actor_secret,
            max_chars=max_chars,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def analyze_record_redacted_with_invocation(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        invocation,
        actor_secret: bytes | None = None,
        max_chars: int = 500,
    ) -> Dict[str, Any]:
        self.wallet_service.verify_invocation(
            wallet_id,
            invocation,
            actor_did=actor_did,
            resource=resource_for_record(wallet_id, record_id),
            ability="record/analyze",
            actor_secret=actor_secret,
        )
        result = self.wallet_service.analyze_document_with_redaction(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=invocation.grant_id,
            actor_secret=actor_secret,
            max_chars=max_chars,
            invocation_caveats=invocation.caveats,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def create_document_vector_profile(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        grant_id: str | None = None,
        actor_secret: bytes | None = None,
        chunk_size_words: int = 80,
    ) -> Dict[str, Any]:
        result = self.wallet_service.create_document_vector_profile(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=grant_id,
            actor_secret=actor_secret,
            chunk_size_words=chunk_size_words,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def create_document_vector_profile_with_invocation(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        invocation,
        actor_secret: bytes | None = None,
        chunk_size_words: int = 80,
    ) -> Dict[str, Any]:
        self.wallet_service.verify_invocation(
            wallet_id,
            invocation,
            actor_did=actor_did,
            resource=resource_for_record(wallet_id, record_id),
            ability="record/analyze",
            actor_secret=actor_secret,
        )
        result = self.wallet_service.create_document_vector_profile(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=invocation.grant_id,
            actor_secret=actor_secret,
            chunk_size_words=chunk_size_words,
            invocation_caveats=invocation.caveats,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def extract_record_text_redacted(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        grant_id: str | None = None,
        actor_secret: bytes | None = None,
        max_chars: int = 20_000,
        max_bytes: int = 200_000,
        use_ocr: bool = True,
    ) -> Dict[str, Any]:
        result = self.wallet_service.extract_document_text_with_redaction(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=grant_id,
            actor_secret=actor_secret,
            max_chars=max_chars,
            max_bytes=max_bytes,
            use_ocr=use_ocr,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def extract_record_text_redacted_with_invocation(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        invocation,
        actor_secret: bytes | None = None,
        max_chars: int = 20_000,
        max_bytes: int = 200_000,
        use_ocr: bool = True,
    ) -> Dict[str, Any]:
        self.wallet_service.verify_invocation(
            wallet_id,
            invocation,
            actor_did=actor_did,
            resource=resource_for_record(wallet_id, record_id),
            ability="record/analyze",
            actor_secret=actor_secret,
        )
        result = self.wallet_service.extract_document_text_with_redaction(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=invocation.grant_id,
            actor_secret=actor_secret,
            max_chars=max_chars,
            max_bytes=max_bytes,
            use_ocr=use_ocr,
            invocation_caveats=invocation.caveats,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def analyze_record_form_redacted(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        grant_id: str | None = None,
        actor_secret: bytes | None = None,
        max_fields: int = 100,
        use_ocr: bool = False,
    ) -> Dict[str, Any]:
        result = self.wallet_service.analyze_document_form_with_redaction(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=grant_id,
            actor_secret=actor_secret,
            max_fields=max_fields,
            use_ocr=use_ocr,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def analyze_record_form_redacted_with_invocation(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        invocation,
        actor_secret: bytes | None = None,
        max_fields: int = 100,
        use_ocr: bool = False,
    ) -> Dict[str, Any]:
        self.wallet_service.verify_invocation(
            wallet_id,
            invocation,
            actor_did=actor_did,
            resource=resource_for_record(wallet_id, record_id),
            ability="record/analyze",
            actor_secret=actor_secret,
        )
        result = self.wallet_service.analyze_document_form_with_redaction(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=invocation.grant_id,
            actor_secret=actor_secret,
            max_fields=max_fields,
            use_ocr=use_ocr,
            invocation_caveats=invocation.caveats,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def analyze_records_redacted(
        self,
        wallet_id: str,
        record_ids: Sequence[str],
        *,
        actor_did: str,
        grant_id: str | None = None,
        actor_secret: bytes | None = None,
    ) -> Dict[str, Any]:
        result = self.wallet_service.analyze_documents_with_redaction(
            wallet_id,
            list(record_ids),
            actor_did=actor_did,
            grant_id=grant_id,
            actor_secret=actor_secret,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def create_redacted_graphrag(
        self,
        wallet_id: str,
        record_ids: Sequence[str],
        *,
        actor_did: str,
        grant_id: str | None = None,
        actor_secret: bytes | None = None,
        max_chars_per_record: int = 20_000,
        max_bytes_per_record: int = 200_000,
        use_ocr: bool = True,
    ) -> Dict[str, Any]:
        result = self.wallet_service.create_redacted_graphrag(
            wallet_id,
            list(record_ids),
            actor_did=actor_did,
            grant_id=grant_id,
            actor_secret=actor_secret,
            max_chars_per_record=max_chars_per_record,
            max_bytes_per_record=max_bytes_per_record,
            use_ocr=use_ocr,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def create_redacted_graphrag_with_invocation(
        self,
        wallet_id: str,
        record_ids: Sequence[str],
        *,
        actor_did: str,
        invocation,
        actor_secret: bytes | None = None,
        max_chars_per_record: int = 20_000,
        max_bytes_per_record: int = 200_000,
        use_ocr: bool = True,
    ) -> Dict[str, Any]:
        ordered_record_ids = list(dict.fromkeys(record_ids))
        for record_id in ordered_record_ids:
            self.wallet_service.verify_invocation(
                wallet_id,
                invocation,
                actor_did=actor_did,
                resource=resource_for_record(wallet_id, record_id),
                ability="record/analyze",
                actor_secret=actor_secret,
            )
        result = self.wallet_service.create_redacted_graphrag(
            wallet_id,
            ordered_record_ids,
            actor_did=actor_did,
            grant_id=invocation.grant_id,
            actor_secret=actor_secret,
            max_chars_per_record=max_chars_per_record,
            max_bytes_per_record=max_bytes_per_record,
            use_ocr=use_ocr,
            invocation_caveats=invocation.caveats,
        )
        self._persist_wallet_if_configured(wallet_id)
        return result

    def issue_record_analysis_invocation(
        self,
        wallet_id: str,
        record_id: str,
        *,
        grant_id: str,
        actor_did: str,
        actor_secret: bytes | None = None,
        expires_at: str | None = None,
        purpose: str | None = None,
        output_types: Sequence[str] | None = None,
        user_present: bool = False,
    ):
        invocation = self.wallet_service.issue_invocation(
            wallet_id,
            grant_id=grant_id,
            actor_did=actor_did,
            resource=resource_for_record(wallet_id, record_id),
            ability="record/analyze",
            actor_secret=actor_secret,
            caveats=self._invocation_caveats(
                grant_id,
                fallback_purpose="service_matching",
                purpose=purpose,
                output_types=output_types,
                user_present=user_present,
            ),
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return invocation

    def issue_record_decrypt_invocation(
        self,
        wallet_id: str,
        record_id: str,
        *,
        grant_id: str,
        actor_did: str,
        actor_secret: bytes | None = None,
        expires_at: str | None = None,
        purpose: str | None = None,
        output_types: Sequence[str] | None = None,
        user_present: bool = False,
    ):
        invocation = self.wallet_service.issue_invocation(
            wallet_id,
            grant_id=grant_id,
            actor_did=actor_did,
            resource=resource_for_record(wallet_id, record_id),
            ability="record/decrypt",
            actor_secret=actor_secret,
            caveats=self._invocation_caveats(
                grant_id,
                fallback_purpose="document_view",
                purpose=purpose,
                output_types=output_types,
                user_present=user_present,
            ),
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return invocation

    def _invocation_caveats(
        self,
        grant_id: str,
        *,
        fallback_purpose: str,
        purpose: str | None = None,
        output_types: Sequence[str] | None = None,
        user_present: bool = False,
        extra: Mapping[str, Any] | None = None,
    ) -> Dict[str, Any]:
        grant = self.wallet_service.grants.get(grant_id)
        caveats: Dict[str, Any] = dict(extra or {})
        grant_purpose = grant.caveats.get("purpose") if grant is not None else None
        caveats["purpose"] = purpose or (str(grant_purpose) if grant_purpose else fallback_purpose)
        if output_types:
            caveats["output_types"] = list(output_types)
        if user_present:
            caveats["user_present"] = True
        return caveats

    def request_record_access(
        self,
        wallet_id: str,
        record_id: str,
        *,
        requester_did: str,
        ability: str = "record/analyze",
        audience_did: str | None = None,
        purpose: str = "service_matching",
        expires_at: str | None = None,
    ):
        if ability not in {"record/analyze", "record/decrypt"}:
            raise ValueError("record access ability must be record/analyze or record/decrypt")
        request = self.wallet_service.request_access(
            wallet_id,
            requester_did=requester_did,
            audience_did=audience_did,
            resources=[resource_for_record(wallet_id, record_id)],
            abilities=[ability],
            purpose=purpose,
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return request

    def request_record_analysis_access(
        self,
        wallet_id: str,
        record_id: str,
        *,
        requester_did: str,
        audience_did: str | None = None,
        purpose: str = "service_matching",
        expires_at: str | None = None,
    ):
        return self.request_record_access(
            wallet_id,
            record_id,
            requester_did=requester_did,
            ability="record/analyze",
            audience_did=audience_did,
            purpose=purpose,
            expires_at=expires_at,
        )

    def list_access_requests(
        self,
        wallet_id: str,
        *,
        status: str | None = "pending",
        requester_did: str | None = None,
        audience_did: str | None = None,
    ):
        return self.wallet_service.list_access_requests(
            wallet_id,
            status=status,
            requester_did=requester_did,
            audience_did=audience_did,
        )

    def access_request_review_items(
        self,
        wallet_id: str,
        *,
        status: str | None = "pending",
        requester_did: str | None = None,
        audience_did: str | None = None,
    ) -> List[Dict[str, Any]]:
        return self.wallet_service.access_request_review_items(
            wallet_id,
            status=status,
            requester_did=requester_did,
            audience_did=audience_did,
        )

    def approve_access_request(
        self,
        wallet_id: str,
        *,
        request_id: str,
        actor_did: str,
        issuer_secret: bytes | None = None,
        audience_secret: bytes | None = None,
        approval_id: str | None = None,
        issue_invocation: bool = False,
        invocation_expires_at: str | None = None,
    ):
        request = self.wallet_service.approve_access_request(
            wallet_id,
            request_id=request_id,
            actor_did=actor_did,
            issuer_secret=issuer_secret,
            audience_secret=audience_secret,
            approval_id=approval_id,
            issue_invocation=issue_invocation,
            invocation_expires_at=invocation_expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return request

    def request_threshold_approval(
        self,
        wallet_id: str,
        *,
        requested_by: str,
        operation: str,
        resources: Sequence[str],
        abilities: Sequence[str],
        expires_at: str | None = None,
    ):
        approval = self.wallet_service.request_approval(
            wallet_id,
            requested_by=requested_by,
            operation=operation,
            resources=list(resources),
            abilities=list(abilities),
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return approval

    def approve_threshold_approval(
        self,
        wallet_id: str,
        *,
        approval_id: str,
        approver_did: str,
    ):
        approval = self.wallet_service.approve_approval(
            wallet_id,
            approval_id=approval_id,
            approver_did=approver_did,
        )
        self._persist_wallet_if_configured(wallet_id)
        return approval

    def list_threshold_approvals(self, wallet_id: str, *, status: str | None = None):
        self.wallet_service._wallet(wallet_id)
        approvals = [
            approval
            for approval in self.wallet_service.approval_requests.values()
            if approval.wallet_id == wallet_id
        ]
        if status is not None:
            approvals = [approval for approval in approvals if approval.status == status]
        return sorted(approvals, key=lambda item: item.created_at)

    def reject_access_request(
        self,
        wallet_id: str,
        *,
        request_id: str,
        actor_did: str,
        reason: str | None = None,
    ):
        request = self.wallet_service.reject_access_request(
            wallet_id,
            request_id=request_id,
            actor_did=actor_did,
            reason=reason,
        )
        self._persist_wallet_if_configured(wallet_id)
        return request

    def revoke_access_request(
        self,
        wallet_id: str,
        *,
        request_id: str,
        actor_did: str,
        reason: str | None = None,
    ):
        request = self.wallet_service.revoke_access_request(
            wallet_id,
            request_id=request_id,
            actor_did=actor_did,
            reason=reason,
        )
        self._persist_wallet_if_configured(wallet_id)
        return request

    def revoke_grant(self, wallet_id: str, grant_id: str, *, actor_did: str):
        grant = self.wallet_service.revoke_grant(wallet_id, grant_id, actor_did=actor_did)
        self._persist_wallet_if_configured(wallet_id)
        return grant

    def emergency_revoke(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        actor_secret: bytes | None = None,
        approval_id: str | None = None,
        rotate_keys: bool = True,
        reason: str | None = None,
    ) -> Dict[str, Any]:
        report = self.wallet_service.emergency_revoke(
            wallet_id,
            actor_did=actor_did,
            actor_secret=actor_secret,
            approval_id=approval_id,
            rotate_keys=rotate_keys,
            reason=reason,
        )
        self._persist_wallet_if_configured(wallet_id)
        return report

    def delegate_grant(
        self,
        wallet_id: str,
        *,
        parent_grant_id: str,
        issuer_did: str,
        audience_did: str,
        resources: Sequence[str],
        abilities: Sequence[str],
        caveats: Dict[str, Any] | None = None,
        expires_at: str | None = None,
        issuer_secret: bytes | None = None,
        audience_secret: bytes | None = None,
    ):
        grant = self.wallet_service.create_grant(
            wallet_id=wallet_id,
            issuer_did=issuer_did,
            audience_did=audience_did,
            resources=list(resources),
            abilities=list(abilities),
            caveats=dict(caveats or {}),
            expires_at=expires_at,
            issuer_secret=issuer_secret,
            audience_secret=audience_secret,
            parent_grant_id=parent_grant_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return grant

    def list_grant_receipts(
        self,
        wallet_id: str,
        *,
        audience_did: str | None = None,
        status: str | None = None,
    ):
        return self.wallet_service.list_grant_receipts(
            wallet_id,
            audience_did=audience_did,
            status=status,
        )

    def create_export_grant(
        self,
        wallet_id: str,
        *,
        issuer_did: str,
        audience_did: str,
        record_ids: Sequence[str],
        issuer_secret: bytes | None = None,
        audience_secret: bytes | None = None,
        purpose: str = "user_export",
        expires_at: str | None = None,
        approval_id: str | None = None,
        output_types: Sequence[str] | None = None,
    ):
        grant = self.wallet_service.create_grant(
            wallet_id=wallet_id,
            issuer_did=issuer_did,
            audience_did=audience_did,
            resources=[resource_for_export(wallet_id)],
            abilities=["export/create"],
            caveats={
                "purpose": purpose,
                "record_ids": list(record_ids),
                "output_types": list(output_types) if output_types is not None else ["encrypted_export_bundle"],
            },
            issuer_secret=issuer_secret,
            audience_secret=audience_secret,
            expires_at=expires_at,
            approval_id=approval_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return grant

    def create_export_bundle(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        grant_id: str | None = None,
        record_ids: Sequence[str] | None = None,
        include_proofs: bool = True,
        include_derived_artifacts: bool = True,
    ):
        bundle = self.wallet_service.create_export_bundle(
            wallet_id,
            actor_did=actor_did,
            grant_id=grant_id,
            record_ids=list(record_ids) if record_ids is not None else None,
            include_proofs=include_proofs,
            include_derived_artifacts=include_derived_artifacts,
        )
        self._persist_wallet_if_configured(wallet_id)
        return bundle

    def issue_export_invocation(
        self,
        wallet_id: str,
        *,
        grant_id: str,
        actor_did: str,
        actor_secret: bytes | None = None,
        record_ids: Sequence[str] | None = None,
        expires_at: str | None = None,
        purpose: str | None = None,
        output_types: Sequence[str] | None = None,
        user_present: bool = False,
    ):
        caveats = self._invocation_caveats(
            grant_id,
            fallback_purpose="user_export",
            purpose=purpose,
            output_types=output_types,
            user_present=user_present,
        )
        if record_ids is not None:
            caveats["record_ids"] = list(record_ids)
        invocation = self.wallet_service.issue_invocation(
            wallet_id,
            grant_id=grant_id,
            actor_did=actor_did,
            resource=resource_for_export(wallet_id),
            ability="export/create",
            actor_secret=actor_secret,
            caveats=caveats,
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return invocation

    def create_export_bundle_with_invocation(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        invocation,
        actor_secret: bytes | None = None,
        record_ids: Sequence[str] | None = None,
        include_proofs: bool = True,
        include_derived_artifacts: bool = True,
    ):
        bundle = self.wallet_service.create_export_bundle_with_invocation(
            wallet_id,
            actor_did=actor_did,
            invocation=invocation,
            actor_secret=actor_secret,
            record_ids=list(record_ids) if record_ids is not None else None,
            include_proofs=include_proofs,
            include_derived_artifacts=include_derived_artifacts,
        )
        self._persist_wallet_if_configured(wallet_id)
        return bundle

    def verify_export_bundle(self, bundle: Dict[str, Any]) -> Dict[str, Any]:
        bundle_hash = self.wallet_service.export_bundle_hash(bundle)
        embedded_hash = bundle.get("bundle_hash")
        hash_valid = isinstance(embedded_hash, str) and embedded_hash == bundle_hash
        schema_valid = False
        schema_error = None
        if hash_valid:
            try:
                self.wallet_service.validate_export_bundle_schema(bundle)
                schema_valid = True
            except Exception as exc:
                schema_error = str(exc)
        return {
            "valid": hash_valid and schema_valid,
            "hash_valid": hash_valid,
            "schema_valid": schema_valid,
            "bundle_id": bundle.get("bundle_id"),
            "bundle_hash": embedded_hash,
            "computed_hash": bundle_hash,
            **({"schema_error": schema_error} if schema_error else {}),
        }

    def import_export_bundle(self, bundle: Dict[str, Any]) -> Dict[str, Any]:
        result = self.wallet_service.import_export_bundle(bundle)
        wallet_id = result.get("wallet_id")
        if isinstance(wallet_id, str) and wallet_id:
            self._persist_wallet_if_configured(wallet_id)
        return result

    def verify_export_bundle_storage(self, bundle: Dict[str, Any]) -> Dict[str, Any]:
        return self.wallet_service.verify_export_bundle_storage(bundle)

    def analyze_record_with_invocation(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        invocation,
        actor_secret: bytes | None = None,
        max_chars: int = 200,
    ):
        artifact = self.wallet_service.analyze_record_summary_with_invocation(
            wallet_id,
            record_id,
            actor_did=actor_did,
            invocation=invocation,
            actor_secret=actor_secret,
            max_chars=max_chars,
        )
        self._persist_wallet_if_configured(wallet_id)
        return artifact

    def decrypt_record_with_invocation(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        invocation,
        actor_secret: bytes | None = None,
    ) -> bytes:
        plaintext = self.wallet_service.decrypt_record_with_invocation(
            wallet_id,
            record_id,
            actor_did=actor_did,
            invocation=invocation,
            actor_secret=actor_secret,
        )
        self._persist_wallet_if_configured(wallet_id)
        return plaintext

    def decrypt_record_for_delegate(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        grant_id: str | None = None,
        actor_secret: bytes | None = None,
    ) -> bytes:
        plaintext = self.wallet_service.decrypt_record(
            wallet_id,
            record_id,
            actor_did=actor_did,
            grant_id=grant_id,
            actor_secret=actor_secret,
        )
        self._persist_wallet_if_configured(wallet_id)
        return plaintext

    def rotate_record_key(
        self,
        wallet_id: str,
        record_id: str,
        *,
        actor_did: str,
        actor_secret: bytes | None = None,
    ):
        version = self.wallet_service.rotate_record_key(
            wallet_id,
            record_id,
            actor_did=actor_did,
            actor_secret=actor_secret,
        )
        self._persist_wallet_if_configured(wallet_id)
        return version

    def verify_record_storage(self, wallet_id: str, record_id: str):
        return self.wallet_service.verify_record_storage(wallet_id, record_id)

    def verify_wallet_storage(self, wallet_id: str):
        return self.wallet_service.verify_wallet_storage(wallet_id)

    def repair_record_storage(self, wallet_id: str, record_id: str, *, actor_did: str):
        report = self.wallet_service.repair_record_storage(wallet_id, record_id, actor_did=actor_did)
        self._persist_wallet_if_configured(wallet_id)
        return report

    def repair_wallet_storage(self, wallet_id: str, *, actor_did: str):
        report = self.wallet_service.repair_wallet_storage(wallet_id, actor_did=actor_did)
        self._persist_wallet_if_configured(wallet_id)
        return report

    def audit_timeline(self, wallet_id: str) -> List[Dict[str, Any]]:
        return [
            {
                "created_at": event.created_at,
                "actor_did": event.actor_did,
                "action": event.action,
                "resource": event.resource,
                "decision": event.decision,
                "grant_id": event.grant_id,
            }
            for event in self.wallet_service.get_audit_log(wallet_id)
        ]

    def list_proof_receipts(self, wallet_id: str):
        self.wallet_service._wallet(wallet_id)
        return sorted(
            [
                proof
                for proof in self.wallet_service.proofs.values()
                if proof.wallet_id == wallet_id
            ],
            key=lambda item: item.created_at,
        )

    def get_world_id_config(self) -> Dict[str, Any]:
        """Return browser-safe World ID configuration."""

        return dict(self.world_id_config.public_dict())

    def get_world_id_status(self, wallet_id: str, *, actor_did: str | None = None) -> Dict[str, Any]:
        """Return sanitized World ID binding status for a wallet."""

        self.wallet_service._wallet(wallet_id)
        if actor_did is not None:
            self._require_portal_actor(wallet_id, actor_did)
        bindings = [
            binding.to_dict()
            for binding in sorted(
                self.wallet_service.list_world_id_bindings(wallet_id),
                key=lambda item: item.created_at,
            )
        ]
        active_bindings = [binding for binding in bindings if binding.get("status") == "active"]
        return {
            "enabled": self.world_id_config.enabled,
            "wallet": {
                "wallet_id": wallet_id,
                "binding_count": len(bindings),
                "active_binding_count": len(active_bindings),
                "bindings": bindings,
            },
        }

    def create_world_id_rp_signature(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        action: str | None = None,
        random_bytes: bytes | None = None,
        created_at: int | None = None,
    ) -> Dict[str, Any]:
        """Create a fresh relying-party signature for the World ID IDKit client."""

        self._require_portal_actor(wallet_id, actor_did)
        selected_action = str(action or self.world_id_config.default_action).strip()
        if selected_action not in self.world_id_config.allowed_actions:
            raise ValueError("World ID action is not allowed")
        signature = sign_world_id_request_from_config(
            self.world_id_config,
            action=selected_action,
            random_bytes=random_bytes,
            created_at=created_at,
        )
        protocol_payload = signature.to_rp_context(self.world_id_config.rp_id)
        return {
            **protocol_payload,
            "signature": signature.signature,
            "action": selected_action,
            "app_id": self.world_id_config.app_id,
            "environment": self.world_id_config.environment,
            "credential_policy": self.world_id_config.credential_policy,
        }

    def create_provider_staff_world_id_rp_signature(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        provider_id: str,
        provider_staff_id: str,
        random_bytes: bytes | None = None,
        created_at: int | None = None,
    ) -> Dict[str, Any]:
        """Create a World ID RP signature scoped to provider staff verification."""

        normalized_provider_id = str(provider_id or "").strip()
        normalized_staff_id = str(provider_staff_id or "").strip()
        if not normalized_provider_id:
            raise ValueError("provider organization policy is required before staff World ID verification")
        if not normalized_staff_id:
            raise ValueError("provider staff ID is required before staff World ID verification")
        payload = self.create_world_id_rp_signature(
            wallet_id,
            actor_did=actor_did,
            action=PROVIDER_STAFF_WORLD_ID_ACTION,
            random_bytes=random_bytes,
            created_at=created_at,
        )
        return {
            **payload,
            "action": PROVIDER_STAFF_WORLD_ID_ACTION,
            "provider_id": normalized_provider_id,
            "provider_staff_id": normalized_staff_id,
            "signal_context": "provider_staff_verification",
        }

    def register_world_id_verification(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        idkit_payload: Mapping[str, Any],
        request_json: WorldIdRequestJson | None = None,
    ) -> Dict[str, Any]:
        """Verify an IDKit result and bind the resulting proof-of-human to a wallet."""

        self._require_portal_actor(wallet_id, actor_did)
        normalized = normalize_world_id_idkit_response(idkit_payload)
        selected_action = normalized.action or self.world_id_config.default_action
        if selected_action not in self.world_id_config.allowed_actions:
            raise ValueError("World ID action is not allowed")
        verifier = request_json or self.world_id_request_json
        verification = verify_world_id_proof_from_config(
            self.world_id_config,
            idkit_payload,
            request_json=verifier,
        )
        if not verification.success:
            raise WorldIdVerificationError(verification.message or "World ID verification failed")
        raw_nullifier = verification.nullifier or (normalized.nullifiers[0] if normalized.nullifiers else "")
        if not raw_nullifier:
            raise WorldIdVerificationError("World ID verification did not return a nullifier")
        signal_hash_ref = ""
        if normalized.signal_hashes:
            signal_hash_ref = "worldid-signal-ref:v1:" + hashlib.sha256(
                json.dumps(sorted(normalized.signal_hashes), sort_keys=True).encode("utf-8")
            ).hexdigest()
        binding = self.wallet_service.add_world_id_binding(
            wallet_id,
            actor_did=actor_did,
            rp_id=self.world_id_config.rp_id,
            app_id=self.world_id_config.app_id,
            action=verification.action or selected_action,
            protocol_version=normalized.protocol_version,
            environment=verification.environment or normalized.environment or self.world_id_config.environment,
            raw_nullifier=raw_nullifier,
            credential_identifiers=list(normalized.credential_identifiers),
            issuer_schema_ids=[
                schema_id for schema_id in (response.issuer_schema_id for response in normalized.responses) if schema_id
            ],
            session_id=normalized.session_id or verification.session_id,
            signal_hash_ref=signal_hash_ref,
            verification_status="verified",
            verified_at=verification.created_at or _utc_now(),
            expires_at_min=min(normalized.expires_at_min_values) if normalized.expires_at_min_values else None,
            metadata={
                "credential_policy": self.world_id_config.credential_policy,
                "idkit": normalized.public_dict(),
                "verification": redact_world_id_payload(verification.public_dict()),
            },
        )
        proof = self.wallet_service.proofs.get(binding.proof_receipt_id or "")
        self._persist_wallet_if_configured(wallet_id)
        return {
            "binding": binding.to_dict(),
            "proof": proof.to_dict() if proof is not None else None,
            "verification": redact_world_id_payload(verification.public_dict()),
        }

    def revoke_world_id_binding(
        self,
        wallet_id: str,
        binding_id: str,
        *,
        actor_did: str,
        reason: str | None = None,
    ):
        """Mark a World ID wallet binding revoked and persist the wallet snapshot."""

        self._require_portal_actor(wallet_id, actor_did)
        binding = self.wallet_service.get_world_id_binding(binding_id)
        if binding.wallet_id != wallet_id:
            raise ValueError("World ID binding does not belong to this wallet")
        if binding.status != "revoked":
            binding.status = "revoked"
            binding.updated_at = _utc_now()
            binding.metadata = {**dict(binding.metadata), "revoked_reason": str(reason or "").strip()}
            append_audit_event(
                self.wallet_service.audit_events.setdefault(wallet_id, []),
                wallet_id=wallet_id,
                actor_did=actor_did,
                action="wallet/world_id_revoke",
                resource=f"wallet://{wallet_id}/world-id-bindings/{binding.binding_id}",
                decision="allow",
                details={"binding_id": binding.binding_id, "reason": str(reason or "").strip()},
            )
            self._persist_wallet_if_configured(wallet_id)
        return binding

    def match_services_for_wallet(
        self,
        wallet_id: str,
        location_record_id: str,
        *,
        actor_did: str,
        need_terms: Sequence[str],
        grant_id: str | None = None,
        limit: int = 10,
    ) -> List[ServiceMatch]:
        claim = self.wallet_service.create_coarse_location_claim(
            wallet_id,
            location_record_id,
            actor_did=actor_did,
            grant_id=grant_id,
        )
        matches = match_services(
            self.services,
            need_terms=need_terms,
            location_claim=claim.to_dict(),
            limit=limit,
        )
        self._persist_wallet_if_configured(wallet_id)
        return matches

    def create_coarse_location_grant(
        self,
        wallet_id: str,
        location_record_id: str,
        *,
        issuer_did: str,
        audience_did: str,
        issuer_secret: bytes | None = None,
        audience_secret: bytes | None = None,
        expires_at: str | None = None,
    ):
        grant = self.wallet_service.create_grant(
            wallet_id=wallet_id,
            issuer_did=issuer_did,
            audience_did=audience_did,
            resources=[resource_for_location(wallet_id, location_record_id)],
            abilities=["location/read_coarse"],
            caveats={"purpose": "service_matching", "precision": "coarse"},
            expires_at=expires_at,
            issuer_secret=issuer_secret,
            audience_secret=audience_secret,
        )
        self._persist_wallet_if_configured(wallet_id)
        return grant

    def create_location_region_proof_grant(
        self,
        wallet_id: str,
        location_record_id: str,
        *,
        issuer_did: str,
        audience_did: str,
        expires_at: str | None = None,
    ):
        grant = self.wallet_service.create_grant(
            wallet_id=wallet_id,
            issuer_did=issuer_did,
            audience_did=audience_did,
            resources=[resource_for_location(wallet_id, location_record_id)],
            abilities=["location/prove_region"],
            caveats={"purpose": "service_matching", "proof_type": "location_region"},
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return grant

    def create_location_region_proof(
        self,
        wallet_id: str,
        location_record_id: str,
        *,
        actor_did: str,
        region_id: str,
        grant_id: str | None = None,
    ):
        proof = self.wallet_service.create_location_region_proof(
            wallet_id,
            location_record_id,
            actor_did=actor_did,
            region_id=region_id,
            grant_id=grant_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return proof

    def create_location_distance_proof_grant(
        self,
        wallet_id: str,
        location_record_id: str,
        *,
        issuer_did: str,
        audience_did: str,
        target_id: str,
        max_distance_km: float,
        expires_at: str | None = None,
    ):
        grant = self.wallet_service.create_grant(
            wallet_id=wallet_id,
            issuer_did=issuer_did,
            audience_did=audience_did,
            resources=[resource_for_location(wallet_id, location_record_id)],
            abilities=["location/prove_distance"],
            caveats={
                "purpose": "service_matching",
                "proof_type": "location_distance",
                "target_id": target_id,
                "max_distance_km": float(max_distance_km),
            },
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return grant

    def create_location_distance_proof(
        self,
        wallet_id: str,
        location_record_id: str,
        *,
        actor_did: str,
        target_id: str,
        target_lat: float,
        target_lon: float,
        max_distance_km: float,
        grant_id: str | None = None,
    ):
        proof = self.wallet_service.create_location_distance_proof(
            wallet_id,
            location_record_id,
            actor_did=actor_did,
            target_id=target_id,
            target_lat=target_lat,
            target_lon=target_lon,
            max_distance_km=max_distance_km,
            grant_id=grant_id,
        )
        self._persist_wallet_if_configured(wallet_id)
        return proof

    def issue_coarse_location_invocation(
        self,
        wallet_id: str,
        location_record_id: str,
        *,
        grant_id: str,
        actor_did: str,
        actor_secret: bytes | None = None,
        expires_at: str | None = None,
        purpose: str | None = None,
        user_present: bool = False,
    ):
        invocation = self.wallet_service.issue_invocation(
            wallet_id,
            grant_id=grant_id,
            actor_did=actor_did,
            resource=resource_for_location(wallet_id, location_record_id),
            ability="location/read_coarse",
            actor_secret=actor_secret,
            caveats=self._invocation_caveats(
                grant_id,
                fallback_purpose="service_matching",
                purpose=purpose,
                user_present=user_present,
                extra={"precision": "coarse"},
            ),
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return invocation

    def match_services_for_wallet_with_invocation(
        self,
        wallet_id: str,
        location_record_id: str,
        *,
        actor_did: str,
        invocation,
        actor_secret: bytes | None = None,
        need_terms: Sequence[str],
        limit: int = 10,
    ) -> List[ServiceMatch]:
        claim = self.wallet_service.create_coarse_location_claim_with_invocation(
            wallet_id,
            location_record_id,
            actor_did=actor_did,
            invocation=invocation,
            actor_secret=actor_secret,
        )
        matches = match_services(
            self.services,
            need_terms=need_terms,
            location_claim=claim.to_dict(),
            limit=limit,
        )
        self._persist_wallet_if_configured(wallet_id)
        return matches

    def match_services_from_derived_facts(
        self,
        *,
        derived_facts: Dict[str, Any],
        limit: int = 10,
    ) -> List[ServiceMatch]:
        need_terms = derived_facts.get("need_terms") or derived_facts.get("needs") or []
        location_claim = derived_facts.get("location_claim")
        return match_services(
            self.services,
            need_terms=list(need_terms),
            location_claim=location_claim,
            limit=limit,
        )

    def create_analytics_consent(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        template_id: str,
        allowed_record_types: Sequence[str],
        allowed_derived_fields: Sequence[str],
        min_cohort_size: int = 10,
        epsilon_budget: float = 1.0,
        expires_at: str | None = None,
    ):
        consent = self.wallet_service.create_analytics_consent(
            wallet_id,
            actor_did=actor_did,
            template_id=template_id,
            allowed_record_types=list(allowed_record_types),
            allowed_derived_fields=list(allowed_derived_fields),
            aggregation_policy={
                "min_cohort_size": min_cohort_size,
                "epsilon_budget": epsilon_budget,
                "duplicate_policy": "reject_by_nullifier",
            },
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return consent

    def create_analytics_template(
        self,
        *,
        template_id: str,
        title: str,
        purpose: str,
        allowed_record_types: Sequence[str],
        allowed_derived_fields: Sequence[str],
        min_cohort_size: int,
        epsilon_budget: float,
        created_by: str,
        status: str = "approved",
        expires_at: str | None = None,
    ):
        template = self.wallet_service.create_analytics_template(
            template_id=template_id,
            title=title,
            purpose=purpose,
            allowed_record_types=list(allowed_record_types),
            allowed_derived_fields=list(allowed_derived_fields),
            aggregation_policy={
                "min_cohort_size": min_cohort_size,
                "epsilon_budget": epsilon_budget,
                "duplicate_policy": "reject_by_nullifier",
            },
            created_by=created_by,
            status=status,
            expires_at=expires_at,
        )
        self._persist_all_wallets_if_configured()
        return template

    def list_analytics_templates(self, *, include_inactive: bool = False):
        return self.wallet_service.list_analytics_templates(include_inactive=include_inactive)

    def list_analytics_consents(self, wallet_id: str, *, status: str = "all"):
        self.wallet_service._wallet(wallet_id)
        consents = [
            consent
            for consent in self.wallet_service.analytics_consents.values()
            if consent.wallet_id == wallet_id
        ]
        if status != "all":
            consents = [consent for consent in consents if consent.status == status]
        return sorted(consents, key=lambda item: item.created_at, reverse=True)

    def create_analytics_consent_from_template(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        template_id: str,
        expires_at: str | None = None,
    ):
        template = self.wallet_service.analytics_templates[template_id]
        consent = self.wallet_service.create_analytics_consent(
            wallet_id,
            actor_did=actor_did,
            template_id=template.template_id,
            allowed_record_types=list(template.allowed_record_types),
            allowed_derived_fields=list(template.allowed_derived_fields),
            expires_at=expires_at,
        )
        self._persist_wallet_if_configured(wallet_id)
        return consent

    def revoke_analytics_consent(self, wallet_id: str, consent_id: str, *, actor_did: str):
        consent = self.wallet_service.revoke_analytics_consent(
            wallet_id,
            consent_id,
            actor_did=actor_did,
        )
        self._persist_wallet_if_configured(wallet_id)
        return consent

    def contribute_analytics_facts(
        self,
        wallet_id: str,
        *,
        actor_did: str,
        consent_id: str,
        template_id: str,
        fields: Dict[str, Any],
    ):
        self._reject_precise_analytics_fields(fields)
        contribution = self.wallet_service.create_analytics_contribution(
            wallet_id,
            actor_did=actor_did,
            consent_id=consent_id,
            template_id=template_id,
            fields=dict(fields),
        )
        self._persist_wallet_if_configured(wallet_id)
        return contribution

    def run_private_aggregate_count(
        self,
        template_id: str,
        *,
        epsilon: float,
        min_cohort_size: int | None = None,
        budget_key: str | None = None,
        budget_limit: float | None = None,
        actor_did: str = "did:service:211-ai-analytics",
    ):
        result = self.wallet_service.run_aggregate_count(
            template_id,
            min_cohort_size=min_cohort_size,
            epsilon=epsilon,
            budget_key=budget_key,
            budget_limit=budget_limit,
            actor_did=actor_did,
        )
        self._persist_all_wallets_if_configured()
        return result

    def run_private_aggregate_count_by_fields(
        self,
        template_id: str,
        *,
        group_by: Sequence[str],
        epsilon: float | None = None,
        min_cohort_size: int | None = None,
        budget_key: str | None = None,
        budget_limit: float | None = None,
        actor_did: str = "did:service:211-ai-analytics",
    ):
        result = self.wallet_service.run_aggregate_count_by_fields(
            template_id,
            group_by=list(group_by),
            min_cohort_size=min_cohort_size,
            epsilon=epsilon,
            budget_key=budget_key,
            budget_limit=budget_limit,
            actor_did=actor_did,
        )
        self._persist_all_wallets_if_configured()
        return result

    def summarize_aggregate_result(self, result) -> Dict[str, Any]:
        return {
            "result_id": result.result_id,
            "template_id": result.template_id,
            "metric": result.metric,
            "released": result.released,
            "suppressed": result.suppressed,
            "count": result.count if result.exact_count_released else None,
            "noisy_count": result.noisy_count if result.released else None,
            "min_cohort_size": result.min_cohort_size,
            "epsilon": result.epsilon,
            "privacy_budget_key": result.privacy_budget_key,
            "privacy_budget_spent": result.privacy_budget_spent,
            "privacy_notes": list(result.privacy_notes),
            "group_by": list(result.group_by),
            "cohorts": [dict(cohort) for cohort in result.cohorts],
            "suppressed_cohort_count": result.suppressed_cohort_count,
        }

    def _reject_precise_analytics_fields(self, fields: Dict[str, Any]) -> None:
        for key, value in fields.items():
            normalized_key = key.lower()
            if normalized_key in {"lat", "lon", "latitude", "longitude"}:
                raise ValueError("analytics contributions require derived or coarse fields, not precise coordinates")
            if normalized_key.startswith("precise_"):
                raise ValueError("analytics contributions require derived or coarse fields, not precise fields")
            if isinstance(value, dict):
                match_services([], need_terms=[], location_claim=value)
