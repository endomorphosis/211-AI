"""Chainlink CRE bridge models for consensus inference workflows.

This module intentionally does not perform live Chainlink network calls.  It
models the local bridge contract and accepts injected submit/wait handlers for
production adapters or deterministic simulated responses for tests.
"""

from __future__ import annotations

import inspect
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar

from .llm_consensus import (
    ConsensusReceipt,
    ConsensusRequest,
    ConsensusResult,
    LLMConsensusError,
    OperatorResponse,
    ProofReceipt,
    normalized_output_hash,
    sha256_digest,
    utc_now_iso,
)
from .proof_verifiers import ChainlinkCREVerifier, ProofContext, VerificationResult


CRE_SUBMISSION_SCHEMA_VERSION = "chainlink-cre-submission-v1"
CRE_RESULT_SCHEMA_VERSION = "chainlink-cre-inference-result-v1"
CRE_VERIFIER_EVENT_SCHEMA_VERSION = "chainlink-cre-verifier-event-v1"
CRE_BRIDGE_VERIFIER_ID = "chainlink-cre-bridge-v1"
CRE_VERIFIER_EVENT_VERIFIER_ID = "chainlink-cre-verifier-contract-event-v1"
CRE_COMPLETED_STATUSES = {"complete", "completed", "done", "success", "succeeded", "verified"}
CRE_FAILED_STATUSES = {"canceled", "cancelled", "error", "failed", "reverted", "timeout"}


class ChainlinkCREBridgeError(LLMConsensusError):
    """Raised when the local CRE bridge cannot safely proceed."""


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, set):
        items = [_jsonable(item) for item in value]
        return sorted(items, key=lambda item: _stable_json({"value": item}))
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return _jsonable(to_dict())
    return str(value)


def _stable_json(data: dict[str, Any]) -> str:
    return json.dumps(_jsonable(data), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _dict_value(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key)
    return dict(value) if isinstance(value, dict) else {}


def _clean_status(value: object, default: str = "submitted") -> str:
    text = str(value or "").strip().lower()
    return text or default


def _get_any(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in data:
            return data[key]
    return default


def _get_nested_any(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    value = _get_any(data, *keys, default=None)
    if value is not None:
        return value
    for nested_key in ("args", "returnValues", "return_values", "event", "metadata"):
        nested = data.get(nested_key)
        if isinstance(nested, dict):
            value = _get_any(nested, *keys, default=None)
            if value is not None:
                return value
    return default


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalize_address(value: str | None) -> str:
    return str(value or "").strip().lower()


def _call_handler(handler: Callable[..., Any], /, **kwargs: Any) -> Any:
    """Call a test/transport handler with the kwargs it declares.

    Handlers used in unit tests are often small one-argument callables, while a
    production adapter may accept the full payload.  This keeps the skeleton
    ergonomic without hiding handler exceptions.
    """

    try:
        signature = inspect.signature(handler)
    except (TypeError, ValueError):
        return handler(**kwargs)

    parameters = signature.parameters
    if any(param.kind is inspect.Parameter.VAR_KEYWORD for param in parameters.values()):
        return handler(**kwargs)

    accepted = {
        key: value
        for key, value in kwargs.items()
        if key in parameters
    }
    return handler(**accepted)


def _failure(reason: str, metadata: dict[str, Any] | None = None) -> VerificationResult:
    return VerificationResult(
        verified=False,
        verifier=CRE_BRIDGE_VERIFIER_ID,
        reason=reason,
        metadata=metadata or {},
    )


def _event_failure(reason: str, metadata: dict[str, Any] | None = None) -> VerificationResult:
    return VerificationResult(
        verified=False,
        verifier=CRE_VERIFIER_EVENT_VERIFIER_ID,
        reason=reason,
        metadata=metadata or {},
    )


@dataclass(frozen=True)
class CREBridgeConfig:
    """Static bridge configuration for one expected CRE workflow."""

    workflow_id: str
    don_id: str
    registry: str = "private"
    chain_id: str | None = None
    endpoint_url: str | None = None
    operator_id: str = "chainlink-cre"
    provider: str = "chainlink_cre"
    timeout_s: float = 120.0
    poll_interval_s: float = 2.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "workflow_id": self.workflow_id,
            "don_id": self.don_id,
            "registry": self.registry,
            "chain_id": self.chain_id,
            "endpoint_url": self.endpoint_url,
            "operator_id": self.operator_id,
            "provider": self.provider,
            "timeout_s": float(self.timeout_s),
            "poll_interval_s": float(self.poll_interval_s),
            "metadata": _jsonable(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CREBridgeConfig":
        return cls(
            workflow_id=str(_get_any(data, "workflow_id", "cre_workflow_id", default="") or ""),
            don_id=str(_get_any(data, "don_id", "cre_don_id", default="") or ""),
            registry=str(data.get("registry") or "private"),
            chain_id=str(data["chain_id"]) if data.get("chain_id") is not None else None,
            endpoint_url=str(data["endpoint_url"]) if data.get("endpoint_url") is not None else None,
            operator_id=str(data.get("operator_id") or "chainlink-cre"),
            provider=str(data.get("provider") or "chainlink_cre"),
            timeout_s=float(data.get("timeout_s") or 120.0),
            poll_interval_s=float(data.get("poll_interval_s") or 2.0),
            metadata=_dict_value(data, "metadata"),
        )

    def to_json(self) -> str:
        return _stable_json(self.to_dict())

    @classmethod
    def from_json(cls, text: str) -> "CREBridgeConfig":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("CREBridgeConfig JSON must decode to an object")
        return cls.from_dict(data)


@dataclass(frozen=True)
class CRESubmission:
    """A submitted CRE inference workflow request."""

    submission_id: str
    workflow_id: str
    don_id: str
    request_id: str
    request_hash: str
    status: str = "submitted"
    submitted_at: str = field(default_factory=utc_now_iso)
    deadline_unix_ms: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    schema_version: str = CRE_SUBMISSION_SCHEMA_VERSION

    EXPECTED_SCHEMA_VERSION: ClassVar[str] = CRE_SUBMISSION_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "submission_id": self.submission_id,
            "workflow_id": self.workflow_id,
            "don_id": self.don_id,
            "request_id": self.request_id,
            "request_hash": self.request_hash,
            "status": self.status,
            "submitted_at": self.submitted_at,
            "deadline_unix_ms": int(self.deadline_unix_ms),
            "metadata": _jsonable(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CRESubmission":
        schema_version = str(data.get("schema_version") or CRE_SUBMISSION_SCHEMA_VERSION)
        if schema_version != cls.EXPECTED_SCHEMA_VERSION:
            raise ValueError(f"Unsupported CRE submission schema_version: {schema_version}")
        return cls(
            schema_version=schema_version,
            submission_id=str(data.get("submission_id") or data.get("id") or ""),
            workflow_id=str(_get_any(data, "workflow_id", "cre_workflow_id", default="") or ""),
            don_id=str(_get_any(data, "don_id", "cre_don_id", default="") or ""),
            request_id=str(data.get("request_id") or ""),
            request_hash=str(data.get("request_hash") or ""),
            status=_clean_status(data.get("status")),
            submitted_at=str(data.get("submitted_at") or utc_now_iso()),
            deadline_unix_ms=int(data.get("deadline_unix_ms") or 0),
            metadata=_dict_value(data, "metadata"),
        )

    def to_json(self) -> str:
        return _stable_json(self.to_dict())

    @classmethod
    def from_json(cls, text: str) -> "CRESubmission":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("CRESubmission JSON must decode to an object")
        return cls.from_dict(data)


@dataclass(frozen=True)
class CREInferenceResult:
    """CRE workflow result metadata bound to one consensus inference request."""

    submission_id: str
    workflow_id: str
    don_id: str
    request_hash: str
    output_hash: str
    status: str = "completed"
    output_text: str = ""
    normalized_output_hash: str = ""
    cre_round: int | str | None = None
    cre_report_hash: str | None = None
    cre_report_id: str | None = None
    chain_id: str | None = None
    tx_hash: str | None = None
    latency_ms: int = 0
    nonce: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    schema_version: str = CRE_RESULT_SCHEMA_VERSION

    EXPECTED_SCHEMA_VERSION: ClassVar[str] = CRE_RESULT_SCHEMA_VERSION

    @property
    def completed(self) -> bool:
        return _clean_status(self.status, default="completed") in CRE_COMPLETED_STATUSES

    @property
    def failed(self) -> bool:
        return _clean_status(self.status, default="completed") in CRE_FAILED_STATUSES

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "submission_id": self.submission_id,
            "workflow_id": self.workflow_id,
            "don_id": self.don_id,
            "request_hash": self.request_hash,
            "output_hash": self.output_hash,
            "normalized_output_hash": self.normalized_output_hash,
            "output_text": self.output_text,
            "status": self.status,
            "cre_round": self.cre_round,
            "cre_report_hash": self.cre_report_hash,
            "cre_report_id": self.cre_report_id,
            "chain_id": self.chain_id,
            "tx_hash": self.tx_hash,
            "latency_ms": int(self.latency_ms),
            "nonce": self.nonce,
            "metadata": _jsonable(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CREInferenceResult":
        schema_version = str(data.get("schema_version") or CRE_RESULT_SCHEMA_VERSION)
        if schema_version != cls.EXPECTED_SCHEMA_VERSION:
            raise ValueError(f"Unsupported CRE result schema_version: {schema_version}")

        round_value = _get_any(data, "cre_round", "round", default=None)
        try:
            cre_round: int | str | None = int(round_value) if round_value is not None else None
        except (TypeError, ValueError):
            cre_round = str(round_value) if round_value is not None else None

        return cls(
            schema_version=schema_version,
            submission_id=str(data.get("submission_id") or data.get("id") or ""),
            workflow_id=str(_get_any(data, "workflow_id", "cre_workflow_id", default="") or ""),
            don_id=str(_get_any(data, "don_id", "cre_don_id", default="") or ""),
            request_hash=str(data.get("request_hash") or ""),
            output_hash=str(data.get("output_hash") or ""),
            normalized_output_hash=str(data.get("normalized_output_hash") or ""),
            output_text=str(data.get("output_text") or ""),
            status=_clean_status(data.get("status"), default="completed"),
            cre_round=cre_round,
            cre_report_hash=(
                str(_get_any(data, "cre_report_hash", "report_hash", default="") or "")
                or None
            ),
            cre_report_id=(
                str(_get_any(data, "cre_report_id", "report_id", default="") or "")
                or None
            ),
            chain_id=str(data["chain_id"]) if data.get("chain_id") is not None else None,
            tx_hash=str(data["tx_hash"]) if data.get("tx_hash") is not None else None,
            latency_ms=int(data.get("latency_ms") or 0),
            nonce=str(data.get("nonce") or ""),
            metadata=_dict_value(data, "metadata"),
        )

    def to_json(self) -> str:
        return _stable_json(self.to_dict())

    @classmethod
    def from_json(cls, text: str) -> "CREInferenceResult":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("CREInferenceResult JSON must decode to an object")
        return cls.from_dict(data)

    def proof_meta(self, *, nonce: str | None = None) -> dict[str, Any]:
        resolved_nonce = str(nonce if nonce is not None else self.nonce)
        meta: dict[str, Any] = {
            "request_hash": self.request_hash,
            "output_hash": self.output_hash,
            "cre_workflow_id": self.workflow_id,
            "cre_don_id": self.don_id,
            "cre_round": self.cre_round,
            "cre_report_hash": self.cre_report_hash,
        }
        if resolved_nonce:
            meta["nonce"] = resolved_nonce
        if self.cre_report_id:
            meta["cre_report_id"] = self.cre_report_id
        if self.chain_id:
            meta["chain_id"] = self.chain_id
        if self.tx_hash:
            meta["tx_hash"] = self.tx_hash
        verifier_event = self.verifier_contract_event()
        if verifier_event is not None:
            meta["verifier_contract_event"] = verifier_event.to_dict()
        return meta

    def verifier_contract_event(self) -> "CREVerifierContractEvent | None":
        raw_event = _get_any(
            self.metadata,
            "verifier_contract_event",
            "verifier_event",
            "contract_event",
            default=None,
        )
        if raw_event is None:
            return None
        if isinstance(raw_event, CREVerifierContractEvent):
            return raw_event
        if isinstance(raw_event, dict):
            return CREVerifierContractEvent.from_dict(raw_event)
        raise ValueError("verifier_contract_event must be an object")

    def to_operator_response(
        self,
        request: ConsensusRequest,
        *,
        operator_id: str = "chainlink-cre",
        provider: str = "chainlink_cre",
        verification: VerificationResult | None = None,
    ) -> OperatorResponse:
        error: str | None = None
        if self.failed:
            error = str(self.metadata.get("error") or self.status)
        elif not self.completed:
            error = f"cre_result_not_completed:{self.status}"
        elif verification is not None and not verification.verified:
            error = verification.reason

        resolved_normalized_hash = self.normalized_output_hash
        if not resolved_normalized_hash and self.output_text and error is None:
            try:
                resolved_normalized_hash = normalized_output_hash(
                    self.output_text,
                    comparison=request.comparison,
                )
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"

        metadata = {
            "cre_workflow_id": self.workflow_id,
            "cre_don_id": self.don_id,
            "cre_round": self.cre_round,
            "cre_report_hash": self.cre_report_hash,
            "cre_report_id": self.cre_report_id,
            "chain_id": self.chain_id,
            "tx_hash": self.tx_hash,
            "submission_id": self.submission_id,
        }
        if verification is not None:
            metadata["verification_reason"] = verification.reason
            metadata["verification_metadata"] = _jsonable(verification.metadata)
        metadata.update(self.metadata)

        return OperatorResponse(
            operator_id=operator_id,
            transport="chainlink_cre",
            peer_id=None,
            provider=provider,
            model_name=request.model_name,
            output_text=self.output_text if error is None else "",
            output_hash=self.output_hash if error is None else "",
            normalized_output_hash=resolved_normalized_hash if error is None else "",
            latency_ms=int(self.latency_ms),
            error=error,
            signature=None,
            attestation=self.proof_meta(),
            metadata=metadata,
        )

    def to_proof_receipt(self, verification: VerificationResult) -> ProofReceipt:
        metadata = {
            "reason": verification.reason,
            "cre_don_id": self.don_id,
            "cre_round": self.cre_round,
            "cre_report_hash": self.cre_report_hash,
            "submission_id": self.submission_id,
        }
        metadata.update(_jsonable(verification.metadata))
        verifier_event = self.verifier_contract_event()
        if verifier_event is not None:
            metadata["verifier_contract_event"] = verifier_event.to_dict()
        return ProofReceipt(
            policy="chainlink_cre",
            verified=bool(verification.verified),
            verifier=verification.verifier,
            cre_workflow_id=self.workflow_id or None,
            cre_report_id=self.cre_report_id,
            chain_id=self.chain_id,
            tx_hash=self.tx_hash,
            metadata=metadata,
        )


@dataclass(frozen=True)
class CREVerifierContractEvent:
    """Parsed verifier-contract event metadata for a CRE result.

    The parser accepts plain dicts and common Web3-style event payloads with
    fields under ``args`` or ``returnValues``.  It performs no RPC calls; callers
    provide expected bindings explicitly and receive a fail-closed
    ``VerificationResult``.
    """

    workflow_id: str
    request_hash: str
    output_hash: str
    proof_hash: str
    chain_id: str
    contract_address: str
    block_number: int
    tx_hash: str
    log_index: int | None = None
    event_name: str = "CREVerifierReceipt"
    schema_version: str = CRE_VERIFIER_EVENT_SCHEMA_VERSION

    EXPECTED_SCHEMA_VERSION: ClassVar[str] = CRE_VERIFIER_EVENT_SCHEMA_VERSION

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CREVerifierContractEvent":
        schema_version = str(data.get("schema_version") or CRE_VERIFIER_EVENT_SCHEMA_VERSION)
        if schema_version != cls.EXPECTED_SCHEMA_VERSION:
            raise ValueError(f"Unsupported CRE verifier event schema_version: {schema_version}")

        return cls(
            schema_version=schema_version,
            workflow_id=str(_get_nested_any(data, "workflow_id", "workflowId", "cre_workflow_id", default="") or ""),
            request_hash=str(_get_nested_any(data, "request_hash", "requestHash", default="") or ""),
            output_hash=str(_get_nested_any(data, "output_hash", "outputHash", default="") or ""),
            proof_hash=str(_get_nested_any(data, "proof_hash", "proofHash", "cre_report_hash", "report_hash", default="") or ""),
            chain_id=str(_get_nested_any(data, "chain_id", "chainId", default="") or ""),
            contract_address=str(
                _get_nested_any(data, "contract_address", "contractAddress", "address", default="") or ""
            ),
            block_number=int(_optional_int(_get_nested_any(data, "block_number", "blockNumber", default=0)) or 0),
            tx_hash=str(_get_nested_any(data, "tx_hash", "transaction_hash", "transactionHash", default="") or ""),
            log_index=_optional_int(_get_nested_any(data, "log_index", "logIndex", default=None)),
            event_name=str(_get_nested_any(data, "event_name", "event", "eventName", default="CREVerifierReceipt") or "CREVerifierReceipt"),
        )

    @classmethod
    def from_json(cls, text: str) -> "CREVerifierContractEvent":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("CREVerifierContractEvent JSON must decode to an object")
        return cls.from_dict(data)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "event_name": self.event_name,
            "workflow_id": self.workflow_id,
            "request_hash": self.request_hash,
            "output_hash": self.output_hash,
            "proof_hash": self.proof_hash,
            "chain_id": self.chain_id,
            "contract_address": self.contract_address,
            "block_number": int(self.block_number),
            "tx_hash": self.tx_hash,
            "log_index": self.log_index,
        }

    def to_json(self) -> str:
        return _stable_json(self.to_dict())

    def verify_expected(
        self,
        *,
        chain_id: str | None = None,
        contract_address: str | None = None,
        workflow_id: str | None = None,
        request_hash: str | None = None,
        output_hash: str | None = None,
        proof_hash: str | None = None,
        block_number: int | None = None,
        tx_hash: str | None = None,
    ) -> VerificationResult:
        checks = (
            ("chain_id", self.chain_id, chain_id),
            ("workflow_id", self.workflow_id, workflow_id),
            ("request_hash", self.request_hash, request_hash),
            ("output_hash", self.output_hash, output_hash),
            ("proof_hash", self.proof_hash, proof_hash),
            ("tx_hash", self.tx_hash, tx_hash),
        )
        for field_name, actual, expected in checks:
            if expected is None:
                continue
            if not actual:
                return _event_failure(f"verifier_contract_{field_name}_missing", self.to_dict())
            if str(actual) != str(expected):
                return _event_failure(f"verifier_contract_{field_name}_mismatch", self.to_dict())

        if contract_address is not None:
            if not self.contract_address:
                return _event_failure("verifier_contract_address_missing", self.to_dict())
            if _normalize_address(self.contract_address) != _normalize_address(contract_address):
                return _event_failure("verifier_contract_address_mismatch", self.to_dict())

        if block_number is not None:
            if not self.block_number:
                return _event_failure("verifier_contract_block_number_missing", self.to_dict())
            if int(self.block_number) != int(block_number):
                return _event_failure("verifier_contract_block_number_mismatch", self.to_dict())

        return VerificationResult(
            verified=True,
            verifier=CRE_VERIFIER_EVENT_VERIFIER_ID,
            reason="verifier_contract_event_verified",
            metadata=self.to_dict(),
        )


CREWorkflowResult = CREInferenceResult
CREInferenceSubmission = CRESubmission


class ChainlinkCREBridgeClient:
    """Local bridge client for CRE-backed inference workflow receipts."""

    def __init__(
        self,
        config: CREBridgeConfig | None = None,
        *,
        workflow_id: str | None = None,
        don_id: str | None = None,
        registry: str = "private",
        chain_id: str | None = None,
        endpoint_url: str | None = None,
        operator_id: str = "chainlink-cre",
        provider: str = "chainlink_cre",
        timeout_s: float = 120.0,
        poll_interval_s: float = 2.0,
        simulated_response: str | dict[str, Any] | CREInferenceResult | Callable[..., Any] | None = None,
        submit_handler: Callable[..., Any] | None = None,
        wait_handler: Callable[..., Any] | None = None,
        verifier: ChainlinkCREVerifier | None = None,
    ) -> None:
        if config is None:
            config = CREBridgeConfig(
                workflow_id=str(workflow_id or ""),
                don_id=str(don_id or ""),
                registry=registry,
                chain_id=chain_id,
                endpoint_url=endpoint_url,
                operator_id=operator_id,
                provider=provider,
                timeout_s=timeout_s,
                poll_interval_s=poll_interval_s,
            )
        if not config.workflow_id:
            raise ChainlinkCREBridgeError("cre_workflow_id_required")
        if not config.don_id:
            raise ChainlinkCREBridgeError("cre_don_id_required")

        self.config = config
        self._submit_handler = submit_handler
        self._wait_handler = wait_handler
        self._simulated_response = simulated_response
        self._round_counter = 0
        self._submissions: dict[str, CRESubmission] = {}
        self._verifier = verifier or ChainlinkCREVerifier(
            expected_workflow_id=config.workflow_id,
            expected_don_id=config.don_id,
        )

    @classmethod
    def simulated(
        cls,
        *,
        workflow_id: str,
        don_id: str,
        output_text: str = "",
        chain_id: str | None = None,
        **kwargs: Any,
    ) -> "ChainlinkCREBridgeClient":
        simulated_response = {"output_text": output_text}
        return cls(
            workflow_id=workflow_id,
            don_id=don_id,
            chain_id=chain_id,
            simulated_response=simulated_response,
            **kwargs,
        )

    def submit(
        self,
        request: ConsensusRequest,
        *,
        prompt: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CRESubmission:
        """Submit a canonical consensus request to a CRE workflow bridge."""

        if not request.request_hash:
            raise ChainlinkCREBridgeError("request_hash_required")

        payload = self._submission_payload(request, prompt=prompt, metadata=metadata)
        if self._submit_handler is not None:
            raw_submission = _call_handler(
                self._submit_handler,
                request=request,
                prompt=prompt,
                payload=payload,
                config=self.config,
            )
            submission = self._coerce_submission(raw_submission, request)
        else:
            submission = CRESubmission(
                submission_id=self._submission_id(request),
                workflow_id=self.config.workflow_id,
                don_id=self.config.don_id,
                request_id=request.request_id,
                request_hash=request.request_hash,
                status="submitted",
                deadline_unix_ms=int(request.deadline_unix_ms or 0),
                metadata={
                    "comparison": request.comparison,
                    "nonce": str(request.metadata.get("nonce") or ""),
                    "registry": self.config.registry,
                    **_jsonable(self.config.metadata),
                    **_jsonable(metadata or {}),
                },
            )

        self._validate_submission(submission, request)
        self._submissions[submission.submission_id] = submission
        return submission

    def wait(
        self,
        submission: CRESubmission | str,
        *,
        timeout_s: float | None = None,
        poll_interval_s: float | None = None,
    ) -> CREInferenceResult:
        """Wait for a CRE workflow result using an injected or simulated source."""

        resolved_submission = self._resolve_submission(submission)
        started = time.monotonic()
        effective_timeout_s = float(self.config.timeout_s if timeout_s is None else timeout_s)
        effective_poll_interval_s = float(
            self.config.poll_interval_s if poll_interval_s is None else poll_interval_s
        )

        if self._wait_handler is not None:
            raw_result = _call_handler(
                self._wait_handler,
                submission=resolved_submission,
                config=self.config,
                timeout_s=effective_timeout_s,
                poll_interval_s=effective_poll_interval_s,
            )
            return CREInferenceResult.from_dict(self._result_mapping(raw_result))

        if self._simulated_response is None:
            raise ChainlinkCREBridgeError("cre_wait_handler_required")

        raw_result = self._resolve_simulated_response(resolved_submission)
        result = self._simulated_result_from_mapping(resolved_submission, raw_result)
        if result.latency_ms:
            return result
        return CREInferenceResult.from_dict(
            {
                **result.to_dict(),
                "latency_ms": int((time.monotonic() - started) * 1000),
            }
        )

    def verify(
        self,
        result: CREInferenceResult | dict[str, Any],
        request: ConsensusRequest,
        *,
        expected_output_hash: str | None = None,
        nonce: str | None = None,
    ) -> VerificationResult:
        """Verify a CRE result against request and output-hash bindings."""

        cre_result = self._coerce_result(result)
        status = _clean_status(cre_result.status, default="completed")
        if status in CRE_FAILED_STATUSES:
            return _failure("cre_result_failed", {"status": cre_result.status})
        if status not in CRE_COMPLETED_STATUSES:
            return _failure("cre_result_not_completed", {"status": cre_result.status})

        if expected_output_hash is None:
            if not cre_result.output_text:
                return _failure("expected_output_hash_missing")
            expected_output_hash = sha256_digest(cre_result.output_text)

        if not expected_output_hash:
            return _failure("expected_output_hash_missing")

        resolved_nonce = nonce
        if resolved_nonce is None:
            resolved_nonce = cre_result.nonce or str(request.metadata.get("nonce") or "")

        context = ProofContext(
            request_hash=request.request_hash or "",
            output_hash=str(expected_output_hash),
            model_commitment=request.model_commitment or "",
            nonce=str(resolved_nonce or ""),
        )
        verification = self._verifier.verify(cre_result.proof_meta(nonce=resolved_nonce), context)
        if not verification.verified:
            return verification

        verifier_event = cre_result.verifier_contract_event()
        if verifier_event is None:
            return verification

        event_verification = verifier_event.verify_expected(
            chain_id=cre_result.chain_id or self.config.chain_id,
            contract_address=_optional_str(self.config.metadata.get("verifier_contract_address")),
            workflow_id=cre_result.workflow_id,
            request_hash=cre_result.request_hash,
            output_hash=cre_result.output_hash,
            proof_hash=cre_result.cre_report_hash,
            tx_hash=cre_result.tx_hash or None,
        )
        if not event_verification.verified:
            return event_verification
        return VerificationResult(
            verified=True,
            verifier=verification.verifier,
            reason=verification.reason,
            metadata={
                **verification.metadata,
                "verifier_contract_event": event_verification.metadata,
            },
        )

    def build_receipt(
        self,
        request: ConsensusRequest,
        result: CREInferenceResult | dict[str, Any],
        *,
        verification: VerificationResult | None = None,
        expected_output_hash: str | None = None,
        fail_closed: bool = True,
        created_at: str | None = None,
    ) -> ConsensusReceipt:
        """Convert a CRE result into the shared consensus receipt shape."""

        cre_result = self._coerce_result(result)
        resolved_verification = verification or self.verify(
            cre_result,
            request,
            expected_output_hash=expected_output_hash,
        )
        if fail_closed and not resolved_verification.verified:
            raise ChainlinkCREBridgeError(f"cre_verification_failed:{resolved_verification.reason}")

        response = cre_result.to_operator_response(
            request,
            operator_id=self.config.operator_id,
            provider=self.config.provider,
            verification=resolved_verification,
        )
        if resolved_verification.verified and not response.error:
            consensus = ConsensusResult(
                accepted=True,
                selected_output_hash=response.output_hash,
                selected_normalized_hash=response.normalized_output_hash,
                selected_operator_ids=[response.operator_id],
                rejected_operator_ids=[],
                quorum=1,
                total_successful=1,
                comparison=request.comparison,
                reason="chainlink_cre_verified",
            )
            text = response.output_text
        else:
            consensus = ConsensusResult(
                accepted=False,
                selected_output_hash="",
                selected_normalized_hash="",
                selected_operator_ids=[],
                rejected_operator_ids=[response.operator_id],
                quorum=1,
                total_successful=0,
                comparison=request.comparison,
                reason=resolved_verification.reason,
            )
            text = ""

        return ConsensusReceipt(
            request=request,
            responses=[response],
            consensus=consensus,
            proof=cre_result.to_proof_receipt(resolved_verification),
            text=text,
            created_at=created_at or utc_now_iso(),
        )

    def run(
        self,
        request: ConsensusRequest,
        *,
        prompt: str | None = None,
        metadata: dict[str, Any] | None = None,
        expected_output_hash: str | None = None,
        fail_closed: bool = True,
        timeout_s: float | None = None,
        poll_interval_s: float | None = None,
    ) -> ConsensusReceipt:
        """Submit, wait, verify, and return a consensus receipt."""

        submission = self.submit(request, prompt=prompt, metadata=metadata)
        result = self.wait(
            submission,
            timeout_s=timeout_s,
            poll_interval_s=poll_interval_s,
        )
        verification = self.verify(
            result,
            request,
            expected_output_hash=expected_output_hash,
        )
        return self.build_receipt(
            request,
            result,
            verification=verification,
            expected_output_hash=expected_output_hash,
            fail_closed=fail_closed,
        )

    submit_inference = submit
    wait_for_result = wait
    verify_result = verify
    submit_wait_verify = run

    def _submission_payload(
        self,
        request: ConsensusRequest,
        *,
        prompt: str | None,
        metadata: dict[str, Any] | None,
    ) -> dict[str, Any]:
        payload = {
            "workflow_id": self.config.workflow_id,
            "don_id": self.config.don_id,
            "registry": self.config.registry,
            "chain_id": self.config.chain_id,
            "request": request.to_dict(),
            "request_hash": request.request_hash or "",
            "request_id": request.request_id,
            "deadline_unix_ms": int(request.deadline_unix_ms or 0),
            "metadata": _jsonable(metadata or {}),
        }
        if prompt is not None:
            payload["prompt"] = prompt
        return payload

    def _submission_id(self, request: ConsensusRequest) -> str:
        return sha256_digest(
            _stable_json(
                {
                    "workflow_id": self.config.workflow_id,
                    "don_id": self.config.don_id,
                    "request_hash": request.request_hash or "",
                    "request_id": request.request_id,
                }
            )
        )

    def _coerce_submission(self, raw_submission: Any, request: ConsensusRequest) -> CRESubmission:
        if isinstance(raw_submission, CRESubmission):
            return raw_submission
        if isinstance(raw_submission, str):
            return CRESubmission(
                submission_id=raw_submission,
                workflow_id=self.config.workflow_id,
                don_id=self.config.don_id,
                request_id=request.request_id,
                request_hash=request.request_hash or "",
                deadline_unix_ms=int(request.deadline_unix_ms or 0),
            )
        mapping = self._mapping(raw_submission, "CRE submission")
        return CRESubmission.from_dict(
            {
                "workflow_id": self.config.workflow_id,
                "don_id": self.config.don_id,
                "request_id": request.request_id,
                "request_hash": request.request_hash or "",
                "deadline_unix_ms": int(request.deadline_unix_ms or 0),
                **mapping,
            }
        )

    def _validate_submission(self, submission: CRESubmission, request: ConsensusRequest) -> None:
        if submission.workflow_id != self.config.workflow_id:
            raise ChainlinkCREBridgeError("cre_submission_workflow_id_mismatch")
        if submission.don_id != self.config.don_id:
            raise ChainlinkCREBridgeError("cre_submission_don_id_mismatch")
        if submission.request_hash != (request.request_hash or ""):
            raise ChainlinkCREBridgeError("cre_submission_request_hash_mismatch")
        if not submission.submission_id:
            raise ChainlinkCREBridgeError("cre_submission_id_missing")

    def _resolve_submission(self, submission: CRESubmission | str) -> CRESubmission:
        if isinstance(submission, CRESubmission):
            return submission
        submission_id = str(submission or "")
        if submission_id in self._submissions:
            return self._submissions[submission_id]
        raise ChainlinkCREBridgeError("cre_submission_unknown")

    def _resolve_simulated_response(self, submission: CRESubmission) -> dict[str, Any]:
        source = self._simulated_response
        if callable(source):
            raw = _call_handler(source, submission=submission, config=self.config)
        elif isinstance(source, CREInferenceResult):
            raw = source.to_dict()
        elif isinstance(source, str):
            raw = {"output_text": source}
        else:
            raw = source
        return self._result_mapping(raw)

    def _simulated_result_from_mapping(
        self,
        submission: CRESubmission,
        data: dict[str, Any],
    ) -> CREInferenceResult:
        self._round_counter += 1
        filled = dict(data)

        if "submission_id" not in filled:
            filled["submission_id"] = submission.submission_id
        if "workflow_id" not in filled and "cre_workflow_id" not in filled:
            filled["workflow_id"] = submission.workflow_id
        if "don_id" not in filled and "cre_don_id" not in filled:
            filled["don_id"] = submission.don_id
        if "request_hash" not in filled:
            filled["request_hash"] = submission.request_hash
        if "status" not in filled:
            filled["status"] = "completed"
        if "cre_round" not in filled and "round" not in filled:
            filled["cre_round"] = self._round_counter
        if "chain_id" not in filled and self.config.chain_id is not None:
            filled["chain_id"] = self.config.chain_id

        output_text = str(filled.get("output_text") or "")
        if output_text and "output_hash" not in filled:
            filled["output_hash"] = sha256_digest(output_text)
        if output_text and "normalized_output_hash" not in filled:
            try:
                comparison = str(submission.metadata.get("comparison") or "exact")
                filled["normalized_output_hash"] = normalized_output_hash(
                    output_text,
                    comparison=comparison,
                )
            except Exception:
                filled["normalized_output_hash"] = ""

        if "cre_report_hash" not in filled and "report_hash" not in filled:
            filled["cre_report_hash"] = sha256_digest(
                _stable_json(
                    {
                        "submission_id": filled.get("submission_id") or "",
                        "request_hash": filled.get("request_hash") or "",
                        "output_hash": filled.get("output_hash") or "",
                        "workflow_id": _get_any(filled, "workflow_id", "cre_workflow_id", default="") or "",
                        "don_id": _get_any(filled, "don_id", "cre_don_id", default="") or "",
                        "cre_round": _get_any(filled, "cre_round", "round", default=None),
                    }
                )
            )
        if "cre_report_id" not in filled and "report_id" not in filled:
            filled["cre_report_id"] = filled["cre_report_hash"]
        if "nonce" not in filled:
            filled["nonce"] = str(submission.metadata.get("nonce") or "")

        return CREInferenceResult.from_dict(filled)

    def _coerce_result(self, result: CREInferenceResult | dict[str, Any]) -> CREInferenceResult:
        if isinstance(result, CREInferenceResult):
            return result
        return CREInferenceResult.from_dict(self._result_mapping(result))

    def _result_mapping(self, raw_result: Any) -> dict[str, Any]:
        if isinstance(raw_result, CREInferenceResult):
            return raw_result.to_dict()
        return self._mapping(raw_result, "CRE result")

    @staticmethod
    def _mapping(value: Any, label: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError(f"{label} must be a dict")
        return dict(value)


ChainlinkCREClient = ChainlinkCREBridgeClient
CREBridgeClient = ChainlinkCREBridgeClient


__all__ = [
    "CRE_BRIDGE_VERIFIER_ID",
    "CRE_COMPLETED_STATUSES",
    "CRE_FAILED_STATUSES",
    "CRE_RESULT_SCHEMA_VERSION",
    "CRE_SUBMISSION_SCHEMA_VERSION",
    "CRE_VERIFIER_EVENT_SCHEMA_VERSION",
    "CRE_VERIFIER_EVENT_VERIFIER_ID",
    "CREBridgeClient",
    "CREBridgeConfig",
    "CREInferenceResult",
    "CREInferenceSubmission",
    "CRESubmission",
    "CREVerifierContractEvent",
    "CREWorkflowResult",
    "ChainlinkCREClient",
    "ChainlinkCREBridgeClient",
    "ChainlinkCREBridgeError",
]
