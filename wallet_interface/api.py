"""FastAPI surface for 211-AI wallet workflows."""

from __future__ import annotations

import base64
import concurrent.futures
from contextlib import contextmanager
import hashlib
import hmac
import io
import json
import math
import mimetypes
import os
import re
import smtplib
import struct
import threading
import time
import uuid
import wave
import zipfile
import secrets
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Any, Dict, List, Mapping, Sequence
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from .app_service import WalletInterfaceService

try:  # pragma: no cover - exercised when optional dependency is installed.
    from fastapi import Body, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel, Field
except ImportError:  # pragma: no cover
    FastAPI = None  # type: ignore[assignment]
    Body = None  # type: ignore[assignment]
    CORSMiddleware = None  # type: ignore[assignment]
    File = None  # type: ignore[assignment]
    Form = None  # type: ignore[assignment]
    Header = None  # type: ignore[assignment]
    HTTPException = None  # type: ignore[assignment]
    Request = object  # type: ignore[assignment,misc]
    Response = object  # type: ignore[assignment,misc]
    UploadFile = object  # type: ignore[assignment,misc]
    BaseModel = object  # type: ignore[assignment,misc]

    def Field(default: Any = None, **_: Any) -> Any:  # type: ignore[no-redef]
        return default

from ._vendor import ensure_ipfs_datasets_py_path

ensure_ipfs_datasets_py_path()

from ipfs_datasets_py.ipfs_backend_router import get_ipfs_backend  # noqa: E402
from ipfs_datasets_py.utils.secrets import resolve_secret  # noqa: E402
from ipfs_datasets_py.wallet.ucan import invocation_from_token, invocation_to_token  # noqa: E402
from ipfs_accelerate_py import HFSpaceClient  # noqa: E402


PORTLAND_POLICE_MISSING_EMAIL = "missing@police.portlandoregon.gov"
OPS_DEAD_DROP_ACTOR_DID = "did:wallet:ops"
_IPFS_CID_PATTERN = re.compile(r"^(?:bafy[a-z0-9]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$")
_AI_ROUTER_RATE_LIMITS: Dict[str, Dict[str, Any]] = {}


class FilecoinPinHandoffError(RuntimeError):
    """Raised when the optional Filecoin Pin sidecar handoff fails."""


def _cors_origins_from_env() -> list[str]:
    origins = [
        origin.strip()
        for origin in os.environ.get("WALLET_API_CORS_ORIGINS", "").split(",")
        if origin.strip()
    ]
    return origins


def _prepare_hf_router_environment(kwargs: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Make encrypted HF credentials visible to ipfs_datasets_py router helpers."""
    token = (
        resolve_secret(
            "IPFS_DATASETS_PY_HF_API_TOKEN",
            "HF_TOKEN",
            "HUGGINGFACEHUB_API_TOKEN",
            "HUGGINGFACE_API_TOKEN",
            "HUGGINGFACE_HUB_TOKEN",
            "HF_API_TOKEN",
        )
        or ""
    ).strip()
    if token:
        for key in ("IPFS_DATASETS_PY_HF_API_TOKEN", "HF_TOKEN", "HUGGINGFACEHUB_API_TOKEN"):
            if not os.getenv(key, "").strip():
                os.environ[key] = token
    bill_to = (
        os.getenv("IPFS_DATASETS_PY_HF_BILL_TO")
        or os.getenv("HUGGINGFACE_BILL_TO")
        or os.getenv("HF_BILL_TO")
        or "publicus"
    ).strip()
    if bill_to:
        os.environ.setdefault("IPFS_DATASETS_PY_HF_BILL_TO", bill_to)
        os.environ.setdefault("HUGGINGFACE_BILL_TO", bill_to)
    router_kwargs = dict(kwargs or {})
    if bill_to:
        router_kwargs.setdefault("bill_to", bill_to)
        router_kwargs.setdefault("organization", bill_to)
    router_kwargs.setdefault("hf_provider", os.getenv("IPFS_DATASETS_PY_HF_PROVIDER", "auto"))
    return router_kwargs


def _normalize_ipfs_cid(value: str) -> str:
    normalized = str(value or "").strip()
    normalized = normalized.replace("ipfs://", "")
    normalized = re.sub(r"^/?ipfs/", "", normalized)
    normalized = normalized.split("/", 1)[0].strip()
    return normalized


def _valid_ipfs_cid(value: str) -> bool:
    return bool(_IPFS_CID_PATTERN.match(_normalize_ipfs_cid(value)))


def _ipfs_proxy_allowed_cids_from_env() -> set[str]:
    raw = str(os.getenv("WALLET_IPFS_PROXY_ALLOWED_CIDS") or "")
    return {
        normalized
        for part in re.split(r"[\s,]+", raw)
        if (normalized := _normalize_ipfs_cid(part))
    }


def _ipfs_proxy_allows_cid(cid: str) -> bool:
    normalized = _normalize_ipfs_cid(cid)
    allowed = _ipfs_proxy_allowed_cids_from_env()
    if not allowed:
        return True
    return normalized in allowed


def _ipfs_proxy_media_type(data: bytes) -> str:
    try:
        decoded = data.decode("utf-8")
        json.loads(decoded)
        return "application/json"
    except Exception:
        return "application/octet-stream"


def _ipfs_proxy_fallback_gateways() -> list[str]:
    configured = [
        gateway.strip().rstrip("/")
        for gateway in os.getenv("WALLET_IPFS_PROXY_FALLBACK_GATEWAYS", "").split(",")
        if gateway.strip()
    ]
    if configured:
        return configured
    return [
        "https://w3s.link/ipfs",
        "https://ipfs.io/ipfs",
        "https://dweb.link/ipfs",
    ]


def _fetch_ipfs_cid_via_gateway(cid: str) -> bytes:
    last_error: Exception | None = None
    for gateway in _ipfs_proxy_fallback_gateways():
        url = f"{gateway.rstrip('/')}/{urllib_parse.quote(cid, safe='')}"
        try:
            req = urllib_request.Request(url, headers={"Accept": "application/octet-stream,*/*"})
            with urllib_request.urlopen(req, timeout=30) as response:
                return response.read()
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"Unable to fetch CID from fallback gateways: {last_error}") from last_error


def _wallet_interface_service_from_env() -> WalletInterfaceService:
    services_jsonl = str(os.environ.get("WALLET_SERVICES_JSONL") or "").strip()
    if services_jsonl:
        return WalletInterfaceService.from_services_jsonl(services_jsonl)
    return WalletInterfaceService()


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


class DocumentPrivacyProfileProofRequest(BaseModel):
    actor_did: str
    public_inputs: Dict[str, Any] = Field(default_factory=dict)


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


class WalletRecordMetadataRequest(BaseModel):
    actor_did: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class DeleteWalletRecordRequest(BaseModel):
    actor_did: str
    unpin_ipfs: bool = True


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


class ServicePlanShareGrantRequest(BaseModel):
    actor_did: str = ""
    issuer_did: str = ""
    audience_did: str = ""
    worker_did: str = ""
    scopes: List[str] = Field(default_factory=lambda: ["service_summary"])
    purpose: str = "service_plan_collaboration"
    worker_recipient_id: str = ""
    worker_name: str = ""
    expires_at: str | None = None
    approval_id: str | None = None
    issuer_key_hex: str | None = None
    audience_key_hex: str | None = None
    caveats: Dict[str, Any] = Field(default_factory=dict)


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


class HmisClientLookupRequest(BaseModel):
    actor_did: str
    name: str = ""
    date_of_birth: str = ""
    program_ref: str = ""


class HmisHouseholdLookupRequest(BaseModel):
    actor_did: str
    name: str = ""
    program_ref: str = ""


class HmisProgramLinkListRequest(BaseModel):
    actor_did: str
    name: str = ""
    program_ref: str = ""
    
class HmisReferralDraftRequest(BaseModel):
    actor_did: str
    local_subject_ref: str
    destination_program_ref: str
    service_plan_id: str = ""
    service_doc_id: str = ""
    provider_name: str = ""
    program_name: str = ""
    summary: str = ""
    eligibility_notes: str = ""
    contact_notes: str = ""
    source_content_cid: str = ""
    source_page_cid: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)


class HmisReferralDraftUpdateRequest(BaseModel):
    actor_did: str
    local_subject_ref: str | None = None
    destination_program_ref: str | None = None
    service_plan_id: str | None = None
    service_doc_id: str | None = None
    provider_name: str | None = None
    program_name: str | None = None
    summary: str | None = None
    eligibility_notes: str | None = None
    contact_notes: str | None = None
    source_content_cid: str | None = None
    source_page_cid: str | None = None
    metadata: Dict[str, Any] | None = None


class HmisReferralDraftValidationRequest(BaseModel):
    actor_did: str


class HmisReferralDraftSubmitRequest(BaseModel):
    actor_did: str


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


class WalletRouterBaseRequest(BaseModel):
    actor_did: str
    actor_key_hex: str | None = None
    wallet_cid: str | None = None
    provider: str | None = "hf_inference_api"
    model_name: str | None = None
    kwargs: Dict[str, Any] = Field(default_factory=dict)


class WalletEmbeddingsRouterRequest(WalletRouterBaseRequest):
    text: str | None = None
    texts: List[str] = Field(default_factory=list)


class WalletLlmRouterRequest(WalletRouterBaseRequest):
    prompt: str
    system_prompt: str | None = None
    max_new_tokens: int | None = 350


class WalletMultimodalRouterRequest(WalletRouterBaseRequest):
    prompt: str
    image_urls: List[str] = Field(default_factory=list)
    additional_text_blocks: List[str] = Field(default_factory=list)
    messages: List[Dict[str, Any]] = Field(default_factory=list)
    image_detail: str | None = "auto"
    max_new_tokens: int | None = 350


class WalletRecordMetadataGenerationRequest(WalletRouterBaseRequest):
    grant_id: str | None = None
    invocation_token: str | None = None
    file_name: str | None = None
    mime_type: str | None = None
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


class FilecoinRecordUploadRequest(BaseModel):
    actorDid: str
    actorKeyHex: str | None = None
    fileName: str | None = None
    grantId: str | None = None
    recordId: str
    walletId: str


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


class MissingPersonDeadDropEmailRequest(BaseModel):
    actor_did: str
    to_email: str = PORTLAND_POLICE_MISSING_EMAIL
    subject: str = "Missing person report dead drop bundle"
    body: str
    bundle: Dict[str, Any]
    bundle_filename: str = "abby-missing-person-wallet-dead-drop.json"


class MissingPersonDeadDropConfigRequest(BaseModel):
    actor_did: str
    enabled: bool = False
    to_email: str = PORTLAND_POLICE_MISSING_EMAIL
    subject: str = "Missing person report dead drop bundle"
    body: str = ""
    bundle: Dict[str, Any] = Field(default_factory=dict)
    bundle_filename: str = "abby-missing-person-wallet-dead-drop.json"
    due_at: str = ""
    last_check_in_at: str = ""


class MissingPersonDeadDropDispatchRequest(BaseModel):
    actor_did: str


class SmsNotificationQueueRequest(BaseModel):
    actor_did: str
    to_phone: str
    message: str
    due_at: str = ""
    reason: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)


class SmsNotificationDispatchRequest(BaseModel):
    actor_did: str


class InboundSmsForwardRequest(BaseModel):
    wallet_id: str
    from_phone: str
    message: str
    to_phone: str = ""
    provider: str = "unknown"
    status: str = "received"
    message_id: str = ""
    provider_message_id: str = ""
    external_reference: str = ""
    created_at: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)


class PhoneCallNotificationQueueRequest(BaseModel):
    actor_did: str
    to_phone: str
    script: str
    due_at: str = ""
    reason: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)


class PhoneCallNotificationDispatchRequest(BaseModel):
    actor_did: str


class MagicLoginRequest(BaseModel):
    contact: str
    portal: str = "client"
    wallet_id: str = ""
    wallet_api_base_url: str = ""
    actor_did: str = ""
    base_url: str = ""


class MagicLoginVerifyRequest(BaseModel):
    token: str


class WalletRecoveryBundleRequest(BaseModel):
    actor_did: str
    encrypted_bundle: Dict[str, Any]
    wrapping_method: str = "passphrase"
    kdf: Dict[str, Any] = Field(default_factory=dict)
    recovery_hint: str = ""
    public_metadata: Dict[str, Any] = Field(default_factory=dict)


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


def _require_portland_police_missing_email(to_email: str) -> str:
    normalized = str(to_email or "").strip().lower()
    if normalized != PORTLAND_POLICE_MISSING_EMAIL:
        raise ValueError(
            f"missing-person dead drop recipient must be {PORTLAND_POLICE_MISSING_EMAIL}"
        )
    return PORTLAND_POLICE_MISSING_EMAIL


def _normalize_phone_number(phone: str) -> str:
    raw = str(phone or "").strip()
    if not raw:
        raise ValueError("to_phone is required")
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 10:
        raise ValueError("to_phone must include at least 10 digits")
    return f"+{digits}" if raw.startswith("+") else digits


def _normalize_login_contact(value: str) -> str:
    normalized = str(value or "").strip()
    if "@" in normalized:
        normalized = normalized.lower()
        if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", normalized):
            raise ValueError("contact must be a valid email address or telephone number")
        return normalized
    return _normalize_phone_number(normalized)


def _is_email_contact(value: str) -> bool:
    return "@" in str(value or "")


def _sms_inbound_actor_did() -> str:
    return str(os.getenv("WALLET_SMS_INBOUND_ACTOR_DID") or "did:wallet:sms-bridge").strip()


def _require_internal_webhook_auth(
    *,
    env_prefix: str,
    authorization: str | None,
    headers: Mapping[str, str],
    error_detail: str,
) -> None:
    expected_bearer = str(os.getenv(f"{env_prefix}_BEARER_TOKEN") or "").strip()
    header_name = str(os.getenv(f"{env_prefix}_HTTP_HEADER_NAME") or "").strip()
    header_value = str(os.getenv(f"{env_prefix}_HTTP_HEADER_VALUE") or "").strip()
    if header_name and not header_value:
        raise RuntimeError(f"{env_prefix}_HTTP_HEADER_VALUE is required when header name is set")

    supplied_bearer = _extract_bearer_token(authorization)
    if expected_bearer and supplied_bearer == expected_bearer:
        return
    if header_name and str(headers.get(header_name) or "").strip() == header_value:
        return
    if not expected_bearer and not header_name:
        raise RuntimeError(
            f"{env_prefix}_BEARER_TOKEN or {env_prefix}_HTTP_HEADER_NAME must be configured for inbound webhook delivery"
        )
    raise HTTPException(status_code=401, detail=error_detail)


def _send_webhook_notification(
    *,
    env_prefix: str,
    required_key: str,
    required_value: str,
    extra_payload: Dict[str, Any] | None = None,
) -> Dict[str, str]:
    webhook_url = str(os.getenv(f"{env_prefix}_WEBHOOK_URL") or "").strip()
    backend = str(os.getenv(f"{env_prefix}_BACKEND") or ("http" if webhook_url else "")).strip().lower()
    if not backend or not webhook_url:
        raise RuntimeError(
            f"{env_prefix}_WEBHOOK_URL environment variable is required for delivery but is not configured"
        )
    if backend != "http":
        raise RuntimeError(f"{env_prefix}_BACKEND must be http when delivery is enabled")

    extra_headers: Dict[str, str] = {}
    if bearer_token := str(os.getenv(f"{env_prefix}_BEARER_TOKEN") or "").strip():
        extra_headers["authorization"] = f"Bearer {bearer_token}"
    if header_name := str(os.getenv(f"{env_prefix}_HTTP_HEADER_NAME") or "").strip():
        header_value = str(os.getenv(f"{env_prefix}_HTTP_HEADER_VALUE") or "").strip()
        if not header_value:
            raise RuntimeError(f"{env_prefix}_HTTP_HEADER_VALUE is required when header name is set")
        extra_headers[header_name] = header_value

    timeout_seconds = float(str(os.getenv(f"{env_prefix}_TIMEOUT_SECONDS") or "15").strip())
    if timeout_seconds <= 0:
        raise RuntimeError(f"{env_prefix}_TIMEOUT_SECONDS must be positive")

    payload = {
        required_key: required_value,
        **dict(extra_payload or {}),
    }

    request_headers = {"content-type": "application/json", **extra_headers}
    body = json.dumps(payload, sort_keys=True).encode("utf-8")
    req = urllib_request.Request(
        webhook_url,
        data=body,
        headers=request_headers,
        method="POST",
    )
    with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
        raw = response.read().decode("utf-8")
        content_type = str(getattr(response, "headers", {}).get("content-type", ""))
        status = str(getattr(response, "status", getattr(response, "code", 200)))

    response_payload: Dict[str, Any] = {}
    if raw:
        if "json" in content_type.lower() or raw.lstrip().startswith("{"):
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("SMS delivery response must be a JSON object")
            response_payload = parsed

    provider_message_id = str(
        response_payload.get("provider_message_id")
        or response_payload.get("provider_call_id")
        or response_payload.get("message_id")
        or response_payload.get("call_id")
        or response_payload.get("email_id")
        or response_payload.get("id")
        or ""
    )
    result = {
        "provider": str(response_payload.get("provider") or "http"),
        "provider_status": str(response_payload.get("status") or status),
    }
    if provider_message_id:
        result["provider_message_id"] = provider_message_id
    return result


def _send_sms_notification(
    *,
    to_phone: str,
    message: str,
    wallet_id: str = "",
    external_reference: str = "",
    metadata: Dict[str, Any] | None = None,
) -> Dict[str, str]:
    normalized_phone = _normalize_phone_number(to_phone)
    normalized_message = str(message or "").strip()
    if not normalized_message:
        raise ValueError("message is required")
    return _send_webhook_notification(
        env_prefix="WALLET_SMS",
        required_key="to_phone",
        required_value=normalized_phone,
        extra_payload={
            "message": normalized_message,
            "wallet_id": str(wallet_id or "").strip(),
            "external_reference": str(external_reference or "").strip(),
            "metadata": dict(metadata or {}),
        },
    )


def _send_auth_email_notification(
    *,
    to_email: str,
    subject: str,
    body: str,
    metadata: Dict[str, Any] | None = None,
) -> Dict[str, str]:
    normalized_to_email = str(to_email or "").strip().lower()
    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", normalized_to_email):
        raise ValueError("to_email must be a valid email address")
    return _send_webhook_notification(
        env_prefix="WALLET_AUTH_EMAIL",
        required_key="to_email",
        required_value=normalized_to_email,
        extra_payload={
            "subject": str(subject or "").strip(),
            "body": str(body or ""),
            "from_email": str(os.getenv("WALLET_AUTH_EMAIL_FROM_EMAIL") or "no-reply@211-ai.com").strip(),
            "metadata": dict(metadata or {}),
        },
    )


_MAGIC_LOGIN_CONTEXT = "abby-login-token-v1"
_MAGIC_LOGIN_PARAM = "abbyLogin"
_MAGIC_UCAN_CONTEXT = "abby-magic-ucan-v1"
_MAGIC_UCAN_ISSUER = "did:web:211-ai.com"


def _magic_login_secret() -> str:
    return resolve_secret("WALLET_MAGIC_LOGIN_SECRET", "MAGIC_LOGIN_SECRET").strip()


def _base64url_encode_bytes(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _base64url_decode_to_bytes(value: str) -> bytes:
    padded = str(value or "").strip()
    padded += "=" * (-len(padded) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _hmac_base64url(secret: str, value: str) -> str:
    return _base64url_encode_bytes(hmac.new(secret.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).digest())


def _sign_magic_login_token(payload: Dict[str, Any]) -> str:
    secret = _magic_login_secret()
    if not secret:
        raise RuntimeError("WALLET_MAGIC_LOGIN_SECRET is required for passwordless login")
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_encoded = _base64url_encode_bytes(payload_json)
    signature = _hmac_base64url(secret, f"{_MAGIC_LOGIN_CONTEXT}.{payload_encoded}")
    return f"{payload_encoded}.{signature}"


def _verify_magic_login_token(token: str) -> Dict[str, Any]:
    secret = _magic_login_secret()
    if not secret:
        raise RuntimeError("WALLET_MAGIC_LOGIN_SECRET is required for passwordless login")
    parts = str(token or "").strip().split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("magic link token is malformed")
    payload_encoded, signature = parts
    expected = _hmac_base64url(secret, f"{_MAGIC_LOGIN_CONTEXT}.{payload_encoded}")
    if not hmac.compare_digest(signature, expected):
        raise ValueError("magic link signature is invalid")
    try:
        payload = json.loads(_base64url_decode_to_bytes(payload_encoded).decode("utf-8"))
    except Exception as exc:
        raise ValueError("magic link payload is malformed") from exc
    if not isinstance(payload, dict):
        raise ValueError("magic link payload is malformed")
    if payload.get("v") != 1 or payload.get("portal") not in {"client", "provider"}:
        raise ValueError("magic link payload is malformed")
    contact = str(payload.get("contact") or "").strip()
    nonce = str(payload.get("nonce") or "").strip()
    issued_at = int(payload.get("issuedAt") or 0)
    expires_at = int(payload.get("expiresAt") or 0)
    now_ms = int(time.time() * 1000)
    if not contact or not nonce or not issued_at or not expires_at:
        raise ValueError("magic link payload is malformed")
    if issued_at > now_ms + 5 * 60 * 1000:
        raise ValueError("magic link was issued in the future")
    if expires_at <= now_ms:
        raise ValueError("magic link is expired")
    return payload


def _allowed_magic_login_hosts() -> set[str]:
    raw = str(os.getenv("WALLET_MAGIC_LOGIN_ALLOWED_HOSTS") or "").strip()
    values = raw.split(",") if raw else ["211-ai.com", "www.211-ai.com", "211-ai.github.io", "localhost", "127.0.0.1"]
    return {value.strip().lower() for value in values if value.strip()}


def _magic_login_base_url(requested: str) -> str:
    fallback = str(os.getenv("WALLET_MAGIC_LOGIN_BASE_URL") or "https://211-ai.com/").strip()
    value = str(requested or fallback).strip()
    parsed = urllib_parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be an absolute http(s) URL")
    if str(parsed.hostname or "").lower() not in _allowed_magic_login_hosts():
        raise ValueError("base_url host is not allowed")
    return value


def _build_magic_login_link(*, token: str, base_url: str) -> str:
    parsed = urllib_parse.urlparse(base_url)
    query = dict(urllib_parse.parse_qsl(parsed.query, keep_blank_values=True))
    query[_MAGIC_LOGIN_PARAM] = token
    return urllib_parse.urlunparse(
        parsed._replace(
            query=urllib_parse.urlencode(query),
            fragment=parsed.fragment or "/",
        )
    )


def _magic_login_payload_from_request(request: MagicLoginRequest) -> Dict[str, Any]:
    portal = str(request.portal or "client").strip().lower()
    if portal not in {"client", "provider"}:
        raise ValueError("portal must be client or provider")
    issued_at = int(time.time() * 1000)
    ttl_seconds = int(str(os.getenv("WALLET_MAGIC_LOGIN_TTL_SECONDS") or "600").strip() or "600")
    ttl_seconds = max(60, min(ttl_seconds, 3600))
    return {
        "v": 1,
        "portal": portal,
        "contact": _normalize_login_contact(request.contact),
        "issuedAt": issued_at,
        "expiresAt": issued_at + ttl_seconds * 1000,
        "nonce": secrets.token_urlsafe(18),
        "walletId": str(request.wallet_id or "").strip(),
        "walletApiBaseUrl": str(request.wallet_api_base_url or "").strip(),
        "actorDid": str(request.actor_did or "").strip(),
    }


def _wallet_config_from_magic_payload(payload: Mapping[str, Any]) -> Dict[str, str]:
    wallet_id = str(payload.get("walletId") or "").strip()
    api_base_url = str(payload.get("walletApiBaseUrl") or "").strip()
    actor_did = str(payload.get("actorDid") or "").strip()
    wallet_config: Dict[str, str] = {}
    if wallet_id:
        wallet_config["walletId"] = wallet_id
    if api_base_url:
        wallet_config["apiBaseUrl"] = api_base_url
    if actor_did:
        wallet_config["actorDid"] = actor_did
    return wallet_config


def _magic_contact_subject_did(contact: str) -> str:
    digest = hashlib.sha256(str(contact or "").strip().lower().encode("utf-8")).hexdigest()[:32]
    return f"did:abby:contact:{digest}"


def _magic_ucan_capabilities(wallet_id: str) -> List[Dict[str, str]]:
    wallet = str(wallet_id or "").strip()
    capabilities = [{"with": "wallet://*", "can": "wallet/login"}]
    if wallet:
        resource = f"wallet://{wallet}"
        capabilities.extend(
            [
                {"with": resource, "can": "wallet/recovery/start"},
                {"with": f"{resource}/recovery-bundles/*", "can": "wallet/recovery/read_encrypted"},
                {"with": f"{resource}/records/*", "can": "wallet/encrypted/read"},
            ]
        )
    return capabilities


def _sign_magic_ucan(payload: Dict[str, Any]) -> str:
    secret = _magic_login_secret()
    if not secret:
        raise RuntimeError("WALLET_MAGIC_LOGIN_SECRET is required for passwordless login")
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_encoded = _base64url_encode_bytes(payload_json)
    signature = _hmac_base64url(secret, f"{_MAGIC_UCAN_CONTEXT}.{payload_encoded}")
    return f"{_MAGIC_UCAN_CONTEXT}.{payload_encoded}.{signature}"


def _verify_magic_ucan(token: str) -> Dict[str, Any]:
    secret = _magic_login_secret()
    if not secret:
        raise RuntimeError("WALLET_MAGIC_LOGIN_SECRET is required for passwordless login")
    parts = str(token or "").strip().split(".")
    if len(parts) != 3 or parts[0] != _MAGIC_UCAN_CONTEXT:
        raise ValueError("UCAN token is malformed")
    _, payload_encoded, signature = parts
    expected = _hmac_base64url(secret, f"{_MAGIC_UCAN_CONTEXT}.{payload_encoded}")
    if not hmac.compare_digest(signature, expected):
        raise ValueError("UCAN signature is invalid")
    try:
        payload = json.loads(_base64url_decode_to_bytes(payload_encoded).decode("utf-8"))
    except Exception as exc:
        raise ValueError("UCAN payload is malformed") from exc
    if not isinstance(payload, dict) or payload.get("profile") != _MAGIC_UCAN_CONTEXT:
        raise ValueError("UCAN payload is malformed")
    expires_at = int(payload.get("expiresAt") or 0)
    if not expires_at or expires_at <= int(time.time() * 1000):
        raise ValueError("UCAN token is expired")
    return payload


def _issue_magic_ucan(payload: Mapping[str, Any]) -> Dict[str, Any]:
    contact = str(payload.get("contact") or "").strip()
    wallet_id = str(payload.get("walletId") or "").strip()
    issued_at = int(time.time() * 1000)
    expires_at = min(int(payload.get("expiresAt") or issued_at), issued_at + 15 * 60 * 1000)
    ucan_payload = {
        "profile": _MAGIC_UCAN_CONTEXT,
        "iss": _MAGIC_UCAN_ISSUER,
        "aud": _magic_contact_subject_did(contact),
        "walletId": wallet_id,
        "contactHash": hashlib.sha256(contact.lower().encode("utf-8")).hexdigest(),
        "capabilities": _magic_ucan_capabilities(wallet_id),
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "nonce": secrets.token_urlsafe(18),
        "caveats": {
            "no_plaintext_key_access": True,
            "server_can_decrypt": False,
            "purpose": "passwordless_wallet_login_and_recovery",
        },
    }
    token = _sign_magic_ucan(ucan_payload)
    return {
        "profile": _MAGIC_UCAN_CONTEXT,
        "issuer": ucan_payload["iss"],
        "audience": ucan_payload["aud"],
        "token": token,
        "capabilities": ucan_payload["capabilities"],
        "expires_at": expires_at,
        "caveats": ucan_payload["caveats"],
    }


def _capability_resource_matches(pattern: str, resource: str) -> bool:
    if pattern == "*" or pattern == resource:
        return True
    if pattern.endswith("/*") and resource.startswith(pattern[:-1]):
        return True
    return False


def _require_magic_ucan(
    *,
    authorization: str | None,
    wallet_id: str,
    ability: str,
    resource: str,
) -> Dict[str, Any]:
    token = _extract_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="recovery UCAN authorization required")
    try:
        payload = _verify_magic_ucan(token)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    if str(payload.get("walletId") or "") != str(wallet_id):
        raise HTTPException(status_code=403, detail="UCAN wallet scope does not match")
    capabilities = payload.get("capabilities")
    if not isinstance(capabilities, list):
        raise HTTPException(status_code=403, detail="UCAN has no capabilities")
    for capability in capabilities:
        if not isinstance(capability, Mapping):
            continue
        if str(capability.get("can") or "") != ability:
            continue
        if _capability_resource_matches(str(capability.get("with") or ""), resource):
            return payload
    raise HTTPException(status_code=403, detail="UCAN does not allow this recovery action")


def _send_phone_call_notification(*, to_phone: str, script: str) -> Dict[str, str]:
    normalized_phone = _normalize_phone_number(to_phone)
    normalized_script = str(script or "").strip()
    if not normalized_script:
        raise ValueError("script is required")
    return _send_webhook_notification(
        env_prefix="WALLET_CALL",
        required_key="to_phone",
        required_value=normalized_phone,
        extra_payload={"script": normalized_script},
    )


def create_app(*, service: WalletInterfaceService | None = None):
    """Create the wallet API app.

    The API stays deliberately thin: all authorization, crypto, proofs,
    analytics privacy, and audit behavior remains in `ipfs_datasets_py.wallet`.
    """

    if FastAPI is None:  # pragma: no cover
        raise RuntimeError("FastAPI is required to create the wallet interface API")

    app_service = service or _wallet_interface_service_from_env()
    app = FastAPI(title="211-AI Wallet Interface", version="0.1.0")
    cors_origins = _cors_origins_from_env()
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
            allow_headers=["authorization", "content-type", "x-wallet-ops-shared-secret"],
        )

    @app.get("/health")
    def health() -> Dict[str, Any]:
        warnings = _voice_proxy_runtime_warnings()
        response: Dict[str, Any] = {"status": "ok"}
        if warnings:
            response["warnings"] = warnings
        return response

    @app.post("/auth/magic-link/request")
    def request_magic_login_link(request: MagicLoginRequest) -> Dict[str, Any]:
        try:
            payload = _magic_login_payload_from_request(request)
            token = _sign_magic_login_token(payload)
            magic_link = _build_magic_login_link(token=token, base_url=_magic_login_base_url(request.base_url))
            expires_in_minutes = max(1, math.ceil((int(payload["expiresAt"]) - int(time.time() * 1000)) / 60000))
            metadata = {
                "message_type": "magic_login",
                "portal": payload["portal"],
                "wallet_id": str(payload.get("walletId") or ""),
                "nonce": str(payload.get("nonce") or ""),
            }
            if _is_email_contact(payload["contact"]):
                delivery = _send_auth_email_notification(
                    to_email=payload["contact"],
                    subject="Your 211 AI / Abby sign-in link",
                    body=(
                        "Use this link to sign in to 211 AI / Abby:\n\n"
                        f"{magic_link}\n\n"
                        f"This link expires in {expires_in_minutes} minutes. "
                        "If you did not request it, you can ignore this email."
                    ),
                    metadata=metadata,
                )
                channel = "email"
            else:
                delivery = _send_sms_notification(
                    to_phone=payload["contact"],
                    message=(
                        f"211 AI / Abby login: open {magic_link} "
                        f"This link expires in {expires_in_minutes} minutes. "
                        "Reply HELP for help or STOP to opt out."
                    ),
                    wallet_id=str(payload.get("walletId") or ""),
                    external_reference=str(payload.get("nonce") or ""),
                    metadata=metadata,
                )
                channel = "sms"
            return {
                "status": "sent",
                "channel": channel,
                "expires_at": int(payload["expiresAt"]),
                "wallet_config": _wallet_config_from_magic_payload(payload),
                **delivery,
            }
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/auth/magic-link/verify")
    def verify_magic_login_link(request: MagicLoginVerifyRequest) -> Dict[str, Any]:
        try:
            payload = _verify_magic_login_token(request.token)
            return {
                "valid": True,
                "portal": str(payload["portal"]),
                "contact": str(payload["contact"]),
                "expires_at": int(payload["expiresAt"]),
                "wallet_config": _wallet_config_from_magic_payload(payload),
                "ucan": _issue_magic_ucan(payload),
            }
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

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
            report = app_service.ops_health(verify_storage=verify_storage)
            voice_warning = _publicus_indextts_credential_warning()
            if voice_warning:
                checks = list(report.get("checks") or [])
                checks.append(
                    {
                        "name": "voice_proxy_credentials",
                        "status": "warning",
                        "summary": voice_warning["message"],
                        "details": voice_warning,
                    }
                )
                report["checks"] = checks
                report["check_count"] = len(checks)
                if report.get("status") == "ok":
                    report["status"] = "warning"
            return report
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.get("/ops/voice-proxy/status")
    def ops_voice_proxy_status(
        authorization: str | None = Header(default=None),
        x_wallet_ops_shared_secret: str | None = Header(default=None),
    ) -> Dict[str, Any]:
        expected_secret = _ops_health_shared_secret()
        if expected_secret:
            supplied_secret = _extract_bearer_token(authorization) or str(x_wallet_ops_shared_secret or "").strip()
            if supplied_secret != expected_secret:
                raise HTTPException(status_code=401, detail="ops voice proxy authorization required")

        warnings = _voice_proxy_runtime_warnings()
        status = "warning" if warnings else "ok"
        return {
            "status": status,
            "spaceUrl": _indextts_space_base_url(),
            "apiName": _indextts_api_name(),
            "batchApiName": _indextts_batch_api_name(),
            "modelName": os.getenv("WALLET_INDEXTTS_MODEL_NAME", "Publicus/IndexTTS-2-Demo"),
            "billTo": (
                os.getenv("WALLET_INDEXTTS_HF_BILL_TO")
                or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO")
                or "publicus"
            ).strip() or "publicus",
            "tokenConfigured": bool(_configured_hf_token()),
            "warnings": warnings,
        }

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

    @app.post("/wallets/{wallet_id}/recovery-bundles")
    def store_wallet_recovery_bundle(wallet_id: str, request: WalletRecoveryBundleRequest) -> Dict[str, Any]:
        try:
            bundle = app_service.store_recovery_bundle(
                wallet_id,
                actor_did=request.actor_did,
                encrypted_bundle=request.encrypted_bundle,
                wrapping_method=request.wrapping_method,
                kdf=request.kdf,
                recovery_hint=request.recovery_hint,
                public_metadata=request.public_metadata,
            )
            return {
                "bundle": bundle.to_dict(),
                "privacy": {
                    "server_can_decrypt": False,
                    "plaintext_wallet_key_received": False,
                    "authorization_model": "wallet actor creates encrypted recovery material; magic-login UCAN can only read encrypted bundles",
                },
            }
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/recovery-bundles/latest")
    def get_latest_wallet_recovery_bundle(
        wallet_id: str,
        authorization: str | None = Header(default=None),
    ) -> Dict[str, Any]:
        resource = f"wallet://{wallet_id}/recovery-bundles/latest"
        ucan = _require_magic_ucan(
            authorization=authorization,
            wallet_id=wallet_id,
            ability="wallet/recovery/read_encrypted",
            resource=resource,
        )
        try:
            bundle = app_service.latest_recovery_bundle(wallet_id)
            return {
                "bundle": bundle.to_dict(),
                "ucan": {
                    "profile": str(ucan.get("profile") or ""),
                    "audience": str(ucan.get("aud") or ""),
                    "capabilities": ucan.get("capabilities") or [],
                    "expires_at": int(ucan.get("expiresAt") or 0),
                },
                "privacy": {
                    "server_can_decrypt": False,
                    "plaintext_wallet_key_returned": False,
                },
            }
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/recovery-bundles/{bundle_id}")
    def get_wallet_recovery_bundle(
        wallet_id: str,
        bundle_id: str,
        authorization: str | None = Header(default=None),
    ) -> Dict[str, Any]:
        resource = f"wallet://{wallet_id}/recovery-bundles/{bundle_id}"
        ucan = _require_magic_ucan(
            authorization=authorization,
            wallet_id=wallet_id,
            ability="wallet/recovery/read_encrypted",
            resource=resource,
        )
        try:
            bundle = app_service.get_recovery_bundle(wallet_id, bundle_id)
            return {
                "bundle": bundle.to_dict(),
                "ucan": {
                    "profile": str(ucan.get("profile") or ""),
                    "audience": str(ucan.get("aud") or ""),
                    "capabilities": ucan.get("capabilities") or [],
                    "expires_at": int(ucan.get("expiresAt") or 0),
                },
                "privacy": {
                    "server_can_decrypt": False,
                    "plaintext_wallet_key_returned": False,
                },
            }
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

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

    @app.post("/wallets/{wallet_id}/dead-drops/missing-person")
    def send_missing_person_dead_drop_email(
        wallet_id: str, request: MissingPersonDeadDropEmailRequest
    ) -> Dict[str, Any]:
        try:
            app_service.get_wallet(wallet_id)
            app_service._require_portal_actor(wallet_id, request.actor_did)
        except Exception as exc:
            status_code = 404 if "not found" in str(exc).lower() else 400
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        try:
            to_email = _require_portland_police_missing_email(request.to_email)
            envelope = _send_dead_drop_email(
                to_email=to_email,
                subject=request.subject,
                body=request.body,
                bundle=request.bundle,
                bundle_filename=request.bundle_filename,
            )
            return {
                "wallet_id": wallet_id,
                "status": "sent",
                "to_email": to_email,
                "subject": request.subject,
                "bundle_filename": request.bundle_filename,
                **envelope,
            }
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except urllib_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip() or str(exc)
            raise HTTPException(status_code=502, detail=detail) from exc
        except urllib_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip() or str(exc)
            raise HTTPException(status_code=502, detail=detail) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/dead-drops/missing-person")
    def get_missing_person_dead_drop(wallet_id: str) -> Dict[str, Any]:
        try:
            return app_service.get_missing_person_dead_drop(wallet_id).to_dict()
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.put("/wallets/{wallet_id}/dead-drops/missing-person")
    def save_missing_person_dead_drop(wallet_id: str, request: MissingPersonDeadDropConfigRequest) -> Dict[str, Any]:
        try:
            record = app_service.save_missing_person_dead_drop(
                wallet_id,
                actor_did=request.actor_did,
                enabled=request.enabled,
                to_email=_require_portland_police_missing_email(request.to_email),
                subject=request.subject,
                body=request.body,
                bundle=request.bundle,
                bundle_filename=request.bundle_filename,
                due_at=request.due_at,
                last_check_in_at=request.last_check_in_at,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/dead-drops/missing-person/dispatch")
    def dispatch_missing_person_dead_drop(
        wallet_id: str, request: MissingPersonDeadDropDispatchRequest
    ) -> Dict[str, Any]:
        try:
            record = app_service.get_missing_person_dead_drop_for_dispatch(
                wallet_id,
                actor_did=request.actor_did,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            envelope = _send_dead_drop_email(
                to_email=_require_portland_police_missing_email(record.to_email),
                subject=record.subject,
                body=record.body,
                bundle=record.bundle,
                bundle_filename=record.bundle_filename,
            )
            updated = app_service.mark_missing_person_dead_drop_sent(
                wallet_id,
                actor_did=request.actor_did,
                message_id=str(envelope.get("message_id") or ""),
                dispatched_reason="manual",
            )
            return {
                "wallet_id": wallet_id,
                "status": "sent",
                "to_email": updated.to_email,
                "subject": updated.subject,
                "bundle_filename": updated.bundle_filename,
                **envelope,
            }
        except RuntimeError as exc:
            app_service.mark_missing_person_dead_drop_failed(
                wallet_id,
                actor_did=request.actor_did,
                error=str(exc),
                dispatched_reason="manual",
            )
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:
            app_service.mark_missing_person_dead_drop_failed(
                wallet_id,
                actor_did=request.actor_did,
                error=str(exc),
                dispatched_reason="manual",
            )
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/ops/dead-drops/missing-person/process-due")
    def process_due_missing_person_dead_drops(
        authorization: str | None = Header(default=None),
        x_wallet_ops_shared_secret: str | None = Header(default=None),
    ) -> Dict[str, Any]:
        expected_secret = _ops_health_shared_secret()
        if not expected_secret:
            raise HTTPException(
                status_code=503,
                detail="WALLET_OPS_HEALTH_SHARED_SECRET environment variable is required for due dead-drop processing",
            )
        supplied_secret = _extract_bearer_token(authorization) or str(x_wallet_ops_shared_secret or "").strip()
        if supplied_secret != expected_secret:
            raise HTTPException(status_code=401, detail="dead-drop processing authorization required")
        try:
            due_records = app_service.list_due_missing_person_dead_drops()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        results: List[Dict[str, Any]] = []
        sent = 0
        failed = 0
        for record in due_records:
            try:
                envelope = _send_dead_drop_email(
                    to_email=_require_portland_police_missing_email(record.to_email),
                    subject=record.subject,
                    body=record.body,
                    bundle=record.bundle,
                    bundle_filename=record.bundle_filename,
                )
                app_service.mark_missing_person_dead_drop_sent(
                    record.wallet_id,
                    actor_did=OPS_DEAD_DROP_ACTOR_DID,
                    message_id=str(envelope.get("message_id") or ""),
                    dispatched_reason="due",
                )
                sent += 1
                results.append(
                    {
                        "wallet_id": record.wallet_id,
                        "status": "sent",
                        "message_id": str(envelope.get("message_id") or ""),
                    }
                )
            except Exception as exc:
                failed += 1
                app_service.mark_missing_person_dead_drop_failed(
                    record.wallet_id,
                    actor_did=OPS_DEAD_DROP_ACTOR_DID,
                    error=str(exc),
                    dispatched_reason="due",
                )
                results.append(
                    {
                        "wallet_id": record.wallet_id,
                        "status": "failed",
                        "detail": "dead-drop dispatch failed",
                    }
                )
        return {
            "status": "ok",
            "due_count": len(due_records),
            "sent_count": sent,
            "failed_count": failed,
            "results": results,
        }

    @app.post("/wallets/{wallet_id}/notifications/sms/queue")
    def queue_sms_notification(wallet_id: str, request: SmsNotificationQueueRequest) -> Dict[str, Any]:
        try:
            record = app_service.queue_sms_notification(
                wallet_id,
                actor_did=request.actor_did,
                to_phone=_normalize_phone_number(request.to_phone),
                message=request.message,
                due_at=request.due_at,
                reason=request.reason,
                metadata=request.metadata,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/notifications/sms")
    def list_sms_notifications(wallet_id: str) -> Dict[str, Any]:
        try:
            notifications = app_service.list_sms_notifications(wallet_id)
            return {
                "wallet_id": wallet_id,
                "count": len(notifications),
                "notifications": [record.to_dict() for record in notifications],
            }
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/messages/sms/inbound")
    def list_inbound_sms_messages(wallet_id: str) -> Dict[str, Any]:
        try:
            messages = app_service.list_inbound_sms_messages(wallet_id)
            return {
                "wallet_id": wallet_id,
                "count": len(messages),
                "messages": [record.to_dict() for record in messages],
            }
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/messages/sms/inbound")
    def receive_inbound_sms_message(http_request: Request, payload: InboundSmsForwardRequest) -> Dict[str, Any]:
        try:
            _require_internal_webhook_auth(
                env_prefix="WALLET_SMS_INBOUND",
                authorization=http_request.headers.get("authorization"),
                headers=http_request.headers,
                error_detail="sms inbound authorization required",
            )
            record = app_service.record_inbound_sms_message(
                str(payload.wallet_id or "").strip(),
                actor_did=_sms_inbound_actor_did(),
                from_phone=_normalize_phone_number(payload.from_phone),
                to_phone=_normalize_phone_number(payload.to_phone) if payload.to_phone else "",
                message=payload.message,
                provider=payload.provider,
                status=payload.status,
                provider_message_id=payload.provider_message_id,
                bridge_message_id=payload.message_id,
                external_reference=payload.external_reference,
                received_at=payload.created_at,
                metadata=payload.metadata,
            )
            return {"status": "ok", "message": record.to_dict()}
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/notifications/sms/{notification_id}/dispatch")
    def dispatch_sms_notification(
        wallet_id: str,
        notification_id: str,
        request: SmsNotificationDispatchRequest,
    ) -> Dict[str, Any]:
        try:
            record = app_service.get_sms_notification_for_dispatch(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            delivery = _send_sms_notification(
                to_phone=record.to_phone,
                message=record.message,
                wallet_id=record.wallet_id,
                external_reference=record.notification_id,
                metadata={**dict(record.metadata), "notification_id": record.notification_id, "reason": record.reason},
            )
            updated = app_service.mark_sms_notification_sent(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
                provider_message_id=str(delivery.get("provider_message_id") or ""),
                dispatched_reason="manual",
            )
            return {
                "wallet_id": wallet_id,
                "status": "sent",
                "notification": updated.to_dict(),
                **delivery,
            }
        except RuntimeError as exc:
            app_service.mark_sms_notification_failed(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
                error=str(exc),
                dispatched_reason="manual",
            )
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            app_service.mark_sms_notification_failed(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
                error=str(exc),
                dispatched_reason="manual",
            )
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            app_service.mark_sms_notification_failed(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
                error=str(exc),
                dispatched_reason="manual",
            )
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/ops/notifications/sms/process-due")
    def process_due_sms_notifications(
        authorization: str | None = Header(default=None),
        x_wallet_ops_shared_secret: str | None = Header(default=None),
    ) -> Dict[str, Any]:
        expected_secret = _ops_health_shared_secret()
        if not expected_secret:
            raise HTTPException(
                status_code=503,
                detail="WALLET_OPS_HEALTH_SHARED_SECRET environment variable is required for due SMS processing",
            )
        supplied_secret = _extract_bearer_token(authorization) or str(x_wallet_ops_shared_secret or "").strip()
        if supplied_secret != expected_secret:
            raise HTTPException(status_code=401, detail="sms processing authorization required")
        try:
            due_records = app_service.list_due_sms_notifications()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        results: List[Dict[str, Any]] = []
        sent = 0
        failed = 0
        for record in due_records:
            try:
                delivery = _send_sms_notification(
                    to_phone=record.to_phone,
                    message=record.message,
                    wallet_id=record.wallet_id,
                    external_reference=record.notification_id,
                    metadata={**dict(record.metadata), "notification_id": record.notification_id, "reason": record.reason},
                )
                app_service.mark_sms_notification_sent(
                    record.wallet_id,
                    record.notification_id,
                    actor_did=OPS_DEAD_DROP_ACTOR_DID,
                    provider_message_id=str(delivery.get("provider_message_id") or ""),
                    dispatched_reason="due",
                )
                sent += 1
                results.append(
                    {
                        "wallet_id": record.wallet_id,
                        "notification_id": record.notification_id,
                        "status": "sent",
                        "provider_message_id": str(delivery.get("provider_message_id") or ""),
                    }
                )
            except Exception as exc:
                failed += 1
                app_service.mark_sms_notification_failed(
                    record.wallet_id,
                    record.notification_id,
                    actor_did=OPS_DEAD_DROP_ACTOR_DID,
                    error=str(exc),
                    dispatched_reason="due",
                )
                results.append(
                    {
                        "wallet_id": record.wallet_id,
                        "notification_id": record.notification_id,
                        "status": "failed",
                        "detail": "sms dispatch failed",
                    }
                )
        return {
            "status": "ok",
            "due_count": len(due_records),
            "sent_count": sent,
            "failed_count": failed,
            "results": results,
        }

    @app.post("/wallets/{wallet_id}/notifications/calls/queue")
    def queue_phone_call_notification(wallet_id: str, request: PhoneCallNotificationQueueRequest) -> Dict[str, Any]:
        try:
            record = app_service.queue_phone_call_notification(
                wallet_id,
                actor_did=request.actor_did,
                to_phone=_normalize_phone_number(request.to_phone),
                script=request.script,
                due_at=request.due_at,
                reason=request.reason,
                metadata=request.metadata,
            )
            return record.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/notifications/calls")
    def list_phone_call_notifications(wallet_id: str) -> Dict[str, Any]:
        try:
            notifications = app_service.list_phone_call_notifications(wallet_id)
            return {
                "wallet_id": wallet_id,
                "count": len(notifications),
                "notifications": [record.to_dict() for record in notifications],
            }
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/notifications/calls/{notification_id}/dispatch")
    def dispatch_phone_call_notification(
        wallet_id: str,
        notification_id: str,
        request: PhoneCallNotificationDispatchRequest,
    ) -> Dict[str, Any]:
        try:
            record = app_service.get_phone_call_notification_for_dispatch(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            delivery = _send_phone_call_notification(to_phone=record.to_phone, script=record.script)
            updated = app_service.mark_phone_call_notification_sent(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
                provider_call_id=str(delivery.get("provider_message_id") or ""),
                dispatched_reason="manual",
            )
            return {
                "wallet_id": wallet_id,
                "status": "sent",
                "notification": updated.to_dict(),
                **delivery,
            }
        except RuntimeError as exc:
            app_service.mark_phone_call_notification_failed(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
                error=str(exc),
                dispatched_reason="manual",
            )
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            app_service.mark_phone_call_notification_failed(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
                error=str(exc),
                dispatched_reason="manual",
            )
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            app_service.mark_phone_call_notification_failed(
                wallet_id,
                notification_id,
                actor_did=request.actor_did,
                error=str(exc),
                dispatched_reason="manual",
            )
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/ops/notifications/calls/process-due")
    def process_due_phone_call_notifications(
        authorization: str | None = Header(default=None),
        x_wallet_ops_shared_secret: str | None = Header(default=None),
    ) -> Dict[str, Any]:
        expected_secret = _ops_health_shared_secret()
        if not expected_secret:
            raise HTTPException(
                status_code=503,
                detail="WALLET_OPS_HEALTH_SHARED_SECRET environment variable is required for due call processing",
            )
        supplied_secret = _extract_bearer_token(authorization) or str(x_wallet_ops_shared_secret or "").strip()
        if supplied_secret != expected_secret:
            raise HTTPException(status_code=401, detail="call processing authorization required")
        try:
            due_records = app_service.list_due_phone_call_notifications()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        results: List[Dict[str, Any]] = []
        sent = 0
        failed = 0
        for record in due_records:
            try:
                delivery = _send_phone_call_notification(to_phone=record.to_phone, script=record.script)
                app_service.mark_phone_call_notification_sent(
                    record.wallet_id,
                    record.notification_id,
                    actor_did=OPS_DEAD_DROP_ACTOR_DID,
                    provider_call_id=str(delivery.get("provider_message_id") or ""),
                    dispatched_reason="due",
                )
                sent += 1
                results.append(
                    {
                        "wallet_id": record.wallet_id,
                        "notification_id": record.notification_id,
                        "status": "sent",
                        "provider_call_id": str(delivery.get("provider_message_id") or ""),
                    }
                )
            except Exception as exc:
                failed += 1
                app_service.mark_phone_call_notification_failed(
                    record.wallet_id,
                    record.notification_id,
                    actor_did=OPS_DEAD_DROP_ACTOR_DID,
                    error=str(exc),
                    dispatched_reason="due",
                )
                results.append(
                    {
                        "wallet_id": record.wallet_id,
                        "notification_id": record.notification_id,
                        "status": "failed",
                        "detail": "phone call dispatch failed",
                    }
                )
        return {
            "status": "ok",
            "due_count": len(due_records),
            "sent_count": sent,
            "failed_count": failed,
            "results": results,
        }

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

    @app.post("/wallets/{wallet_id}/records/{record_id}/document-profile-proofs")
    def create_document_profile_proof(
        wallet_id: str,
        record_id: str,
        request: DocumentPrivacyProfileProofRequest,
    ) -> Dict[str, Any]:
        try:
            proof = app_service.create_document_profile_proof(
                wallet_id,
                record_id,
                actor_did=request.actor_did,
                public_inputs=request.public_inputs,
            )
            return proof.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/ai-router/embeddings")
    def proxy_wallet_embeddings_router(
        wallet_id: str,
        request: WalletEmbeddingsRouterRequest,
    ) -> Dict[str, Any]:
        try:
            _require_wallet_router_actor(app_service, wallet_id, request.actor_did)
            wallet_cid = _wallet_router_subject(wallet_id, request.wallet_cid)
            limit = _check_wallet_router_rate_limit(wallet_cid, cost=max(1, len(request.texts) or 1))
            texts = list(request.texts or [])
            if request.text:
                texts.insert(0, request.text)
            if not texts:
                raise ValueError("text or texts is required")
            kwargs = _prepare_hf_router_environment(request.kwargs)
            from ipfs_datasets_py import embeddings_router  # noqa: WPS433

            embeddings = [
                embeddings_router.embed_text(
                    text,
                    model_name=request.model_name,
                    provider=request.provider,
                    **kwargs,
                )
                for text in texts
            ]
            return {
                "router": "embeddings_router",
                "wallet_id": wallet_id,
                "wallet_cid": wallet_cid,
                "provider": request.provider,
                "model_name": request.model_name,
                "rate_limit": limit,
                "embeddings": embeddings,
            }
        except ValueError as exc:
            raise HTTPException(status_code=429 if "rate limit" in str(exc).lower() else 400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/ai-router/llm")
    def proxy_wallet_llm_router(
        wallet_id: str,
        request: WalletLlmRouterRequest,
    ) -> Dict[str, Any]:
        try:
            _require_wallet_router_actor(app_service, wallet_id, request.actor_did)
            wallet_cid = _wallet_router_subject(wallet_id, request.wallet_cid)
            limit = _check_wallet_router_rate_limit(wallet_cid)
            prompt = request.prompt
            if request.system_prompt:
                prompt = f"system: {request.system_prompt}\nuser: {request.prompt}"
            kwargs = _prepare_hf_router_environment(request.kwargs)
            from ipfs_datasets_py import llm_router  # noqa: WPS433

            if request.max_new_tokens is not None:
                kwargs.setdefault("max_new_tokens", request.max_new_tokens)
            model_name = request.model_name or os.getenv("WALLET_AI_ROUTER_LLM_MODEL", "Qwen/Qwen3.5-2B")
            text = llm_router.generate_text(
                prompt,
                model_name=model_name,
                provider=request.provider,
                **kwargs,
            )
            return {
                "router": "llm_router",
                "wallet_id": wallet_id,
                "wallet_cid": wallet_cid,
                "provider": request.provider,
                "model_name": model_name,
                "rate_limit": limit,
                "text": text,
            }
        except ValueError as exc:
            raise HTTPException(status_code=429 if "rate limit" in str(exc).lower() else 400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/ai-router/multimodal")
    def proxy_wallet_multimodal_router(
        wallet_id: str,
        request: WalletMultimodalRouterRequest,
    ) -> Dict[str, Any]:
        try:
            _require_wallet_router_actor(app_service, wallet_id, request.actor_did)
            wallet_cid = _wallet_router_subject(wallet_id, request.wallet_cid)
            limit = _check_wallet_router_rate_limit(wallet_cid)
            kwargs = _prepare_hf_router_environment(request.kwargs)
            from ipfs_datasets_py import multimodal_router  # noqa: WPS433

            if request.max_new_tokens is not None:
                kwargs.setdefault("max_new_tokens", request.max_new_tokens)
            model_name = request.model_name or os.getenv("WALLET_AI_ROUTER_MULTIMODAL_MODEL")
            text = multimodal_router.generate_multimodal_text(
                request.prompt,
                model_name=model_name,
                provider=request.provider,
                image_urls=request.image_urls,
                system_prompt=None,
                additional_text_blocks=request.additional_text_blocks,
                messages=request.messages or None,
                image_detail=request.image_detail,
                **kwargs,
            )
            return {
                "router": "multimodal_router",
                "wallet_id": wallet_id,
                "wallet_cid": wallet_cid,
                "provider": request.provider,
                "model_name": model_name,
                "rate_limit": limit,
                "text": text,
            }
        except ValueError as exc:
            raise HTTPException(status_code=429 if "rate limit" in str(exc).lower() else 400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/voice/indextts/tts")
    def indextts_voice_tts(
        text: str = Form(default=""),
        voice_description: str | None = Form(default=None),
    ) -> Dict[str, Any]:
        try:
            audio = _run_indextts_with_endpoint_retry(
                "tts",
                lambda: _run_indextts_tts_with_batch_fallback(
                    text=text,
                    voice_description=voice_description,
                ),
            )
            return audio
        except Exception as exc:
            raise HTTPException(status_code=503, detail=_indextts_degraded_error_payload(exc, "tts")) from exc

    @app.post("/voice/indextts/batch")
    def indextts_voice_batch(payload: Dict[str, Any] = Body(default_factory=dict)) -> Dict[str, Any]:
        try:
            raw_texts = payload.get("texts") if isinstance(payload, Mapping) else None
            if isinstance(raw_texts, str):
                texts = [raw_texts]
            elif isinstance(raw_texts, Sequence):
                texts = [str(item) for item in raw_texts if str(item or "").strip()]
            else:
                texts = []
            audio = _run_indextts_with_endpoint_retry(
                "batch",
                lambda: _run_indextts_gradio_batch_tts(
                    texts=texts,
                    voice_description=str(payload.get("voice_description") or payload.get("voiceDescription") or "")
                    if isinstance(payload, Mapping)
                    else "",
                ),
            )
            return audio
        except Exception as exc:
            raise HTTPException(status_code=503, detail=_indextts_degraded_error_payload(exc, "batch")) from exc

    @app.post("/voice/indextts/infer")
    async def indextts_voice_infer(
        audio: UploadFile | None = File(default=None),
        mode: str = Form(default=""),
        text: str = Form(default=""),
        systemPrompt: str | None = Form(default=None),
        system_prompt: str | None = Form(default=None),
        userPrompt: str | None = Form(default=None),
        user_prompt: str | None = Form(default=None),
        fallbackText: str | None = Form(default=None),
        fallback_text: str | None = Form(default=None),
        voice_description: str | None = Form(default=None),
    ) -> Dict[str, Any]:
        try:
            reference_audio = await audio.read() if audio is not None else None
            reference_name = getattr(audio, "filename", None) if audio is not None else None
            reference_type = getattr(audio, "content_type", None) if audio is not None else None
            reply_text, generation_latency = _run_indextts_with_endpoint_retry(
                "infer-generate",
                lambda: _generate_indextts_voice_reply_text(
                    mode=mode,
                    text=text,
                    system_prompt=system_prompt or systemPrompt,
                    user_prompt=user_prompt or userPrompt,
                    fallback_text=fallback_text or fallbackText,
                ),
            )
            audio_payload = _run_indextts_with_endpoint_retry(
                "infer",
                lambda: _run_indextts_tts_with_batch_fallback(
                    text=reply_text,
                    voice_description=voice_description,
                    reference_audio=reference_audio,
                    reference_audio_name=reference_name,
                    reference_audio_mime_type=reference_type,
                ),
            )
            audio_payload["text"] = reply_text
            latency = dict(audio_payload.get("latency") or {})
            latency.update(generation_latency)
            audio_payload["latency"] = latency
            return audio_payload
        except Exception as exc:
            raise HTTPException(status_code=503, detail=_indextts_degraded_error_payload(exc, "infer")) from exc

    @app.post("/voice/hf-whisper/stt")
    async def hf_whisper_voice_stt(
        audio: UploadFile | None = File(default=None),
        model_name: str | None = Form(default=None),
        language: str | None = Form(default=None),
    ) -> Dict[str, Any]:
        try:
            audio_bytes = await audio.read() if audio is not None else _silent_wav_bytes()
            audio_name = getattr(audio, "filename", None) if audio is not None else "preflight.wav"
            audio_type = getattr(audio, "content_type", None) if audio is not None else "audio/wav"
            return _run_hf_whisper_stt(
                audio_bytes,
                audio_name=audio_name,
                audio_type=audio_type,
                language=language,
                model_name=model_name,
            )
        except urllib_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip() or str(exc)
            raise HTTPException(status_code=502, detail=detail) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

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

    @app.post("/filecoin-upload")
    async def upload_to_ipfs_bridge(
        request: Request,
        file: UploadFile | None = File(default=None),
        metadata: str | None = Form(default=None),
    ) -> Dict[str, Any]:
        try:
            content_type = request.headers.get("content-type", "")
            if "application/json" in content_type:
                payload = FilecoinRecordUploadRequest(**(await request.json()))
                encrypted_record = app_service.export_record_encrypted_blobs(
                    payload.walletId,
                    payload.recordId,
                    actor_did=payload.actorDid,
                )
                return _publish_encrypted_record_graph_to_ipfs(
                    encrypted_record,
                    file_name=payload.fileName,
                )

            if file is None:
                raise ValueError("multipart uploads require a file field")
            upload_metadata = _parse_upload_metadata(metadata)
            data = await file.read()
            expected_sha256 = str(upload_metadata.get("sha256") or "").strip()
            if expected_sha256:
                actual_sha256 = hashlib.sha256(data).hexdigest()
                if actual_sha256 != expected_sha256:
                    raise ValueError("uploaded file SHA-256 does not match metadata")
            return _publish_bytes_to_ipfs(
                data,
                file_name=str(upload_metadata.get("fileName") or file.filename or "").strip() or None,
                mime_type=str(upload_metadata.get("mimeType") or file.content_type or "").strip() or None,
                source_record_id=str(upload_metadata.get("recordId") or "").strip() or None,
                wallet_id=str(upload_metadata.get("walletId") or "").strip() or None,
            )
        except FilecoinPinHandoffError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/ipfs-proxy/{cid}")
    def proxy_ipfs_cid(cid: str) -> Response:
        normalized_cid = _normalize_ipfs_cid(cid)
        if not _valid_ipfs_cid(normalized_cid):
            raise HTTPException(status_code=400, detail="invalid IPFS CID")
        if not _ipfs_proxy_allows_cid(normalized_cid):
            raise HTTPException(status_code=403, detail="CID is not allowed by WALLET_IPFS_PROXY_ALLOWED_CIDS")
        try:
            payload = get_ipfs_backend().cat(normalized_cid)
        except Exception as local_exc:
            try:
                payload = _fetch_ipfs_cid_via_gateway(normalized_cid)
            except Exception as fallback_exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"Unable to fetch CID from local IPFS or fallback gateways: {local_exc}; {fallback_exc}",
                ) from fallback_exc
        return Response(
            content=payload,
            media_type=_ipfs_proxy_media_type(payload),
            headers={"Cache-Control": "public, max-age=300"},
        )

    @app.get("/filecoin-upload/status/{request_id}")
    def get_filecoin_upload_status(request_id: str) -> Dict[str, Any]:
        try:
            payload = _fetch_filecoin_pin_status(request_id)
            normalized_request_id = str(
                payload.get("requestId") or payload.get("requestid") or request_id
            ).strip()
            if normalized_request_id:
                payload["requestId"] = normalized_request_id
            if isinstance(payload.get("info"), dict) and not isinstance(payload.get("filecoinPinInfo"), dict):
                payload["filecoinPinInfo"] = payload["info"]
            status_url = _filecoin_upload_status_url(request_id)
            if status_url:
                payload["statusUrl"] = status_url
            return payload
        except FilecoinPinHandoffError as exc:
            status_code = 503 if "not configured" in str(exc).lower() else 502
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/records")
    def list_records(wallet_id: str, data_type: str | None = None) -> Dict[str, Any]:
        try:
            records = app_service.list_records(wallet_id, data_type=data_type)
            return {"records": [app_service.record_to_dict(record) for record in records]}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.patch("/wallets/{wallet_id}/records/{record_id}/metadata")
    def update_record_metadata(
        wallet_id: str,
        record_id: str,
        request: WalletRecordMetadataRequest,
    ) -> Dict[str, Any]:
        try:
            record = app_service.update_record_metadata(
                wallet_id,
                record_id,
                actor_did=request.actor_did,
                metadata=request.metadata,
            )
            if _should_publish_record_metadata_ipld(request.metadata):
                metadata_patch = _publish_record_metadata_ipld(record)
                if metadata_patch:
                    record = app_service.update_record_metadata(
                        wallet_id,
                        record_id,
                        actor_did=request.actor_did,
                        metadata=metadata_patch,
                    )
            return record
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.delete("/wallets/{wallet_id}/records/{record_id}")
    def delete_record(
        wallet_id: str,
        record_id: str,
        request: DeleteWalletRecordRequest,
    ) -> Dict[str, Any]:
        try:
            return app_service.delete_record(
                wallet_id,
                record_id,
                actor_did=request.actor_did,
                unpin_ipfs=request.unpin_ipfs,
            )
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

    @app.post("/wallets/{wallet_id}/portal/plans/{plan_id}/share-grants")
    def create_service_plan_share_grant(
        wallet_id: str,
        plan_id: str,
        request: ServicePlanShareGrantRequest,
    ) -> Dict[str, Any]:
        try:
            result = app_service.create_service_plan_share_grant(
                wallet_id,
                plan_id,
                issuer_did=request.actor_did or request.issuer_did,
                audience_did=request.audience_did or request.worker_did,
                scopes=request.scopes,
                purpose=request.purpose,
                worker_recipient_id=request.worker_recipient_id,
                worker_name=request.worker_name,
                expires_at=request.expires_at,
                approval_id=request.approval_id,
                issuer_secret=_key_from_optional_hex(request.issuer_key_hex),
                audience_secret=_key_from_optional_hex(request.audience_key_hex),
                extra_caveats=request.caveats,
            )
            return result.to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/services/{service_doc_id}/share-grants")
    def create_service_share_grant(
        wallet_id: str,
        service_doc_id: str,
        request: ServicePlanShareGrantRequest,
    ) -> Dict[str, Any]:
        try:
            result = app_service.create_service_share_grant(
                wallet_id,
                service_doc_id,
                issuer_did=request.actor_did or request.issuer_did,
                audience_did=request.audience_did or request.worker_did,
                scopes=request.scopes,
                purpose=request.purpose,
                worker_recipient_id=request.worker_recipient_id,
                worker_name=request.worker_name,
                expires_at=request.expires_at,
                approval_id=request.approval_id,
                issuer_secret=_key_from_optional_hex(request.issuer_key_hex),
                audience_secret=_key_from_optional_hex(request.audience_key_hex),
                extra_caveats=request.caveats,
            )
            return result.to_dict()
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

    @app.post("/wallets/{wallet_id}/hmis/lookup-clients")
    def lookup_hmis_clients(wallet_id: str, request: HmisClientLookupRequest) -> Dict[str, Any]:
        try:
            return app_service.lookup_hmis_clients(
                wallet_id,
                actor_did=request.actor_did,
                name=request.name,
                date_of_birth=request.date_of_birth,
                program_ref=request.program_ref,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/hmis/lookup-households")
    def lookup_hmis_households(wallet_id: str, request: HmisHouseholdLookupRequest) -> Dict[str, Any]:
        try:
            return app_service.lookup_hmis_households(
                wallet_id,
                actor_did=request.actor_did,
                name=request.name,
                program_ref=request.program_ref,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/hmis/program-links")
    def list_hmis_program_links(wallet_id: str, request: HmisProgramLinkListRequest) -> Dict[str, Any]:
        try:
            return app_service.list_hmis_program_links(
                wallet_id,
                actor_did=request.actor_did,
                name=request.name,
                program_ref=request.program_ref,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/wallets/{wallet_id}/hmis/referral-drafts")
    def list_hmis_referral_drafts(wallet_id: str, status: str | None = None) -> Dict[str, Any]:
        try:
            return {
                "referral_drafts": [
                    draft.to_dict() for draft in app_service.list_hmis_referral_drafts(wallet_id, status=status)
                ]
            }
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/hmis/referral-drafts")
    def create_hmis_referral_draft(wallet_id: str, request: HmisReferralDraftRequest) -> Dict[str, Any]:
        try:
            return app_service.create_hmis_referral_draft(
                wallet_id,
                actor_did=request.actor_did,
                local_subject_ref=request.local_subject_ref,
                destination_program_ref=request.destination_program_ref,
                service_plan_id=request.service_plan_id,
                service_doc_id=request.service_doc_id,
                provider_name=request.provider_name,
                program_name=request.program_name,
                summary=request.summary,
                eligibility_notes=request.eligibility_notes,
                contact_notes=request.contact_notes,
                source_content_cid=request.source_content_cid,
                source_page_cid=request.source_page_cid,
                metadata=request.metadata,
            ).to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.patch("/wallets/{wallet_id}/hmis/referral-drafts/{referral_draft_id}")
    def update_hmis_referral_draft(
        wallet_id: str,
        referral_draft_id: str,
        request: HmisReferralDraftUpdateRequest,
    ) -> Dict[str, Any]:
        try:
            return app_service.update_hmis_referral_draft(
                wallet_id,
                referral_draft_id,
                actor_did=request.actor_did,
                local_subject_ref=request.local_subject_ref,
                destination_program_ref=request.destination_program_ref,
                service_plan_id=request.service_plan_id,
                service_doc_id=request.service_doc_id,
                provider_name=request.provider_name,
                program_name=request.program_name,
                summary=request.summary,
                eligibility_notes=request.eligibility_notes,
                contact_notes=request.contact_notes,
                source_content_cid=request.source_content_cid,
                source_page_cid=request.source_page_cid,
                metadata=request.metadata,
            ).to_dict()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/hmis/referral-drafts/{referral_draft_id}/validate")
    def validate_hmis_referral_draft(
        wallet_id: str,
        referral_draft_id: str,
        request: HmisReferralDraftValidationRequest,
    ) -> Dict[str, Any]:
        try:
            return app_service.validate_hmis_referral_draft(
                wallet_id,
                referral_draft_id,
                actor_did=request.actor_did,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/wallets/{wallet_id}/hmis/referral-drafts/{referral_draft_id}/submit")
    def submit_hmis_referral_draft(
        wallet_id: str,
        referral_draft_id: str,
        request: HmisReferralDraftSubmitRequest,
    ) -> Dict[str, Any]:
        try:
            return app_service.submit_hmis_referral_draft(
                wallet_id,
                referral_draft_id,
                actor_did=request.actor_did,
            )
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

    @app.post("/wallets/{wallet_id}/records/{record_id}/metadata/generate")
    def generate_wallet_record_metadata(
        wallet_id: str,
        record_id: str,
        request: WalletRecordMetadataGenerationRequest,
    ) -> Dict[str, Any]:
        try:
            wallet_cid = _wallet_router_subject(wallet_id, request.wallet_cid)
            limit = _check_wallet_router_rate_limit(wallet_cid, cost=4)
            actor_secret = _key_from_optional_hex(request.actor_key_hex)
            invocation = invocation_from_token(request.invocation_token) if request.invocation_token else None
            metadata_status = app_service.update_record_metadata(
                wallet_id,
                record_id,
                actor_did=request.actor_did,
                metadata={
                    "privacyProfileMessage": "Creating redacted GraphRAG, vector metadata, and wallet router labels.",
                    "privacyProfileStatus": "profiling",
                    **({"privacyProfileMimeType": request.mime_type} if request.mime_type else {}),
                },
            )

            derived_results: List[Dict[str, Any]] = []
            result_errors: List[str] = []
            for create_result in (
                lambda: app_service.analyze_record_redacted_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation,
                    actor_secret=actor_secret,
                    max_chars=500,
                )
                if invocation
                else app_service.analyze_record_redacted(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    max_chars=500,
                ),
                lambda: app_service.create_document_vector_profile_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation,
                    actor_secret=actor_secret,
                    chunk_size_words=80,
                )
                if invocation
                else app_service.create_document_vector_profile(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    chunk_size_words=80,
                ),
                lambda: app_service.create_redacted_graphrag_with_invocation(
                    wallet_id,
                    [record_id],
                    actor_did=request.actor_did,
                    invocation=invocation,
                    actor_secret=actor_secret,
                    max_chars_per_record=request.max_chars_per_record,
                    max_bytes_per_record=request.max_bytes_per_record,
                    use_ocr=request.use_ocr,
                )
                if invocation
                else app_service.create_redacted_graphrag(
                    wallet_id,
                    [record_id],
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    max_chars_per_record=request.max_chars_per_record,
                    max_bytes_per_record=request.max_bytes_per_record,
                    use_ocr=request.use_ocr,
                ),
                lambda: app_service.extract_record_text_redacted_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation,
                    actor_secret=actor_secret,
                    max_chars=12_000,
                    max_bytes=request.max_bytes_per_record,
                    use_ocr=request.use_ocr,
                )
                if invocation
                else app_service.extract_record_text_redacted(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    max_chars=12_000,
                    max_bytes=request.max_bytes_per_record,
                    use_ocr=request.use_ocr,
                ),
                lambda: app_service.analyze_record_form_redacted_with_invocation(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    invocation=invocation,
                    actor_secret=actor_secret,
                    max_fields=100,
                    use_ocr=request.use_ocr,
                )
                if invocation
                else app_service.analyze_record_form_redacted(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    grant_id=request.grant_id,
                    actor_secret=actor_secret,
                    max_fields=100,
                    use_ocr=request.use_ocr,
                ),
            ):
                try:
                    derived_results.append(create_result())
                except Exception as exc:
                    result_errors.append(str(exc))

            outputs = [_derived_output(result) for result in derived_results if _derived_output(result)]
            if not outputs:
                outputs.append(
                    _fallback_document_profile_output(
                        file_name=request.file_name or record_id,
                        mime_type=request.mime_type or _record_metadata_value(metadata_status, "privacyProfileMimeType") or "application/octet-stream",
                    )
                )
            organizer_profile = _generate_wallet_organizer_profile(
                wallet_id=wallet_id,
                wallet_cid=wallet_cid,
                file_name=request.file_name or _record_metadata_value(metadata_status, "fileName") or record_id,
                mime_type=request.mime_type or _record_metadata_value(metadata_status, "privacyProfileMimeType") or "application/octet-stream",
                outputs=outputs,
                provider=request.provider,
                model_name=request.model_name,
                kwargs=request.kwargs,
            )
            if organizer_profile:
                outputs.append(
                    {
                        "openrouter_organizer_profile": organizer_profile,
                        "output_policy": "redacted_wallet_router_organizer",
                    }
                )
            artifact_ids = [_derived_artifact_id(result) for result in derived_results]
            artifact_ids = [artifact_id for artifact_id in artifact_ids if artifact_id]
            public_inputs = _build_document_profile_public_inputs(
                artifact_ids=artifact_ids,
                file_name=request.file_name or _record_metadata_value(metadata_status, "fileName") or record_id,
                mime_type=request.mime_type or _record_metadata_value(metadata_status, "privacyProfileMimeType") or "application/octet-stream",
                outputs=outputs,
            )
            proof = app_service.create_document_profile_proof(
                wallet_id,
                record_id,
                actor_did=request.actor_did,
                public_inputs=public_inputs,
            )
            metadata_patch = {
                "privacyProfileArtifactIds": artifact_ids,
                "privacyProfileClassification": _classify_document_profile(public_inputs),
                "privacyProfileLabels": _read_string_list(public_inputs.get("organizer_labels")) or _default_labels_for_mime_type(str(public_inputs.get("mime_type") or "")),
                "privacyProfileMessage": "Safe document profile and proof are attached to this wallet record.",
                "privacyProfileMimeType": public_inputs.get("mime_type"),
                "privacyProfileNeedsRefresh": False,
                "privacyProfileProofId": proof.proof_id,
                "privacyProfilePublicInputs": public_inputs,
                "privacyProfileSearchText": _build_privacy_search_text(outputs, public_inputs),
                "privacyProfileStatus": "profiled",
                "privacyProfileSummary": _summarize_document_profile(public_inputs),
                "privacyProfileVectorTerms": _build_privacy_vector_terms(outputs, public_inputs),
                "walletRouterRateLimit": limit,
            }
            if result_errors:
                metadata_patch["privacyProfileWarnings"] = result_errors[:5]
            record = app_service.update_record_metadata(
                wallet_id,
                record_id,
                actor_did=request.actor_did,
                metadata=metadata_patch,
            )
            metadata_ipld_patch = _publish_record_metadata_ipld(record)
            if metadata_ipld_patch:
                record = app_service.update_record_metadata(
                    wallet_id,
                    record_id,
                    actor_did=request.actor_did,
                    metadata=metadata_ipld_patch,
                )
            return {
                "record": record,
                "metadata": record.get("metadata", {}),
                "proof": proof.to_dict(),
                "router": {
                    "wallet_id": wallet_id,
                    "wallet_cid": wallet_cid,
                    "provider": request.provider,
                    "model_name": request.model_name,
                    "rate_limit": limit,
                },
            }
        except ValueError as exc:
            raise HTTPException(status_code=429 if "rate limit" in str(exc).lower() else 400, detail=str(exc)) from exc
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


def _wallet_router_subject(wallet_id: str, wallet_cid: str | None) -> str:
    normalized_cid = _normalize_ipfs_cid(str(wallet_cid or ""))
    if normalized_cid and _valid_ipfs_cid(normalized_cid):
        return normalized_cid
    if str(wallet_cid or "").strip():
        return re.sub(r"[^a-zA-Z0-9:._-]+", "-", str(wallet_cid).strip())[:160]
    return re.sub(r"[^a-zA-Z0-9:._-]+", "-", str(wallet_id or "unknown-wallet").strip())[:160]


def _require_wallet_router_actor(
    app_service: WalletInterfaceService,
    wallet_id: str,
    actor_did: str,
) -> None:
    wallet = app_service.get_wallet(wallet_id)
    actor = str(actor_did or "").strip()
    principals = {
        str(wallet.owner_did),
        *[str(item) for item in getattr(wallet, "controller_dids", [])],
        *[str(item) for item in getattr(wallet, "device_dids", [])],
    }
    if not actor:
        raise ValueError("actor_did is required")
    if actor not in principals:
        raise ValueError("actor_did is not authorized for this wallet")


def _wallet_router_rate_limit_per_minute() -> int:
    try:
        return max(1, int(os.getenv("WALLET_AI_ROUTER_RATE_LIMIT_PER_MINUTE", "30")))
    except Exception:
        return 30


def _wallet_router_rate_limit_per_day() -> int:
    try:
        return max(1, int(os.getenv("WALLET_AI_ROUTER_RATE_LIMIT_PER_DAY", "500")))
    except Exception:
        return 500


def _check_wallet_router_rate_limit(wallet_subject: str, *, cost: int = 1) -> Dict[str, Any]:
    subject = wallet_subject or "unknown-wallet"
    now = time.time()
    minute_window = int(now // 60)
    day_window = int(now // 86400)
    state = _AI_ROUTER_RATE_LIMITS.setdefault(
        subject,
        {"minute_window": minute_window, "minute_count": 0, "day_window": day_window, "day_count": 0},
    )
    if state.get("minute_window") != minute_window:
        state["minute_window"] = minute_window
        state["minute_count"] = 0
    if state.get("day_window") != day_window:
        state["day_window"] = day_window
        state["day_count"] = 0
    per_minute = _wallet_router_rate_limit_per_minute()
    per_day = _wallet_router_rate_limit_per_day()
    next_minute = int(state.get("minute_count") or 0) + max(1, int(cost or 1))
    next_day = int(state.get("day_count") or 0) + max(1, int(cost or 1))
    if next_minute > per_minute:
        raise ValueError(f"wallet router rate limit exceeded for {subject}: {per_minute} requests per minute")
    if next_day > per_day:
        raise ValueError(f"wallet router rate limit exceeded for {subject}: {per_day} requests per day")
    state["minute_count"] = next_minute
    state["day_count"] = next_day
    return {
        "subject": subject,
        "cost": max(1, int(cost or 1)),
        "minuteLimit": per_minute,
        "minuteRemaining": max(0, per_minute - next_minute),
        "dayLimit": per_day,
        "dayRemaining": max(0, per_day - next_day),
    }


def _derived_output(result: Mapping[str, Any]) -> Dict[str, Any]:
    output = result.get("output")
    return dict(output) if isinstance(output, Mapping) else {}


def _derived_artifact_id(result: Mapping[str, Any]) -> str:
    artifact = result.get("artifact")
    if hasattr(artifact, "artifact_id"):
        return str(getattr(artifact, "artifact_id") or "")
    if hasattr(artifact, "id"):
        return str(getattr(artifact, "id") or "")
    if isinstance(artifact, Mapping):
        return str(artifact.get("artifact_id") or artifact.get("id") or "")
    return ""


def _record_metadata_value(record: Mapping[str, Any], key: str) -> str:
    metadata = record.get("metadata")
    if isinstance(metadata, Mapping):
        value = metadata.get(key)
        if isinstance(value, str):
            return value
    return ""


def _safe_short_text(value: Any, *, limit: int = 240) -> str:
    text = str(value or "")
    text = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[email]", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b", "[phone]", text)
    text = re.sub(r"\b\d{4,}\b", "[number]", text)
    return text.strip()[:limit]


def _safe_organizer_signal(output: Mapping[str, Any]) -> Dict[str, Any]:
    signal: Dict[str, Any] = {
        "output_policy": _safe_short_text(output.get("output_policy")),
        "summary": _safe_short_text(output.get("summary")),
        "text": _safe_short_text(output.get("text")),
    }
    profile = output.get("profile")
    if isinstance(profile, Mapping):
        signal["profile"] = {
            key: profile.get(key)
            for key in ("profile_type", "chunk_count")
            if profile.get(key) is not None
        }
    graph = output.get("graph")
    if isinstance(graph, Mapping):
        signal["graph"] = {
            key: graph.get(key)
            for key in ("graph_type", "node_count", "edge_count")
            if graph.get(key) is not None
        }
    return {key: value for key, value in signal.items() if value not in ("", None, {})}


def _redacted_file_name(file_name: str) -> str:
    _, dot, extension = str(file_name or "").rpartition(".")
    return f"document.{extension.lower()}" if dot and extension else "document"


def _generate_wallet_organizer_profile(
    *,
    wallet_id: str,
    wallet_cid: str,
    file_name: str,
    mime_type: str,
    outputs: Sequence[Mapping[str, Any]],
    provider: str | None,
    model_name: str | None,
    kwargs: Mapping[str, Any] | None,
) -> Dict[str, Any] | None:
    safe_signals = [_safe_organizer_signal(output) for output in outputs]
    safe_signals = [signal for signal in safe_signals if signal]
    if not safe_signals:
        return None
    try:
        _check_wallet_router_rate_limit(wallet_cid or wallet_id)
        from ipfs_datasets_py import llm_router  # noqa: WPS433

        prompt = "\n".join(
            [
                "Create privacy-preserving organizer metadata from redacted wallet document signals.",
                "Return only one JSON object with keys: summary, labels, browseHints, riskSignals.",
                "Use generic non-identifying language only.",
                json.dumps(
                    {
                        "fileName": _redacted_file_name(file_name),
                        "mimeType": mime_type,
                        "redactedSignals": safe_signals[:8],
                    },
                    sort_keys=True,
                ),
            ]
        )
        text = llm_router.generate_text(
            prompt,
            model_name=model_name,
            provider=provider or "hf_inference_api",
            **dict(kwargs or {}),
        )
        parsed = _parse_first_json_object(text)
        if not parsed:
            return None
        return {
            "summary": _safe_short_text(parsed.get("summary")),
            "labels": _read_string_list(parsed.get("labels"), limit=8),
            "browseHints": _read_string_list(parsed.get("browseHints"), limit=8),
            "riskSignals": _read_string_list(parsed.get("riskSignals"), limit=8),
            "model": model_name or provider or "wallet-router",
        }
    except Exception:
        return None


def _parse_first_json_object(text: str) -> Dict[str, Any] | None:
    trimmed = str(text or "").strip()
    start = trimmed.find("{")
    end = trimmed.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(trimmed[start : end + 1])
    except Exception:
        return None
    return dict(parsed) if isinstance(parsed, Mapping) else None


def _read_string_list(value: Any, *, limit: int = 12) -> List[str]:
    if not isinstance(value, list):
        return []
    return [_safe_short_text(item, limit=80) for item in value if _safe_short_text(item, limit=80)][:limit]


def _read_number(record: Mapping[str, Any] | None, key: str) -> int | float | None:
    if not isinstance(record, Mapping):
        return None
    value = record.get(key)
    return value if isinstance(value, (int, float)) else None


def _read_string(record: Mapping[str, Any] | None, key: str) -> str:
    if not isinstance(record, Mapping):
        return ""
    value = record.get(key)
    return str(value).strip() if isinstance(value, str) else ""


def _default_labels_for_mime_type(mime_type: str) -> List[str]:
    normalized = str(mime_type or "").lower()
    if normalized == "application/pdf":
        return ["pdf", "document"]
    if normalized.startswith("image/"):
        return ["image", "visual file"]
    if normalized.startswith("text/"):
        return ["text", "document"]
    if "json" in normalized:
        return ["json", "structured data"]
    if "spreadsheet" in normalized or "excel" in normalized or "csv" in normalized:
        return ["spreadsheet", "tabular data"]
    if "wordprocessing" in normalized or "msword" in normalized:
        return ["word document", "document"]
    if normalized.startswith("audio/"):
        return ["audio"]
    if normalized.startswith("video/"):
        return ["video"]
    return ["wallet file"]


def _display_mime_type(mime_type: str) -> str:
    normalized = str(mime_type or "").strip().lower()
    if not normalized:
        return "Unknown file"
    if normalized == "application/pdf":
        return "PDF document"
    if normalized.startswith("image/"):
        return f"{normalized.split('/', 1)[1].upper()} image"
    if normalized.startswith("text/"):
        return "Text document"
    if "json" in normalized:
        return "JSON data"
    if "spreadsheet" in normalized or "excel" in normalized or "csv" in normalized:
        return "Spreadsheet"
    if "wordprocessing" in normalized or "msword" in normalized:
        return "Word document"
    if normalized.startswith("audio/"):
        return "Audio file"
    if normalized.startswith("video/"):
        return "Video file"
    if normalized == "application/octet-stream":
        return "Encrypted/binary file"
    return normalized


def _fallback_document_profile_output(*, file_name: str, mime_type: str) -> Dict[str, Any]:
    return {
        "output_policy": "local_metadata_only",
        "profile": {"chunk_count": 0, "profile_type": "metadata fallback"},
        "summary": f"{_display_mime_type(mime_type)} wallet file queued for redacted profiling.",
        "upload_state": {"fileName": _redacted_file_name(file_name), "mimeType": mime_type},
    }


def _build_document_profile_public_inputs(
    *,
    artifact_ids: Sequence[str],
    file_name: str,
    mime_type: str,
    outputs: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    graphs = [output.get("graph") for output in outputs]
    graph = next((item for item in graphs if isinstance(item, Mapping)), {})
    profiles = [output.get("profile") for output in outputs]
    profile = next((item for item in profiles if isinstance(item, Mapping)), {})
    organizer_profiles = [output.get("openrouter_organizer_profile") for output in outputs]
    organizer = next((item for item in organizer_profiles if isinstance(item, Mapping)), {})
    redaction_count = 0
    for output in outputs:
        counts = output.get("redaction_counts")
        if isinstance(counts, Mapping):
            redaction_count += sum(value for value in counts.values() if isinstance(value, (int, float)))
    public_mime_type = mime_type or "application/octet-stream"
    labels = _read_string_list(organizer.get("labels")) or _default_labels_for_mime_type(public_mime_type)
    return {
        "artifact_ids": list(artifact_ids),
        "chunk_count": _read_number(profile, "chunk_count"),
        "edge_count": _read_number(graph, "edge_count"),
        "file_name_profile": _redacted_file_name(file_name),
        "graph_type": _read_string(graph, "graph_type"),
        "mime_family": public_mime_type.split("/", 1)[0] or "application",
        "mime_type": public_mime_type,
        "node_count": _read_number(graph, "node_count"),
        "openrouter_model": _read_string(organizer, "model"),
        "organizer_labels": labels,
        "organizer_summary": _read_string(organizer, "summary") or _display_mime_type(public_mime_type),
        "output_policies": sorted({str(output.get("output_policy")) for output in outputs if output.get("output_policy")}),
        "privacy_policy": "no_plaintext_public_inputs",
        "profile_methods": sorted({str(output.get("output_policy")) for output in outputs if output.get("output_policy")}),
        "redaction_count": redaction_count,
        "size_bucket": "server-side",
        "summary": "Redacted GraphRAG, vector metadata, and derived descriptors created inside the wallet boundary.",
    }


def _classify_document_profile(public_inputs: Mapping[str, Any]) -> str:
    summary = _read_string(public_inputs, "organizer_summary")
    if summary:
        return summary
    labels = _read_string_list(public_inputs.get("organizer_labels"), limit=3)
    if labels:
        return ", ".join(labels[:3])
    return _display_mime_type(str(public_inputs.get("mime_type") or ""))


def _summarize_document_profile(public_inputs: Mapping[str, Any]) -> str:
    mime_type = str(public_inputs.get("mime_type") or "document")
    graph_type = str(public_inputs.get("graph_type") or "redacted graph")
    nodes = public_inputs.get("node_count")
    chunks = public_inputs.get("chunk_count")
    nodes_text = f"{nodes} nodes" if isinstance(nodes, (int, float)) else "safe graph"
    chunks_text = f"{chunks} chunks" if isinstance(chunks, (int, float)) else "vector metadata"
    return f"{mime_type} · {graph_type} · {nodes_text} · {chunks_text}"


def _build_privacy_search_text(outputs: Sequence[Mapping[str, Any]], public_inputs: Mapping[str, Any]) -> str:
    parts: List[str] = [
        _classify_document_profile(public_inputs),
        _summarize_document_profile(public_inputs),
        " ".join(_read_string_list(public_inputs.get("organizer_labels"), limit=12)),
        " ".join(str(policy) for policy in public_inputs.get("output_policies", []) if isinstance(policy, str)),
    ]
    for output in outputs:
        parts.append(_safe_short_text(output.get("summary")))
        parts.append(_safe_short_text(output.get("text")))
    return " ".join(part for part in parts if part).strip()


def _build_privacy_vector_terms(outputs: Sequence[Mapping[str, Any]], public_inputs: Mapping[str, Any]) -> List[str]:
    terms: List[str] = []
    terms.extend(_read_string_list(public_inputs.get("organizer_labels"), limit=12))
    for key in ("mime_type", "mime_family", "graph_type", "organizer_summary"):
        value = public_inputs.get(key)
        if isinstance(value, str) and value.strip():
            terms.append(value.strip())
    for output in outputs:
        policy = output.get("output_policy")
        if isinstance(policy, str) and policy.strip():
            terms.append(policy.strip())
    normalized: List[str] = []
    seen = set()
    for term in terms:
        safe = _safe_short_text(term, limit=80).lower()
        if safe and safe not in seen:
            normalized.append(safe)
            seen.add(safe)
    return normalized[:24]


def _indextts_space_base_url() -> str:
    override = str(getattr(_INDEXTTS_ACTIVE_SPACE_URL, "value", "") or "").strip().rstrip("/")
    if override:
        return override
    return os.getenv("WALLET_INDEXTTS_SPACE_URL", "https://publicus-indextts-2-demo.hf.space").strip().rstrip("/")


def _indextts_fallback_space_base_url() -> str:
    return os.getenv("WALLET_INDEXTTS_FALLBACK_SPACE_URL", "https://indexteam-indextts-2-demo.hf.space").strip().rstrip("/")


def _indextts_space_base_urls() -> List[str]:
    urls: List[str] = []
    for candidate in (_indextts_space_base_url(), _indextts_fallback_space_base_url()):
        normalized = str(candidate or "").strip().rstrip("/")
        if normalized and normalized not in urls:
            urls.append(normalized)
    return urls


def _indextts_model_name() -> str:
    primary_model = os.getenv("WALLET_INDEXTTS_MODEL_NAME", "Publicus/IndexTTS-2-Demo").strip()
    fallback_model = os.getenv("WALLET_INDEXTTS_FALLBACK_MODEL_NAME", "IndexTeam/IndexTTS-2-Demo").strip()
    active_space = _indextts_space_base_url().strip().rstrip("/")
    if active_space and active_space == _indextts_fallback_space_base_url():
        return fallback_model or primary_model
    return primary_model


def _indextts_api_name() -> str:
    return os.getenv("WALLET_INDEXTTS_API_NAME", "gen_single").strip()


def _indextts_batch_api_name() -> str:
    return os.getenv("WALLET_INDEXTTS_BATCH_API_NAME", "gen_batch").strip()


def _indextts_timeout_seconds() -> float:
    override = getattr(_INDEXTTS_ACTIVE_TIMEOUT_SECONDS, "value", None)
    if override is not None:
        try:
            return max(5.0, float(override))
        except Exception:
            pass
    try:
        return max(5.0, float(os.getenv("WALLET_INDEXTTS_TIMEOUT_SECONDS", "180")))
    except Exception:
        return 180.0


_ADDRESS_DIRECTION_WORDS = {
    "n": "North",
    "s": "South",
    "e": "East",
    "w": "West",
    "ne": "North East",
    "nw": "North West",
    "se": "South East",
    "sw": "South West",
}

_STREET_SUFFIX_WORDS = {
    "aly": "Alley",
    "allee": "Alley",
    "aly.": "Alley",
    "ave": "Avenue",
    "ave.": "Avenue",
    "aven": "Avenue",
    "avenu": "Avenue",
    "avenue": "Avenue",
    "blvd": "Boulevard",
    "blvd.": "Boulevard",
    "boul": "Boulevard",
    "boulevard": "Boulevard",
    "cir": "Circle",
    "cir.": "Circle",
    "circle": "Circle",
    "ct": "Court",
    "ct.": "Court",
    "court": "Court",
    "dr": "Drive",
    "dr.": "Drive",
    "drive": "Drive",
    "hwy": "Highway",
    "hwy.": "Highway",
    "highway": "Highway",
    "ln": "Lane",
    "ln.": "Lane",
    "lane": "Lane",
    "loop": "Loop",
    "pkwy": "Parkway",
    "pkwy.": "Parkway",
    "parkway": "Parkway",
    "pl": "Place",
    "pl.": "Place",
    "place": "Place",
    "rd": "Road",
    "rd.": "Road",
    "road": "Road",
    "st": "Street",
    "st.": "Street",
    "street": "Street",
    "ter": "Terrace",
    "ter.": "Terrace",
    "terrace": "Terrace",
    "trl": "Trail",
    "trl.": "Trail",
    "trail": "Trail",
    "way": "Way",
}

_UNIT_WORDS = {
    "apt": "Apartment",
    "apt.": "Apartment",
    "bldg": "Building",
    "bldg.": "Building",
    "fl": "Floor",
    "fl.": "Floor",
    "ste": "Suite",
    "ste.": "Suite",
    "suite": "Suite",
    "unit": "Unit",
}

_STATE_WORDS = {
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "DC": "District of Columbia",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
}

_OMITTED_VOICE_FIELDS = (
    "source",
    "source url",
    "url",
    "website",
    "link",
    "cid",
    "ipfs cid",
    "hash",
    "bundle hash",
    "record id",
    "schema",
    "metadata",
)


def _number_to_words(value: int) -> str:
    if value < 0 or value > 9999:
        return str(value)
    ones = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ]
    tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
    if value < 20:
        return ones[value]
    if value < 100:
        return tens[value // 10] if value % 10 == 0 else f"{tens[value // 10]} {ones[value % 10]}"
    if value < 1000:
        rest = value % 100
        return f"{ones[value // 100]} hundred" + (f" {_number_to_words(rest)}" if rest else "")
    rest = value % 1000
    return f"{_number_to_words(value // 1000)} thousand" + (f" {_number_to_words(rest)}" if rest else "")


def _ordinal_to_words(value: int) -> str:
    if value <= 0:
        return "zero"
    irregular = {
        1: "first",
        2: "second",
        3: "third",
        4: "fourth",
        5: "fifth",
        6: "sixth",
        7: "seventh",
        8: "eighth",
        9: "ninth",
        10: "tenth",
        11: "eleventh",
        12: "twelfth",
        13: "thirteenth",
        14: "fourteenth",
        15: "fifteenth",
        16: "sixteenth",
        17: "seventeenth",
        18: "eighteenth",
        19: "nineteenth",
    }
    tens_ordinals = {
        20: "twentieth",
        30: "thirtieth",
        40: "fortieth",
        50: "fiftieth",
        60: "sixtieth",
        70: "seventieth",
        80: "eightieth",
        90: "ninetieth",
    }
    if value in irregular:
        return irregular[value]
    if value in tens_ordinals:
        return tens_ordinals[value]
    if value < 100:
        return f"{_number_to_words(value - value % 10)} {_ordinal_to_words(value % 10)}"
    if value < 10000:
        base = _number_to_words(value - value % 100)
        rest = value % 100
        return f"{base} {_ordinal_to_words(rest)}" if rest else f"{base}th"
    return str(value)


def _normalize_direction_token(token: str) -> str:
    compact = re.sub(r"[^A-Za-z]", "", token).lower()
    return _ADDRESS_DIRECTION_WORDS.get(compact, token)


def _normalize_suffix_token(token: str) -> str:
    return _STREET_SUFFIX_WORDS.get(token.lower(), token)


def _digits_to_words(value: str) -> str:
    digit_words = {
        "0": "zero",
        "1": "one",
        "2": "two",
        "3": "three",
        "4": "four",
        "5": "five",
        "6": "six",
        "7": "seven",
        "8": "eight",
        "9": "nine",
    }
    return " ".join(digit_words.get(char, char) for char in value)


def _normalize_zip_codes(text: str) -> str:
    def replace_state_zip(match: re.Match[str]) -> str:
        if match.group("state") != match.group("state").upper():
            return match.group(0)
        state = _STATE_WORDS.get(match.group("state").upper(), match.group("state"))
        zip_code = _digits_to_words(match.group("zip"))
        plus_four = match.group("plus4")
        if plus_four:
            zip_code = f"{zip_code} dash {_digits_to_words(plus_four)}"
        return f"{state} {zip_code}"

    normalized = re.sub(
        r"\b(?P<state>AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+(?P<zip>\d{5})(?:-(?P<plus4>\d{4}))?\b",
        replace_state_zip,
        text,
        flags=re.IGNORECASE,
    )
    direction_pattern = r"(?:N|S|E|W|NE|NW|SE|SW|N\.E\.|N\.W\.|S\.E\.|S\.W\.|North|South|East|West|North East|North West|South East|South West)"
    suffix_pattern = "|".join(sorted((re.escape(value) for value in set(_STREET_SUFFIX_WORDS) | set(_STREET_SUFFIX_WORDS.values())), key=len, reverse=True))
    return re.sub(
        rf"(?<![\d-])(?P<zip>\d{{5}})(?:-(?P<plus4>\d{{4}}))?(?![\d-])(?!(?:\s+(?:{direction_pattern})\b|\s+[A-Z][A-Za-z'.-]+\s+(?:{suffix_pattern})\b))",
        lambda match: (
            f"{_digits_to_words(match.group('zip'))}"
            + (f" dash {_digits_to_words(match.group('plus4'))}" if match.group("plus4") else "")
        ),
        normalized,
    )


def _normalize_address_directions_and_highways(text: str) -> str:
    direction_pattern = r"(?:N|S|E|W|NE|NW|SE|SW|N\.E\.|N\.W\.|S\.E\.|S\.W\.)"
    suffix_pattern = "|".join(sorted((re.escape(value) for value in set(_STREET_SUFFIX_WORDS) | set(_STREET_SUFFIX_WORDS.values())), key=len, reverse=True))

    def replace_numbered_or_named_street(match: re.Match[str]) -> str:
        street = match.group("street")
        numbered = re.fullmatch(r"\d{1,3}(?:st|nd|rd|th)?", street, flags=re.IGNORECASE)
        street_words = _ordinal_to_words(int(re.sub(r"\D", "", street))) if numbered else street
        return (
            f"{match.group('number')} "
            f"{_normalize_direction_token(match.group('direction'))} "
            f"{street_words} "
            f"{_normalize_suffix_token(match.group('suffix'))}"
        )

    normalized = re.sub(
        rf"\b(?P<number>\d{{1,6}})\s+(?P<direction>{direction_pattern})\s+(?P<street>\d{{1,3}}(?:st|nd|rd|th)?|[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){{0,4}})\s+(?P<suffix>{suffix_pattern})\b",
        replace_numbered_or_named_street,
        text,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        rf"\b(?P<number>\d{{1,6}})\s+(?P<direction>{direction_pattern})\s+(?P<street>[A-Z][A-Za-z'.-]+)\b(?=\s+(?:Suite|Room|Floor|Unit|Apartment|Building)\b)",
        lambda match: f"{match.group('number')} {_normalize_direction_token(match.group('direction'))} {match.group('street')}",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        rf"\b(?P<number>\d{{1,6}})\s+(?P<direction>{direction_pattern})\s+(?P<street>[A-Z][A-Za-z'.-]+)\b(?=\s+(?:[A-Z][a-z]+,?\s+)?(?:OR|WA|CA|CO|Oregon|Washington|California|Colorado)\b|$)",
        lambda match: f"{match.group('number')} {_normalize_direction_token(match.group('direction'))} {match.group('street')}",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        rf"\b(?P<suffix>{suffix_pattern})\s+(?P<direction>{direction_pattern})\b",
        lambda match: f"{_normalize_suffix_token(match.group('suffix'))} {_normalize_direction_token(match.group('direction'))}",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r"\bHighway\s+(?P<number>\d{1,3})(?:\s+(?P<direction>N|S|E|W))?\b",
        lambda match: (
            f"Highway {_number_to_words(int(match.group('number')))}"
            + (f" {_normalize_direction_token(match.group('direction'))}" if match.group("direction") else "")
        ),
        normalized,
        flags=re.IGNORECASE,
    )
    return normalized


def _domain_to_spoken_site(url: str) -> str:
    parsed = urllib_parse.urlparse(url if re.match(r"^[a-z][a-z0-9+.-]*://", url, re.IGNORECASE) else f"https://{url}")
    host = (parsed.netloc or parsed.path.split("/", 1)[0]).lower()
    host = host.removeprefix("www.")
    if not host:
        return "the website"
    if host in {"211info.org", "gethelp.211info.org"}:
        return "the two one one info website"
    first_label = host.split(".", 1)[0].replace("-", " ").strip()
    return f"the {first_label} website" if first_label else "the website"


def _strip_unspoken_fields(text: str) -> str:
    spoken = str(text or "")
    omitted_pattern = "|".join(re.escape(field) for field in sorted(_OMITTED_VOICE_FIELDS, key=len, reverse=True))
    spoken = re.sub(
        r"(?i)\b(?:phone|eligibility|address|location|hours|email|website)\s*:\s*[^.;]*(?:not listed|not available|unavailable|not provided)[^.;]*(?=$|[.;])",
        " ",
        spoken,
    )
    spoken = re.sub(
        rf"(?i)(?:^|[\s.;])(?:{omitted_pattern})\s*:\s*(?:https?://\S+|www\.\S+|[^\n.;]+)(?=$|[\n.;])",
        " ",
        spoken,
    )
    spoken = re.sub(
        r"(?i)(?:^|[.!?]\s+)[^.!?]*(?:not listed|not available|unavailable|not provided) in this record[^.!?]*[.!?]?",
        " ",
        spoken,
    )
    return re.sub(r"\s*([.;,])\s*(?:[.;,]\s*)+", r"\1 ", spoken)


def _normalize_urls_for_speech(text: str) -> str:
    url_pattern = r"(?i)\b(?:https?://|www\.)[^\s<>)\]]+|\b[A-Za-z0-9][A-Za-z0-9.-]*\.(?:org|com|gov|net|edu)(?:/[^\s<>)\]]*)?"

    def replace_url(match: re.Match[str]) -> str:
        raw_url = match.group(0).rstrip(".,;:")
        trailing = match.group(0)[len(raw_url) :]
        return f"{_domain_to_spoken_site(raw_url)}{trailing}"

    return re.sub(url_pattern, replace_url, text)


def _strip_scraped_page_chrome(text: str) -> str:
    cleaned = str(text or "")
    cleaned = re.sub(r"(?i)\bEmail\s+(?:\(\d{3}\)\s*)?\d{3}[-.]\d{4}\s+Get Directions\s+Visit Website\s+More Details\s+", " ", cleaned)
    cleaned = re.sub(r"(?i)\b(?:Email|Get Directions|Visit Website|More Details|Print\s*&\s*Share|Print PDF)\b", " ", cleaned)
    cleaned = re.sub(r"\bX\s+Print\s*&\s*Share\b", " ", cleaned)
    cleaned = re.sub(r"\bX\b", " ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def _normalize_phone_numbers(text: str) -> str:
    def replace_phone(match: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        if len(digits) == 11 and digits.startswith("1"):
            digits = digits[1:]
        if len(digits) != 10:
            return match.group(0)
        return f"{_digits_to_words(digits[:3])}, {_digits_to_words(digits[3:6])}, {_digits_to_words(digits[6:])}"

    return re.sub(
        r"(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b",
        replace_phone,
        text,
    )


def _normalize_phone_extensions(text: str) -> str:
    return re.sub(
        r"\b(?:ext\.?|extension|x)\s*#?\s*(?P<extension>\d{1,6})\b",
        lambda match: f"extension {_digits_to_words(match.group('extension'))}",
        text,
        flags=re.IGNORECASE,
    )


def _title_case_program_name(value: str) -> str:
    acronyms = {
        "CAF",
        "DHS",
        "EBT",
        "HIV",
        "HUD",
        "ID",
        "LGBTQ",
        "LGBTQIA",
        "NARA",
        "NW",
        "SNAP",
        "SSDI",
        "SSI",
        "VA",
        "WIC",
    }
    small_words = {"and", "or", "of", "for", "to", "the", "a", "an", "in", "on", "at", "by", "with"}
    tokens = re.split(r"(\s+|-)", value.strip())
    output: list[str] = []
    word_index = 0
    for token in tokens:
        if not token or token.isspace() or token == "-":
            output.append(token)
            continue
        bare = re.sub(r"[^A-Za-z0-9]", "", token)
        if not bare:
            output.append(token)
            continue
        upper = bare.upper()
        lower = token.lower()
        if upper in acronyms:
            replacement = token.replace(bare, upper)
        elif word_index > 0 and lower in small_words:
            replacement = lower
        elif "'" in token:
            replacement = "'".join(part.capitalize() for part in lower.split("'"))
        else:
            replacement = lower.capitalize()
        replacement = replacement.replace("Peerplus", "Peer Plus")
        replacement = replacement.replace("Sbhc", "school based health center")
        replacement = replacement.replace("Chruch", "Church")
        output.append(replacement)
        word_index += 1
    return re.sub(r"\s+and$", "", "".join(output), flags=re.IGNORECASE)


def _normalize_phone_list_prosody(text: str) -> str:
    digit_word = r"(?:zero|one|two|three|four|five|six|seven|eight|nine)"
    phone = rf"{digit_word}(?: {digit_word}){{2}}, {digit_word}(?: {digit_word}){{2}}, {digit_word}(?: {digit_word}){{3}}"

    def replace_pair(match: re.Match[str]) -> str:
        first = match.group("first")
        second = match.group("second")
        second_extension = match.group("second_extension") or ""
        trailing = match.group("trailing")
        if first == second and second_extension:
            return f"You can call {first}, {second_extension}{trailing}"
        return f"You can call {first}. Another number is {second}{second_extension}{trailing}"

    return re.sub(
        rf"\bPhone:\s*(?P<first>{phone}),\s*(?P<second>{phone})(?P<second_extension>\s+extension\s+(?:{digit_word}\s*){{1,6}})?(?P<trailing>[.;])",
        replace_pair,
        text,
        flags=re.IGNORECASE,
    )


def _normalize_address_prosody(text: str) -> str:
    suffix_pattern = "|".join(sorted((re.escape(value) for value in set(_STREET_SUFFIX_WORDS.values())), key=len, reverse=True))
    state_pattern = "|".join(sorted((re.escape(value) for value in set(_STATE_WORDS.values())), key=len, reverse=True))
    normalized = re.sub(
        rf"\b(?P<street>{suffix_pattern})\s+(?P<city>(?!(?:North|South|East|West)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){{0,2}}),?\s+(?P<state>{state_pattern})\b",
        lambda match: f"{match.group('street')}, {match.group('city')}, {match.group('state')}",
        text,
    )
    normalized = re.sub(
        r"\b(?P<street>Street|Avenue|Road|Boulevard|Drive|Lane|Loop|Parkway|Court|Way)\s+(?P<unit>[A-Z])(?P<number>\d{1,4})(?=\s+[A-Z][a-z]+,\s+(?:Oregon|Washington|California|Colorado)\b)",
        lambda match: f"{match.group('street')}, building {match.group('unit')} {_number_to_words(int(match.group('number')))}",
        normalized,
    )
    normalized = re.sub(
        r"\b(?P<label>Suite|Unit|Apartment|Building|Floor)\s+(?P<unit>[A-Za-z0-9-]+)\s+(?=[A-Z][A-Za-z]+,?\s+(?:Oregon|Washington|California|Colorado)\b)",
        lambda match: f"{match.group('label')} {match.group('unit')}, ",
        normalized,
    )
    normalized = re.sub(
        r"\b(?P<street>Street|Avenue|Road|Boulevard|Drive|Lane|Loop|Parkway|Court|Way)\s+(?P<direction>North|South|East|West|North East|North West|South East|South West)\s+(?=[A-Z][a-z]+,?\s+(?:Oregon|Washington|California|Colorado)\b)",
        lambda match: f"{match.group('street')} {match.group('direction')}, ",
        normalized,
    )
    return normalized


def _prefer_primary_voice_contact(text: str) -> str:
    state_pattern = "|".join(sorted((re.escape(value) for value in set(_STATE_WORDS.values())), key=len, reverse=True))
    zip_words = r"(?:zero|one|two|three|four|five|six|seven|eight|nine)(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){4}(?: dash (?:zero|one|two|three|four|five|six|seven|eight|nine)(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){3})?"
    address_stop = re.compile(r",\s+(?=\d{2,6}\s+)")

    def replace_address(match: re.Match[str]) -> str:
        address = match.group("address")
        remainder = match.group("remainder")
        split = address_stop.search(address)
        if not split:
            return match.group(0)
        primary = address[: split.start()].strip(" ,")
        return f"The address is {primary}. There may be more locations in the service details.{remainder}"

    spoken = re.sub(
        rf"The address is (?P<address>.*?\b(?:{state_pattern}) {zip_words})(?P<remainder>\. (?:You can call|Phone number:))",
        replace_address,
        text,
    )
    return spoken


def _normalize_sentence_prosody(text: str) -> str:
    spoken = re.sub(
        r"\bI found (?P<name>[A-Z][A-Z0-9 &'(),/-]{3,})\.",
        lambda match: f"I found {_title_case_program_name(match.group('name'))}.",
        text,
    )
    spoken = re.sub(
        r"\bI found (?P<name>[A-Z][A-Z0-9 &'(),/-]{3,})\s+(?=Phone:|Phone number:|Eligibility:|The address is\b)",
        lambda match: f"I found {_title_case_program_name(match.group('name'))}. ",
        spoken,
    )
    spoken = re.sub(
        r"\bI found (VA [^.]*? Community Resource and Referral Center)\s+VA Community Resource and Referral Center\.",
        r"I found \1.",
        spoken,
    )
    spoken = re.sub(
        r"\bI found Saint (?P<name>[A-Z][A-Z0-9 &'(),/-]{3,})\.",
        lambda match: f"I found Saint {_title_case_program_name(match.group('name'))}.",
        spoken,
    )
    spoken = _normalize_phone_list_prosody(spoken)
    spoken = re.sub(
        r"\bAges?\s+(?P<start>\d{1,3})\s*-\s*(?P<end>\d{1,3})\b",
        lambda match: f"Ages {_number_to_words(int(match.group('start')))} to {_number_to_words(int(match.group('end')))}",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        r"\bage\s+(?P<age>\d{1,3})\b",
        lambda match: f"age {_number_to_words(int(match.group('age')))}",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = _normalize_address_prosody(spoken)
    spoken = _prefer_primary_voice_contact(spoken)
    spoken = spoken.replace("&", "and")
    spoken = re.sub(
        r"\bConfirm details before traveling, since service availability can change\.",
        "Please confirm details before you go, since service availability can change.",
        spoken,
    )
    spoken = re.sub(r"\bPhone:\s*", "You can call ", spoken)
    spoken = re.sub(r"\bPhone number:\s*", "You can call ", spoken)
    spoken = re.sub(r"\bAlternate phone number:\s*", "Another number is ", spoken)
    spoken = re.sub(r"\bAges ([^.]+?) All other\b", r"Ages \1. Other eligibility rules may apply", spoken)
    spoken = re.sub(r"\bI found Need Help Finding Child Care\?\s*Call two one one\.", "For help finding child care, call two one one.", spoken)
    spoken = re.sub(r"\bEligibility:\s*Unrestricted\.\s*anyone\b", "Eligibility: anyone", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*Unrestricted[.;]\s*Varies by program\.", "Eligibility varies by program.", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*(?P<body>[^.]+?\.)\s*Unrestricted[.;]", r"Eligibility: \g<body>", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*Unrestricted[.;]", "Eligibility is unrestricted.", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*None\.\s*", "Eligibility: ", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bEligibility:\s*", "Eligibility: ", spoken)
    spoken = re.sub(r"\bEligibility:\s*Individuals and families with minor children in substance use disorder recovery\.", "Eligibility: individuals and families with minor children who are in substance use disorder recovery.", spoken)
    spoken = re.sub(r"\bFPL\b", "federal poverty level", spoken)
    spoken = re.sub(r"\bFederal Poverty Level\b", "federal poverty level", spoken)
    spoken = re.sub(r"\s*\(federal poverty level\)", "", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bFamiles\b", "Families", spoken)
    spoken = re.sub(r"\s+(Veteran must\b)", r". \1", spoken)
    spoken = re.sub(r"\s+(Any discharge\b)", r". \1", spoken)
    spoken = re.sub(r"\s+(Household must\b)", r". \1", spoken)
    spoken = re.sub(r"\s+(Documentation may\b)", r". \1", spoken)
    spoken = re.sub(
        r"\bschool based health center\s+School Based Health Center\b",
        "school-based health center",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(r"\bschool based health center\b", "school-based health center", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"\bMen'S\b", "Men's", spoken)
    spoken = re.sub(r"\s*;\s*", ". ", spoken)
    spoken = _shorten_long_eligibility_for_voice(spoken)
    state_pattern = "|".join(sorted((re.escape(value) for value in set(_STATE_WORDS.values())), key=len, reverse=True))
    zip_words = r"(?:zero|one|two|three|four|five|six|seven|eight|nine)(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){4}(?: dash (?:zero|one|two|three|four|five|six|seven|eight|nine)(?: (?:zero|one|two|three|four|five|six|seven|eight|nine)){3})?"
    spoken = re.sub(rf"\b(?P<state>{state_pattern}) (?P<zip>{zip_words})\b", r"\g<state>. ZIP code \g<zip>", spoken)
    spoken = re.sub(r"\s+([.,;:!?])", r"\1", spoken)
    return re.sub(r"([.!?])\s*(?=(?:You can call|Another number|Eligibility|Please confirm)\b)", r"\1 ", spoken)


def _shorten_long_eligibility_for_voice(text: str) -> str:
    match = re.search(r"\bEligibility(?: is|:)\s+(?P<body>.*?)(?=\s+Before traveling\b|$)", text)
    if not match:
        return text
    body = match.group("body").strip()
    if len(body) <= 220:
        return text
    first_clause = re.split(r"(?<=[.!?])\s+|(?:\s+[A-Z][a-z]+:)", body, maxsplit=1)[0].strip()
    if len(first_clause) > 180:
        first_clause = first_clause[:180].rsplit(" ", 1)[0].strip() + "."
    replacement = f"Eligibility: {first_clause} More eligibility details may be in the service details."
    return f"{text[:match.start()]}{replacement}{text[match.end():]}"


def _normalize_percentages_and_currency(text: str) -> str:
    def numberish_to_words(value: str) -> str:
        if "." in value:
            left, right = value.split(".", 1)
            return f"{_number_to_words(int(left))} point {_digits_to_words(right)}"
        return _number_to_words(int(value))

    normalized = re.sub(
        r"\b(?P<start>\d{1,3})(?:\.\d+)?\s*-\s*(?P<end>\d{1,3}(?:\.\d+)?)%",
        lambda match: f"{numberish_to_words(match.group('start'))} to {numberish_to_words(match.group('end'))} percent",
        text,
    )
    normalized = re.sub(
        r"\b(?P<value>\d{1,3}(?:\.\d+)?)%",
        lambda match: f"{numberish_to_words(match.group('value'))} percent",
        normalized,
    )
    return re.sub(
        r"\$(?P<amount>\d{1,4})(?:\.(?P<cents>\d{2}))?",
        lambda match: (
            f"{_number_to_words(int(match.group('amount')))} dollars"
            + (f" and {_number_to_words(int(match.group('cents')))} cents" if match.group("cents") else "")
        ),
        normalized,
    )


def _normalize_hours_and_separators(text: str) -> str:
    day_names = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
    text = re.sub(r"\s*[-–]\s*211info\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*\*\s*", " for ", text)
    text = re.sub(r"\s+/\s+", ", ", text)
    normalized = re.sub(rf"\b({day_names})(?:/({day_names}))+\b", lambda match: match.group(0).replace("/", ", "), text)
    normalized = re.sub(r"\b([A-Za-z]+)/([A-Za-z]+)\b", r"\1 and \2", normalized)
    normalized = re.sub(r"(?m)(^|\s)-(?=[A-Za-z])", r"\1", normalized)
    normalized = re.sub(r"\s+-\s*", " to ", normalized)
    normalized = re.sub(r"(?<=\d)(am|pm)\b", lambda match: f" {match.group(1).upper()}", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"(?<=\b(?:AM|PM))\s*-\s*(?=\d)", " to ", normalized)
    normalized = re.sub(r"\b9/11\b", "September eleventh", normalized)
    return normalized


def _strip_coordinates(text: str) -> str:
    if re.fullmatch(r"\s*-?\d{1,3}\.\d{3,}\s*", str(text or "")):
        return ""
    cleaned = re.sub(r"(?i)\b(?:lat(?:itude)?|lon(?:gitude)?|lng)\s*[:=]?\s*-?\d+(?:\.\d+)?", " ", text)
    cleaned = re.sub(r"\b-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b", " ", cleaned)
    return cleaned


def _normalize_record_list_sentence(text: str) -> str:
    direction_pattern = r"(?:N|S|E|W|NE|NW|SE|SW|N\.E\.|N\.W\.|S\.E\.|S\.W\.)"
    suffix_pattern = "|".join(sorted((re.escape(key) for key in _STREET_SUFFIX_WORDS), key=len, reverse=True))
    address_start = re.compile(
        rf"\b\d{{1,6}}\s+(?:(?:{direction_pattern})\s+)?(?:\d{{1,3}}(?:st|nd|rd|th)?|[A-Za-z][A-Za-z'.-]+)\s+(?:{suffix_pattern})\b",
        re.IGNORECASE,
    )

    def replace_record_list(match: re.Match[str]) -> str:
        listed = _strip_coordinates(match.group("listed"))
        if re.search(r"(?i)\b(?:not listed|not available|unavailable|not provided)\b", listed):
            return " "
        listed = re.sub(r"(?i)\b\d+\s*(?:minute|minutes|min|mins)\b\.?\s*", " ", listed)
        listed = re.sub(r"\s+", " ", listed).strip(" ;,.")
        address_match = address_start.search(listed)
        if address_match:
            listed = listed[address_match.start() :].strip(" ;,.")
        if not listed:
            return " "
        return f"The address is {listed}."

    return re.sub(
        r"(?i)\bThe record lists\s+(?P<listed>.*?)(?=\s+(?:Phone|Eligibility|Source|Confirm)\s*:| Confirm\b|$)",
        replace_record_list,
        text,
    )


def _normalize_indextts_spoken_text(text: str) -> str:
    spoken = _strip_scraped_page_chrome(text)
    spoken = _strip_unspoken_fields(spoken)
    spoken = _strip_coordinates(spoken)
    spoken = _normalize_record_list_sentence(spoken)
    spoken = _normalize_urls_for_speech(spoken)
    spoken = _normalize_phone_numbers(spoken)
    spoken = _normalize_phone_extensions(spoken)
    spoken = _normalize_percentages_and_currency(spoken)
    spoken = _normalize_hours_and_separators(spoken)
    spoken = re.sub(r"\bST\s+(?=[A-Z])", "Saint ", spoken)
    spoken = re.sub(r"(?i)\ba grounded\s+211\s+match\s+is\b", "I found", spoken)
    spoken = re.sub(r"(?i)\ba grounded\s+two one one\s+match\s+is\b", "I found", spoken)
    spoken = re.sub(r"(?i)\bgrounded detail\b", "detail", spoken)
    spoken = re.sub(r"(?i)\b211[\s-]?ai\b", "two one one AI", spoken)
    spoken = re.sub(r"(?i)\b211[\s-]?info\b", "two one one info", spoken)
    spoken = re.sub(r"(?<!\d)911(?!\d)", "nine one one", spoken)
    spoken = re.sub(r"(?<!\d)211(?!\d)", "two one one", spoken)
    spoken = re.sub(r"\b(?P<tens>\d)\s+(?P<ones>\d)(?P<suffix>st|nd|rd|th)\b", r"\g<tens>\g<ones>\g<suffix>", spoken, flags=re.IGNORECASE)

    direction_pattern = r"(?:N|S|E|W|NE|NW|SE|SW|N\.E\.|N\.W\.|S\.E\.|S\.W\.)"
    suffix_pattern = "|".join(sorted((re.escape(key) for key in _STREET_SUFFIX_WORDS), key=len, reverse=True))

    spoken = re.sub(
        rf"\b(?P<direction>{direction_pattern})\s+(?P<number>\d{{1,3}})(?:st|nd|rd|th)?\s+(?P<suffix>{suffix_pattern})\b",
        lambda match: (
            f"{_normalize_direction_token(match.group('direction'))} "
            f"{_ordinal_to_words(int(match.group('number')))} "
            f"{_normalize_suffix_token(match.group('suffix'))}"
        ),
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        rf"\b(?P<number>\d{{1,3}})(?:st|nd|rd|th)?\s+(?P<suffix>{suffix_pattern})\b",
        lambda match: f"{match.group('number')} {_normalize_suffix_token(match.group('suffix'))}"
        if match.group("suffix").lower().rstrip(".") in {"hwy", "highway"}
        else f"{_ordinal_to_words(int(match.group('number')))} {_normalize_suffix_token(match.group('suffix'))}",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        rf"\b(?P<direction>{direction_pattern})\b(?=\s+\d)",
        lambda match: _normalize_direction_token(match.group("direction")),
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = _normalize_address_directions_and_highways(spoken)
    spoken = re.sub(
        rf"\b(?P<suffix>{suffix_pattern})\b",
        lambda match: match.group("suffix")
        if match.group("suffix").isupper()
        else _normalize_suffix_token(match.group("suffix")),
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        r"\b(?P<label>apt\.?|ste\.?|suite|unit|bldg\.?|fl\.?)\s+#?\s*(?P<unit>[A-Za-z0-9-]+)\b",
        lambda match: f"{_UNIT_WORDS.get(match.group('label').lower(), match.group('label'))} {match.group('unit')}",
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = re.sub(
        r"\b(?P<number>\d{1,3})(?:st|nd|rd|th)\b",
        lambda match: match.group(0)
        if re.search(r"(?:Suite|Room|Floor|Unit|Building|Apartment)\s+$", spoken[max(0, match.start() - 24) : match.start()], re.IGNORECASE)
        else _ordinal_to_words(int(match.group("number"))),
        spoken,
        flags=re.IGNORECASE,
    )
    spoken = _normalize_zip_codes(spoken)
    spoken = _normalize_sentence_prosody(spoken)
    spoken = re.sub(r"\s+([.,;:!?])", r"\1", spoken)
    spoken = re.sub(r"(?:\.\s*){2,}", ". ", spoken)
    spoken = re.sub(r"\s+", " ", spoken).strip(" ;,")
    return spoken.lstrip(".,; ")


def _indextts_headers(*, accept: str = "application/json") -> Dict[str, str]:
    headers = {"Accept": accept}
    token = (
        resolve_secret(
            "WALLET_INDEXTTS_HF_TOKEN",
            "HF_TOKEN",
            "HUGGINGFACEHUB_API_TOKEN",
            "IPFS_DATASETS_PY_HF_API_TOKEN",
            "HUGGINGFACE_API_TOKEN",
            "HUGGINGFACE_HUB_TOKEN",
        )
        or ""
    ).strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    bill_to = (
        os.getenv("WALLET_INDEXTTS_HF_BILL_TO")
        or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO")
        or "publicus"
    ).strip()
    if bill_to:
        headers["X-HF-Bill-To"] = bill_to
    return headers


def _configured_hf_token() -> str:
    return (
        resolve_secret(
            "WALLET_INDEXTTS_HF_TOKEN",
            "HF_TOKEN",
            "HUGGINGFACEHUB_API_TOKEN",
            "IPFS_DATASETS_PY_HF_API_TOKEN",
            "HUGGINGFACE_API_TOKEN",
            "HUGGINGFACE_HUB_TOKEN",
        )
        or ""
    ).strip()


def _publicus_indextts_credential_warning() -> Dict[str, Any] | None:
    space_url = _indextts_space_base_url().lower()
    if "publicus-indextts" not in space_url and "publicus/indextts" not in (os.getenv("WALLET_INDEXTTS_MODEL_NAME", "").lower()):
        return None
    token_present = bool(_configured_hf_token())
    if token_present:
        return None
    bill_to = (
        os.getenv("WALLET_INDEXTTS_HF_BILL_TO")
        or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO")
        or "publicus"
    ).strip() or "publicus"
    return {
        "code": "publicus_indextts_missing_hf_token",
        "message": (
            "Publicus IndexTTS is configured without a Hugging Face token. "
            "Set WALLET_INDEXTTS_HF_TOKEN or HF_TOKEN and keep X-HF-Bill-To set to the Publicus account."
        ),
        "spaceUrl": _indextts_space_base_url(),
        "modelName": os.getenv("WALLET_INDEXTTS_MODEL_NAME", "Publicus/IndexTTS-2-Demo"),
        "billTo": bill_to,
        "envVars": ["WALLET_INDEXTTS_HF_TOKEN", "HF_TOKEN", "WALLET_INDEXTTS_HF_BILL_TO"],
    }


def _voice_proxy_runtime_warnings() -> List[Dict[str, Any]]:
    warnings: List[Dict[str, Any]] = []
    publicus_warning = _publicus_indextts_credential_warning()
    if publicus_warning:
        warnings.append(publicus_warning)
    return warnings


def _http_json(method: str, url: str, payload: Mapping[str, Any] | None = None) -> Dict[str, Any]:
    data = None
    headers = _indextts_headers()
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib_request.Request(url, data=data, headers=headers, method=method)
    with urllib_request.urlopen(request, timeout=_indextts_timeout_seconds()) as response:
        raw = response.read()
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError(f"{url} did not return a JSON object")
    return parsed


def _http_bytes(url: str) -> tuple[bytes, str]:
    request = urllib_request.Request(url, headers=_indextts_headers(accept="audio/*, application/octet-stream"))
    with urllib_request.urlopen(request, timeout=_indextts_timeout_seconds()) as response:
        return response.read(), response.headers.get("Content-Type") or "audio/wav"


_INDEXTTS_CACHE_LOCK = threading.Lock()
_INDEXTTS_CONFIG_CACHE: Dict[tuple[str, str], Dict[str, Any]] = {}
_INDEXTTS_FN_INDEX_CACHE: Dict[tuple[str, str], int] = {}
_INDEXTTS_REFERENCE_CACHE: Dict[tuple[str, str], Dict[str, Any]] = {}


def _voice_llm_timeout_seconds() -> float:
    try:
        return max(5.0, float(os.getenv("WALLET_VOICE_LLM_TIMEOUT_SECONDS", "20")))
    except Exception:
        return 20.0


def _clean_voice_reply_text(text: str, *, prompt: str = "", fallback_text: str = "") -> str:
    cleaned = str(text or "").strip()
    prompt = str(prompt or "").strip()
    if prompt and cleaned.startswith(prompt):
        cleaned = cleaned[len(prompt) :].strip()
    for marker in ("Assistant:", "Abby:", "Response:", "Answer:"):
        index = cleaned.rfind(marker)
        if index >= 0:
            cleaned = cleaned[index + len(marker) :].strip()
            break
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        cleaned = str(fallback_text or "").strip()
    max_chars = 520
    if len(cleaned) > max_chars:
        trimmed = cleaned[:max_chars].rsplit(" ", 1)[0].strip()
        cleaned = trimmed or cleaned[:max_chars].strip()
    return cleaned


def _generate_indextts_voice_reply_text(
    *,
    mode: str,
    text: str,
    system_prompt: str | None,
    user_prompt: str | None,
    fallback_text: str | None,
) -> tuple[str, Dict[str, Any]]:
    timings: Dict[str, Any] = {}
    fallback = str(fallback_text or "").strip()
    prompt = str(text or "").strip()
    if str(mode or "").strip().lower() != "voice-reply":
        reply_text = prompt or fallback
        if not reply_text:
            raise ValueError("text is required")
        return reply_text, timings

    user_text = str(user_prompt or "").strip()
    system_text = str(system_prompt or "").strip()
    if not prompt:
        prompt = "\n\n".join(part for part in (system_text, f"Caller request: {user_text}" if user_text else "") if part)
    if not prompt:
        raise ValueError("text or user_prompt is required")

    llm_start = time.perf_counter()
    try:
        kwargs = _prepare_hf_router_environment(
            {
                "max_new_tokens": int(os.getenv("WALLET_VOICE_LLM_MAX_NEW_TOKENS", "120")),
                "temperature": float(os.getenv("WALLET_VOICE_LLM_TEMPERATURE", "0.2")),
                "timeout": _voice_llm_timeout_seconds(),
            }
        )
        from ipfs_datasets_py import llm_router  # noqa: WPS433

        provider = os.getenv("WALLET_VOICE_LLM_PROVIDER", "hf_inference_api").strip() or "hf_inference_api"
        model_name = (
            os.getenv("WALLET_VOICE_LLM_MODEL")
            or os.getenv("WALLET_AI_ROUTER_LLM_MODEL")
            or "Qwen/Qwen3.5-2B"
        ).strip()
        generated = llm_router.generate_text(
            prompt,
            model_name=model_name,
            provider=provider,
            **kwargs,
        )
        timings["llm_request_ms"] = max(0, int((time.perf_counter() - llm_start) * 1000))
        timings["llm_provider"] = provider
        timings["llm_model"] = model_name
        return _clean_voice_reply_text(generated, prompt=prompt, fallback_text=fallback), timings
    except Exception as exc:
        timings["llm_request_ms"] = max(0, int((time.perf_counter() - llm_start) * 1000))
        timings["llm_error"] = str(exc)[:240]
        if fallback:
            return fallback, timings
        raise


def _indextts_cache_ttl_seconds() -> float:
    try:
        return max(0.0, float(os.getenv("WALLET_INDEXTTS_CACHE_TTL_SECONDS", "3600")))
    except Exception:
        return 3600.0


_INDEXTTS_SPACE_CLIENT: HFSpaceClient | None = None
_INDEXTTS_SPACE_CLIENT_KEY = ""
_INDEXTTS_ACTIVE_SPACE_URL = threading.local()
_INDEXTTS_ACTIVE_TIMEOUT_SECONDS = threading.local()
_INDEXTTS_FAST_FAIL_MODE = threading.local()
_INDEXTTS_FORCE_REQUIRE_BATCH = threading.local()


@contextmanager
def _indextts_use_space_base_url(base_url: str):
    previous = getattr(_INDEXTTS_ACTIVE_SPACE_URL, "value", None)
    _INDEXTTS_ACTIVE_SPACE_URL.value = str(base_url or "").strip().rstrip("/")
    try:
        yield
    finally:
        if previous is None:
            try:
                delattr(_INDEXTTS_ACTIVE_SPACE_URL, "value")
            except AttributeError:
                pass
        else:
            _INDEXTTS_ACTIVE_SPACE_URL.value = previous


@contextmanager
def _indextts_use_timeout_seconds(seconds: float | None):
    previous = getattr(_INDEXTTS_ACTIVE_TIMEOUT_SECONDS, "value", None)
    _INDEXTTS_ACTIVE_TIMEOUT_SECONDS.value = None if seconds is None else float(seconds)
    try:
        yield
    finally:
        if previous is None:
            try:
                delattr(_INDEXTTS_ACTIVE_TIMEOUT_SECONDS, "value")
            except AttributeError:
                pass
        else:
            _INDEXTTS_ACTIVE_TIMEOUT_SECONDS.value = previous


def _indextts_attempt_timeout_seconds(space_index: int, total_spaces: int) -> float:
    default_timeout = _indextts_timeout_seconds()
    if total_spaces > 1 and space_index == 0:
        return min(default_timeout, 20.0)
    if total_spaces > 1 and space_index == total_spaces - 1:
        return min(default_timeout, 45.0)
    return default_timeout


def _indextts_degraded_fast_fail_enabled() -> bool:
    value = str(os.getenv("WALLET_INDEXTTS_DEGRADED_FAST_FAIL", "true")).strip().lower()
    return value in {"1", "true", "yes", "on"}


@contextmanager
def _indextts_fast_fail_mode(enabled: bool):
    previous = getattr(_INDEXTTS_FAST_FAIL_MODE, "value", False)
    _INDEXTTS_FAST_FAIL_MODE.value = bool(enabled)
    try:
        yield
    finally:
        _INDEXTTS_FAST_FAIL_MODE.value = previous


def _indextts_is_fast_fail_mode() -> bool:
    return bool(getattr(_INDEXTTS_FAST_FAIL_MODE, "value", False))


@contextmanager
def _indextts_force_require_batch(enabled: bool):
    previous = getattr(_INDEXTTS_FORCE_REQUIRE_BATCH, "value", False)
    _INDEXTTS_FORCE_REQUIRE_BATCH.value = bool(enabled)
    try:
        yield
    finally:
        _INDEXTTS_FORCE_REQUIRE_BATCH.value = previous


def _indextts_require_batch_mode() -> bool:
    if bool(getattr(_INDEXTTS_FORCE_REQUIRE_BATCH, "value", False)):
        return True
    return str(os.getenv("WALLET_INDEXTTS_REQUIRE_BATCH", "")).strip().lower() in {"1", "true", "yes"}


def _indextts_space_client() -> HFSpaceClient:
    global _INDEXTTS_SPACE_CLIENT
    global _INDEXTTS_SPACE_CLIENT_KEY
    cache_key = "|".join(
        [
            _indextts_space_base_url(),
            str(_indextts_timeout_seconds()),
            os.getenv("WALLET_INDEXTTS_API_NAME", ""),
            os.getenv("WALLET_INDEXTTS_BATCH_API_NAME", ""),
            os.getenv("WALLET_INDEXTTS_HF_BILL_TO", ""),
            os.getenv("IPFS_DATASETS_PY_HF_BILL_TO", ""),
            os.getenv("HF_TOKEN", ""),
            os.getenv("HUGGINGFACEHUB_API_TOKEN", ""),
            os.getenv("IPFS_DATASETS_PY_HF_API_TOKEN", ""),
        ]
    )
    if _INDEXTTS_SPACE_CLIENT is not None and cache_key == _INDEXTTS_SPACE_CLIENT_KEY:
        return _INDEXTTS_SPACE_CLIENT
    _INDEXTTS_SPACE_CLIENT = HFSpaceClient(
        _indextts_space_base_url(),
        timeout_seconds=_indextts_timeout_seconds(),
        headers_factory=lambda: _indextts_headers(),
    )
    _INDEXTTS_SPACE_CLIENT_KEY = cache_key
    return _INDEXTTS_SPACE_CLIENT


def _indextts_config() -> Dict[str, Any]:
    cache_key = (_indextts_space_base_url(), _indextts_api_name())
    now = time.time()
    with _INDEXTTS_CACHE_LOCK:
        cached = _INDEXTTS_CONFIG_CACHE.get(cache_key)
        if cached and now - float(cached.get("created_at", 0)) < _indextts_cache_ttl_seconds():
            return dict(cached["config"])
    config = _indextts_space_client().get_config()
    with _INDEXTTS_CACHE_LOCK:
        _INDEXTTS_CONFIG_CACHE[cache_key] = {"created_at": now, "config": dict(config)}
    return config


def _indextts_fn_index(config: Mapping[str, Any]) -> int:
    raw = os.getenv("WALLET_INDEXTTS_FN_INDEX", "").strip()
    if raw:
        return int(raw)
    cache_key = (_indextts_space_base_url(), _indextts_api_name())
    with _INDEXTTS_CACHE_LOCK:
        if cache_key in _INDEXTTS_FN_INDEX_CACHE:
            return _INDEXTTS_FN_INDEX_CACHE[cache_key]
    api_name = _indextts_api_name()
    try:
        fn_index = int(
            _indextts_space_client().resolve_fn_index(
                api_name,
                config,
                fallback_markers=("tts", "synth", "generate", "infer", "predict"),
            )
        )
    except Exception as exc:
        raise ValueError(f"IndexTTS api_name {api_name!r} was not found in Gradio config") from exc
    with _INDEXTTS_CACHE_LOCK:
        _INDEXTTS_FN_INDEX_CACHE[cache_key] = fn_index
    return fn_index


def _indextts_batch_fn_index(config: Mapping[str, Any]) -> int:
    raw = os.getenv("WALLET_INDEXTTS_BATCH_FN_INDEX", "").strip()
    if raw:
        return int(raw)
    api_name = _indextts_batch_api_name()
    if not api_name:
        raise ValueError("WALLET_INDEXTTS_BATCH_API_NAME is empty")
    cache_key = (_indextts_space_base_url(), f"batch:{api_name}")
    with _INDEXTTS_CACHE_LOCK:
        if cache_key in _INDEXTTS_FN_INDEX_CACHE:
            return _INDEXTTS_FN_INDEX_CACHE[cache_key]
    try:
        fn_index = int(_indextts_space_client().resolve_fn_index(api_name, config))
    except Exception as exc:
        raise ValueError(f"IndexTTS batch api_name {api_name!r} was not found in Gradio config") from exc
    with _INDEXTTS_CACHE_LOCK:
        _INDEXTTS_FN_INDEX_CACHE[cache_key] = fn_index
    return fn_index


def _indextts_queue_join(fn_index: int, data: Sequence[Any]) -> str:
    return _indextts_space_client().queue_join(int(fn_index), list(data))


def _is_opaque_indextts_queue_failure(detail: str) -> bool:
    normalized = str(detail or "").lower()
    return "space queue failed" in normalized and (
        "error=null" in normalized or "{'error': none}" in normalized
    )


def _indextts_allow_direct_predict_fallback() -> bool:
    value = str(os.getenv("WALLET_INDEXTTS_ALLOW_DIRECT_PREDICT_FALLBACK", "true")).strip().lower()
    return value in {"1", "true", "yes", "on"}


def _indextts_execute_with_queue_fallback(
    *,
    fn_index: int,
    data: Sequence[Any],
    timings: Dict[str, Any],
    api_name: str,
) -> Mapping[str, Any]:
    stage_start = time.perf_counter()
    session_hash = _indextts_queue_join(fn_index, data)
    timings["queue_join_ms"] = max(0, int((time.perf_counter() - stage_start) * 1000))

    stage_start = time.perf_counter()
    queue_error: Exception | None = None
    should_retry_queue = True
    try:
        result = _indextts_wait_for_result(session_hash)
        timings["queue_wait_ms"] = max(0, int((time.perf_counter() - stage_start) * 1000))
        timings["result_path"] = "queue"
        return result
    except Exception as exc:
        timings["queue_wait_ms"] = max(0, int((time.perf_counter() - stage_start) * 1000))
        timings["queue_error"] = str(exc)
        if _indextts_is_fast_fail_mode():
            raise
        if not _indextts_allow_direct_predict_fallback():
            raise
        if not _is_opaque_indextts_queue_failure(str(exc)):
            should_retry_queue = False
        queue_error = exc

    if _indextts_is_fast_fail_mode():
        if queue_error is not None:
            raise queue_error
        raise ValueError("IndexTTS fast-fail mode reached fallback guard without queue error")

    if _indextts_degraded_fast_fail_enabled():
        if queue_error is not None:
            raise queue_error
        raise ValueError("IndexTTS degraded fast-fail mode reached fallback guard without queue error")

    if should_retry_queue:
        # Opaque queue failures are commonly transient. Retry one fresh queue session
        # before using direct predict as a compatibility fallback.
        retry_start = time.perf_counter()
        retry_session_hash = _indextts_queue_join(fn_index, data)
        timings["queue_retry_join_ms"] = max(0, int((time.perf_counter() - retry_start) * 1000))
        retry_start = time.perf_counter()
        try:
            result = _indextts_wait_for_result(retry_session_hash)
            timings["queue_retry_wait_ms"] = max(0, int((time.perf_counter() - retry_start) * 1000))
            timings["result_path"] = "queue-retry"
            return result
        except Exception as retry_exc:
            timings["queue_retry_wait_ms"] = max(0, int((time.perf_counter() - retry_start) * 1000))
            timings["queue_retry_error"] = str(retry_exc)
            if not _is_opaque_indextts_queue_failure(str(retry_exc)):
                raise
            queue_error = retry_exc

    api_name_fallback_start = time.perf_counter()
    try:
        api_name_result = _indextts_space_client().call_api_name(
            api_name,
            data,
            timeout_seconds=_indextts_timeout_seconds(),
            poll_interval_seconds=0.5,
        )
        timings["api_name_fallback_ms"] = max(0, int((time.perf_counter() - api_name_fallback_start) * 1000))
        timings["result_path"] = "api-name-fallback"
        return api_name_result if isinstance(api_name_result, Mapping) else {"data": api_name_result}
    except Exception as api_name_exc:
        timings["api_name_fallback_ms"] = max(0, int((time.perf_counter() - api_name_fallback_start) * 1000))
        timings["api_name_fallback_error"] = str(api_name_exc)

    direct_start = time.perf_counter()
    try:
        direct_result = _indextts_space_client().call_endpoint(fn_index, data)
        timings["direct_predict_ms"] = max(0, int((time.perf_counter() - direct_start) * 1000))
        timings["result_path"] = "direct-predict-fallback"
        return {"data": direct_result if isinstance(direct_result, list) else [direct_result]}
    except Exception as direct_predict_exc:
        timings["direct_predict_ms"] = max(0, int((time.perf_counter() - direct_start) * 1000))
        timings["direct_predict_error"] = str(direct_predict_exc)
        if queue_error is not None:
            raise queue_error
        raise


def _indextts_degraded_error_payload(exc: Exception, operation: str) -> Dict[str, Any]:
    return {
        "code": "indextts_temporarily_unavailable",
        "message": "IndexTTS is temporarily unavailable across configured spaces.",
        "operation": operation,
        "retryable": True,
        "degraded": True,
        "fallbackRecommended": "local-audio",
        "detail": str(exc),
        "spaceUrls": _indextts_space_base_urls(),
    }


def _indextts_endpoint_timeout_seconds() -> float:
    try:
        return max(5.0, float(os.getenv("WALLET_INDEXTTS_ENDPOINT_TIMEOUT_SECONDS", "95")))
    except Exception:
        return 95.0


def _indextts_endpoint_retry_count() -> int:
    try:
        return max(0, min(2, int(os.getenv("WALLET_INDEXTTS_ENDPOINT_RETRIES", "1"))))
    except Exception:
        return 1


def _run_indextts_with_endpoint_timeout(operation: str, fn):
    timeout_seconds = _indextts_endpoint_timeout_seconds()
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = executor.submit(fn)
    try:
        return future.result(timeout=timeout_seconds)
    except concurrent.futures.TimeoutError as exc:
        future.cancel()
        raise TimeoutError(f"IndexTTS {operation} exceeded endpoint timeout ({timeout_seconds:.0f}s)") from exc
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def _run_indextts_with_endpoint_retry(operation: str, fn):
    retries = _indextts_endpoint_retry_count()
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return _run_indextts_with_endpoint_timeout(operation, fn)
        except Exception as exc:
            last_exc = exc
            if attempt >= retries:
                raise
            # Short pause before retrying to avoid immediately re-hitting a transient failure.
            time.sleep(0.2)
    if last_exc is not None:
        raise last_exc
    raise RuntimeError(f"IndexTTS {operation} failed without an explicit error")


def _run_indextts_gradio_tts(
    *,
    text: str,
    voice_description: str | None = None,
    reference_audio: bytes | None = None,
    reference_audio_name: str | None = None,
    reference_audio_mime_type: str | None = None,
) -> Dict[str, Any]:
    last_error: Exception | None = None
    errors_by_space: Dict[str, str] = {}
    space_urls = _indextts_space_base_urls()
    for index, space_url in enumerate(space_urls):
        with _indextts_use_space_base_url(space_url), _indextts_use_timeout_seconds(
            _indextts_attempt_timeout_seconds(index, len(space_urls))
        ), _indextts_fast_fail_mode(index < (len(space_urls) - 1)):
            try:
                return _run_indextts_gradio_tts_for_space(
                    text=text,
                    voice_description=voice_description,
                    reference_audio=reference_audio,
                    reference_audio_name=reference_audio_name,
                    reference_audio_mime_type=reference_audio_mime_type,
                )
            except Exception as exc:
                last_error = exc
                errors_by_space[space_url] = str(exc)
                continue
    detail = "; ".join(f"{url}: {message}" for url, message in errors_by_space.items())
    if last_error is not None:
        raise ValueError(f"IndexTTS failed across configured spaces ({detail})") from last_error
    raise ValueError("IndexTTS failed: no configured spaces available")


def _run_indextts_gradio_tts_for_space(
    *,
    text: str,
    voice_description: str | None = None,
    reference_audio: bytes | None = None,
    reference_audio_name: str | None = None,
    reference_audio_mime_type: str | None = None,
) -> Dict[str, Any]:
    total_start = time.perf_counter()
    timings: Dict[str, Any] = {}
    raw_prompt = str(text or "").strip()
    if not raw_prompt:
        raise ValueError("text is required")
    prompt = _normalize_indextts_spoken_text(raw_prompt)
    stage_start = time.perf_counter()
    config = _indextts_config()
    timings["config_ms"] = max(0, int((time.perf_counter() - stage_start) * 1000))
    stage_start = time.perf_counter()
    uploaded_reference = _indextts_upload_reference_audio(reference_audio, reference_audio_name, reference_audio_mime_type)
    timings["reference_upload_ms"] = max(0, int((time.perf_counter() - stage_start) * 1000))
    stage_start = time.perf_counter()
    fn_index = _indextts_fn_index(config)
    timings["fn_index_ms"] = max(0, int((time.perf_counter() - stage_start) * 1000))
    data = _indextts_request_data(
        text=prompt,
        voice_description=voice_description,
        reference_audio=uploaded_reference,
    )
    result = _indextts_execute_with_queue_fallback(
        fn_index=fn_index,
        data=data,
        timings=timings,
        api_name=_indextts_api_name(),
    )
    audio_ref = _find_gradio_audio_reference(result)
    if not audio_ref:
        # Some Space revisions return batch-shaped outputs (including zip bundles)
        # even for single-item invocations. Reuse batch extraction and keep the
        # first generated audio to preserve the single-route contract.
        batch_refs = _indextts_batch_audio_references(result)
        if batch_refs:
            audio_ref = batch_refs[0]
    if not audio_ref:
        raise ValueError("IndexTTS completed without an audio file in the Gradio output")
    stage_start = time.perf_counter()
    audio_bytes, mime_type = _fetch_gradio_file(audio_ref)
    timings["file_fetch_ms"] = max(0, int((time.perf_counter() - stage_start) * 1000))
    if audio_bytes.startswith(b"RIFF") and b"WAVE" in audio_bytes[:16]:
        mime_type = "audio/wav"
    timings["total_ms"] = max(0, int((time.perf_counter() - total_start) * 1000))
    return {
        "audioBase64": base64.b64encode(audio_bytes).decode("ascii"),
        "mimeType": mime_type or "audio/wav",
        "model": _indextts_model_name(),
        "spaceUrl": _indextts_space_base_url(),
        "provider": "huggingface-zero-gpu-gradio",
        "billTo": os.getenv("WALLET_INDEXTTS_HF_BILL_TO") or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO") or "publicus",
        "referenceAudio": str(uploaded_reference.get("orig_name") or uploaded_reference.get("path") or "")
        if isinstance(uploaded_reference, Mapping)
        else "",
        "text": prompt,
        "originalText": raw_prompt if raw_prompt != prompt else "",
        "latency": timings,
    }


def _run_indextts_gradio_batch_tts(
    *,
    texts: Sequence[str],
    voice_description: str | None = None,
    reference_audio: bytes | None = None,
    reference_audio_name: str | None = None,
    reference_audio_mime_type: str | None = None,
) -> Dict[str, Any]:
    last_error: Exception | None = None
    errors_by_space: Dict[str, str] = {}
    space_urls = _indextts_space_base_urls()
    for index, space_url in enumerate(space_urls):
        with _indextts_use_space_base_url(space_url), _indextts_use_timeout_seconds(
            _indextts_attempt_timeout_seconds(index, len(space_urls))
        ), _indextts_fast_fail_mode(index < (len(space_urls) - 1)):
            try:
                return _run_indextts_gradio_batch_tts_for_space(
                    texts=texts,
                    voice_description=voice_description,
                    reference_audio=reference_audio,
                    reference_audio_name=reference_audio_name,
                    reference_audio_mime_type=reference_audio_mime_type,
                )
            except Exception as exc:
                last_error = exc
                errors_by_space[space_url] = str(exc)
                continue
    detail = "; ".join(f"{url}: {message}" for url, message in errors_by_space.items())
    if last_error is not None:
        raise ValueError(f"IndexTTS batch failed across configured spaces ({detail})") from last_error
    raise ValueError("IndexTTS batch failed: no configured spaces available")


def _run_indextts_gradio_batch_tts_for_space(
    *,
    texts: Sequence[str],
    voice_description: str | None = None,
    reference_audio: bytes | None = None,
    reference_audio_name: str | None = None,
    reference_audio_mime_type: str | None = None,
) -> Dict[str, Any]:
    total_start = time.perf_counter()
    raw_prompts = [str(text or "").strip() for text in texts if str(text or "").strip()]
    if not raw_prompts:
        raise ValueError("texts is required")
    prompts = [_normalize_indextts_spoken_text(text) for text in raw_prompts]
    config = _indextts_config()
    uploaded_reference = _indextts_upload_reference_audio(reference_audio, reference_audio_name, reference_audio_mime_type)
    timings: Dict[str, Any] = {}
    try:
        stage_start = time.perf_counter()
        fn_index = _indextts_batch_fn_index(config)
        timings["batch_fn_index_ms"] = max(0, int((time.perf_counter() - stage_start) * 1000))
        data = _indextts_batch_request_data(
            texts=prompts,
            voice_description=voice_description,
            reference_audio=uploaded_reference,
        )
        result = _indextts_execute_with_queue_fallback(
            fn_index=fn_index,
            data=data,
            timings=timings,
            api_name=_indextts_batch_api_name(),
        )
        audio_refs = _indextts_batch_audio_references(result)
        if len(audio_refs) < len(prompts):
            raise ValueError(f"IndexTTS batch returned {len(audio_refs)} audio files for {len(prompts)} texts")
        items: List[Dict[str, Any]] = []
        fetch_start = time.perf_counter()
        for index, audio_ref in enumerate(audio_refs[: len(prompts)]):
            audio_bytes, mime_type = _fetch_gradio_file(audio_ref)
            if audio_bytes.startswith(b"RIFF") and b"WAVE" in audio_bytes[:16]:
                mime_type = "audio/wav"
            items.append(
                {
                    "audioBase64": base64.b64encode(audio_bytes).decode("ascii"),
                    "mimeType": mime_type or "audio/wav",
                    "text": prompts[index],
                    "originalText": raw_prompts[index] if raw_prompts[index] != prompts[index] else "",
                }
            )
        timings["file_fetch_ms"] = max(0, int((time.perf_counter() - fetch_start) * 1000))
        mode = "batch"
    except Exception as exc:
        if _indextts_require_batch_mode():
            raise
        fallback_start = time.perf_counter()
        items = [
            _run_indextts_gradio_tts_for_space(
                text=raw_prompt,
                voice_description=voice_description,
                reference_audio=reference_audio,
                reference_audio_name=reference_audio_name,
                reference_audio_mime_type=reference_audio_mime_type,
            )
            for raw_prompt in raw_prompts
        ]
        timings["sequential_fallback_ms"] = max(0, int((time.perf_counter() - fallback_start) * 1000))
        mode = "sequential-fallback"
        timings["batch_error"] = str(exc)
    timings["total_ms"] = max(0, int((time.perf_counter() - total_start) * 1000))
    return {
        "items": items,
        "batchSize": len(items),
        "mode": mode,
        "model": _indextts_model_name(),
        "spaceUrl": _indextts_space_base_url(),
        "provider": "huggingface-zero-gpu-gradio",
        "billTo": os.getenv("WALLET_INDEXTTS_HF_BILL_TO") or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO") or "publicus",
        "latency": timings,
    }


def _indextts_single_batch_fallback_enabled() -> bool:
    value = str(os.getenv("WALLET_INDEXTTS_SINGLE_BATCH_FALLBACK", "true")).strip().lower()
    return value in {"1", "true", "yes", "on"}


def _run_indextts_tts_with_batch_fallback(
    *,
    text: str,
    voice_description: str | None = None,
    reference_audio: bytes | None = None,
    reference_audio_name: str | None = None,
    reference_audio_mime_type: str | None = None,
) -> Dict[str, Any]:
    try:
        return _run_indextts_gradio_tts(
            text=text,
            voice_description=voice_description,
            reference_audio=reference_audio,
            reference_audio_name=reference_audio_name,
            reference_audio_mime_type=reference_audio_mime_type,
        )
    except Exception as single_exc:
        if not _indextts_single_batch_fallback_enabled():
            raise
        try:
            with _indextts_force_require_batch(True):
                batch = _run_indextts_gradio_batch_tts(
                    texts=[text],
                    voice_description=voice_description,
                    reference_audio=reference_audio,
                    reference_audio_name=reference_audio_name,
                    reference_audio_mime_type=reference_audio_mime_type,
                )
        except Exception as batch_exc:
            raise ValueError(
                f"IndexTTS single failed and batch fallback failed: single={single_exc}; batch={batch_exc}"
            ) from batch_exc
        items = batch.get("items") if isinstance(batch, Mapping) else None
        if not isinstance(items, list) or not items:
            raise ValueError("IndexTTS batch fallback returned no items") from single_exc
        first_item = items[0] if isinstance(items[0], Mapping) else {}
        response: Dict[str, Any] = {
            "audioBase64": str(first_item.get("audioBase64") or ""),
            "mimeType": str(first_item.get("mimeType") or "audio/wav"),
            "model": str(batch.get("model") or _indextts_model_name()) if isinstance(batch, Mapping) else _indextts_model_name(),
            "spaceUrl": str(batch.get("spaceUrl") or _indextts_space_base_url()) if isinstance(batch, Mapping) else _indextts_space_base_url(),
            "provider": str(batch.get("provider") or "huggingface-zero-gpu-gradio") if isinstance(batch, Mapping) else "huggingface-zero-gpu-gradio",
            "billTo": str(batch.get("billTo") or os.getenv("WALLET_INDEXTTS_HF_BILL_TO") or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO") or "publicus")
            if isinstance(batch, Mapping)
            else (os.getenv("WALLET_INDEXTTS_HF_BILL_TO") or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO") or "publicus"),
            "referenceAudio": "",
            "text": str(first_item.get("text") or text),
            "originalText": str(first_item.get("originalText") or ""),
            "latency": {
                "result_path": "single-batch-fallback",
                "single_error": str(single_exc),
                "batch_latency": dict(batch.get("latency") or {}) if isinstance(batch, Mapping) else {},
            },
        }
        if not response["audioBase64"]:
            raise ValueError("IndexTTS batch fallback did not return audioBase64") from single_exc
        return response


def _indextts_upload_reference_audio(
    audio: bytes | None,
    file_name: str | None,
    mime_type: str | None = None,
) -> Dict[str, Any] | None:
    if audio:
        guessed_type = mime_type or mimetypes.guess_type(file_name or "")[0] or "audio/wav"
        parsed = _indextts_space_client().upload_file(file_name or "reference.wav", audio, guessed_type)
        upload_path = _first_upload_path(parsed)
        if not upload_path:
            raise RuntimeError("IndexTTS upload did not return a reference path")
        return {"path": upload_path, "meta": {"_type": "gradio.FileData"}, "orig_name": os.path.basename(file_name or "reference.wav")}
    path = os.getenv("WALLET_INDEXTTS_REFERENCE_AUDIO_PATH", "").strip()
    if path and os.path.exists(path):
        stat = os.stat(path)
        cache_key = (os.path.abspath(path), f"{stat.st_mtime_ns}:{stat.st_size}")
        with _INDEXTTS_CACHE_LOCK:
            cached = _INDEXTTS_REFERENCE_CACHE.get(cache_key)
            if cached:
                return dict(cached)
        with open(path, "rb") as handle:
            data = handle.read()
        mime_type = mimetypes.guess_type(path)[0] or "audio/wav"
        parsed = _indextts_space_client().upload_file(os.path.basename(path), data, mime_type)
        upload_path = _first_upload_path(parsed)
        if not upload_path:
            raise RuntimeError("IndexTTS upload did not return a reference path")
        uploaded = {"path": upload_path, "meta": {"_type": "gradio.FileData"}, "orig_name": os.path.basename(path)}
        with _INDEXTTS_CACHE_LOCK:
            _INDEXTTS_REFERENCE_CACHE[cache_key] = dict(uploaded)
        return uploaded
    remote_path = os.getenv("WALLET_INDEXTTS_REFERENCE_AUDIO_REMOTE_PATH", "").strip()
    if remote_path:
        return {"path": remote_path, "meta": {"_type": "gradio.FileData"}, "orig_name": os.path.basename(remote_path) or "reference.wav"}
    cache_key = ("default-abby-reference", "v1")
    with _INDEXTTS_CACHE_LOCK:
        cached = _INDEXTTS_REFERENCE_CACHE.get(cache_key)
        if cached:
            return dict(cached)
    parsed = _indextts_space_client().upload_file("abby-reference.wav", _default_indextts_reference_wav(), "audio/wav")
    upload_path = _first_upload_path(parsed)
    if not upload_path:
        raise RuntimeError("IndexTTS upload did not return a reference path")
    uploaded = {"path": upload_path, "meta": {"_type": "gradio.FileData"}, "orig_name": "abby-reference.wav"}
    with _INDEXTTS_CACHE_LOCK:
        _INDEXTTS_REFERENCE_CACHE[cache_key] = dict(uploaded)
    return uploaded


def _default_indextts_reference_wav() -> bytes:
    sample_rate = 24_000
    duration_seconds = 1.5
    frames = int(sample_rate * duration_seconds)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        for index in range(frames):
            envelope = min(1.0, index / 2_400, (frames - index) / 2_400)
            value = int(10_000 * envelope * math.sin(2.0 * math.pi * 220.0 * index / sample_rate))
            wav.writeframesraw(struct.pack("<h", value))
    return buffer.getvalue()


def _gradio_upload_file(data: bytes, file_name: str, mime_type: str) -> Dict[str, Any]:
    boundary = f"----211AiIndexTts{uuid.uuid4().hex}"
    safe_name = os.path.basename(file_name or "reference.wav")
    body = b"".join(
        [
            f"--{boundary}\r\n".encode("utf-8"),
            f'Content-Disposition: form-data; name="files"; filename="{safe_name}"\r\n'.encode("utf-8"),
            f"Content-Type: {mime_type or 'application/octet-stream'}\r\n\r\n".encode("utf-8"),
            data,
            f"\r\n--{boundary}--\r\n".encode("utf-8"),
        ]
    )
    headers = _indextts_headers()
    headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    request = urllib_request.Request(
        f"{_indextts_space_base_url()}/gradio_api/upload",
        data=body,
        headers=headers,
        method="POST",
    )
    with urllib_request.urlopen(request, timeout=_indextts_timeout_seconds()) as response:
        parsed = json.loads(response.read().decode("utf-8"))
    upload_path = _first_upload_path(parsed)
    if not upload_path:
        raise ValueError("IndexTTS upload did not return a Gradio file path")
    return {"path": upload_path, "meta": {"_type": "gradio.FileData"}, "orig_name": safe_name}


def _first_upload_path(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        for item in value:
            found = _first_upload_path(item)
            if found:
                return found
    if isinstance(value, Mapping):
        for key in ("path", "name"):
            item = value.get(key)
            if isinstance(item, str) and item.strip():
                return item.strip()
        for item in value.values():
            found = _first_upload_path(item)
            if found:
                return found
    return ""


def _indextts_request_data(
    *,
    text: str,
    voice_description: str | None,
    reference_audio: Mapping[str, Any] | None,
) -> List[Any]:
    raw_template = os.getenv("WALLET_INDEXTTS_DATA_TEMPLATE", "").strip()
    if raw_template:
        rendered = (
            raw_template.replace("{text}", text)
            .replace("{voice_description}", voice_description or "")
            .replace("{reference_audio}", json.dumps(reference_audio) if reference_audio else "null")
        )
        parsed = json.loads(rendered)
        if not isinstance(parsed, list):
            raise ValueError("WALLET_INDEXTTS_DATA_TEMPLATE must render to a JSON array")
        return parsed
    # IndexTeam/IndexTTS-2-Demo /gen_single Gradio input order.
    return [
        "Same as the voice reference",
        reference_audio,
        text,
        None,
        0.8,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        voice_description or "",
        False,
        120,
        True,
        0.8,
        30,
        0.8,
        0.0,
        3,
        10.0,
        1500,
    ]


def _indextts_batch_request_data(
    *,
    texts: Sequence[str],
    voice_description: str | None,
    reference_audio: Mapping[str, Any] | None,
) -> List[Any]:
    text_list = [str(text) for text in texts]
    raw_template = os.getenv("WALLET_INDEXTTS_BATCH_DATA_TEMPLATE", "").strip()
    if raw_template:
        rendered = (
            raw_template.replace("{texts}", json.dumps(text_list))
            .replace("{text}", json.dumps(json.dumps(text_list)))
            .replace("{voice_description}", json.dumps(voice_description or ""))
            .replace("{reference_audio}", json.dumps(reference_audio) if reference_audio else "null")
        )
        parsed = json.loads(rendered)
        if not isinstance(parsed, list):
            raise ValueError("WALLET_INDEXTTS_BATCH_DATA_TEMPLATE must render to a JSON array")
        return parsed
    # Publicus/IndexTTS-2-Demo /gen_batch uses a Gradio Textbox, but the
    # backend batch parser expects a JSON-encoded list string in that textbox.
    return [
        "Same as the voice reference",
        reference_audio,
        json.dumps(text_list),
        None,
        0.8,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        voice_description or "",
        False,
        120,
        len(text_list) if len(text_list) > 1 else 0,
        True,
        0.8,
        30,
        0.8,
        0.0,
        3,
        10.0,
        1500,
    ]


def _indextts_wait_for_result(session_hash: str) -> Dict[str, Any]:
    try:
        return _indextts_space_client().wait_for_queue_result(
            session_hash,
            timeout_seconds=_indextts_timeout_seconds(),
            poll_interval_seconds=0.5,
        )
    except Exception as exc:
        detail = _normalize_indextts_queue_failure(exc)
        raise ValueError(f"IndexTTS Gradio queue failed: {detail}") from exc


def _normalize_indextts_queue_failure(error: Exception) -> str:
    detail = str(error or "").strip() or type(error).__name__
    normalized = detail.replace('"', "'").lower()
    if "space queue failed" in normalized and "{'error': none}" in normalized:
        return (
            "Space queue failed without diagnostic details (error=null). "
            "The Hugging Face Space may be overloaded or dropped the job; retry shortly."
        )
    return detail


def _find_gradio_audio_reference(value: Any) -> Any:
    if isinstance(value, Mapping):
        if str(value.get("mime_type") or value.get("mimeType") or "").startswith("audio/"):
            return value
        if any(key in value for key in ("path", "url", "name")) and not value.get("is_stream"):
            pathish = str(value.get("path") or value.get("url") or value.get("name") or "")
            if pathish and (pathish.endswith((".wav", ".mp3", ".flac", ".ogg")) or "/file=" in pathish or "/gradio_api/file=" in pathish):
                return value
        for item in value.values():
            found = _find_gradio_audio_reference(item)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = _find_gradio_audio_reference(item)
            if found:
                return found
    if isinstance(value, str) and (value.endswith((".wav", ".mp3", ".flac", ".ogg")) or "/file=" in value or "/gradio_api/file=" in value):
        return value
    return None


def _find_gradio_audio_references(value: Any) -> List[Any]:
    found: List[Any] = []
    seen: set[str] = set()

    def visit(item: Any) -> None:
        if isinstance(item, Mapping):
            direct = _find_gradio_audio_reference(item)
            if direct is item:
                key = json.dumps(item, sort_keys=True, default=str)
                if key not in seen:
                    seen.add(key)
                    found.append(item)
                return
            for child in item.values():
                visit(child)
            return
        if isinstance(item, list):
            for child in item:
                visit(child)
            return
        if isinstance(item, str):
            direct = _find_gradio_audio_reference(item)
            if direct:
                key = str(direct)
                if key not in seen:
                    seen.add(key)
                    found.append(direct)

    visit(value)
    return found


def _gradio_update_value(value: Any) -> Any:
    if isinstance(value, Mapping) and value.get("__type__") == "update":
        return value.get("value")
    return value


def _gradio_output_values(result: Mapping[str, Any]) -> List[Any]:
    data = result.get("data")
    if isinstance(data, list):
        return [_gradio_update_value(item) for item in data]
    return []


def _gradio_file_key(reference: Any) -> str:
    if isinstance(reference, Mapping):
        return str(reference.get("url") or reference.get("path") or reference.get("name") or json.dumps(reference, sort_keys=True, default=str))
    return str(reference)


def _dedupe_gradio_references(references: Sequence[Any]) -> List[Any]:
    deduped: List[Any] = []
    seen: set[str] = set()
    for reference in references:
        key = _gradio_file_key(reference)
        if key and key not in seen:
            seen.add(key)
            deduped.append(reference)
    return deduped


def _indextts_batch_audio_references(result: Mapping[str, Any]) -> List[Any]:
    outputs = _gradio_output_values(result)
    if len(outputs) >= 2:
        generated_files = _find_gradio_audio_references(outputs[1])
        if generated_files:
            return _dedupe_gradio_references(generated_files)
    if len(outputs) >= 3:
        zip_ref = _find_gradio_file_reference(outputs[2], suffixes=(".zip",))
        if zip_ref:
            try:
                archive, _mime_type = _fetch_gradio_file(zip_ref)
                extracted = _extract_audio_files_from_zip(archive)
                if extracted:
                    return extracted
            except Exception:
                pass
    return _dedupe_gradio_references(_find_gradio_audio_references(result))


def _find_gradio_file_reference(value: Any, *, suffixes: Sequence[str]) -> Any:
    suffix_tuple = tuple(suffix.lower() for suffix in suffixes)
    if isinstance(value, Mapping):
        if any(key in value for key in ("path", "url", "name")) and not value.get("is_stream"):
            pathish = str(value.get("path") or value.get("url") or value.get("name") or "").lower()
            if pathish.endswith(suffix_tuple) or any(f"/file=" in pathish and suffix in pathish for suffix in suffix_tuple):
                return value
        for item in value.values():
            found = _find_gradio_file_reference(item, suffixes=suffix_tuple)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = _find_gradio_file_reference(item, suffixes=suffix_tuple)
            if found:
                return found
    if isinstance(value, str) and value.lower().endswith(suffix_tuple):
        return value
    return None


def _extract_audio_files_from_zip(data: bytes) -> List[Dict[str, Any]]:
    extracted: List[Dict[str, Any]] = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name in sorted(archive.namelist()):
            if name.endswith("/") or not name.lower().endswith((".wav", ".mp3", ".flac", ".ogg")):
                continue
            extracted.append({"name": name, "_inline_bytes": archive.read(name)})
    return extracted


def _fetch_gradio_file(reference: Any) -> tuple[bytes, str]:
    if isinstance(reference, Mapping) and isinstance(reference.get("_inline_bytes"), (bytes, bytearray)):
        name = str(reference.get("name") or reference.get("path") or "")
        return bytes(reference["_inline_bytes"]), mimetypes.guess_type(name)[0] or "audio/wav"
    data, detected_type = _indextts_space_client().fetch_file(reference)
    path = str(reference.get("path") or reference.get("name") or "") if isinstance(reference, Mapping) else str(reference or "")
    mime_type = str(reference.get("mime_type") or reference.get("mimeType") or "") if isinstance(reference, Mapping) else ""
    return data, mime_type or detected_type or mimetypes.guess_type(path)[0] or "audio/wav"


def _hf_whisper_model_name(model_name: str | None = None) -> str:
    return (model_name or os.getenv("WALLET_HF_WHISPER_MODEL_NAME") or "openai/whisper-large-v3-turbo").strip()


def _run_hf_whisper_stt(
    audio: bytes,
    *,
    audio_name: str | None = None,
    audio_type: str | None = None,
    language: str | None = None,
    model_name: str | None = None,
) -> Dict[str, Any]:
    if not audio:
        raise ValueError("audio is required")
    token = (
        resolve_secret(
            "WALLET_HF_WHISPER_TOKEN",
            "IPFS_DATASETS_PY_HF_API_TOKEN",
            "HF_TOKEN",
            "HUGGINGFACEHUB_API_TOKEN",
            "HUGGINGFACE_API_TOKEN",
            "HUGGINGFACE_HUB_TOKEN",
        )
        or ""
    ).strip()
    if not token:
        raise ValueError("Hugging Face token is required for Whisper STT")
    selected_model = _hf_whisper_model_name(model_name)
    base_url = (
        os.getenv("WALLET_HF_WHISPER_BASE_URL", "https://router.huggingface.co/hf-inference/models")
        .strip()
        .rstrip("/")
    )
    content_type = (audio_type or mimetypes.guess_type(audio_name or "")[0] or "audio/wav").strip()
    if content_type in {"application/octet-stream", "binary/octet-stream"}:
        content_type = mimetypes.guess_type(audio_name or "")[0] or "audio/wav"
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
    }
    bill_to = (
        os.getenv("WALLET_HF_WHISPER_BILL_TO")
        or os.getenv("IPFS_DATASETS_PY_HF_BILL_TO")
        or "publicus"
    ).strip()
    if bill_to:
        headers["X-HF-Bill-To"] = bill_to
    if language:
        headers["X-Wallet-STT-Language"] = language
    url = f"{base_url}/{urllib_parse.quote(selected_model, safe='/')}"
    request = urllib_request.Request(url, data=audio, headers=headers, method="POST")
    with urllib_request.urlopen(request, timeout=_hf_whisper_timeout_seconds()) as response:
        raw = response.read()
    result = json.loads(raw.decode("utf-8"))
    text = _extract_hf_whisper_text(result)
    return {
        "model": selected_model,
        "modelName": selected_model,
        "provider": "huggingface-whisper",
        "text": text,
    }


def _extract_hf_whisper_text(payload: Any) -> str:
    if isinstance(payload, Mapping):
        for key in ("text", "transcription", "transcript", "generated_text", "output_text"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for key in ("items", "results", "segments", "chunks", "output", "data"):
            nested = payload.get(key)
            extracted = _extract_hf_whisper_text(nested)
            if extracted:
                return extracted
        return ""
    if isinstance(payload, Sequence) and not isinstance(payload, (str, bytes, bytearray)):
        pieces: List[str] = []
        for item in payload:
            extracted = _extract_hf_whisper_text(item)
            if extracted:
                pieces.append(extracted)
        if pieces:
            return " ".join(pieces).strip()
        return ""
    if isinstance(payload, str):
        return payload.strip()
    return ""


def _hf_whisper_timeout_seconds() -> float:
    try:
        return max(5.0, float(os.getenv("WALLET_HF_WHISPER_TIMEOUT_SECONDS", "45")))
    except Exception:
        return 45.0


def _silent_wav_bytes(duration_ms: int = 240, sample_rate: int = 16_000) -> bytes:
    sample_count = max(1, int(sample_rate * duration_ms / 1000))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * sample_count)
    return buffer.getvalue()


def _parse_upload_metadata(metadata: str | None) -> Dict[str, Any]:
    if not metadata:
        return {}
    parsed = json.loads(metadata)
    if not isinstance(parsed, dict):
        raise ValueError("upload metadata must decode to an object")
    return parsed


def _publish_bytes_to_ipfs(
    data: bytes,
    *,
    file_name: str | None = None,
    mime_type: str | None = None,
    source_record_id: str | None = None,
    wallet_id: str | None = None,
) -> Dict[str, Any]:
    cid = _publish_bytes_via_ipfs_backend(data)
    gateway_base_url = os.environ.get("WALLET_IPFS_PUBLIC_GATEWAY_BASE_URL", "/ipfs-proxy").rstrip("/")
    payload: Dict[str, Any] = {
        "cid": cid,
        "gatewayUrl": f"{gateway_base_url}/{cid}",
        "ipfsCid": cid,
        "message": "Pinned to IPFS through the wallet upload bridge.",
        "provider": "ipfs-filecoin",
        "status": "stored",
    }
    sidecar_result = _submit_ipfs_cid_to_filecoin_pin(
        cid,
        file_name=file_name,
        mime_type=mime_type,
        source_record_id=source_record_id,
        wallet_id=wallet_id,
    )
    if sidecar_result is not None:
        payload["message"] = "Pinned to IPFS and queued for Filecoin persistence through the wallet upload bridge."
        request_id = str(sidecar_result.get("requestid") or sidecar_result.get("requestId") or "").strip()
        handoff_status = str(sidecar_result.get("status") or "").strip()
        if request_id:
            payload["requestId"] = request_id
            payload["filecoinPinRequestId"] = request_id
            payload["statusUrl"] = _filecoin_upload_status_url(request_id)
        if handoff_status:
            payload["filecoinPinStatus"] = handoff_status
        if isinstance(sidecar_result.get("info"), dict):
            payload["filecoinPinInfo"] = sidecar_result["info"]
    if file_name:
        payload["fileName"] = file_name
    if mime_type:
        payload["mimeType"] = mime_type
    if source_record_id:
        payload["recordId"] = source_record_id
    if wallet_id:
        payload["walletId"] = wallet_id
    return payload


def _publish_encrypted_record_graph_to_ipfs(
    encrypted_record: Mapping[str, Any],
    *,
    file_name: str | None = None,
) -> Dict[str, Any]:
    record = dict(encrypted_record["record"])
    version = dict(encrypted_record["version"])
    wallet_id = str(record.get("wallet_id") or "")
    record_id = str(record.get("record_id") or "")
    version_id = str(version.get("version_id") or record.get("current_version_id") or "")
    payload_result = _publish_bytes_to_ipfs(
        encrypted_record["encrypted_payload"],
        file_name=f"{file_name or record_id}.encrypted-payload.json",
        mime_type="application/vnd.211-ai.wallet.encrypted-payload+json",
        source_record_id=record_id,
        wallet_id=wallet_id,
    )
    payload_cid = str(payload_result.get("ipfsCid") or payload_result.get("cid") or "")
    metadata_result = None
    metadata_cid = ""
    if encrypted_record.get("encrypted_metadata") is not None:
        metadata_result = _publish_bytes_to_ipfs(
            encrypted_record["encrypted_metadata"],
            file_name=f"{file_name or record_id}.encrypted-metadata.json",
            mime_type="application/vnd.211-ai.wallet.encrypted-metadata+json",
            source_record_id=record_id,
            wallet_id=wallet_id,
        )
        metadata_cid = str(metadata_result.get("ipfsCid") or metadata_result.get("cid") or "")
    encrypted_payload_ref = dict(version.get("encrypted_payload_ref") or {})
    encrypted_metadata_ref = dict(version.get("encrypted_metadata_ref") or {}) if version.get("encrypted_metadata_ref") else None
    graph = {
        "schemaVersion": "211-ai-wallet-encrypted-record-ipld-v1",
        "walletId": wallet_id,
        "recordId": record_id,
        "versionId": version_id,
        "dataType": record.get("data_type"),
        "sensitivity": record.get("sensitivity"),
        "publicDescriptor": record.get("public_descriptor"),
        "ciphertextHash": version.get("ciphertext_hash"),
        "encryptionSuite": version.get("encryption_suite"),
        "encryptedPayload": {
            "/": payload_cid,
            "storageRef": encrypted_payload_ref,
            "filecoin": payload_result,
        },
        "encryptedMetadata": (
            {
                "/": metadata_cid,
                "storageRef": encrypted_metadata_ref,
                "filecoin": metadata_result,
            }
            if metadata_result is not None
            else None
        ),
        "walletMetadata": None,
        "links": [
            {"name": "encrypted_payload", "/": payload_cid, "mediaType": "application/vnd.211-ai.wallet.encrypted-payload+json"},
            *(
                [{"name": "encrypted_metadata", "/": metadata_cid, "mediaType": "application/vnd.211-ai.wallet.encrypted-metadata+json"}]
                if metadata_result is not None
                else []
            ),
        ],
    }
    wallet_metadata_cid = _record_metadata_cid(encrypted_record)
    if wallet_metadata_cid:
        graph["walletMetadata"] = {
            "/": wallet_metadata_cid,
            "mediaType": "application/vnd.211-ai.wallet.record-metadata+json",
        }
        graph["links"].append(
            {
                "name": "wallet_metadata",
                "/": wallet_metadata_cid,
                "mediaType": "application/vnd.211-ai.wallet.record-metadata+json",
            }
        )
    graph_result = _publish_bytes_to_ipfs(
        json.dumps(graph, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        file_name=f"{file_name or record_id}.ipld-wallet-record.json",
        mime_type="application/vnd.ipld.dag-json",
        source_record_id=record_id,
        wallet_id=wallet_id,
    )
    graph_cid = str(graph_result.get("ipfsCid") or graph_result.get("cid") or "")
    return {
        **graph_result,
        "message": "Pinned encrypted wallet record graph to IPFS/Filecoin.",
        "encryptedPayloadCid": payload_cid,
        "encryptedMetadataCid": metadata_cid or None,
        "metadataCid": wallet_metadata_cid or None,
        "metadataIpldCid": wallet_metadata_cid or None,
        "ipldLinks": graph["links"],
        "recordId": record_id,
        "versionId": version_id,
        "root": {"/": graph_cid},
        "walletId": wallet_id,
    }


def _record_metadata_cid(encrypted_record: Mapping[str, Any]) -> str:
    metadata = encrypted_record.get("metadata")
    if isinstance(metadata, Mapping):
        for key in ("metadataCid", "metadataIpldCid"):
            value = str(metadata.get(key) or "").strip()
            if value:
                return value
    record = encrypted_record.get("record")
    if isinstance(record, Mapping):
        metadata = record.get("metadata")
        if isinstance(metadata, Mapping):
            for key in ("metadataCid", "metadataIpldCid"):
                value = str(metadata.get(key) or "").strip()
                if value:
                    return value
    return ""


def _should_publish_record_metadata_ipld(metadata: Mapping[str, Any]) -> bool:
    generated_keys = {
        "decryptedClassification",
        "decryptedLabels",
        "decryptedMimeType",
        "privacyProfileArtifactIds",
        "privacyProfileClassification",
        "privacyProfileLabels",
        "privacyProfileMimeType",
        "privacyProfileProofId",
        "privacyProfilePublicInputs",
        "privacyProfileSearchText",
        "privacyProfileStatus",
        "privacyProfileSummary",
        "privacyProfileVectorTerms",
    }
    return any(key in metadata for key in generated_keys)


def _publish_record_metadata_ipld(record: Mapping[str, Any]) -> Dict[str, Any]:
    metadata = record.get("metadata")
    if not isinstance(metadata, Mapping):
        return {}
    generated_metadata = _generated_wallet_metadata(metadata)
    if not generated_metadata:
        return {}
    record_id = str(record.get("record_id") or "")
    wallet_id = str(record.get("wallet_id") or metadata.get("walletId") or "")
    graph = {
        "schemaVersion": "211-ai-wallet-record-metadata-ipld-v1",
        "walletId": wallet_id,
        "recordId": record_id,
        "dataType": record.get("data_type"),
        "sensitivity": record.get("sensitivity"),
        "metadata": generated_metadata,
        "privacyPolicy": "proof_backed_metadata_no_plaintext_payload",
        "links": [
            *(
                [
                    {
                        "name": "document_privacy_profile_proof",
                        "proofId": str(generated_metadata["privacyProfileProofId"]),
                        "mediaType": "application/vnd.211-ai.wallet.proof-receipt+json",
                    }
                ]
                if generated_metadata.get("privacyProfileProofId")
                else []
            ),
            *(
                [
                    {
                        "name": "derived_artifact",
                        "artifactId": artifact_id,
                        "mediaType": "application/vnd.211-ai.wallet.derived-artifact+json",
                    }
                    for artifact_id in generated_metadata.get("privacyProfileArtifactIds", [])
                    if isinstance(artifact_id, str) and artifact_id.strip()
                ]
            ),
        ],
    }
    result = _publish_bytes_to_ipfs(
        json.dumps(graph, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        file_name=f"{record_id or 'wallet-record'}.wallet-metadata.ipld.json",
        mime_type="application/vnd.211-ai.wallet.record-metadata+json",
        source_record_id=record_id or None,
        wallet_id=wallet_id or None,
    )
    cid = str(result.get("ipfsCid") or result.get("cid") or "")
    if not cid:
        return {}
    existing_links = metadata.get("ipldLinks") if isinstance(metadata.get("ipldLinks"), list) else []
    metadata_link = {
        "name": "wallet_metadata",
        "/": cid,
        "mediaType": "application/vnd.211-ai.wallet.record-metadata+json",
    }
    links = [
        link
        for link in existing_links
        if not (isinstance(link, Mapping) and str(link.get("name") or "") == "wallet_metadata")
    ]
    links.append(metadata_link)
    patch: Dict[str, Any] = {
        "metadataCid": cid,
        "metadataGatewayUrl": result.get("gatewayUrl") or result.get("url"),
        "metadataIpldCid": cid,
        "metadataIpldLink": metadata_link,
        "metadataStorageMessage": result.get("message") or "Pinned wallet metadata IPLD to IPFS/Filecoin.",
        "ipldLinks": links,
    }
    for key in ("filecoinPinRequestId", "filecoinPinStatus", "filecoinPinStatusUrl"):
        value = result.get(key)
        if value:
            patch[f"metadata{key[0].upper()}{key[1:]}"] = value
    return patch


def _generated_wallet_metadata(metadata: Mapping[str, Any]) -> Dict[str, Any]:
    allowed = {
        "decryptedClassification",
        "decryptedLabels",
        "decryptedMimeType",
        "fileName",
        "privacyProfileArtifactIds",
        "privacyProfileClassification",
        "privacyProfileLabels",
        "privacyProfileMimeType",
        "privacyProfileProofId",
        "privacyProfilePublicInputs",
        "privacyProfileSearchText",
        "privacyProfileStatus",
        "privacyProfileSummary",
        "privacyProfileVectorTerms",
    }
    generated = {key: metadata[key] for key in sorted(allowed) if key in metadata}
    return _json_safe_metadata(generated)


def _json_safe_metadata(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _json_safe_metadata(item)
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, list):
        return [_json_safe_metadata(item) for item in value if item is not None]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _publish_bytes_via_ipfs_backend(data: bytes) -> str:
    backend_mode = str(os.getenv("WALLET_IPFS_UPLOAD_BACKEND") or "").strip().lower()
    if backend_mode == "mock":
        return _mock_ipfs_cid_for_bytes(data)
    backend = get_ipfs_backend()
    return backend.add_bytes(data, pin=True)


def _mock_ipfs_cid_for_bytes(data: bytes) -> str:
    digest = hashlib.sha256(data).hexdigest()
    return f"bafybeimock{digest[:24]}"


def _submit_ipfs_cid_to_filecoin_pin(
    cid: str,
    *,
    file_name: str | None = None,
    mime_type: str | None = None,
    source_record_id: str | None = None,
    wallet_id: str | None = None,
) -> Dict[str, Any] | None:
    if not _filecoin_pin_service_url():
        return None

    origins = [
        origin.strip()
        for origin in str(os.getenv("WALLET_FILECOIN_PIN_ORIGINS") or "").split(",")
        if origin.strip()
    ]
    metadata: Dict[str, str] = {"source": "211-ai-wallet"}
    if wallet_id:
        metadata["walletId"] = wallet_id
    if source_record_id:
        metadata["recordId"] = source_record_id
    if file_name:
        metadata["fileName"] = file_name
    if mime_type:
        metadata["mimeType"] = mime_type

    payload: Dict[str, Any] = {
        "cid": cid,
        "meta": metadata,
    }
    if file_name:
        payload["name"] = file_name
    if origins:
        payload["origins"] = origins
    return _filecoin_pin_request("POST", "/pins", payload=payload)


def _fetch_filecoin_pin_status(request_id: str) -> Dict[str, Any]:
    if not request_id.strip():
        raise ValueError("request ID is required")
    return _filecoin_pin_request("GET", f"/pins/{request_id}")


def _filecoin_pin_request(method: str, path: str, *, payload: Dict[str, Any] | None = None) -> Dict[str, Any]:
    service_url = _filecoin_pin_service_url()
    if not service_url:
        raise FilecoinPinHandoffError("WALLET_FILECOIN_PIN_SERVICE_URL is not configured")
    if service_url == "mock":
        return _mock_filecoin_pin_request(method, path, payload=payload)

    endpoint = f"{service_url}{path}"
    body = json.dumps(payload, sort_keys=True).encode("utf-8") if payload is not None else None
    req = urllib_request.Request(
        endpoint,
        data=body,
        headers=_filecoin_pin_request_headers(include_json_content_type=payload is not None),
        method=method,
    )
    try:
        with urllib_request.urlopen(req, timeout=_filecoin_pin_timeout_seconds()) as response:
            raw = response.read().decode("utf-8")
            content_type = str(getattr(response, "headers", {}).get("content-type", ""))
    except urllib_error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        detail = _response_message_from_raw_json(error_body) or f"Filecoin Pin sidecar rejected the request with HTTP {exc.code}"
        raise FilecoinPinHandoffError(detail) from exc
    except urllib_error.URLError as exc:
        raise FilecoinPinHandoffError(f"Unable to reach Filecoin Pin sidecar at {endpoint}: {exc.reason}") from exc

    if not raw:
        return {}
    if "json" not in content_type.lower() and not raw.lstrip().startswith("{"):
        raise FilecoinPinHandoffError("Filecoin Pin sidecar returned a non-JSON response")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise FilecoinPinHandoffError("Filecoin Pin sidecar returned a non-object response")
    return parsed


def _filecoin_pin_service_url() -> str:
    return str(os.getenv("WALLET_FILECOIN_PIN_SERVICE_URL") or "").strip().rstrip("/")


def _filecoin_pin_mock_status() -> str:
    return str(os.getenv("WALLET_FILECOIN_PIN_MOCK_STATUS") or "pinned").strip() or "pinned"


def _mock_filecoin_pin_request(method: str, path: str, *, payload: Dict[str, Any] | None = None) -> Dict[str, Any]:
    normalized_method = str(method or "").strip().upper()
    normalized_path = str(path or "").strip()

    if normalized_method == "POST" and normalized_path == "/pins":
        cid = str((payload or {}).get("cid") or "").strip()
        if not cid:
            raise FilecoinPinHandoffError("mock Filecoin Pin request requires a cid")
        request_id = f"mock-pin-{hashlib.sha256(cid.encode('utf-8')).hexdigest()[:12]}"
        return {
            "requestid": request_id,
            "status": "queued",
            "info": {
                "provider": "mock-filecoin-pin",
                "cid": cid,
                "mock": True,
            },
        }

    if normalized_method == "GET" and normalized_path.startswith("/pins/"):
        request_id = normalized_path.rsplit("/", 1)[-1].strip()
        if not request_id:
            raise FilecoinPinHandoffError("mock Filecoin Pin status requires a request ID")
        return {
            "requestid": request_id,
            "status": _filecoin_pin_mock_status(),
            "info": {
                "provider": "mock-filecoin-pin",
                "mock": True,
                "pieceCid": f"baga6ea4seaq{hashlib.sha256(request_id.encode('utf-8')).hexdigest()[:16]}",
            },
        }

    raise FilecoinPinHandoffError(f"mock Filecoin Pin does not support {normalized_method} {normalized_path}")


def _filecoin_pin_timeout_seconds() -> float:
    timeout_seconds = float(str(os.getenv("WALLET_FILECOIN_PIN_TIMEOUT_SECONDS") or "30").strip())
    if timeout_seconds <= 0:
        raise FilecoinPinHandoffError("WALLET_FILECOIN_PIN_TIMEOUT_SECONDS must be positive")
    return timeout_seconds


def _filecoin_pin_request_headers(*, include_json_content_type: bool) -> Dict[str, str]:
    request_headers: Dict[str, str] = {}
    if include_json_content_type:
        request_headers["content-type"] = "application/json"
    if bearer_token := str(os.getenv("WALLET_FILECOIN_PIN_BEARER_TOKEN") or "").strip():
        request_headers["authorization"] = f"Bearer {bearer_token}"
    if header_name := str(os.getenv("WALLET_FILECOIN_PIN_HTTP_HEADER_NAME") or "").strip():
        header_value = str(os.getenv("WALLET_FILECOIN_PIN_HTTP_HEADER_VALUE") or "").strip()
        if not header_value:
            raise FilecoinPinHandoffError(
                "WALLET_FILECOIN_PIN_HTTP_HEADER_VALUE is required when WALLET_FILECOIN_PIN_HTTP_HEADER_NAME is set"
            )
        request_headers[header_name] = header_value
    return request_headers


def _response_message_from_raw_json(raw: str) -> str:
    if not raw.strip():
        return ""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip()
    if not isinstance(parsed, dict):
        return raw.strip()
    return str(parsed.get("error") or parsed.get("message") or "").strip()


def _filecoin_pin_status_url(request_id: str) -> str:
    service_url = _filecoin_pin_service_url()
    return f"{service_url}/pins/{request_id}" if service_url else ""


def _filecoin_upload_status_url(request_id: str) -> str:
    return f"/filecoin-upload/status/{request_id}"


def _key_from_optional_hex(value: str | None) -> bytes | None:
    if value is None:
        return None
    key = bytes.fromhex(value)
    if len(key) != 32:
        raise ValueError("wallet key must decode to 32 bytes")
    return key


def _send_dead_drop_email(
    *,
    to_email: str,
    subject: str,
    body: str,
    bundle: Dict[str, Any],
    bundle_filename: str,
) -> Dict[str, Any]:
    normalized_to_email = str(to_email or "").strip()
    normalized_subject = str(subject or "").strip()
    normalized_body = str(body or "")
    bundle_json = json.dumps(bundle, indent=2, sort_keys=True)
    sender = str(os.getenv("WALLET_DEAD_DROP_FROM_EMAIL") or "no-reply@211-ai.org").strip()

    webhook_url = str(os.getenv("WALLET_DEAD_DROP_WEBHOOK_URL") or "").strip()
    backend = str(os.getenv("WALLET_DEAD_DROP_BACKEND") or ("http" if webhook_url else "")).strip().lower()
    if backend or webhook_url:
        if backend != "http" or not webhook_url:
            raise RuntimeError(
                "WALLET_DEAD_DROP_WEBHOOK_URL environment variable is required for dead-drop delivery when WALLET_DEAD_DROP_BACKEND is enabled"
            )
        delivery = _send_webhook_notification(
            env_prefix="WALLET_DEAD_DROP",
            required_key="to_email",
            required_value=normalized_to_email,
            extra_payload={
                "subject": normalized_subject,
                "body": normalized_body,
                "from_email": sender,
                "attachment_base64": base64.b64encode(bundle_json.encode("utf-8")).decode("ascii"),
                "attachment_filename": str(bundle_filename or "abby-missing-person-wallet-dead-drop.json"),
                "attachment_mime_type": "application/json",
            },
        )
        return {"message_id": str(delivery.get("provider_message_id") or "")}

    smtp_host = str(os.getenv("WALLET_DEAD_DROP_SMTP_HOST") or "").strip()
    if not smtp_host:
        raise RuntimeError(
            "WALLET_DEAD_DROP_SMTP_HOST environment variable is required for dead-drop email delivery but is not configured"
        )
    smtp_port = int(str(os.getenv("WALLET_DEAD_DROP_SMTP_PORT") or "587").strip())
    smtp_use_ssl = str(os.getenv("WALLET_DEAD_DROP_SMTP_USE_SSL") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    smtp_starttls = str(os.getenv("WALLET_DEAD_DROP_SMTP_STARTTLS") or "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    smtp_username = str(os.getenv("WALLET_DEAD_DROP_SMTP_USERNAME") or "").strip()
    smtp_password = str(os.getenv("WALLET_DEAD_DROP_SMTP_PASSWORD") or "")

    message = EmailMessage()
    message["From"] = sender
    message["To"] = normalized_to_email
    message["Subject"] = normalized_subject
    sender_domain = sender.rsplit("@", 1)[-1].strip() if "@" in sender else ""
    message["Message-Id"] = make_msgid(domain=sender_domain or None)
    message.set_content(normalized_body)
    message.add_attachment(
        bundle_json.encode("utf-8"),
        maintype="application",
        subtype="json",
        filename=bundle_filename,
    )

    smtp_factory = smtplib.SMTP_SSL if smtp_use_ssl else smtplib.SMTP
    with smtp_factory(smtp_host, smtp_port, timeout=20) as smtp:
        if not smtp_use_ssl and smtp_starttls:
            smtp.starttls()
        if smtp_username:
            smtp.login(smtp_username, smtp_password)
        rejected = smtp.send_message(message)
    if rejected:
        raise RuntimeError(f"Dead-drop email delivery rejected recipients: {sorted(rejected)}")
    return {"message_id": str(message.get("Message-Id") or "")}
