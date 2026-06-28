"""FastAPI surface for 211-AI wallet workflows."""

from __future__ import annotations

import base64
import os
from typing import Any, Dict, List, Sequence

from .app_service import WalletInterfaceService

try:  # pragma: no cover - exercised when optional dependency is installed.
    from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel, Field
except ImportError:  # pragma: no cover
    FastAPI = None  # type: ignore[assignment]
    CORSMiddleware = None  # type: ignore[assignment]
    File = None  # type: ignore[assignment]
    Form = None  # type: ignore[assignment]
    Header = None  # type: ignore[assignment]
    HTTPException = None  # type: ignore[assignment]
    UploadFile = object  # type: ignore[assignment,misc]
    BaseModel = object  # type: ignore[assignment,misc]

    def Field(default: Any = None, **_: Any) -> Any:  # type: ignore[no-redef]
        return default

from ._vendor import ensure_ipfs_datasets_py_path

ensure_ipfs_datasets_py_path()

from ipfs_datasets_py.wallet.ucan import invocation_from_token, invocation_to_token  # noqa: E402


def _cors_origins_from_env() -> list[str]:
    origins = [
        origin.strip()
        for origin in os.environ.get("WALLET_API_CORS_ORIGINS", "").split(",")
        if origin.strip()
    ]
    return origins


def _cors_origin_regex_from_env() -> str | None:
    value = str(os.environ.get("WALLET_API_CORS_ORIGIN_REGEX", "")).strip()
    return value or None


class CreateWalletRequest(BaseModel):
    owner_did: str
    controller_dids: List[str] = Field(default_factory=list)
    approval_threshold: int | None = None


class WalletControllerRequest(BaseModel):
    actor_did: str
    controller_did: str
    controller_key_hex: str | None = None
    approval_id: str | None = None


class WalletDeviceRequest(BaseModel):
    actor_did: str
    device_did: str
    device_key_hex: str | None = None
    approval_id: str | None = None


class WalletRecoveryPolicyRequest(BaseModel):
    actor_did: str
    contact_dids: List[str] = Field(default_factory=list)
    threshold: int = 1
    approval_id: str | None = None


class WalletControllerRecoveryRequest(BaseModel):
    actor_did: str
    controller_did: str
    controller_key_hex: str | None = None
    approval_id: str | None = None


class AddLocationRequest(BaseModel):
    actor_did: str
    lat: float
    lon: float


class CoarseLocationGrantRequest(BaseModel):
    issuer_did: str
    audience_did: str
    issuer_key_hex: str | None = None
    audience_key_hex: str | None = None
    expires_at: str | None = None


class CoarseLocationInvocationRequest(BaseModel):
    grant_id: str
    actor_did: str
    actor_key_hex: str | None = None
    expires_at: str | None = None
    purpose: str | None = None
    user_present: bool = False


class LocationRegionProofGrantRequest(BaseModel):
    issuer_did: str
    audience_did: str
    expires_at: str | None = None


class LocationRegionProofRequest(BaseModel):
    actor_did: str
    region_id: str
    grant_id: str | None = None


class LocationDistanceProofGrantRequest(BaseModel):
    issuer_did: str
    audience_did: str
    target_id: str
    max_distance_km: float
    expires_at: str | None = None


class LocationDistanceProofRequest(BaseModel):
    actor_did: str
    target_id: str
    target_lat: float
    target_lon: float
    max_distance_km: float
    grant_id: str | None = None


class AddTextDocumentRequest(BaseModel):
    actor_did: str
    text: str
    filename: str = "document.txt"
    title: str | None = None
    key_hex: str | None = None


class AnalysisGrantRequest(BaseModel):
    issuer_did: str
    audience_did: str
    issuer_key_hex: str | None = None
    audience_key_hex: str | None = None
    expires_at: str | None = None


class RecordGrantRequest(BaseModel):
    issuer_did: str
    audience_did: str
    abilities: List[str] = Field(default_factory=lambda: ["record/analyze"])
    purpose: str = "service_matching"
    output_types: List[str] = Field(default_factory=list)
    user_presence_required: bool = False
    caveats: Dict[str, Any] = Field(default_factory=dict)
    issuer_key_hex: str | None = None
    audience_key_hex: str | None = None
    approval_id: str | None = None
    expires_at: str | None = None
    max_delegation_depth: int | None = None


class AnalysisInvocationRequest(BaseModel):
    grant_id: str
    actor_did: str
    actor_key_hex: str | None = None
    expires_at: str | None = None
    purpose: str | None = None
    output_types: List[str] = Field(default_factory=list)
    user_present: bool = False


class AccessRequestCreateRequest(BaseModel):
    record_id: str
    requester_did: str
    ability: str = "record/analyze"
    audience_did: str | None = None
    purpose: str = "service_matching"
    expires_at: str | None = None


class AccessRequestDecisionRequest(BaseModel):
    actor_did: str
    issuer_key_hex: str | None = None
    audience_key_hex: str | None = None
    approval_id: str | None = None
    issue_invocation: bool = False
    invocation_expires_at: str | None = None
    reason: str | None = None


class ThresholdApprovalCreateRequest(BaseModel):
    requested_by: str
    operation: str = "grant/create"
    resources: List[str] = Field(default_factory=list)
    abilities: List[str] = Field(default_factory=list)
    expires_at: str | None = None


class ThresholdApprovalDecisionRequest(BaseModel):
    approver_did: str


class RevokeGrantRequest(BaseModel):
    actor_did: str


class EmergencyRevokeRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    approval_id: str | None = None
    rotate_keys: bool = True
    reason: str | None = None


class DelegateGrantRequest(BaseModel):
    issuer_did: str
    audience_did: str
    resources: List[str] = Field(default_factory=list)
    abilities: List[str] = Field(default_factory=list)
    caveats: Dict[str, Any] = Field(default_factory=dict)
    expires_at: str | None = None
    issuer_key_hex: str | None = None
    audience_key_hex: str | None = None


class ExportGrantRequest(BaseModel):
    issuer_did: str
    audience_did: str
    record_ids: List[str] = Field(default_factory=list)
    issuer_key_hex: str | None = None
    audience_key_hex: str | None = None
    purpose: str = "user_export"
    expires_at: str | None = None
    approval_id: str | None = None
    output_types: List[str] = Field(default_factory=list)


class ExportBundleRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    grant_id: str | None = None
    invocation_token: str | None = None
    record_ids: List[str] = Field(default_factory=list)
    include_proofs: bool = True
    include_derived_artifacts: bool = True


class ExportBundleVerifyRequest(BaseModel):
    bundle: Dict[str, Any]


class ExportBundleImportRequest(BaseModel):
    bundle: Dict[str, Any]


class ExportBundleStorageRequest(BaseModel):
    bundle: Dict[str, Any]


class ExportInvocationRequest(BaseModel):
    grant_id: str
    actor_did: str
    actor_key_hex: str | None = None
    record_ids: List[str] = Field(default_factory=list)
    expires_at: str | None = None
    purpose: str | None = None
    output_types: List[str] = Field(default_factory=list)
    user_present: bool = False


class AnalyzeRecordRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    grant_id: str | None = None
    invocation_token: str | None = None
    max_chars: int = 200


class SavedServiceRequest(BaseModel):
    actor_did: str
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
    private_notes_record_id: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)


class SavedServiceUpdateRequest(BaseModel):
    actor_did: str
    source_content_cid: str | None = None
    source_page_cid: str | None = None
    title: str | None = None
    provider_name: str | None = None
    program_name: str | None = None
    source_url: str | None = None
    label: str | None = None
    reason: str | None = None
    priority: str | None = None
    status: str | None = None
    private_notes_record_id: str | None = None
    metadata: Dict[str, Any] | None = None


class ServicePlanRequest(BaseModel):
    actor_did: str
    service_doc_id: str
    source_content_cid: str = ""
    source_page_cid: str = ""
    service_title: str = ""
    provider_name: str = ""
    goal: str = ""
    steps: List[str] = Field(default_factory=list)
    documents_needed: List[str] = Field(default_factory=list)
    questions_to_ask: List[str] = Field(default_factory=list)
    appointment_at: str = ""
    reminder_at: str = ""
    travel_target: str = ""
    assigned_worker_recipient_id: str = ""
    status: str = "active"
    related_interaction_ids: List[str] = Field(default_factory=list)
    private_notes_record_id: str = ""


class ServicePlanUpdateRequest(BaseModel):
    actor_did: str
    source_content_cid: str | None = None
    source_page_cid: str | None = None
    service_title: str | None = None
    provider_name: str | None = None
    goal: str | None = None
    steps: List[str] | None = None
    documents_needed: List[str] | None = None
    questions_to_ask: List[str] | None = None
    appointment_at: str | None = None
    reminder_at: str | None = None
    travel_target: str | None = None
    assigned_worker_recipient_id: str | None = None
    status: str | None = None
    related_interaction_ids: List[str] | None = None
    private_notes_record_id: str | None = None


class ServiceInteractionRequest(BaseModel):
    actor_did: str
    service_doc_id: str
    source_content_cid: str = ""
    source_page_cid: str = ""
    provider_name: str = ""
    program_name: str = ""
    interaction_type: str
    channel: str = ""
    counterparty_name: str = ""
    counterparty_contact: str = ""
    timestamp: str = ""
    status: str = ""
    outcome: str = ""
    notes_record_id: str = ""
    next_action: str = ""
    next_follow_up_at: str = ""
    source_action_url: str = ""
    related_grant_ids: List[str] = Field(default_factory=list)
    related_record_ids: List[str] = Field(default_factory=list)
    privacy_level: str = "private"
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ServiceInteractionUpdateRequest(BaseModel):
    actor_did: str
    source_content_cid: str | None = None
    source_page_cid: str | None = None
    provider_name: str | None = None
    program_name: str | None = None
    channel: str | None = None
    counterparty_name: str | None = None
    counterparty_contact: str | None = None
    timestamp: str | None = None
    status: str | None = None
    outcome: str | None = None
    notes_record_id: str | None = None
    next_action: str | None = None
    next_follow_up_at: str | None = None
    source_action_url: str | None = None
    related_grant_ids: List[str] | None = None
    related_record_ids: List[str] | None = None
    privacy_level: str | None = None
    metadata: Dict[str, Any] | None = None


class RedactedAnalyzeRecordRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    grant_id: str | None = None
    invocation_token: str | None = None
    max_chars: int = 500


class VectorProfileRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    grant_id: str | None = None
    invocation_token: str | None = None
    chunk_size_words: int = 80


class RedactedTextExtractionRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    grant_id: str | None = None
    invocation_token: str | None = None
    max_chars: int = 20_000
    max_bytes: int = 200_000
    use_ocr: bool = True


class RedactedFormAnalysisRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    grant_id: str | None = None
    invocation_token: str | None = None
    max_fields: int = 100
    use_ocr: bool = False


class RedactedAnalyzeRecordsRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    grant_id: str | None = None
    record_ids: List[str] = Field(default_factory=list)


class RedactedGraphRAGRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    grant_id: str | None = None
    invocation_token: str | None = None
    record_ids: List[str] = Field(default_factory=list)
    max_chars_per_record: int = 20_000
    max_bytes_per_record: int = 200_000
    use_ocr: bool = True


class DecryptRecordRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    grant_id: str | None = None
    invocation_token: str | None = None


class RotateRecordKeyRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None


class RepairStorageRequest(BaseModel):
    actor_did: str


class WalletServiceMatchRequest(BaseModel):
    location_record_id: str
    actor_did: str
    need_terms: Sequence[str] = Field(default_factory=list)
    grant_id: str | None = None
    invocation_token: str | None = None
    actor_key_hex: str | None = None
    limit: int = 10


class AnalyticsTemplateRequest(BaseModel):
    template_id: str
    title: str
    purpose: str
    allowed_record_types: List[str] = Field(default_factory=list)
    allowed_derived_fields: List[str] = Field(default_factory=list)
    min_cohort_size: int = 10
    epsilon_budget: float = 1.0
    created_by: str
    status: str = "approved"
    expires_at: str | None = None


class AnalyticsConsentFromTemplateRequest(BaseModel):
    actor_did: str
    template_id: str
    expires_at: str | None = None


class AnalyticsConsentRevokeRequest(BaseModel):
    actor_did: str


class AnalyticsContributionRequest(BaseModel):
    actor_did: str
    consent_id: str
    template_id: str
    fields: Dict[str, Any]


class PrivateAggregateCountRequest(BaseModel):
    epsilon: float
    min_cohort_size: int | None = None
    budget_key: str | None = None
    budget_limit: float | None = None
    actor_did: str = "did:service:211-ai-api"


class PrivateAggregateCohortCountRequest(BaseModel):
    group_by: List[str] = Field(default_factory=list)
    epsilon: float | None = None
    min_cohort_size: int | None = None
    budget_key: str | None = None
    budget_limit: float | None = None
    actor_did: str = "did:service:211-ai-api"


class DerivedServiceMatchRequest(BaseModel):
    need_terms: Sequence[str] = Field(default_factory=list)
    location_claim: Dict[str, Any] | None = None
    limit: int = 10


def _ops_health_shared_secret() -> str:
    return str(os.getenv("WALLET_OPS_HEALTH_SHARED_SECRET") or "").strip()


def _extract_bearer_token(authorization: str | None) -> str:
    raw = str(authorization or "").strip()
    if not raw:
        return ""
    scheme, _, token = raw.partition(" ")
    if scheme.lower() != "bearer":
        return ""
    return token.strip()


def create_app(*, service: WalletInterfaceService | None = None):
    """Create the wallet API app.

    The API stays deliberately thin: all authorization, crypto, proofs,
    analytics privacy, and audit behavior remains in `ipfs_datasets_py.wallet`.
    """

    if FastAPI is None:  # pragma: no cover
        raise RuntimeError("FastAPI is required to create the wallet interface API")

    app_service = service or WalletInterfaceService()
    app = FastAPI(title="211-AI Wallet Interface", version="0.1.0")
    cors_origins = _cors_origins_from_env()
    cors_origin_regex = _cors_origin_regex_from_env()
    if cors_origins or cors_origin_regex:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_origin_regex=cors_origin_regex,
            allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
            allow_headers=["authorization", "content-type", "x-wallet-ops-shared-secret"],
        )

    @app.get("/health")
    def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.get("/ops/health")
    def ops_health(
        verify_storage: bool = False,
        authorization: str | None = Header(default=None),
        x_wallet_ops_shared_secret: str | None = Header(default=None),
    ) -> Dict[str, Any]:
        expected_secret = _ops_health_shared_secret()
        if expected_secret:
            supplied_secret = _extract_bearer_token(authorization) or str(x_wallet_ops_shared_secret or "").strip()
            if supplied_secret != expected_secret:
                raise HTTPException(status_code=401, detail="ops health authorization required")
        try:
            return app_service.ops_health(verify_storage=verify_storage)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.get("/wallets/snapshots")
    def list_wallet_snapshots() -> Dict[str, Any]:
        return {"wallet_ids": app_service.list_wallet_snapshots()}

    @app.post("/wallets/snapshots/save-all")
    def save_all_wallet_snapshots() -> Dict[str, Any]:
        try:
            paths = app_service.save_all_wallet_snapshots()
            return {"paths": [str(path) for path in paths], "count": len(paths)}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/snapshots/load-all")
    def load_all_wallet_snapshots() -> Dict[str, Any]:
        try:
            wallet_ids = app_service.load_all_wallet_snapshots()
            return {"wallet_ids": wallet_ids, "count": len(wallet_ids)}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets")
    def create_wallet(request: CreateWalletRequest) -> Dict[str, Any]:
        wallet = app_service.create_wallet(
            request.owner_did,
            controller_dids=request.controller_dids or None,
            approval_threshold=request.approval_threshold,
        )
        return wallet.to_dict()

    @app.get("/wallets/{wallet_id}")
    def get_wallet(wallet_id: str) -> Dict[str, Any]:
        try:
            return app_service.get_wallet(wallet_id).to_dict()
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/controllers")
    def add_wallet_controller(wallet_id: str, request: WalletControllerRequest) -> Dict[str, Any]:
        try:
            wallet = app_service.add_controller(
                wallet_id,
                actor_did=request.actor_did,
                controller_did=request.controller_did,
                controller_secret=_key_from_optional_hex(request.controller_key_hex),
                approval_id=request.approval_id,
            )
            return wallet.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/controllers/remove")
    def remove_wallet_controller(wallet_id: str, request: WalletControllerRequest) -> Dict[str, Any]:
        try:
            wallet = app_service.remove_controller(
                wallet_id,
                actor_did=request.actor_did,
                controller_did=request.controller_did,
                approval_id=request.approval_id,
            )
            return wallet.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/devices")
    def add_wallet_device(wallet_id: str, request: WalletDeviceRequest) -> Dict[str, Any]:
        try:
            wallet = app_service.add_device(
                wallet_id,
                actor_did=request.actor_did,
                device_did=request.device_did,
                device_secret=_key_from_optional_hex(request.device_key_hex),
                approval_id=request.approval_id,
            )
            return wallet.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/devices/revoke")
    def revoke_wallet_device(wallet_id: str, request: WalletDeviceRequest) -> Dict[str, Any]:
        try:
            wallet = app_service.revoke_device(
                wallet_id,
                actor_did=request.actor_did,
                device_did=request.device_did,
                approval_id=request.approval_id,
            )
            return wallet.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/recovery-policy")
    def set_wallet_recovery_policy(wallet_id: str, request: WalletRecoveryPolicyRequest) -> Dict[str, Any]:
        try:
            wallet = app_service.set_recovery_policy(
                wallet_id,
                actor_did=request.actor_did,
                contact_dids=request.contact_dids,
                threshold=request.threshold,
                approval_id=request.approval_id,
            )
            return wallet.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/controllers/recover")
    def recover_wallet_controller(wallet_id: str, request: WalletControllerRecoveryRequest) -> Dict[str, Any]:
        try:
            wallet = app_service.recover_controller(
                wallet_id,
                actor_did=request.actor_did,
                controller_did=request.controller_did,
                controller_secret=_key_from_optional_hex(request.controller_key_hex),
                approval_id=request.approval_id,
            )
            return wallet.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/snapshot")
    def save_wallet_snapshot(wallet_id: str) -> Dict[str, Any]:
        try:
            path = app_service.save_wallet_snapshot(wallet_id)
            return {"wallet_id": wallet_id, "path": str(path)}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/snapshot")
    def verify_wallet_snapshot(wallet_id: str) -> Dict[str, Any]:
        try:
            return app_service.verify_wallet_snapshot(wallet_id)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/snapshot/load")
    def load_wallet_snapshot(wallet_id: str) -> Dict[str, Any]:
        try:
            app_service.load_wallet_snapshot(wallet_id)
            return {"wallet_id": wallet_id, "loaded": True}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/locations")
    def add_location(wallet_id: str, request: AddLocationRequest) -> Dict[str, Any]:
        try:
            record = app_service.add_location(
                wallet_id,
                actor_did=request.actor_did,
                lat=request.lat,
                lon=request.lon,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/locations/{location_record_id}/coarse-grants")
    def create_coarse_location_grant(
        wallet_id: str,
        location_record_id: str,
        request: CoarseLocationGrantRequest,
    ) -> Dict[str, Any]:
        try:
            grant = app_service.create_coarse_location_grant(
                wallet_id,
                location_record_id,
                issuer_did=request.issuer_did,
                audience_did=request.audience_did,
                issuer_secret=_key_from_optional_hex(request.issuer_key_hex),
                audience_secret=_key_from_optional_hex(request.audience_key_hex),
                expires_at=request.expires_at,
            )
            return grant.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/locations/{location_record_id}/coarse-invocations")
    def issue_coarse_location_invocation(
        wallet_id: str,
        location_record_id: str,
        request: CoarseLocationInvocationRequest,
    ) -> Dict[str, Any]:
        try:
            invocation = app_service.issue_coarse_location_invocation(
                wallet_id,
                location_record_id,
                grant_id=request.grant_id,
                actor_did=request.actor_did,
                actor_secret=_key_from_optional_hex(request.actor_key_hex),
                expires_at=request.expires_at,
                purpose=request.purpose,
                user_present=request.user_present,
            )
            return {"invocation": invocation.to_dict(), "token": invocation_to_token(invocation)}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/locations/{location_record_id}/region-proof-grants")
    def create_location_region_proof_grant(
        wallet_id: str,
        location_record_id: str,
        request: LocationRegionProofGrantRequest,
    ) -> Dict[str, Any]:
        try:
            grant = app_service.create_location_region_proof_grant(
                wallet_id,
                location_record_id,
                issuer_did=request.issuer_did,
                audience_did=request.audience_did,
                expires_at=request.expires_at,
            )
            return grant.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/locations/{location_record_id}/region-proofs")
    def create_location_region_proof(
        wallet_id: str,
        location_record_id: str,
        request: LocationRegionProofRequest,
    ) -> Dict[str, Any]:
        try:
            proof = app_service.create_location_region_proof(
                wallet_id,
                location_record_id,
                actor_did=request.actor_did,
                region_id=request.region_id,
                grant_id=request.grant_id,
            )
            return proof.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/locations/{location_record_id}/distance-proof-grants")
    def create_location_distance_proof_grant(
        wallet_id: str,
        location_record_id: str,
        request: LocationDistanceProofGrantRequest,
    ) -> Dict[str, Any]:
        try:
            grant = app_service.create_location_distance_proof_grant(
                wallet_id,
                location_record_id,
                issuer_did=request.issuer_did,
                audience_did=request.audience_did,
                target_id=request.target_id,
                max_distance_km=request.max_distance_km,
                expires_at=request.expires_at,
            )
            return grant.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/locations/{location_record_id}/distance-proofs")
    def create_location_distance_proof(
        wallet_id: str,
        location_record_id: str,
        request: LocationDistanceProofRequest,
    ) -> Dict[str, Any]:
        try:
            proof = app_service.create_location_distance_proof(
                wallet_id,
                location_record_id,
                actor_did=request.actor_did,
                target_id=request.target_id,
                target_lat=request.target_lat,
                target_lon=request.target_lon,
                max_distance_km=request.max_distance_km,
                grant_id=request.grant_id,
            )
            return proof.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/documents/text")
    def add_text_document(wallet_id: str, request: AddTextDocumentRequest) -> Dict[str, Any]:
        try:
            metadata = {"title": request.title} if request.title else {}
            record = app_service.add_text_document(
                wallet_id,
                actor_did=request.actor_did,
                actor_secret=_key_from_optional_hex(request.key_hex),
                text=request.text,
                filename=request.filename,
                metadata=metadata,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/documents")
    async def add_binary_document(
        wallet_id: str,
        actor_did: str = Form(...),
        key_hex: str | None = Form(default=None),
        title: str | None = Form(default=None),
        file: UploadFile = File(...),
    ) -> Dict[str, Any]:
        try:
            metadata = {"title": title} if title else {}
            data = await file.read()
            record = app_service.add_binary_document(
                wallet_id,
                actor_did=actor_did,
                actor_secret=_key_from_optional_hex(key_hex),
                data=data,
                filename=file.filename or "document.bin",
                content_type=file.content_type,
                metadata=metadata,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/records")
    def list_records(wallet_id: str, data_type: str | None = None) -> Dict[str, Any]:
        try:
            records = app_service.list_records(wallet_id, data_type=data_type)
            return {"records": [record.to_dict() for record in records]}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/portal/saved-services")
    def list_saved_services(wallet_id: str, status: str | None = None) -> Dict[str, Any]:
        try:
            return {
                "saved_services": [
                    record.to_dict() for record in app_service.list_saved_services(wallet_id, status=status)
                ]
            }
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/portal/saved-services")
    def save_service(wallet_id: str, request: SavedServiceRequest) -> Dict[str, Any]:
        try:
            record = app_service.save_service_for_wallet(
                wallet_id,
                actor_did=request.actor_did,
                service_doc_id=request.service_doc_id,
                source_content_cid=request.source_content_cid,
                source_page_cid=request.source_page_cid,
                title=request.title,
                provider_name=request.provider_name,
                program_name=request.program_name,
                source_url=request.source_url,
                label=request.label,
                reason=request.reason,
                priority=request.priority,
                status=request.status,
                private_notes_record_id=request.private_notes_record_id,
                metadata=request.metadata,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.patch("/wallets/{wallet_id}/portal/saved-services/{saved_service_id}")
    def update_saved_service(wallet_id: str, saved_service_id: str, request: SavedServiceUpdateRequest) -> Dict[str, Any]:
        try:
            record = app_service.update_saved_service(
                wallet_id,
                saved_service_id,
                actor_did=request.actor_did,
                source_content_cid=request.source_content_cid,
                source_page_cid=request.source_page_cid,
                title=request.title,
                provider_name=request.provider_name,
                program_name=request.program_name,
                source_url=request.source_url,
                label=request.label,
                reason=request.reason,
                priority=request.priority,
                status=request.status,
                private_notes_record_id=request.private_notes_record_id,
                metadata=request.metadata,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/portal/plans")
    def list_service_plans(
        wallet_id: str,
        service_doc_id: str | None = None,
        status: str | None = None,
    ) -> Dict[str, Any]:
        try:
            return {
                "plans": [
                    record.to_dict()
                    for record in app_service.list_service_plans(
                        wallet_id,
                        service_doc_id=service_doc_id,
                        status=status,
                    )
                ]
            }
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/portal/plans")
    def create_service_plan(wallet_id: str, request: ServicePlanRequest) -> Dict[str, Any]:
        try:
            record = app_service.create_service_plan(
                wallet_id,
                actor_did=request.actor_did,
                service_doc_id=request.service_doc_id,
                source_content_cid=request.source_content_cid,
                source_page_cid=request.source_page_cid,
                service_title=request.service_title,
                provider_name=request.provider_name,
                goal=request.goal,
                steps=request.steps,
                documents_needed=request.documents_needed,
                questions_to_ask=request.questions_to_ask,
                appointment_at=request.appointment_at,
                reminder_at=request.reminder_at,
                travel_target=request.travel_target,
                assigned_worker_recipient_id=request.assigned_worker_recipient_id,
                status=request.status,
                related_interaction_ids=request.related_interaction_ids,
                private_notes_record_id=request.private_notes_record_id,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.patch("/wallets/{wallet_id}/portal/plans/{plan_id}")
    def update_service_plan(wallet_id: str, plan_id: str, request: ServicePlanUpdateRequest) -> Dict[str, Any]:
        try:
            record = app_service.update_service_plan(
                wallet_id,
                plan_id,
                actor_did=request.actor_did,
                source_content_cid=request.source_content_cid,
                source_page_cid=request.source_page_cid,
                service_title=request.service_title,
                provider_name=request.provider_name,
                goal=request.goal,
                steps=request.steps,
                documents_needed=request.documents_needed,
                questions_to_ask=request.questions_to_ask,
                appointment_at=request.appointment_at,
                reminder_at=request.reminder_at,
                travel_target=request.travel_target,
                assigned_worker_recipient_id=request.assigned_worker_recipient_id,
                status=request.status,
                related_interaction_ids=request.related_interaction_ids,
                private_notes_record_id=request.private_notes_record_id,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/portal/interactions")
    def list_service_interactions(
        wallet_id: str,
        service_doc_id: str | None = None,
        interaction_type: str | None = None,
        status: str | None = None,
    ) -> Dict[str, Any]:
        try:
            return {
                "interactions": [
                    record.to_dict()
                    for record in app_service.list_service_interactions(
                        wallet_id,
                        service_doc_id=service_doc_id,
                        interaction_type=interaction_type,
                        status=status,
                    )
                ]
            }
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/portal/interactions")
    def create_service_interaction(wallet_id: str, request: ServiceInteractionRequest) -> Dict[str, Any]:
        try:
            record = app_service.create_service_interaction(
                wallet_id,
                actor_did=request.actor_did,
                service_doc_id=request.service_doc_id,
                source_content_cid=request.source_content_cid,
                source_page_cid=request.source_page_cid,
                provider_name=request.provider_name,
                program_name=request.program_name,
                interaction_type=request.interaction_type,
                channel=request.channel,
                counterparty_name=request.counterparty_name,
                counterparty_contact=request.counterparty_contact,
                timestamp=request.timestamp,
                status=request.status,
                outcome=request.outcome,
                notes_record_id=request.notes_record_id,
                next_action=request.next_action,
                next_follow_up_at=request.next_follow_up_at,
                source_action_url=request.source_action_url,
                related_grant_ids=request.related_grant_ids,
                related_record_ids=request.related_record_ids,
                privacy_level=request.privacy_level,
                metadata=request.metadata,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.patch("/wallets/{wallet_id}/portal/interactions/{interaction_id}")
    def update_service_interaction(
        wallet_id: str,
        interaction_id: str,
        request: ServiceInteractionUpdateRequest,
    ) -> Dict[str, Any]:
        try:
            record = app_service.update_service_interaction(
                wallet_id,
                interaction_id,
                actor_did=request.actor_did,
                source_content_cid=request.source_content_cid,
                source_page_cid=request.source_page_cid,
                provider_name=request.provider_name,
                program_name=request.program_name,
                channel=request.channel,
                counterparty_name=request.counterparty_name,
                counterparty_contact=request.counterparty_contact,
                timestamp=request.timestamp,
                status=request.status,
                outcome=request.outcome,
                notes_record_id=request.notes_record_id,
                next_action=request.next_action,
                next_follow_up_at=request.next_follow_up_at,
                source_action_url=request.source_action_url,
                related_grant_ids=request.related_grant_ids,
                related_record_ids=request.related_record_ids,
                privacy_level=request.privacy_level,
                metadata=request.metadata,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/analysis-grants")
    def create_analysis_grant(
        wallet_id: str,
        record_id: str,
        request: AnalysisGrantRequest,
    ) -> Dict[str, Any]:
        try:
            grant = app_service.create_record_analysis_grant(
                wallet_id,
                record_id,
                issuer_did=request.issuer_did,
                audience_did=request.audience_did,
                issuer_secret=_key_from_optional_hex(request.issuer_key_hex),
                audience_secret=_key_from_optional_hex(request.audience_key_hex),
                expires_at=request.expires_at,
            )
            return grant.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/grants")
    def create_record_grant(
        wallet_id: str,
        record_id: str,
        request: RecordGrantRequest,
    ) -> Dict[str, Any]:
        try:
            grant = app_service.create_record_grant(
                wallet_id,
                record_id,
                issuer_did=request.issuer_did,
                audience_did=request.audience_did,
                abilities=request.abilities,
                purpose=request.purpose,
                issuer_secret=_key_from_optional_hex(request.issuer_key_hex),
                audience_secret=_key_from_optional_hex(request.audience_key_hex),
                approval_id=request.approval_id,
                expires_at=request.expires_at,
                max_delegation_depth=request.max_delegation_depth,
                output_types=request.output_types or None,
                user_presence_required=request.user_presence_required,
                extra_caveats=request.caveats,
            )
            return grant.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/analysis-invocations")
    def issue_analysis_invocation(
        wallet_id: str,
        record_id: str,
        request: AnalysisInvocationRequest,
    ) -> Dict[str, Any]:
        try:
            invocation = app_service.issue_record_analysis_invocation(
                wallet_id,
                record_id,
                grant_id=request.grant_id,
                actor_did=request.actor_did,
                actor_secret=_key_from_optional_hex(request.actor_key_hex),
                expires_at=request.expires_at,
                purpose=request.purpose,
                output_types=request.output_types or None,
                user_present=request.user_present,
            )
            return {"invocation": invocation.to_dict(), "token": invocation_to_token(invocation)}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/decrypt-invocations")
    def issue_decrypt_invocation(
        wallet_id: str,
        record_id: str,
        request: AnalysisInvocationRequest,
    ) -> Dict[str, Any]:
        try:
            invocation = app_service.issue_record_decrypt_invocation(
                wallet_id,
                record_id,
                grant_id=request.grant_id,
                actor_did=request.actor_did,
                actor_secret=_key_from_optional_hex(request.actor_key_hex),
                expires_at=request.expires_at,
                purpose=request.purpose,
                output_types=request.output_types or None,
                user_present=request.user_present,
            )
            return {"invocation": invocation.to_dict(), "token": invocation_to_token(invocation)}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/access-requests")
    def request_access(wallet_id: str, request: AccessRequestCreateRequest) -> Dict[str, Any]:
        try:
            access_request = app_service.request_record_access(
                wallet_id,
                request.record_id,
                requester_did=request.requester_did,
                ability=request.ability,
                audience_did=request.audience_did,
                purpose=request.purpose,
                expires_at=request.expires_at,
            )
            return access_request.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/access-requests")
    def list_access_requests(
        wallet_id: str,
        status: str = "pending",
        requester_did: str | None = None,
        audience_did: str | None = None,
    ) -> Dict[str, Any]:
        try:
            normalized_status = None if status == "all" else status
            requests = app_service.access_request_review_items(
                wallet_id,
                status=normalized_status,
                requester_did=requester_did,
                audience_did=audience_did,
            )
            return {"requests": requests}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/access-requests/{request_id}/approve")
    def approve_access_request(
        wallet_id: str,
        request_id: str,
        request: AccessRequestDecisionRequest,
    ) -> Dict[str, Any]:
        try:
            access_request = app_service.approve_access_request(
                wallet_id,
                request_id=request_id,
                actor_did=request.actor_did,
                issuer_secret=_key_from_optional_hex(request.issuer_key_hex),
                audience_secret=_key_from_optional_hex(request.audience_key_hex),
                approval_id=request.approval_id,
                issue_invocation=request.issue_invocation,
                invocation_expires_at=request.invocation_expires_at,
            )
            response = access_request.to_dict()
            if access_request.invocation_id:
                invocation = app_service.wallet_service.invocations[access_request.invocation_id]
                response["invocation_token"] = invocation_to_token(invocation)
            return response
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/access-requests/{request_id}/reject")
    def reject_access_request(
        wallet_id: str,
        request_id: str,
        request: AccessRequestDecisionRequest,
    ) -> Dict[str, Any]:
        try:
            access_request = app_service.reject_access_request(
                wallet_id,
                request_id=request_id,
                actor_did=request.actor_did,
                reason=request.reason,
            )
            return access_request.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/access-requests/{request_id}/revoke")
    def revoke_access_request(
        wallet_id: str,
        request_id: str,
        request: AccessRequestDecisionRequest,
    ) -> Dict[str, Any]:
        try:
            access_request = app_service.revoke_access_request(
                wallet_id,
                request_id=request_id,
                actor_did=request.actor_did,
                reason=request.reason,
            )
            return access_request.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/approvals")
    def request_threshold_approval(
        wallet_id: str,
        request: ThresholdApprovalCreateRequest,
    ) -> Dict[str, Any]:
        try:
            approval = app_service.request_threshold_approval(
                wallet_id,
                requested_by=request.requested_by,
                operation=request.operation,
                resources=request.resources,
                abilities=request.abilities,
                expires_at=request.expires_at,
            )
            return approval.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/approvals")
    def list_threshold_approvals(wallet_id: str, status: str = "all") -> Dict[str, Any]:
        try:
            normalized_status = None if status == "all" else status
            approvals = app_service.list_threshold_approvals(wallet_id, status=normalized_status)
            return {"approvals": [approval.to_dict() for approval in approvals]}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/approvals/{approval_id}/approve")
    def approve_threshold_approval(
        wallet_id: str,
        approval_id: str,
        request: ThresholdApprovalDecisionRequest,
    ) -> Dict[str, Any]:
        try:
            approval = app_service.approve_threshold_approval(
                wallet_id,
                approval_id=approval_id,
                approver_did=request.approver_did,
            )
            return approval.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/grants/{grant_id}/revoke")
    def revoke_grant(wallet_id: str, grant_id: str, request: RevokeGrantRequest) -> Dict[str, Any]:
        try:
            grant = app_service.revoke_grant(wallet_id, grant_id, actor_did=request.actor_did)
            return grant.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/emergency-revoke")
    def emergency_revoke(wallet_id: str, request: EmergencyRevokeRequest) -> Dict[str, Any]:
        try:
            return app_service.emergency_revoke(
                wallet_id,
                actor_did=request.actor_did,
                actor_secret=_key_from_optional_hex(request.actor_key_hex),
                approval_id=request.approval_id,
                rotate_keys=request.rotate_keys,
                reason=request.reason,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/grants/{parent_grant_id}/delegate")
    def delegate_grant(
        wallet_id: str,
        parent_grant_id: str,
        request: DelegateGrantRequest,
    ) -> Dict[str, Any]:
        try:
            grant = app_service.delegate_grant(
                wallet_id,
                parent_grant_id=parent_grant_id,
                issuer_did=request.issuer_did,
                audience_did=request.audience_did,
                resources=request.resources,
                abilities=request.abilities,
                caveats=request.caveats,
                expires_at=request.expires_at,
                issuer_secret=_key_from_optional_hex(request.issuer_key_hex),
                audience_secret=_key_from_optional_hex(request.audience_key_hex),
            )
            return grant.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/grant-receipts")
    def list_grant_receipts(
        wallet_id: str,
        audience_did: str | None = None,
        status: str = "all",
    ) -> Dict[str, Any]:
        try:
            normalized_status = None if status == "all" else status
            receipts = app_service.list_grant_receipts(
                wallet_id,
                audience_did=audience_did,
                status=normalized_status,
            )
            return {"receipts": [receipt.to_dict() for receipt in receipts]}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/exports/grants")
    def create_export_grant(wallet_id: str, request: ExportGrantRequest) -> Dict[str, Any]:
        try:
            if not request.record_ids:
                raise ValueError("export grants require at least one record_id")
            grant = app_service.create_export_grant(
                wallet_id,
                issuer_did=request.issuer_did,
                audience_did=request.audience_did,
                record_ids=request.record_ids,
                issuer_secret=_key_from_optional_hex(request.issuer_key_hex),
                audience_secret=_key_from_optional_hex(request.audience_key_hex),
                purpose=request.purpose,
                expires_at=request.expires_at,
                approval_id=request.approval_id,
                output_types=request.output_types or None,
            )
            return grant.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/exports/invocations")
    def issue_export_invocation(wallet_id: str, request: ExportInvocationRequest) -> Dict[str, Any]:
        try:
            invocation = app_service.issue_export_invocation(
                wallet_id,
                grant_id=request.grant_id,
                actor_did=request.actor_did,
                actor_secret=_key_from_optional_hex(request.actor_key_hex),
                record_ids=request.record_ids or None,
                expires_at=request.expires_at,
                purpose=request.purpose,
                output_types=request.output_types or None,
                user_present=request.user_present,
            )
            return {
                **invocation.to_dict(),
                "invocation_token": invocation_to_token(invocation),
            }
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/exports")
    def create_export_bundle(wallet_id: str, request: ExportBundleRequest) -> Dict[str, Any]:
        try:
            if request.invocation_token:
                return app_service.create_export_bundle_with_invocation(
                    wallet_id,
                    actor_did=request.actor_did,
                    invocation=invocation_from_token(request.invocation_token),
                    actor_secret=_key_from_optional_hex(request.actor_key_hex),
                    record_ids=request.record_ids or None,
                    include_proofs=request.include_proofs,
                    include_derived_artifacts=request.include_derived_artifacts,
                )
            return app_service.create_export_bundle(
                wallet_id,
                actor_did=request.actor_did,
                grant_id=request.grant_id,
                record_ids=request.record_ids or None,
                include_proofs=request.include_proofs,
                include_derived_artifacts=request.include_derived_artifacts,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/exports/verify")
    def verify_export_bundle(request: ExportBundleVerifyRequest) -> Dict[str, Any]:
        try:
            return app_service.verify_export_bundle(request.bundle)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/exports/import")
    def import_export_bundle(request: ExportBundleImportRequest) -> Dict[str, Any]:
        try:
            return app_service.import_export_bundle(request.bundle)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/exports/storage")
    def verify_export_bundle_storage(request: ExportBundleStorageRequest) -> Dict[str, Any]:
        try:
            return app_service.verify_export_bundle_storage(request.bundle)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/decrypt")
    def decrypt_record(
        wallet_id: str,
        record_id: str,
        request: DecryptRecordRequest,
    ) -> Dict[str, Any]:
        try:
            actor_secret = _key_from_optional_hex(request.actor_key_hex)
            if request.invocation_token:
                plaintext = app_service.decrypt_record_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation_from_token(request.invocation_token),
                    actor_secret=actor_secret,
                )
            else:
                plaintext = app_service.decrypt_record_for_delegate(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                )
            return {
                "size_bytes": len(plaintext),
                "text": plaintext.decode("utf-8", errors="replace"),
                "base64": base64.b64encode(plaintext).decode("ascii"),
            }
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/analyze")
    def analyze_record(
        wallet_id: str,
        record_id: str,
        request: AnalyzeRecordRequest,
    ) -> Dict[str, Any]:
        try:
            actor_secret = _key_from_optional_hex(request.actor_key_hex)
            if request.invocation_token:
                artifact = app_service.analyze_record_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation_from_token(request.invocation_token),
                    actor_secret=actor_secret,
                    max_chars=request.max_chars,
                )
            else:
                artifact = app_service.analyze_record_for_delegate(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id or "",
                    actor_secret=actor_secret,
                    max_chars=request.max_chars,
                )
            return artifact.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/analyze/redacted")
    def analyze_record_redacted(
        wallet_id: str,
        record_id: str,
        request: RedactedAnalyzeRecordRequest,
    ) -> Dict[str, Any]:
        try:
            actor_secret = _key_from_optional_hex(request.actor_key_hex)
            if request.invocation_token:
                result = app_service.analyze_record_redacted_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation_from_token(request.invocation_token),
                    actor_secret=actor_secret,
                    max_chars=request.max_chars,
                )
            else:
                result = app_service.analyze_record_redacted(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    max_chars=request.max_chars,
                )
            return _analysis_result_to_dict(result)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/vector-profile")
    def create_document_vector_profile(
        wallet_id: str,
        record_id: str,
        request: VectorProfileRequest,
    ) -> Dict[str, Any]:
        try:
            actor_secret = _key_from_optional_hex(request.actor_key_hex)
            if request.invocation_token:
                result = app_service.create_document_vector_profile_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation_from_token(request.invocation_token),
                    actor_secret=actor_secret,
                    chunk_size_words=request.chunk_size_words,
                )
            else:
                result = app_service.create_document_vector_profile(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    chunk_size_words=request.chunk_size_words,
                )
            return _analysis_result_to_dict(result)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/extract-text/redacted")
    def extract_record_text_redacted(
        wallet_id: str,
        record_id: str,
        request: RedactedTextExtractionRequest,
    ) -> Dict[str, Any]:
        try:
            actor_secret = _key_from_optional_hex(request.actor_key_hex)
            if request.invocation_token:
                result = app_service.extract_record_text_redacted_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation_from_token(request.invocation_token),
                    actor_secret=actor_secret,
                    max_chars=request.max_chars,
                    max_bytes=request.max_bytes,
                    use_ocr=request.use_ocr,
                )
            else:
                result = app_service.extract_record_text_redacted(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    max_chars=request.max_chars,
                    max_bytes=request.max_bytes,
                    use_ocr=request.use_ocr,
                )
            return _analysis_result_to_dict(result)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/forms/analyze/redacted")
    def analyze_record_form_redacted(
        wallet_id: str,
        record_id: str,
        request: RedactedFormAnalysisRequest,
    ) -> Dict[str, Any]:
        try:
            actor_secret = _key_from_optional_hex(request.actor_key_hex)
            if request.invocation_token:
                result = app_service.analyze_record_form_redacted_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation_from_token(request.invocation_token),
                    actor_secret=actor_secret,
                    max_fields=request.max_fields,
                    use_ocr=request.use_ocr,
                )
            else:
                result = app_service.analyze_record_form_redacted(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    max_fields=request.max_fields,
                    use_ocr=request.use_ocr,
                )
            return _analysis_result_to_dict(result)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/analyze/redacted")
    def analyze_records_redacted(
        wallet_id: str,
        request: RedactedAnalyzeRecordsRequest,
    ) -> Dict[str, Any]:
        try:
            if not request.record_ids:
                raise ValueError("redacted cross-record analysis requires at least one record_id")
            result = app_service.analyze_records_redacted(
                wallet_id,
                request.record_ids,
                actor_did=request.actor_did,
                grant_id=request.grant_id,
                actor_secret=_key_from_optional_hex(request.actor_key_hex),
            )
            return _analysis_result_to_dict(result)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/graphrag/redacted")
    def create_redacted_graphrag(
        wallet_id: str,
        request: RedactedGraphRAGRequest,
    ) -> Dict[str, Any]:
        try:
            if not request.record_ids:
                raise ValueError("redacted GraphRAG creation requires at least one record_id")
            actor_secret = _key_from_optional_hex(request.actor_key_hex)
            if request.invocation_token:
                result = app_service.create_redacted_graphrag_with_invocation(
                    wallet_id,
                    request.record_ids,
                    actor_did=request.actor_did,
                    invocation=invocation_from_token(request.invocation_token),
                    actor_secret=actor_secret,
                    max_chars_per_record=request.max_chars_per_record,
                    max_bytes_per_record=request.max_bytes_per_record,
                    use_ocr=request.use_ocr,
                )
            else:
                result = app_service.create_redacted_graphrag(
                    wallet_id,
                    request.record_ids,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    max_chars_per_record=request.max_chars_per_record,
                    max_bytes_per_record=request.max_bytes_per_record,
                    use_ocr=request.use_ocr,
                )
            return _analysis_result_to_dict(result)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/rotate-key")
    def rotate_record_key(
        wallet_id: str,
        record_id: str,
        request: RotateRecordKeyRequest,
    ) -> Dict[str, Any]:
        try:
            version = app_service.rotate_record_key(
                wallet_id,
                record_id,
                actor_did=request.actor_did,
                actor_secret=_key_from_optional_hex(request.actor_key_hex),
            )
            return version.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/records/{record_id}/storage")
    def verify_record_storage(wallet_id: str, record_id: str) -> Dict[str, Any]:
        try:
            report = app_service.verify_record_storage(wallet_id, record_id)
            return report.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/storage")
    def verify_wallet_storage(wallet_id: str) -> Dict[str, Any]:
        try:
            report = app_service.verify_wallet_storage(wallet_id)
            return report.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/storage/repair")
    def repair_wallet_storage(wallet_id: str, request: RepairStorageRequest) -> Dict[str, Any]:
        try:
            report = app_service.repair_wallet_storage(wallet_id, actor_did=request.actor_did)
            return report.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/records/{record_id}/storage/repair")
    def repair_record_storage(
        wallet_id: str,
        record_id: str,
        request: RepairStorageRequest,
    ) -> Dict[str, Any]:
        try:
            report = app_service.repair_record_storage(
                wallet_id,
                record_id,
                actor_did=request.actor_did,
            )
            return report.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/services/match")
    def match_services_for_wallet(wallet_id: str, request: WalletServiceMatchRequest) -> Dict[str, Any]:
        try:
            if request.invocation_token:
                matches = app_service.match_services_for_wallet_with_invocation(
                    wallet_id,
                    request.location_record_id,
                    actor_did=request.actor_did,
                    invocation=invocation_from_token(request.invocation_token),
                    actor_secret=_key_from_optional_hex(request.actor_key_hex),
                    need_terms=list(request.need_terms),
                    limit=request.limit,
                )
            else:
                matches = app_service.match_services_for_wallet(
                    wallet_id,
                    request.location_record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    need_terms=list(request.need_terms),
                    limit=request.limit,
                )
            return {"matches": [_match_to_dict(match) for match in matches]}
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/audit")
    def audit_timeline(wallet_id: str) -> Dict[str, Any]:
        try:
            return {"events": app_service.audit_timeline(wallet_id)}
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/proofs")
    def list_proof_receipts(wallet_id: str) -> Dict[str, Any]:
        try:
            return {"proofs": [proof.to_dict() for proof in app_service.list_proof_receipts(wallet_id)]}
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/analytics/templates")
    def create_analytics_template(request: AnalyticsTemplateRequest) -> Dict[str, Any]:
        try:
            template = app_service.create_analytics_template(
                template_id=request.template_id,
                title=request.title,
                purpose=request.purpose,
                allowed_record_types=request.allowed_record_types,
                allowed_derived_fields=request.allowed_derived_fields,
                min_cohort_size=request.min_cohort_size,
                epsilon_budget=request.epsilon_budget,
                created_by=request.created_by,
                status=request.status,
                expires_at=request.expires_at,
            )
            return template.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/analytics/templates")
    def list_analytics_templates(include_inactive: bool = False) -> Dict[str, Any]:
        return {
            "templates": [
                template.to_dict()
                for template in app_service.list_analytics_templates(include_inactive=include_inactive)
            ]
        }

    @app.get("/wallets/{wallet_id}/analytics/consents")
    def list_analytics_consents(wallet_id: str, status: str = "all") -> Dict[str, Any]:
        try:
            return {
                "consents": [
                    consent.to_dict()
                    for consent in app_service.list_analytics_consents(wallet_id, status=status)
                ]
            }
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/analytics/consents/from-template")
    def create_analytics_consent_from_template(
        wallet_id: str,
        request: AnalyticsConsentFromTemplateRequest,
    ) -> Dict[str, Any]:
        try:
            consent = app_service.create_analytics_consent_from_template(
                wallet_id,
                actor_did=request.actor_did,
                template_id=request.template_id,
                expires_at=request.expires_at,
            )
            return consent.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/analytics/consents/{consent_id}/revoke")
    def revoke_analytics_consent(
        wallet_id: str,
        consent_id: str,
        request: AnalyticsConsentRevokeRequest,
    ) -> Dict[str, Any]:
        try:
            consent = app_service.revoke_analytics_consent(
                wallet_id,
                consent_id,
                actor_did=request.actor_did,
            )
            return consent.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/analytics/contributions")
    def create_analytics_contribution(
        wallet_id: str,
        request: AnalyticsContributionRequest,
    ) -> Dict[str, Any]:
        try:
            contribution = app_service.contribute_analytics_facts(
                wallet_id,
                actor_did=request.actor_did,
                consent_id=request.consent_id,
                template_id=request.template_id,
                fields=request.fields,
            )
            return contribution.to_dict()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/analytics/{template_id}/count")
    def run_private_aggregate_count(
        template_id: str,
        request: PrivateAggregateCountRequest,
    ) -> Dict[str, Any]:
        try:
            result = app_service.run_private_aggregate_count(
                template_id,
                epsilon=request.epsilon,
                min_cohort_size=request.min_cohort_size,
                budget_key=request.budget_key,
                budget_limit=request.budget_limit,
                actor_did=request.actor_did,
            )
            return app_service.summarize_aggregate_result(result)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/analytics/{template_id}/count-by-fields")
    def run_private_aggregate_count_by_fields(
        template_id: str,
        request: PrivateAggregateCohortCountRequest,
    ) -> Dict[str, Any]:
        try:
            result = app_service.run_private_aggregate_count_by_fields(
                template_id,
                group_by=request.group_by,
                epsilon=request.epsilon,
                min_cohort_size=request.min_cohort_size,
                budget_key=request.budget_key,
                budget_limit=request.budget_limit,
                actor_did=request.actor_did,
            )
            return app_service.summarize_aggregate_result(result)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/services/match-derived")
    def match_services_from_derived(request: DerivedServiceMatchRequest) -> Dict[str, Any]:
        try:
            matches = app_service.match_services_from_derived_facts(
                derived_facts={
                    "need_terms": list(request.need_terms),
                    "location_claim": request.location_claim,
                },
                limit=request.limit,
            )
            return {
                "matches": [_match_to_dict(match) for match in matches]
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    return app


def _match_to_dict(match) -> Dict[str, Any]:
    return {
        "service": match.service.__dict__,
        "score": match.score,
        "reasons": list(match.reasons),
    }


def _analysis_result_to_dict(result: Dict[str, Any]) -> Dict[str, Any]:
    artifact = result["artifact"]
    artifact_data = artifact.to_dict() if hasattr(artifact, "to_dict") else dict(artifact)
    return {
        "artifact": artifact_data,
        "output": result["output"],
    }


def _key_from_optional_hex(value: str | None) -> bytes | None:
    if value is None:
        return None
    key = bytes.fromhex(value)
    if len(key) != 32:
        raise ValueError("wallet key must decode to 32 bytes")
    return key
